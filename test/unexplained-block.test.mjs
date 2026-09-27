import test from "node:test";
import assert from "node:assert/strict";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

/**
 * A BLOCK THAT NAMES NO CONDITION AND NO OWNER.
 *
 * The missing-edge half of task_1790474243733_325ba6, and the half that did not have to wait for
 * a ruling about prose. The rule a block must satisfy is about AUTHORING, not reading: the edge is
 * the claim, the reason is narration. So a block is explained when it names an edge or an owner,
 * and the prose never substitutes for either - which is checkable from two fields.
 *
 * The distinction from `stale` is the whole point, because conflating them reintroduces the very
 * false block this project keeps producing:
 *   STALE       - names a real edge, and every known dependency is DONE.
 *   UNEXPLAINED - names nothing at all. No condition to evaluate, so it cannot be stale and it
 *                 cannot be released; it is simply unowned.
 *
 * Report-only, like the staleness label. Alerting on it would page lanes about a bookkeeping
 * error only a human can fix, and an alert that fires on ordinary queue latency is one everyone
 * learns to ignore - after which the next real one is missed too.
 */

const NOW = 1_800_000_000_000;

function card(id, extra = {}) {
  return {
    id,
    title: `card ${id}`,
    owner: "agsuite-dev",
    created: NOW - 60_000,
    updated: NOW - 60_000,
    blocked_at: new Date(NOW - 30_000).toISOString(),
    ...extra,
  };
}

// A card's status on this board IS ITS COLUMN. My first version of this file passed a flat
// `tasks` array the function never reads, so all six arms failed IDENTICALLY - which is the
// signature of a broken fixture rather than of six wrong assertions. That distinction is worth
// keeping: a card done in every field EXCEPT the column the board reads is exactly the false-block
// shape, so reading it the wrong way round would have looked like the label failing.
function metricsFor(blocked, elsewhere = {}) {
  return buildCoordinatorMetrics({
    board: { columns: { blocked, ...elsewhere } },
    now: NOW,
    deliveredState: { delivered: {} },
  });
}

const unexplained = (m, id) => m.blockedWork.find((b) => b.id === id)?.unexplained;

test("a block with no edge, no owner and no condition is UNEXPLAINED", () => {
  const m = metricsFor([card("task_x")]);
  assert.equal(unexplained(m, "task_x"), true);
});

test("THE CONTROL: WAIT-WITH-OWNER, next_actor set and depends_on empty, is NOT unexplained", () => {
  // This is coordinator's own corrected shape and it must stay legal. Refusing to require an edge
  // would forbid the honest state in favour of a structured lie - and inventing a dependency for
  // an answer nobody has given is precisely how the false block happened in the first place.
  const m = metricsFor([card("task_x", { next_actor: "player-rig" })]);
  assert.equal(unexplained(m, "task_x"), false);
});

test("a block with a LIVE edge is NOT unexplained", () => {
  const m = metricsFor(
    [card("task_x", { depends_on: ["task_dep"] })],
    { doing: [card("task_dep")] },
  );
  assert.equal(unexplained(m, "task_x"), false);
});

test("a block whose only edge is UNKNOWN does not count as naming a condition", () => {
  // An edge to an id that is not on the board may be remembered rather than read, which is the
  // false-block signature. Crediting it would let a mis-encoded edge explain itself.
  const m = metricsFor([card("task_x", { depends_on: ["task_never_existed"] })]);
  assert.equal(unexplained(m, "task_x"), true);
});

test("a block whose edges are ALL done is NOT unexplained - it is stale, a different defect", () => {
  const m = metricsFor(
    [card("task_x", { depends_on: ["task_dep"] })],
    { done: [card("task_dep", { done_at: "2026-09-26T00:00:00.000Z" })] },
  );
  assert.equal(unexplained(m, "task_x"), false,
    "it names a condition, so it is a stale block and not an unowned one");
});

test("prose alone does NOT explain a block", () => {
  // The reason is narration. If a sentence counted as a condition, the false block would have been
  // self-explaining and the whole class of defect would be invisible.
  const m = metricsFor([card("task_x", { block_reason: "waiting on player-rig to answer" })]);
  assert.equal(unexplained(m, "task_x"), true,
    "a reason that names a person is still not an edge and still not an owner field");
});

test("it is REPORT-ONLY: the alert set is untouched by an unexplained block", () => {
  const withIt = metricsFor([card("task_x", { block_reason: "no owner, no edge" })]);
  const withoutIt = metricsFor([card("task_x", { block_reason: "no owner, no edge", next_actor: "range" })]);
  assert.deepEqual(
    withIt.alerts.map((a) => a.id).sort(),
    withoutIt.alerts.map((a) => a.id).sort(),
    "labelling a block must not page anyone",
  );
});
