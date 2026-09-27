import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

/**
 * The staleness LABEL, built first out of the three criteria coordinator narrowed this card to.
 *
 * WHAT IT IS FOR. A blocked card whose dependencies are ALL DONE is unambiguously a defect in
 * the BOARD rather than in the work: nothing is waiting on anything, so the block is simply
 * wrong. Coordinator's own false block was exactly this - waiting on a card superseded hours
 * earlier, known to be superseded, noted rather than re-pointed. Both the tooling defect and the
 * human defect are the same defect: nothing releases a block when its dependency completes, so
 * a legitimate wait and a permanent one look identical.
 *
 * WHY IT IS A REPORT AND NOT AN ALERT. Alerting on it would page lanes about a bookkeeping error
 * only a human can fix, and an alert that fires on ordinary queue latency is one everyone learns
 * to ignore - after which the next real one is missed too. This is why the test below asserts the
 * label is REPORT-ONLY by checking the alert set is untouched.
 *
 * WHAT IT IS NOT. It is not a ban on self-routing. Five of six self-routed blocks on the live
 * board are CORRECT - a lane legitimately holding both a block and the work that releases it - so
 * criterion 3 as originally written would have replaced five true next actors with five invented
 * ones, and an invented actor is indistinguishable from a real one.
 */

const NOW = 1_800_000_000_000;

function board(columns) {
  return { columns };
}

function card(id, extra = {}) {
  return {
    id,
    title: `card ${id}`,
    owner: "agsuite-dev",
    created: NOW - 60_000,
    updated: NOW - 60_000,
    ...extra,
  };
}

// A card's status on this board IS ITS COLUMN. The first version of this file put finished
// cards in `doing` with a `status: "done"` property, and the label correctly did not fire -
// because statusById is built from column names, so that card was in fact "doing". Worth stating
// because a card that is done in every field EXCEPT the one the board reads is exactly the shape
// of the false block this label exists to catch, and it would have been easy to call the label
// broken instead of the fixture.
function build(columns) {
  return buildCoordinatorMetrics({ board: board(columns), now: NOW, deliveredState: { delivered: {} } });
}

describe("a block whose dependencies are all done is labelled STALE", () => {
  test("the real shape: waiting on a card that is already finished", () => {
    // Coordinator's e48dd5: the blocker was DONE and the edge was never re-pointed. Before this
    // label it was an ordinary blocked card, indistinguishable from a genuine wait.
    const m = build({
      backlog: [],
      doing: [card("d1")],
      done: [card("4a3c3a")],
      blocked: [card("e48dd5", { depends_on: ["4a3c3a"], block_reason: "waiting on the check" })],
    });
    const stale = m.blockedOldest.stale;
    assert.equal(stale.length, 1, "one stale block");
    assert.equal(stale[0].id, "e48dd5");
    assert.equal(stale[0].releasedBy, "4a3c3a",
      "and it records WHICH dependency had already released it - that is the actionable half");
  });

  test("a genuinely-waiting block is NOT labelled stale", () => {
    // The false positive that would make this label worthless on its first day. If a correctly
    // blocked card were labelled stale, people would stop reading the label, and then the real
    // one would be missed too.
    const m = build({
      backlog: [],
      doing: [card("314618")],
      blocked: [card("bbbb18", { depends_on: ["314618"], block_reason: "waiting" })],
    });
    assert.equal(m.blockedOldest.stale.length, 0, "314618 is not done, so the wait is real");
    assert.equal(m.blockedOldest.noEdge.length, 0);
  });

  test("SEVERAL finished dependencies still release it", () => {
    const m = build({
      backlog: [],
      done: [card("d1"), card("d2")],
      blocked: [card("x", { depends_on: ["d1", "d2"] })],
    });
    assert.equal(m.blockedOldest.stale.length, 1);
    assert.equal(m.blockedOldest.stale[0].releasedBy, "d1,d2",
      "every one of them is named, so the card can be re-pointed in one step");
  });

  test("a block waiting on BOTH a done and an unfinished card is NOT stale", () => {
    const m = build({
      backlog: [],
      done: [card("d1")],
      doing: [card("d2")],
      blocked: [card("x", { depends_on: ["d1", "d2"] })],
    });
    assert.equal(m.blockedOldest.stale.length, 0,
      "one finished dependency is not a release while another is still running");
  });
});

