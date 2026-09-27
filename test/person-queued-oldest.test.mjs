import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * QUEUED CARDS POINTED AT A PERSON WERE AGED BY NOTHING.
 *
 * Coordinator measured it on the live board: all ten user decisions were status QUEUED with
 * next_actor=user, the oldest ~6.5h, and no alert had ever named one. `blocked_oldest` ages
 * blocked cards; the person-gated line counts blocked cards whose chain ends at a person;
 * `queue_age` covers backlog/doing/review only. Queued fell through all three. The board looked
 * healthy because the person-gated line DID report a count - the reporting was not wrong, it was
 * incomplete in the direction that hides.
 *
 * THE ENCODING IS CORRECT AND IS NOT BEING CHANGED. A card waiting on a person cannot be blocked
 * (blocked requires a non-done machine-readable dependency, and these are the roots). So this adds
 * a signal, it does not re-encode anything.
 *
 * THREE PROPERTIES THE ARMS BELOW PIN, each of which was a way to get this wrong:
 *   1. IT NEVER PAGES. Ten cards waiting on an owner is the correct shape of a project waiting on
 *      its owner. An alert that pages on it trains people to ignore alerts, and a human-gated wait
 *      cannot clear while an alert names it.
 *   2. ONE DECISION IS COUNTED ONCE. cd9e12 and 07e71e wait behind e135d1; reporting them as
 *      three separate waits overstates the backlog AND understates the leverage of one answer.
 *   3. THE ORDERING IS THE POINT. A count is what the person-gated line already does, and a count
 *      did not surface this. Oldest must be the actual oldest, not insertion order.
 */

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const mins = (n) => n * 60_000;
const q = (id, extra = {}) => ({
  id, title: id, owner: "lane", status: "queued", next_actor: "user",
  created: new Date(NOW - mins(600)).toISOString(), ...extra,
});
const build = (columns) =>
  buildCoordinatorMetrics({ board: { columns }, now: NOW, deliveredState: { delivered: {} } });
const alert = (m) => m.alerts.find((a) => a.id === "person_queued_oldest");

test("THE GAP: a person-gated QUEUED card is now named, and it was invisible before", () => {
  const m = build({ queued: [q("e135d1")] });
  const a = alert(m);
  assert.ok(a, "a queued card waiting on a person must produce a signal");
  assert.equal(a.oldestDecisionId, "e135d1");
  assert.equal(a.decisionCount, 1);
  assert.ok(a.oldestAgeMs >= mins(590), `aged from its own state clock, got ${a.oldestAgeMs}`);
});

test("IT NEVER PAGES - a person waiting is not a delivery failure", () => {
  // Even absurdly old. The severity is a property of the CLASS, not of the number: a human-gated
  // wait resolves only through a person acting, so raising its severity trains people to ignore
  // the alerts that can be acted on.
  const ancient = build({ queued: [q("old", { created: new Date(NOW - mins(60 * 24 * 30)).toISOString() })] });
  assert.equal(alert(ancient).severity, "warning",
    "thirty days of waiting on an owner must not become a page");
});

test("ONE DECISION IS COUNTED ONCE: cards behind the same root are grouped under it", () => {
  // e135d1 <- 07e71e <- cd9e12, exactly the live shape. Two cards behind the root must not
  // inflate the decision count, and the root must be what is ranked.
  const m = build({
    queued: [
      q("e135d1", { created: new Date(NOW - mins(390)).toISOString() }),
      q("07e71e", { next_actor: null, depends_on: ["e135d1"], created: new Date(NOW - mins(380)).toISOString() }),
      q("cd9e12", { next_actor: null, depends_on: ["07e71e"], created: new Date(NOW - mins(370)).toISOString() }),
    ],
  });
  const a = alert(m);
  assert.equal(a.decisionCount, 1, "one answer is one decision however many cards wait on it");
  assert.equal(a.waitingCardCount, 3, "all three cards are still reported as waiting");
  assert.equal(a.oldestDecisionId, "e135d1", "and the root is what gets ranked");
});

test("THE ORDERING IS THE POINT: oldest is the oldest, not the first seen", () => {
  const m = build({
    queued: [
      q("young", { created: new Date(NOW - mins(105)).toISOString() }),
      q("ancient", { created: new Date(NOW - mins(393)).toISOString() }),
    ],
  });
  const a = alert(m);
  assert.equal(a.oldestDecisionId, "ancient", "a 6.5h decision outranks a 105m one");
  assert.deepEqual(a.decisions.map((d) => d.root.id), ["ancient", "young"], "and the list is ranked");
});

test("A QUEUED CARD A LANE CAN PICK UP IS NOT A PERSON WAIT", () => {
  // The whole point of splitting the bucket. Reporting lane-runnable work as "waiting on a person"
  // would be a false claim about a card somebody could have started an hour ago.
  assert.equal(alert(build({ queued: [q("lane-work", { next_actor: "agsuite-dev" })] })), undefined);
  assert.equal(alert(build({ queued: [q("unowned", { next_actor: null })] })), undefined,
    "no pointer and no chain to a person is not a person wait");
});

test("AN UNKNOWN DEPENDENCY DOES NOT BECOME A PERSON WAIT", () => {
  // A dependency may legitimately precede its target. Assuming "waiting on a person" because a
  // link dangles would demote real lane-actionable work into a count nobody acts on.
  assert.equal(alert(build({ queued: [q("x", { next_actor: null, depends_on: ["never-created"] })] })), undefined);
});

test("A DEPENDENCY CYCLE TERMINATES rather than recursing forever", () => {
  const m = build({
    queued: [q("c1", { next_actor: null, depends_on: ["c2"] }), q("c2", { next_actor: null, depends_on: ["c1"] })],
  });
  assert.equal(alert(m), undefined, "a cycle is not a person-gated chain, and must not hang the metrics build");
});

test("THE SIGNAL REACHES A HUMAN: the bridge doorbell list must name it", () => {
  // Found by reading the bridge after shipping the alert, which is the wrong order - this arm
  // should have existed first. The bridge selects ONE alert by a hardcoded id set, and mine was
  // `warning` so it could never win the `severity === "critical"` find. The alert existed, was
  // correct, passed every test above, and would never have been shown to anybody.
  //
  // A signal in the payload that no reader is shown is the same failure as the TASK_FLAGS comment
  // that described a capability the handler did not have: a claim in the artifact about what the
  // artifact does, one layer up. Tests on the producer cannot catch it - the producer was right.
  const bridge = fs.readFileSync(path.join(HERE, "..", "src", "bridge.mjs"), "utf8");
  const list = bridge.slice(bridge.indexOf("DOORBELL_ALERT_IDS = ["), bridge.indexOf("];", bridge.indexOf("DOORBELL_ALERT_IDS = [")));
  assert.ok(list.includes("person_queued_oldest"),
    "an alert nobody is shown is not delivered, however correct the payload is");
  assert.ok(bridge.includes('alert.severity === "critical"'),
    "and it must still lose to a genuine critical, or a person-wait outranks real work");
});
