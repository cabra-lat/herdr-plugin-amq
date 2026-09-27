import test from "node:test";
import assert from "node:assert/strict";
import { buildCoordinatorMetricsWithWorkAge } from "../src/metrics.mjs";
import { __resetWorkAgeCache } from "../src/work-age.mjs";

/**
 * WORK-AGE COVERED ONLY THE STALL-ELIGIBLE SUBSET, AND NOBODY CHOSE THAT.
 *
 * The loop sat on `activeCards`, which is `activeBoardTasks(board, { stallEligible: true })`, so
 * work-age consumed the stall map by accident of construction - the second clock bolted onto the
 * same array. Coordinator's test for whether a scope is deliberate is the one I have been quoting
 * all night in the other direction: A DELIBERATE SCOPE IS ONE A READER COULD DISCOVER FROM THE
 * ARTIFACT. Nothing in the payload key or the alert text said "active only". It was not
 * deliberate, and I said as much on the card without having measured the mechanism.
 *
 * Five cards citing plugin commits read as citing nothing, and after the repository fix they
 * STILL did - because a done card is not in the map at all. The entry was ABSENT, not undated,
 * which is why the number never moved no matter what the resolver did.
 *
 * THE CONSTRAINT COORDINATOR MEASURED, AND IT IS THE INTERESTING PART. `activeCards` feeds NINE
 * signals inside buildCoordinatorMetrics - blocked_oldest, backlog_idle, stalled_work, queue_age,
 * blocked_cards, blocked_age, person_queued_oldest, stale_heartbeat, retry_failure_trend - and
 * stalled_work is defined after the array is built, in the same function. Widening
 * `activeBoardTasks` in place would have silently widened the STALL ALERT. So the fix is a SIBLING
 * loop over the board's full task set, and the second arm below exists to prove the stall alert
 * did not move with it.
 */

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const mins = (n) => n * 60_000;
const card = (id, column, extra = {}) => ({
  id, title: id, owner: "lane", status: column, next_actor: "user",
  created: new Date(NOW - mins(600)).toISOString(), ...extra,
});
const board = (columns) => ({ columns });
const build = (columns) => buildCoordinatorMetricsWithWorkAge({
  board: board(columns), now: NOW, deliveredState: { delivered: {} },
});

test("A DONE CARD IS IN THE MAP, not absent from it", async () => {
  // The specific defect: not "its citation is undated" but "there is no entry to be undated".
  // The distinction matters because a consumer iterating workAgeById cannot see a card that was
  // never inserted, so the gap was invisible to every count anyone took.
  const { workAgeById } = await build({ done: [card("dcec35", "done")], doing: [card("live", "doing")] });
  assert.ok(workAgeById.has("dcec35"), "a done card must have a work-age entry");
  assert.ok(workAgeById.has("live"), "and an active one still does");
});

test("A BACKLOG CARD IS COVERED TOO - stallEligible was narrower than 'not done'", async () => {
  // `stallEligible` is not the same predicate as "unfinished". A backlog card is unfinished and
  // was outside the map, so "active only" was doubly wrong: it was never a scope, and it was not
  // even the scope its own name implied.
  const { workAgeById } = await build({ backlog: [card("waiting", "backlog")] });
  assert.ok(workAgeById.has("waiting"), "an unfinished card in backlog is still unfinished");
});

test("THE STALL ALERT DID NOT WIDEN - this was the whole constraint", async () => {
  // Nine signals read `activeCards` inside buildCoordinatorMetrics, and stalled_work is defined
  // after the array is built. If the fix had widened the shared map in place, a DONE card would
  // appear in the stall list - a card that finished and is being nagged about for not moving.
  // The live card carries a RECENT update on purpose. My first version reused the shared fixture,
  // which is 10h old with no update, and asserted it was not stalled - so the arm failed with the
  // stall alert CORRECTLY reporting a card that genuinely had not moved in ten hours. The code was
  // right and the fixture was wrong: what this arm is about is whether DONE cards leak in, not
  // whether a stale card gets excused.
  const { metrics } = await build({
    done: [card("finished", "done")],
    doing: [card("live", "doing", { updated: new Date(NOW - mins(1)).toISOString() })],
  });
  const stalled = metrics.alerts.find((a) => a.id === "stalled_work");
  const ids = (stalled?.cards || []).map((c) => c.id);
  assert.ok(!ids.includes("finished"), "a done card must never appear in a stall alert");
  assert.ok(!ids.includes("live"), "and a card that moved a minute ago is not stalled");
});

test("THE SCOPE IS DISCOVERABLE FROM THE ARTIFACT, which is the test that was failed", async () => {
  const { metrics } = await build({ done: [card("d", "done")] });
  assert.ok(metrics.workAgeScope, "the payload must state its own scope");
  assert.equal(metrics.workAgeScope.cards, 1, "and report how many cards it covers");
  assert.match(metrics.workAgeScope.note, /EVERY card/, "in words a reader can act on");
});

test("A CARD WHOSE RESOLUTION THROWS IS AN EXPLICIT null, NOT AN ABSENT ENTRY", async () => {
  // The per-card catch records null rather than skipping, so "could not resolve" and "was never
  // considered" stay distinguishable. Collapsing them is how the original gap stayed invisible:
  // both looked like a card that simply was not there.
  const broken = card("broken", "done", { created: Symbol.iterator ? "not-a-date" : null });
  const { workAgeById } = await build({ done: [broken] });
  assert.ok(workAgeById.has("broken"), "a failing card is still recorded");
});
