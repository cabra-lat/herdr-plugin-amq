import test from "node:test";
import assert from "node:assert/strict";
import { classifyTwoClocks, CLOCK_OBSERVATIONS, CLOCK_LABEL_VALUES } from "../src/work-age.mjs";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

const HOUR = 60 * 60 * 1000;
const T = HOUR;
const W = 24 * HOUR; // the work axis is a slower question than the state axis
const recent = 0.5 * HOUR;
const old = 50 * HOUR;
const dated = (ageMs) => ({ state: "dated", ageMs, latestSha: "e8e9f35", latestAt: "2026-09-24T10:00:00.000Z" });

test("both clocks stale is labelled by its clocks, not as a verdict about the owner", () => {
  const c = classifyTwoClocks({ stateAgeMs: old, work: dated(old), stateStaleAfterMs: T, workStaleAfterMs: W });
  assert.equal(c.label, CLOCK_OBSERVATIONS.BOTH_STALE);
  assert.equal(c.label, "both-stale");
});

test("work fresh with a still card is a clock description, and carries what it also fits", () => {
  const c = classifyTwoClocks({ stateAgeMs: old, work: dated(recent), stateStaleAfterMs: T, workStaleAfterMs: W });
  assert.equal(c.label, CLOCK_OBSERVATIONS.WORK_RECENT_STATE_STALE);
  // The boundary case is IN THE PAYLOAD, not left for the reader to guess: this label is
  // equally an implemented-but-forgotten card and work that does not address the card.
  assert.ok(c.alsoConsistentWith.length >= 2, "alternatives must travel with the label");
  const joined = c.alsoConsistentWith.join(" | ").toLowerCase();
  assert.match(joined, /forgotten/, "the implemented-but-forgotten reading must be present");
  assert.match(joined, /does not actually address/, "the unrelated-work reading must be present");
});

test("card moved but nothing built is its own label, and names bookkeeping as a reading", () => {
  const c = classifyTwoClocks({ stateAgeMs: recent, work: dated(old), stateStaleAfterMs: T, workStaleAfterMs: W });
  assert.equal(c.label, CLOCK_OBSERVATIONS.STATE_RECENT_WORK_STALE);
  const joined = c.alsoConsistentWith.join(" | ").toLowerCase();
  assert.match(joined, /bookkeeping/, "rewriting a reason is bookkeeping and must be listed as a reading");
});

// The constraint that matters more than the feature: a verdict-shaped label is argued
// with as a judgement, and the moment a human sees one next to a colleague's name the
// metric becomes a performance signal and owners learn to move the clock instead of
// finishing the work.
test("no label names an agent, a person, or a behaviour", () => {
  const forbidden = /\b(idle|lazy|neglect|abandon|fail|inactive|slack|bad|poor|behind|unresponsive|derelict)\w*/i;
  for (const label of CLOCK_LABEL_VALUES) {
    assert.doesNotMatch(label, forbidden, `label "${label}" reads as a verdict about the owner`);
    // Every label is built from clock vocabulary.
    assert.match(label, /(recent|stale|work|state|both|unknown)/, `label "${label}" must name a clock`);
  }
});

test("no label's description, alternatives, or field names judge the owner", () => {
  const cases = [
    { stateAgeMs: old, work: dated(old) },
    { stateAgeMs: old, work: dated(recent) },
    { stateAgeMs: recent, work: dated(old) },
    { stateAgeMs: recent, work: dated(recent) },
    { stateAgeMs: recent, work: { state: "no-claims" } },
  ];
  const forbidden = /\b(idle|lazy|neglect|failure|failed|bad|poor|sloppy|wrong|culprit|blame)\w*/i;
  for (const c of cases) {
    const out = classifyTwoClocks({ ...c, stateStaleAfterMs: T, workStaleAfterMs: W });
    const text = [out.label, out.describes, ...(out.alsoConsistentWith || [])].join(" ");
    assert.doesNotMatch(text, forbidden, `a judgement leaked into: ${text}`);
    // And no field is named after a person.
    assert.equal(out.owner, undefined);
    assert.equal(out.agent, undefined);
    assert.equal(out.verdict, undefined);
  }
});

test("no dated work is work-unknown, never silently stale", () => {
  for (const work of [null, { state: "no-claims" }, { state: "undated" }, { state: "dated", ageMs: null }]) {
    const c = classifyTwoClocks({ stateAgeMs: old, work, stateStaleAfterMs: T, workStaleAfterMs: W });
    assert.equal(c.label, CLOCK_OBSERVATIONS.WORK_UNKNOWN, `work=${JSON.stringify(work)}`);
    // Defaulting to stale would invent evidence of inactivity that does not exist.
    assert.notEqual(c.label, CLOCK_OBSERVATIONS.BOTH_STALE);
  }
});

test("a missing state clock is unreadable, not stale", () => {
  const c = classifyTwoClocks({ stateAgeMs: null, work: dated(recent), stateStaleAfterMs: T, workStaleAfterMs: W });
  assert.equal(c.label, CLOCK_OBSERVATIONS.WORK_UNKNOWN);
  assert.equal(c.stateAgeMs, null);
});

test("both recent is reachable and distinct", () => {
  const c = classifyTwoClocks({ stateAgeMs: recent, work: dated(recent), stateStaleAfterMs: T, workStaleAfterMs: W });
  assert.equal(c.label, CLOCK_OBSERVATIONS.BOTH_RECENT);
});

