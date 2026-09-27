import test from "node:test";
import assert from "node:assert/strict";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

/**
 * LANE-ACTIONABILITY COMES FROM THE DEPENDENCY CHAIN, NOT FROM next_actor.
 *
 * The convention is settled: next_actor means WHO MUST ACT FOR THE CARD TO ADVANCE, owner means
 * who does the work. But a settled convention is not a reliable field. `task reassign` does not
 * maintain next_actor - it moved owner and left the pointer alone - so a re-pointed card keeps
 * pointing at whoever it used to wait for. An alert that reads the pointer therefore pages on a
 * card no lane can move.
 *
 * The two failure modes are independent, which is why this is not redundancy: a HUMAN can
 * misread next_actor, and the VERB can corrupt it. The chain answers the question the alert
 * actually asks - can anyone move this card right now - and it stays right when the pointer is
 * stale, wrong, or absent.
 *
 * Every arm below is built so that the pointer and the chain DISAGREE, because a test where they
 * agree cannot tell which one the code consulted.
 */

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const mins = (n) => n * 60_000;
const card = (id, extra = {}) => ({
  id, title: id, owner: "lane", status: "blocked", created: new Date(NOW - mins(600)).toISOString(),
  blocked_at: new Date(NOW - mins(30)).toISOString(), ...extra,
});
const build = (columns) =>
  buildCoordinatorMetrics({ board: { columns }, now: NOW, deliveredState: { delivered: {} } });
const alert = (m) => m.alerts.find((a) => a.id === "blocked_oldest");

test("a person pointer is NOT overridden by a shallow lane dependency", () => {
  // I first wrote this arm backwards: I expected a card with next_actor=user and no
  // dependencies to stay actionable, on the theory that next_actor is display-only. That is
  // wrong, and the code was right. A card with no dependencies has a chain of exactly itself, so
  // a chain that terminates in a person IS a person-gated card, and treating it as actionable
  // would page on a card that is genuinely waiting for a human. "Display-only" cannot mean
  // "ignored": it means the chain decides, and the chain starts at the card.
  //
  // What the pointer genuinely cannot do is RESCUE a card whose chain reaches a person - arm 2 -
  // and that is the defect reassign could cause. So the invariant is directional.
  const m = build({
    blocked: [card("shallow", { next_actor: "user", depends_on: ["lane-work"] })],
    doing: [card("lane-work", { next_actor: "range" })],
  });
  const a = alert(m);
  assert.equal(a.humanGatedCount, 1, "the card says user, so its chain terminates at a person");
  assert.equal(a.oldestCardId, null, "and it is not ranked as lane-actionable");
});

test("and a card with NO pointer and no dependency is not mistaken for a person-gated one", () => {
  // The other direction, so the walk cannot pass the first arm by simply always returning true.
  const m = build({ blocked: [card("bare", {}), card("real", { next_actor: "qa", blocked_at: new Date(NOW - mins(90)).toISOString() })] });
  assert.equal(alert(m).humanGatedCount, 0, "no pointer and no chain is not a person");
  assert.equal(alert(m).unownedBlockedCount, 1, "it is blocked on nobody");
});

test("THE OPPOSITE: a pointer naming a LANE does not rescue a card behind a person", () => {
  // The other direction, and the reason the chain is walked rather than trusted in place. Here
  // the pointer says a lane can move it, but it waits on a card that waits on a person.
  const m = build({
    blocked: [card("behind", { next_actor: "verifier", depends_on: ["gate"], blocked_at: new Date(NOW - mins(200)).toISOString() })],
    doing: [card("gate", { next_actor: "user" })],
  });
  const a = alert(m);
  assert.equal(a.humanGatedCount, 1, "the chain reaches a person, so the card is human-gated");
  assert.equal(a.oldestCardId, null, "and cannot take the lane-actionable headline");
});

test("the chain is walked TRANSITIVELY, not one hop", () => {
  const m = build({
    blocked: [card("c", { next_actor: "range", depends_on: ["b"] })],
    doing: [card("b", { next_actor: "qa", depends_on: ["a"] })],
    queued: [card("a", { next_actor: "user" })],
  });
  assert.equal(alert(m).humanGatedCount, 1, "two hops from a person is still human-gated");
});

test("an UNKNOWN dependency does not prove human-gated - a dangling link stays actionable", () => {
  // Assuming "blocked on a person" because a link dangles would demote real defects into a
  // count, which is the failure this whole split exists to prevent. A dependency may
  // legitimately precede its target and not exist yet.
  const m = build({ blocked: [card("dangling", { next_actor: "verifier", depends_on: ["not-created-yet"] })] });
  assert.equal(alert(m).humanGatedCount, 0);
  assert.equal(alert(m).oldestCardId, "dangling");
});

test("a DEPENDENCY CYCLE does not hang the walk", () => {
  // A cycle is a malformed board, not an impossible one; the walk must terminate rather than
  // recurse until the stack gives out, because a hang in the metrics builder takes down the
  // whole coordinator view rather than one alert.
  const m = build({ blocked: [card("x", { next_actor: "qa", depends_on: ["y"] }), card("y", { next_actor: "qa", depends_on: ["x"] })] });
  assert.equal(alert(m).humanGatedCount, 0, "a cycle of lane cards is not a person");
});

test("a card with a LANE dependency is actionable even with no next_actor of its own", () => {
  // "Blocked on nobody" must stay narrower than "has no next_actor": a card waiting behind a
  // lane card is movable by moving that card, and calling it nobody's problem hides a real edge.
  const m = build({ blocked: [card("nodep", { depends_on: ["work"] })], doing: [card("work", { next_actor: "range" })] });
  assert.equal(alert(m).oldestCardId, "nodep", "a lane dependency makes it actionable");
  assert.equal(alert(m).unownedBlockedCount, 0, "and it is not 'blocked on nobody'");
});

test("and a card with NEITHER a pointer NOR a dependency is still 'blocked on nobody'", () => {
  const m = build({ blocked: [card("lonely", {}), card("real", { next_actor: "qa", blocked_at: new Date(NOW - mins(90)).toISOString() })] });
  assert.equal(alert(m).unownedBlockedCount, 1);
  assert.match(alert(m).message, /blocked on nobody/);
});

test("THE CONTROL: the chain is consulted, not the pointer - both agree and the answer is human", () => {
  // If the code read the pointer, this arm would also pass; it is here so a future change that
  // breaks the CHAIN has an arm that only the chain can satisfy, which is arm 2.
  const m = build({ blocked: [card("agree", { next_actor: "user" })] });
  assert.equal(alert(m).humanGatedCount, 1);
  assert.match(alert(m).message, /good news, not a broken alert/);
});
