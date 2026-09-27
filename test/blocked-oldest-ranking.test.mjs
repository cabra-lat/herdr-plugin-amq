import test from "node:test";
import assert from "node:assert/strict";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

/**
 * blocked_oldest RANKS WHAT A LANE CAN MOVE, AND COUNTS WHAT ONLY A PERSON CAN.
 *
 * The alert was permanently pinned. On the 2026-09-27 board, 4 of 10 blocked cards carried
 * next_actor=user and the oldest of those was the oldest overall, so the alert named a card
 * blocked on a human decision. That card resolves ONLY through a person acting - and when a
 * person acts the card leaves blocked. So the alert named the same card on every future firing
 * and could not clear while it existed. An alert with exactly one possible exit is not
 * measuring anything.
 *
 * WORSE THAN NOISE, and this is the argument for the change rather than against the alert: it
 * reports a correctly-encoded human wait with the same urgency it would report a stale edge to
 * a finished card. The lanes that learn to ignore it are exactly the lanes that would have
 * caught the real ones.
 *
 * THIS IS A CHANGE OF RANKING, NOT A SUPPRESSION. Suppressing on age would hide a genuinely
 * stale edge, because a card blocked on a finished dependency lands in the same bucket as a
 * card blocked on a person and only next_actor distinguishes them.
 */

const NOW = 1_800_000_000_000;
const card = (id, extra = {}) => ({
  id, title: `card ${id}`, owner: "agsuite-dev", created: NOW - 60_000, updated: NOW - 60_000, ...extra,
});
const build = (columns) =>
  buildCoordinatorMetrics({ board: { columns }, now: NOW, deliveredState: { delivered: {} } });
const alert = (m, id = "blocked_oldest") => m.alerts.find((a) => a.id === id);
const mins = (n) => n * 60_000;

test("a human-gated card does NOT take the headline from a lane-actionable one", () => {
  const m = build({
    blocked: [
      card("human", { next_actor: "user", blocked_at: new Date(NOW - mins(261)).toISOString() }),
      card("lane", { next_actor: "verifier", blocked_at: new Date(NOW - mins(38)).toISOString() }),
    ],
  });
  const a = alert(m);
  assert.equal(a.oldestCardId, "lane", "the 38-minute lane item is the real one");
  assert.equal(a.oldestAgeMs, mins(38));
  // The wording changed when actionability moved from the pointer to the dependency CHAIN. The
  // card below still has next_actor=user, so it is still human-gated - but the alert now says
  // WHY it is human-gated in terms a reader can check, and the assertion checks the new words so
  // a revert to pointer-based gating fails here rather than passing on a stale regex.
  assert.match(a.message, /1 blocked card\(s\) have a dependency chain terminating in a person-gated card/);
  assert.match(a.message, /reported as a count, not ranked/);
});

test("THE CONTROL: a human-gated card is STILL REPORTED, not suppressed", () => {
  // The distinction that matters. If the human card vanished from the payload entirely, this
  // would be a suppression wearing a ranking's clothes - and coordinator's argument against
  // suppression is precisely that it hides the real defects.
  const m = build({
    blocked: [card("human", { next_actor: "user", blocked_at: new Date(NOW - mins(261)).toISOString() })],
  });
  const a = alert(m);
  assert.equal(a.humanGatedCount, 1);
  assert.equal(a.humanGatedOldestAgeMs, mins(261));
});

test("when nothing is lane-actionable, the alert says GOOD NEWS rather than breaking", () => {
  const m = build({
    blocked: [card("human", { next_actor: "user", blocked_at: new Date(NOW - mins(261)).toISOString() })],
  });
  assert.match(alert(m).message, /good news, not a broken alert/);
  assert.equal(alert(m).oldestCardId, null, "and it does not name a card it cannot rank");
});

test("a human wait cannot PIN the fingerprint, so the alert can self-clear", () => {
  // The pinning was mechanical: the fingerprint was built from the ranked cards, and the ranked
  // card was the human one. Ageing it, re-owning it or resolving it must not re-fire the alert,
  // or the exit condition is "the alert goes away" and there is no other.
  const human = (id, at) => card(id, { next_actor: "user", blocked_at: new Date(at).toISOString() });
  const one = build({ blocked: [human("h1", NOW - mins(261))] });
  const two = build({ blocked: [human("h1", NOW - mins(900))] });
  assert.equal(alert(one).fingerprint, alert(two).fingerprint,
    "a human wait ageing must not change the alert's identity");
});

test("a REAL lane-actionable change DOES change the fingerprint", () => {
  // Without this arm the arm above is trivially satisfiable by a constant.
  const lane = (id) => card(id, { next_actor: "verifier", blocked_at: new Date(NOW - mins(38)).toISOString() });
  assert.notEqual(alert(build({ blocked: [lane("l1")] })).fingerprint,
    alert(build({ blocked: [lane("l2")] })).fingerprint);
});

test("a human-gated card does not inflate severity", () => {
  // The same class of bug the `owned`/`unowned` split already fixed once: a card a human owns
  // must not be able to escalate the severity of a page a lane owns.
  //
  // The lane card sits BETWEEN blockedWarnMs (10min) and blockedCriticalMs (30min) on purpose. My
  // first version used 38 minutes, which is already past critical, so `critical` was the correct
  // answer and my assertion failed for a reason the thresholds do not control - the sixth time
  // tonight an arm of mine has been wrong that way. To PROVE the human card is not escalating
  // anything, the baseline severity must be one the lane card earns on its own.
  const m = build({
    blocked: [
      card("human", { next_actor: "user", blocked_at: new Date(NOW - mins(6000)).toISOString() }),
      card("lane", { next_actor: "verifier", blocked_at: new Date(NOW - mins(12)).toISOString() }),
    ],
  });
  assert.equal(alert(m).severity, "warning",
    "a 100-hour human wait must not escalate a 12-minute lane blocker to critical");
  assert.equal(alert(m).oldestAgeMs, mins(12), "and the age quoted is the lane card's");
});
