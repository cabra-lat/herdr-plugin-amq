import test from "node:test";
import assert from "node:assert/strict";
import { rankDoorbellAlerts, DOORBELL_ALERT_IDS } from "../src/bridge.mjs";

/**
 * A SIGNAL IN THE CANDIDATE LIST IS NOT A DELIVERED SIGNAL.
 *
 * I added `person_queued_oldest` to the bridge's doorbell list, wrote a test asserting the id was
 * present, and closed the card with the rule "a producer test cannot establish that a signal is
 * delivered - only a test that reads the consumer can." Then I wrote a CONSUMER test that checked
 * MEMBERSHIP, which is the same non-test wearing a different name, and the signal delivered ZERO
 * times on a live board.
 *
 * The reason: selection was `alerts.find(sev === "critical") || alerts.find(id => IDS.includes(id))`.
 * Array.find returns the first match IN THE ALERTS ARRAY, so the winner was decided by the order
 * metrics.mjs pushes its alerts in, and the list order was irrelevant to it. Coordinator measured
 * it: person_queued_oldest 0 deliveries against blocked_cards 188 and backlog_idle 94, same board,
 * same day, producer firing, three daemon restarts on a worktree that contained the fix.
 *
 * The push order is the whole defect and it is invisible to any test about the list, so these
 * arms are about the ORDER OF THE ALERTS ARRAY. The first one reproduces the live shape exactly.
 */

const NOW = Date.parse("2026-09-27T08:00:00.000Z");
const alert = (id, extra = {}) => ({ id, severity: "warning", message: id, ...extra });
// The live push order from metrics.mjs, with person_queued_oldest in its real position.
const LIVE_ORDER = [
  alert("backlog_idle"), alert("blocked_cards"), alert("blocked_age"),
  alert("person_queued_oldest"), alert("retry_failure_trend"),
];

test("THE DEFECT: an alert pushed LAST was undeliverable, whatever the list said", () => {
  // Every other candidate delivered recently; person_queued_oldest never has. This is the live
  // situation after the fix shipped: the producer fires, the id is in the list, and the doorbell
  // had no path to it because three earlier candidates were present.
  const state = {
    backlog_idle: { at: new Date(NOW - 60_000).toISOString() },
    blocked_cards: { at: new Date(NOW - 30_000).toISOString() },
    blocked_age: { at: new Date(NOW - 45_000).toISOString() },
    // My first fixture listed three of the four other candidates and left retry_failure_trend
    // undelivered too - so it tied with person_queued_oldest on starvation and the declared list
    // order handed it the win. The code was right and the fixture was wrong: the live claim is
    // that the OTHER candidates are being delivered, which is what 188 and 94 against 0 measured.
    retry_failure_trend: { at: new Date(NOW - 90_000).toISOString() },
  };
  const winner = rankDoorbellAlerts(LIVE_ORDER, state, NOW)[0];
  assert.equal(winner.id, "person_queued_oldest",
    "the signal that has gone longest undelivered must win, or it can never be delivered at all");
});

test("PUSH ORDER NO LONGER DECIDES THE WINNER", () => {
  // Same five alerts, reversed. The chosen one must be identical - a ranking that changes when the
  // producer reorders two unrelated alerts is a ranking by source line number.
  const state = { blocked_cards: { at: new Date(NOW - 30_000).toISOString() } };
  const forward = rankDoorbellAlerts(LIVE_ORDER, state, NOW)[0]?.id;
  const reversed = rankDoorbellAlerts([...LIVE_ORDER].reverse(), state, NOW)[0]?.id;
  assert.equal(forward, reversed, "the winner may not depend on where a producer pushed its alert");
});

test("A CRITICAL STILL OUTRANKS A WARNING, however long the warning has waited", () => {
  // The one place a person-gated wait must never come first. A starvation rule that could promote
  // a six-hour wait for a human above a broken build would be a worse defect than the one being
  // fixed, so this is a hard ceiling rather than a weight.
  const state = { person_queued_oldest: { at: new Date(NOW - 6 * 3600_000).toISOString() } };
  const alerts = [alert("person_queued_oldest"), alert("build_red", { severity: "critical" })];
  assert.equal(rankDoorbellAlerts(alerts, state, NOW)[0].id, "build_red");
});

test("TWO NEVER-DELIVERED WARNINGS: THE LIST ORDER IS THE TIEBREAK, AND IT BINDS", () => {
  // With no history, starvation ties at +Infinity and the declared list order decides. Asserting
  // it BINDS is the point: before, the list order was decorative and the push order was real.
  const winner = rankDoorbellAlerts(LIVE_ORDER, {}, NOW)[0];
  assert.equal(winner.id, DOORBELL_ALERT_IDS[0], "the list's first entry wins the tie, as declared");
});

test("ROTATION IS REAL: DELIVERING THE WINNER ADVANCES IT, SO THE NEXT ONE GETS A TURN", () => {
  // Without this the ranking could name the same alert forever and starvation would never engage.
  const first = rankDoorbellAlerts(LIVE_ORDER, {}, NOW)[0].id;
  const after = { ...{}, [first]: { at: new Date(NOW).toISOString() } };
  const second = rankDoorbellAlerts(LIVE_ORDER, after, NOW)[0].id;
  assert.notEqual(second, first, "delivering one alert must not make it win again immediately");
});

test("A NON-CANDIDATE IS NEVER SELECTED, and the filter is a filter", () => {
  // stalled_work and blocked_oldest are not doorbell candidates; only a CRITICAL of any id is.
  const alerts = [alert("stalled_work"), alert("blocked_oldest"), alert("build_red", { severity: "critical" })];
  assert.deepEqual(rankDoorbellAlerts(alerts, {}, NOW).map((a) => a.id), ["build_red"],
    "only a critical escapes the id filter");
  assert.deepEqual(rankDoorbellAlerts([alert("stalled_work")], {}, NOW), [],
    "and a board with no candidate and no critical selects nothing, rather than something anyway");
});

test("A MISSING `at` IS TREATED AS NEVER DELIVERED, not as epoch-zero", () => {
  // The state is written by another process. A record with no `at`, or an unparseable one, must
  // not be read as "delivered at the beginning of time", which would make a fresh alert sort as
  // ancient and lose every tiebreak to a stale one.
  const state = { person_queued_oldest: {}, backlog_idle: { at: "not-a-date" } };
  const winner = rankDoorbellAlerts([alert("person_queued_oldest"), alert("backlog_idle")], state, NOW)[0];
  assert.equal(winner.id, DOORBELL_ALERT_IDS.indexOf("person_queued_oldest")
    < DOORBELL_ALERT_IDS.indexOf("backlog_idle") ? "person_queued_oldest" : "backlog_idle",
    "unusable timestamps fall through to the declared order instead of inventing an age");
});