test("classification is report-only and can never page anyone", () => {
  for (const c of [old, recent, 0, HOUR * 1000]) {
    const out = classifyTwoClocks({ stateAgeMs: c, work: dated(c), stateStaleAfterMs: T, workStaleAfterMs: W });
    assert.equal(out.alerts, false);
    assert.equal(out.thresholdPages, false);
    assert.equal(out.reportOnly, true);
    assert.equal(out.severity, undefined);
  }
});

test("the boundary case travels in the payload, not in a comment", () => {
  const result = buildCoordinatorMetrics({ handles: [], agentStatuses: {}, board: { columns: {} }, now: Date.now() });
  const text = JSON.stringify(result.workAge.classification);
  assert.match(text, /forgotten/, "the implemented-but-forgotten boundary must be in the payload");
  assert.match(text, /does not address/, "the unrelated-work boundary must be in the payload");
  assert.match(text, /never agents|not the owner/i);
  assert.equal(result.workAge.classification.alerts, false);
  assert.equal(result.workAge.classification.thresholdsPage, false);
});

test("the label set is exactly the five clock combinations, with no sixth", () => {
  assert.deepEqual(CLOCK_LABEL_VALUES.slice().sort(), [
    "both-recent", "both-stale", "state-recent-work-stale", "work-recent-state-stale", "work-unknown",
  ]);
});

// The defect this test exists for: the first version used the STATE threshold (minutes)
// on the WORK axis (hours). Measured on the live board, 0 of 6 cards with dated work
// qualified as work-recent, so `both-recent` and `work-recent-state-stale` could never
// fire and the classification silently collapsed from five labels to three. A label that
// is unreachable is worse than no label, because it looks like coverage.
test("work-recent is reachable, so the two axes cannot share one threshold", () => {
  // One card: moved 30 minutes ago, last cited a commit 2 hours ago. Both ages are small
  // in human terms and both are old against a 10-minute bar, which is the state scale.
  const card = { stateAgeMs: 0.5 * HOUR, work: dated(2 * HOUR) };
  const shared = classifyTwoClocks({ ...card, stateStaleAfterMs: 10 * 60 * 1000, workStaleAfterMs: 10 * 60 * 1000 });
  assert.equal(shared.label, CLOCK_OBSERVATIONS.BOTH_STALE, "a shared 10m bar calls a 2h-old commit stale");

  // With each axis on its own scale - state recent under 1h, work recent under 24h - the
  // same card is recent on both. Under the shared 10m bar, 30 minutes of card age was
  // already "stale" too, which is why the shared version reads both-stale.
  const separated = classifyTwoClocks({ ...card, stateStaleAfterMs: T, workStaleAfterMs: 24 * HOUR });
  assert.equal(separated.label, CLOCK_OBSERVATIONS.BOTH_RECENT, "the same card on a work-scale bar");
  // The label the live board collapsed to, and the one it should have been able to reach.
  assert.notEqual(separated.label, shared.label);
});

test("every one of the five labels is reachable", () => {
  const seen = new Set();
  const ages = [0.5 * HOUR, 50 * HOUR];
  for (const stateAgeMs of ages) {
    for (const workAgeMs of ages) {
      seen.add(classifyTwoClocks({ stateAgeMs, work: dated(workAgeMs), stateStaleAfterMs: T, workStaleAfterMs: W }).label);
    }
  }
  seen.add(classifyTwoClocks({ stateAgeMs: T, work: { state: "no-claims" }, stateStaleAfterMs: T, workStaleAfterMs: W }).label);
  for (const label of CLOCK_LABEL_VALUES) {
    assert.ok(seen.has(label), `label "${label}" is unreachable - a dead label looks like coverage`);
  }
});

test("the two axes are independently tunable, so each can be argued about on its own", () => {
  const card = { stateAgeMs: 0.5 * HOUR, work: dated(2 * HOUR) };
  // Hold the state bar, move only the work bar.
  const workA = classifyTwoClocks({ ...card, stateStaleAfterMs: 60 * 1000, workStaleAfterMs: 24 * HOUR });
  const workB = classifyTwoClocks({ ...card, stateStaleAfterMs: 60 * 1000, workStaleAfterMs: 60 * 60 * 1000 });
  assert.notEqual(workA.label, workB.label, "the work bar must be able to move the label by itself");
  // Hold the work bar, move only the state bar.
  const stateA = classifyTwoClocks({ ...card, stateStaleAfterMs: 60 * 1000, workStaleAfterMs: 60 * 60 * 1000 });
  const stateB = classifyTwoClocks({ ...card, stateStaleAfterMs: 24 * HOUR, workStaleAfterMs: 60 * 60 * 1000 });
  assert.notEqual(stateA.label, stateB.label, "the state bar must be able to move the label by itself");
  // And a card that is recent on BOTH axes is labelled recent on both thresholds.
  const fresh = classifyTwoClocks({ stateAgeMs: 60 * 1000, work: dated(60 * 1000), stateStaleAfterMs: T, workStaleAfterMs: W });
  assert.equal(fresh.label, CLOCK_OBSERVATIONS.BOTH_RECENT);
});

test("the label travels with both raw ages and both thresholds, so it can be re-derived", () => {
  const c = classifyTwoClocks({ stateAgeMs: 0.5 * HOUR, work: dated(2 * HOUR), stateStaleAfterMs: T, workStaleAfterMs: W });
  assert.equal(c.stateAgeMs, 0.5 * HOUR);
  assert.equal(c.workAgeMs, 2 * HOUR);
  assert.equal(c.stateThresholdMs, T);
  assert.equal(c.workThresholdMs, W);
  // A reader who disagrees with the threshold can ignore the label entirely and use the
  // ages; that is the escape hatch that keeps a chosen threshold from becoming a verdict.
  assert.equal(c.labelDependsOnThreshold, true);
});
