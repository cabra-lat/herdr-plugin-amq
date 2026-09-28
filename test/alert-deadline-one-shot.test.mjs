#!/usr/bin/env node
// A DEADLINE MUST FIRE ONCE, GO TO SOMEONE WHO CAN ACT, AND NEVER RE-ANNOUNCE.
//
// The card asked for a deadline field. The verdict on it is a REFINEMENT, not a per-alert-class
// mechanism, and the test that decides admission is the coordinator's: a deadline is admissible IFF
// the alert is right AND its recommended action is UNEXECUTABLE by the audience it is addressed to.
//
// That test excludes the obvious candidate. stalled_work fired roughly 150 times in four hours and
// produced zero transitions, and it is exactly the alert a deadline would have HIDDEN rather than
// solved: its action was not unexecutable, it was UNTRUTHFUL, because every verb it offered
// asserted something the reader could not assert. A timer would have ended the noise and left the
// lie in place, and the reader would have concluded the lane had gone quiet when in fact nobody
// had been able to answer. So stalled_work is not on the list, and the liveness dimension is what
// fixed it. An alert earns a deadline by being RIGHT and UNANSWERABLE, not by being LOUD.
//
// The clock is firstAttemptAt, already stored as a monotonic stamp, so nothing new is timed. The
// coordinator's distinction is load-bearing and is the thing most likely to be got wrong later:
// age is INADMISSIBLE for suppression and ADMISSIBLE for a deadline. The fingerprint answers "is
// this new?" and must stay age-free or the dedup dies; the deadline answers "how long?".
//
// Run: node test/alert-deadline-one-shot.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/bridge.mjs", import.meta.url), "utf8");

/** Extract the function under test so it can be evaluated against real state shapes. */
function extractDeadlineFn() {
  const start = src.indexOf("function coordinatorAlertDeadline(");
  assert.ok(start >= 0, "coordinatorAlertDeadline must exist");
  let depth = 0;
  let end = start;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const body = src.slice(start, end);
  const formatAge = src.match(/function formatAge\(value\) \{[\s\S]*?\n\}/)?.[0] ?? "function formatAge(){return '?'}";
  const admissible = src.match(/const DEADLINE_ADMISSIBLE = new Set\(\[[^\]]*\]\);/)?.[0] ?? "";
  return new Function(`${admissible}\n${formatAge}\n${body}\nreturn coordinatorAlertDeadline;`)();
}

const deadline = extractDeadlineFn();
const NOW = Date.parse("2026-07-01T12:00:00Z");
const alert = (id) => ({ id, message: "m", recommendedAction: "a" });
const entryAged = (ms) => ({
  at: new Date(NOW - ms - 60_000).toISOString(),
  firstAttemptAt: new Date(NOW - ms).toISOString(),
  attempts: 3,
});

test("stalled_work is NOT deadline-admissible, however long it holds", () => {
  // The card's own loudest alert, and the one a naive implementation reaches for first.
  const r = deadline(alert("stalled_work"), entryAged(10 * 3600_000), 3600_000, NOW);
  assert.equal(r.expired, false, "a loud alert must not be silenced by a timer");
  assert.match(r.reason, /not deadline-admissible/);
});

test("an admissible alert past its deadline expires, and says how long it held", () => {
  const r = deadline(alert("retry_failure_trend"), entryAged(4 * 3600_000), 3600_000, NOW);
  assert.equal(r.expired, true, "a held, unanswerable condition must eventually escalate");
  assert.match(r.reason, /held/, "and it must say how long, which is the whole point of a deadline");
  assert.match(r.reason, /past/, "and that it is past the bound rather than merely old");
});

test("an admissible alert INSIDE its deadline does not expire", () => {
  const r = deadline(alert("retry_failure_trend"), entryAged(60_000), 3600_000, NOW);
  assert.equal(r.expired, false, "a deadline must not fire early just because the state exists");
  assert.match(r.reason, /inside the deadline/);
});

test("it fires ONCE: a fired deadline never expires again, however long it holds", () => {
  // The one-shot property, which is the entire card. A deadline that re-announces is a
  // re-announcement with a timer on it, which is what we had before and what this exists to stop.
  const fired = { ...entryAged(99 * 3600_000), deadlineFired: true };
  const r = deadline(alert("retry_failure_trend"), fired, 3600_000, NOW);
  assert.equal(r.expired, false, "once fired, never again - regardless of age");
  assert.match(r.reason, /already fired once/);
});

test("the clock is firstAttemptAt, not at - so a re-announcement cannot reset the deadline", () => {
  // If the clock were `at`, every firing would push the deadline forward and an alert firing every
  // three seconds would never expire - a deadline that cannot fire is worse than none.
  const entry = {
    at: new Date(NOW - 1000).toISOString(),           // re-announced a second ago
    firstAttemptAt: new Date(NOW - 4 * 3600_000).toISOString(),
    attempts: 400,
  };
  assert.equal(deadline(alert("retry_failure_trend"), entry, 3600_000, NOW).expired, true,
    "a chatty alert must still expire, because the bound reads the FIRST attempt");
  assert.match(src, /firstAttemptAt \|\| entry\.at/, "and the fallback may only be used when no first attempt exists");
});

test("no prior state means the clock has not started, not that the deadline passed", () => {
  const r = deadline(alert("retry_failure_trend"), null, 3600_000, NOW);
  assert.equal(r.expired, false, "a first firing cannot already be overdue");
  assert.match(r.reason, /clock has not started/);
});

test("a corrupt start stamp is refused rather than read as epoch zero", () => {
  const r = deadline(alert("retry_failure_trend"), { at: "not-a-date", firstAttemptAt: "" }, 1, NOW);
  assert.equal(r.expired, false, "an unparseable stamp must not read as very old");
  assert.match(r.reason, /parseable/);
});
