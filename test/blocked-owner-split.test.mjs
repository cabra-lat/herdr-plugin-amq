// A blocked card with NO next actor is blocked on nobody, and its age is not the board's
// business to page about.
//
// The defect this fixes: blocked_oldest asked one metric to mean two different things. A
// card blocked on WORK has an owner who can move it and its age is a real warning. A
// card blocked on a DECISION that belongs to a human has no actor, and its age measures
// how long someone has been waiting. On such a card the recommended actions are all
// false: resolving is false, re-scoping is false, and recording a reason is exactly what
// has already been done - and it fires anyway.
//
// Both halves are required, and the negative half is the one that matters: a change that
// only silences is indistinguishable from a change that stops measuring. So a blocked card
// WITH a next actor must still alert, at the same threshold.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

const NOW = Date.parse("2026-09-26T18:00:00.000Z");
const MIN = 60 * 1000;
const H = 60 * MIN;

const card = (over = {}) => ({
  id: "t1",
  title: "blocked card",
  owner: "player-rig",
  status: "blocked",
  created: new Date(NOW - 3 * H).toISOString(),
  updated: new Date(NOW - 50 * MIN).toISOString(),
  blocked_at: new Date(NOW - 50 * MIN).toISOString(),
  next_actor: null,
  ...over,
});

const metrics = (cards) =>
  buildCoordinatorMetrics({
    handles: ["player-rig"],
    agentStatuses: { "player-rig": "working" },
    board: { columns: { backlog: [], doing: [], blocked: cards, done: [] } },
    jobQueue: { queueDepth: 0, active: 0, concurrency: { current: 0, max: 1 }, outcomes: {} },
    now: NOW,
  });

const alert = (m, id) => (m.alerts || []).find((a) => a.id === id);

describe("blocked_oldest: blocked on work vs blocked on a person", () => {
  test("NEGATIVE ARM: a blocked card with NO next actor does not alert", () => {
    const m = metrics([card()]);
    assert.equal(alert(m, "blocked_oldest"), undefined, "nobody can move this card, so do not page");
  });

  test("POSITIVE ARM: a blocked card WITH a next actor still alerts at the same threshold", () => {
    const m = metrics([card({ next_actor: "player-rig" })]);
    const a = alert(m, "blocked_oldest");
    assert.ok(a, "an owner can move this card, so the age is a real warning");
    assert.ok(a.oldestAgeMs >= 50 * MIN);
  });

  test("the split is structural - it does not depend on any card's identity", () => {
    // Two unowned cards, two owned cards, all at the same age: the alert must track
    // ownership, not which card it is. An exemption by name would pass the first test
    // and fail this one.
    const unowned = metrics([card({ id: "u1" }), card({ id: "u2" })]);
    assert.equal(alert(unowned, "blocked_oldest"), undefined, "two unowned cards, still silent");
    const mixed = metrics([card({ id: "u1" }), card({ id: "o1", next_actor: "qa" })]);
    assert.ok(alert(mixed, "blocked_oldest"), "one owned card is enough to alert");
    assert.equal(alert(mixed, "blocked_oldest").unownedBlockedCount, 1, "and the unowned one is still counted");
  });

  test("an unowned blocked card is REPORTED, not merely dropped", () => {
    // A card that stopped alerting and a card that was never evaluated must not look the
    // same - that is the whole point of a report-only classification.
    const m = metrics([card({ id: "u1" })]);
    assert.equal(m.unownedBlockedCount, 1, "silence must still be readable");
    assert.equal(m.unownedBlocked[0].oldestId, "u1");
    assert.ok(m.unownedBlocked[0].oldestAgeMs >= 50 * MIN, "and it must carry the age that was not alerted on");
  });

  test("ownership, not triage, decides - a reason alone still alerts when owned", () => {
    const m = metrics([card({ next_actor: "qa", block_reason: "triaged and waiting on qa" })]);
    assert.ok(alert(m, "blocked_oldest"), "a reason is not a substitute for an owner");
  });

  test("an unowned card does not make the alert fire by dragging the max age", () => {
    // The failure mode a threshold bump invites: the unowned card's age must not be
    // borrowed by the owned metric.
    const m = metrics([card({ id: "old-unowned" }), card({ id: "young-owned", next_actor: "qa", blocked_at: new Date(NOW - 5 * MIN).toISOString(), updated: new Date(NOW - 5 * MIN).toISOString() })]);
    const a = alert(m, "blocked_oldest");
    if (a) assert.ok(a.oldestAgeMs < 50 * MIN, "an unowned card's 50 minutes must not be attributed to the owned one");
    assert.equal(m.unownedBlockedCount, 1);
  });
});
