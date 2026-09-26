// The alert's RENDER must tell the truth about ownership.
//
// Found by the coordinator against live data: they cleared next_actor on a blocked card,
// read it back as null, and the very next alert rendered that card as
// `next-actor=player-rig` - the card's OWNER. The render was falling back to owner
// whenever next_actor was empty.
//
// This is the same defect as an alert that contradicts state you have just verified: a
// display asserting something the underlying state does not contain. And it is worse than
// cosmetic here, because the next_actor split is precisely the rule that a blocked card
// with no next actor has no actor. If the render manufactures an owner, the split looks
// like it did nothing even when the predicate is correct - and "the change appears not to
// work" is exactly the conclusion a reader will draw.
//
// The red arm is the RENDER, not the predicate. Silencing the metric while leaving the
// render lying still passes a predicate-only test.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildCoordinatorAlertPrompt } from "../src/bridge.mjs";

const alert = (card) => ({
  id: "blocked_oldest",
  severity: "warning",
  message: "oldest blocked card",
  recommendedAction: "resolve or re-scope",
  cards: [{ id: "t1", ageMs: 3000000, owner: "player-rig", nextActor: card.nextActor, reason: "x" }],
});

describe("coordinator alert render: owner is not a next actor", () => {
  test("an unowned blocked card must NOT render its owner as the next actor", () => {
    const text = buildCoordinatorAlertPrompt(alert({ nextActor: null }));
    const line = text.split("\n").find((l) => l.includes("- t1:"));
    assert.ok(line, "the card must appear in the triage snapshot");
    assert.ok(
      !/next-actor=player-rig/.test(line),
      `the render invented a next actor from the owner: ${line}`
    );
    assert.match(line, /next-actor=none/, `an absent next actor must be stated, not omitted: ${line}`);
  });

  test("the owner is still reported, just not as the next actor", () => {
    // Nothing may be lost by telling the truth: owner and next actor are separate facts
    // and both belong on the line.
    const line = buildCoordinatorAlertPrompt(alert({ nextActor: null }))
      .split("\n")
      .find((l) => l.includes("- t1:"));
    assert.match(line, /owner=player-rig/);
  });

  test("a real next actor renders as itself", () => {
    const line = buildCoordinatorAlertPrompt(alert({ nextActor: "spotter" }))
      .split("\n")
      .find((l) => l.includes("- t1:"));
    assert.match(line, /next-actor=spotter/);
  });

  test("an EMPTY STRING next actor is also absent, not borrowed from owner", () => {
    // `""` is falsy but is not null; a render that tests only `null` would leak here.
    const line = buildCoordinatorAlertPrompt(alert({ nextActor: "" }))
      .split("\n")
      .find((l) => l.includes("- t1:"));
    assert.ok(!/next-actor=player-rig/.test(line), `empty string must not fall back to owner: ${line}`);
  });

  test("a card with neither owner nor next actor states both honestly", () => {
    const text = buildCoordinatorAlertPrompt({
      ...alert({ nextActor: null }),
      cards: [{ id: "t2", ageMs: 1000, reason: "x" }],
    });
    const line = text.split("\n").find((l) => l.includes("- t2:"));
    assert.match(line, /owner=unknown/);
    assert.match(line, /next-actor=none/);
  });
});

// Found by the coordinator against live data, and it is the SAME defect as the missing
// `stage` on the stalled projection: the BLOCKED projection carried the field and the
// STALLED one did not, so the two alerts disagreed about the same underlying field and
// only one of them read it.
//
// The consequence was worse than a missing field. The render prints
// "next-actor=none (blocked on nobody)" whenever the field is empty, so seven stalled
// cards were asserting something false about themselves - three of them with a live actor
// recorded on the task (01ba6d -> range, e5ba17 -> coordinator, 139ea1 -> player-rig) and
// four parked with next_actor=testkit. The board was right and the alert was not.
describe("stalled_work cards carry their next actor", () => {
  const projected = (over) => ({
    id: "t1", title: "t1", owner: "range", status: "in_progress", stage: "in_progress",
    created: new Date(Date.now() - 200 * 60000).toISOString(),
    updated: new Date(Date.now() - 126 * 60000).toISOString(),
    ...over,
  });

  test("the stalled projection carries nextActor, so the render does not invent an absence", async () => {
    const { buildCoordinatorMetrics } = await import("../src/metrics.mjs");
    const now = Date.now();
    const m = buildCoordinatorMetrics({
      handles: ["range"], agentStatuses: { range: "working" },
      board: { columns: { backlog: [], queued: [], in_progress: [projected({ next_actor: "coordinator" })], blocked: [], done: [] } },
      jobQueue: { queueDepth: 0, active: 0, concurrency: { current: 0, max: 1 }, outcomes: {} },
      now,
    });
    const card = (m.stalledWork || [])[0];
    assert.ok(card, "the card is well past the threshold");
    assert.equal(card.nextActor, "coordinator", "a live actor must survive the projection, or the render calls it absent");
  });

  test("a genuinely unowned card reports null, which is NOT the same as the key being absent", async () => {
    const { buildCoordinatorMetrics } = await import("../src/metrics.mjs");
    const m = buildCoordinatorMetrics({
      handles: ["range"], agentStatuses: { range: "working" },
      board: { columns: { backlog: [], queued: [], in_progress: [projected()], blocked: [], done: [] } },
      jobQueue: { queueDepth: 0, active: 0, concurrency: { current: 0, max: 1 }, outcomes: {} },
      now: Date.now(),
    });
    const card = (m.stalledWork || [])[0];
    assert.ok("nextActor" in card, "an absent key and a null value are different states and must be distinguishable");
    assert.equal(card.nextActor, null, "no next actor is a real, reportable state");
  });

  test("a STALLED card with no next actor does not claim to be BLOCKED on nobody", () => {
    const text = buildCoordinatorAlertPrompt({
      id: "stalled_work", severity: "warning", message: "m", recommendedAction: "r",
      cards: [{ id: "t9", ageMs: 1000, owner: "range", stage: "in_progress", nextActor: null, reason: "x" }],
    });
    const line = text.split("\n").find((l) => l.includes("- t9:"));
    assert.ok(!/blocked on nobody/.test(line), `a stalled card is not a blocked card: ${line}`);
    assert.match(line, /next-actor=none \(no next actor\)/);
  });

  test("a BLOCKED card with no next actor still says blocked on nobody", () => {
    const line = buildCoordinatorAlertPrompt({
      id: "blocked_oldest", severity: "warning", message: "m", recommendedAction: "r",
      cards: [{ id: "t8", ageMs: 1000, owner: "user", stage: "blocked", nextActor: null, reason: "x" }],
    }).split("\n").find((l) => l.includes("- t8:"));
    assert.match(line, /next-actor=none \(blocked on nobody\)/, "the blocked wording is correct for a blocked card");
  });
});