describe("a block with no dependency at all is labelled NO-EDGE, not stale", () => {
  test("the abandonment shape is a separate label, not folded into stale", () => {
    // 1b4a3e: blocked with an empty dependency list while actually waiting on a two-test
    // experiment that existed and was running. It is a park expressed as NOTHING, which is why
    // it was indistinguishable from a card nobody came back to. Keeping it separate from `stale`
    // is the point: one is a wrong edge, the other is a missing one, and they need different
    // repairs.
    const m = build({ backlog: [], doing: [], done: [], blocked: [card("1b4a3e")] });
    assert.equal(m.blockedOldest.stale.length, 0, "no dependency is not a stale edge");
    assert.equal(m.blockedOldest.noEdge.length, 1);
    assert.equal(m.blockedOldest.noEdge[0].id, "1b4a3e");
  });
});

describe("criterion 3: self-routing is NOT a defect, and this must not make it one", () => {
  test("a self-routed block with a live dependency is reported as neither stale nor no-edge", () => {
    // Five of the six live self-routed blocks are correct: a lane holding both the block and the
    // work that releases it. If this labelled them, it would replace five true next actors with
    // five invented ones, and an invented actor is indistinguishable from a real one.
    const m = build({
      backlog: [],
      doing: [card("314618")],
      blocked: [card("bbbb18", { owner: "npc-body", next_actor: "npc-body", depends_on: ["314618"] })],
    });
    const bo = m.blockedOldest;
    assert.equal(bo.stale.length, 0);
    assert.equal(bo.noEdge.length, 0,
      "a self-routed block with a live dependency is CORRECT, not an abandonment");
  });

  test("but a self-routed block with NO edge is still flagged, because the edge is the defect", () => {
    // The narrowing is about the ACTOR, not the edge. Losing the edge is the problem regardless
    // of who is named as next actor.
    const m = build({
      backlog: [], doing: [], done: [],
      blocked: [card("s1", { owner: "coord", next_actor: "coord" })],
    });
    assert.equal(m.blockedOldest.noEdge.length, 1);
  });
});

describe("it is a REPORT and never an ALERT", () => {
  test("a stale block adds NO alert, because paging about a bookkeeping error trains people to ignore alerts", () => {
    const m = build({
      backlog: [],
      doing: [card("4a3c3a", { status: "done" })],
      blocked: [card("e48dd5", { depends_on: ["4a3c3a"], block_reason: "waiting" })],
    });
    const ids = (m.alerts || []).map((a) => a.id);
    assert.ok(!ids.some((id) => /stale_block|released_block/.test(id)),
      `the label must not page; alerts were ${JSON.stringify(ids)}`);
  });

  test("and an UNKNOWN dependency is not assumed done", () => {
    // The false positive that would make the label worse than nothing: a dependency id that is
    // not in the board is UNKNOWN, and treating unknown as done labels a correctly-blocked card
    // as stale. Whoever reads the label would then be told to release a real wait.
    const m = build({
      backlog: [], doing: [], done: [],
      blocked: [card("x", { depends_on: ["id-that-is-not-on-the-board"] })],
    });
    assert.equal(m.blockedOldest.stale.length, 0,
      "an absent dependency is not a finished one");
  });

  test("a card with NO depends_on field at all does not throw", () => {
    const m = build({ backlog: [], doing: [], blocked: [card("bare", { block_reason: "x" })] });
    assert.equal(m.blockedOldest.noEdge.length, 1);
    assert.equal(m.blockedOldest.stale.length, 0);
  });
});
