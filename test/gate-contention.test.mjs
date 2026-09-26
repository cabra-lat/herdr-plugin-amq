import test from "node:test";
import assert from "node:assert/strict";
import { classifyContention, readLoadavg } from "../src/job-queue.mjs";

// A single loadavg reading describes the box BEFORE the work. loadavg is damped, so
// the honest measurement is a PAIR - one at start, one at exit - and the verdict
// comes from the pair, not from either end of it.
const sample = (one, cores = 4) => ({ one, five: one, fifteen: one, cores, perCore: Number((one / cores).toFixed(3)) });

test("a timeout on a quiet host is a hang, and a hang is a finding", () => {
  const verdict = classifyContention(sample(0.4), sample(0.6));
  assert.equal(verdict.classification, "uncontended");
  // The pair, not one reading: a job that loaded the box itself must not read clean.
  assert.match(verdict.reason, /at both ends/);
});

test("a host busy at both ends is contention-limited, not a finding about the job", () => {
  const verdict = classifyContention(sample(12.0), sample(14.0));
  assert.equal(verdict.classification, "contention-limited");
  assert.match(verdict.reason, /high at both ends/);
});

test("quiet at start and busy at exit is the case a single reading would miss", () => {
  // This is the exact failure the pair exists to catch: a start-only reading records
  // 0.4 and calls the host healthy, when the job itself ran the box to 14.
  const start = sample(0.4);
  const exit = sample(14.0);
  assert.ok(start.perCore < 0.5, "the start reading alone looks healthy");
  const verdict = classifyContention(start, exit);
  assert.equal(verdict.classification, "contention-limited");
  assert.match(verdict.reason, /quiet at start/);
  // And a start-only implementation would have said "uncontended" here, which is the
  // wrong answer this test exists to prevent.
  assert.notEqual(verdict.classification, "uncontended");
});

test("busy at start and quiet at exit is reported as its own state, not as clean", () => {
  const verdict = classifyContention(sample(9.0), sample(0.2));
  assert.equal(verdict.classification, "started-contended");
  assert.notEqual(verdict.classification, "uncontended");
});

test("classification never changes the pass/fail verdict, only its description", () => {
  // The whole point of the rule the coordinator adopted: a rule that suppresses sound
  // results to defend an unsound one is worse than no rule. Nothing here may mark a
  // job failed or passed - it only ever annotates.
  for (const [s, e] of [[sample(0.1), sample(0.1)], [sample(20), sample(20)], [sample(0.1), sample(20)]]) {
    const verdict = classifyContention(s, e);
    assert.deepEqual(Object.keys(verdict).sort(), ["classification", "reason"]);
    assert.equal(typeof verdict.classification, "string");
    assert.equal(verdict.passed, undefined);
    assert.equal(verdict.ok, undefined);
  }
});

test("per-core is the comparable number, because 1.0 means different things per host", () => {
  const four = sample(4.0, 4);
  const sixtyFour = sample(4.0, 64);
  assert.equal(four.perCore, 1);
  assert.equal(sixtyFour.perCore, 0.063);
  // The same 1-minute reading is a fully-saturated 4-core box and an idle 64-core one.
  assert.notEqual(four.perCore, sixtyFour.perCore);
});

test("an unavailable loadavg is admitted, not guessed at", () => {
  const verdict = classifyContention(null, null);
  assert.equal(verdict.classification, null);
  assert.match(verdict.reason, /unavailable/);
});

test("readLoadavg reports the raw readings and a core count", () => {
  const load = readLoadavg();
  assert.ok(load, "/proc/loadavg must be readable on this host");
  assert.equal(typeof load.one, "number");
  assert.equal(typeof load.five, "number");
  assert.equal(typeof load.fifteen, "number");
  assert.ok(load.cores >= 1, "a core count of zero would make perCore infinite");
  assert.equal(load.perCore, Number((load.one / load.cores).toFixed(3)));
});
