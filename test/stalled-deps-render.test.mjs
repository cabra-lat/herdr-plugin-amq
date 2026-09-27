import test from "node:test";
import assert from "node:assert/strict";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

/**
 * A STALL ALERT MUST SHOW WHAT IS STILL GATING A CARD, NOT MERELY WHAT IT POINTS AT.
 *
 * `stalled_work` printed `dependency=${JSON.stringify(card.dependency || null)}` and the stalled
 * projection had NO `dependency` key - the blocked projection had one, the stalled one did not.
 * `|| null` cannot tell a missing key from a null value, so the render turned a MISSING FIELD
 * into an authoritative "this card has no dependencies" and three cards carrying live edges were
 * displayed as unencumbered. It is the same defect as the `stage=undefined` bug recorded inside
 * the projection itself, reached by the same route: one projection has a field its sibling lacks.
 *
 * Printing the real edge would have been only half a fix, and a fix that makes the output WORSE.
 * All three of the observed cards depend on cards that are DONE, so a satisfied edge printed
 * beside a stall alert invites the reader to conclude the work is blocked when it is runnable.
 * "deps all satisfied" is the most useful thing this alert can say, because it separates work
 * nobody started from work nobody could start - and the alert previously could not tell them
 * apart at all.
 *
 * Every arm pins a DISTINCT state, because collapsing any two of them is the bug in a new place.
 */

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const mins = (n) => n * 60_000;
const card = (id, extra = {}) => ({
  id, title: id, owner: "lane", status: "in_progress",
  created: new Date(NOW - mins(600)).toISOString(),
  status_at: new Date(NOW - mins(200)).toISOString(),
  updated: new Date(NOW - mins(200)).toISOString(),
  ...extra,
});
const build = (columns) =>
  buildCoordinatorMetrics({
    board: { columns },
    now: NOW,
    deliveredState: { delivered: {} },
    thresholds: { stallWarnMs: mins(60), stallCriticalMs: mins(400) },
  });
const stalled = (m) => m.alerts.find((a) => a.id === "stalled_work")?.cards || [];

test("THE DEFECT: a stalled card WITH a live edge is not projected as having none", () => {
  const m = build({
    doing: [card("waiting", { depends_on: ["gate"] })],
    blocked: [card("gate", { status: "blocked" })],
  });
  const c = stalled(m).find((x) => x.id === "waiting");
  assert.ok(c, "the card is reported as stalled");
  assert.ok(Array.isArray(c.dependency), "the projection CARRIES the edge");
  assert.deepEqual(c.unmetDependencies.map((d) => d.id), ["gate"]);
  assert.equal(c.depsAllSatisfied, false);
});

test("THE HALF-FIX THAT WOULD HAVE BEEN WRONG: satisfied deps say so, not 'you are blocked'", () => {
  const m = build({
    doing: [card("runnable", { depends_on: ["finished"] })],
    done: [card("finished", { status: "done" })],
  });
  const c = stalled(m).find((x) => x.id === "runnable");
  assert.equal(c.depsAllSatisfied, true, "every edge is done");
  assert.deepEqual(c.unmetDependencies, [], "and nothing is gating it");
  // The edge is still reported, so "all satisfied" is checkable rather than a bare reassurance.
  assert.equal(c.dependencyStates.length, 1);
});

test("ZERO edges is NOT 'all satisfied' - it is the blocked-on-nobody case", () => {
  // Conflating these would report a card with no edges as a card whose edges are fine, which is
  // the same collapse one level up.
  const m = build({ doing: [card("lonely", {})] });
  const c = stalled(m).find((x) => x.id === "lonely");
  assert.equal(c.depsAllSatisfied, false, "no edges cannot be satisfied edges");
  assert.deepEqual(c.dependencyStates, []);
});

test("an UNKNOWN dependency counts as UNMET, never as satisfied", () => {
  // A dependency may legitimately precede its target and not exist yet. Treating that as
  // satisfied would clear a card on the strength of a dangling link.
  const m = build({ doing: [card("dangling", { depends_on: ["not-yet"] })] });
  const c = stalled(m).find((x) => x.id === "dangling");
  assert.deepEqual(c.unmetDependencies.map((d) => d.status), ["unknown"]);
  assert.equal(c.depsAllSatisfied, false);
});

test("a MIX is reported per-edge, so the reader sees which one still bites", () => {
  const m = build({
    doing: [card("mixed", { depends_on: ["done-one", "live-one"] })],
    done: [card("done-one", { status: "done" })],
    review: [card("live-one")],
  });
  const c = stalled(m).find((x) => x.id === "mixed");
  assert.deepEqual(c.unmetDependencies.map((d) => d.id), ["live-one"]);
  assert.equal(c.depsAllSatisfied, false);
});

test("THE CONTROL: a card that was never stalled is not in the list at all", () => {
  // Otherwise "the projection now carries dependency" could be satisfied by a list that reports
  // everything, which is a different and worse alert.
  //
  // Both clocks have to be fresh, not just `updated`: this alert deliberately ages the card's
  // STATE clock, so a card whose status_at is 200 minutes old is stalled even if something
  // touched `updated` two minutes ago. My first version of this arm refreshed only `updated` and
  // the card was reported - correctly, on the documented clock. The arm was wrong, not the code.
  const fresh = new Date(NOW - mins(2)).toISOString();
  const m = build({ doing: [card("fresh", { updated: fresh, status_at: fresh })] });
  assert.equal(m.alerts.find((a) => a.id === "stalled_work"), undefined);
});

test("a card with a reason is unaffected - the projection still carries it", () => {
  const m = build({ doing: [card("triaged", { block_reason: "waiting on a capture" })] });
  const c = stalled(m).find((x) => x.id === "triaged");
  assert.equal(c.reason, "waiting on a capture");
});
