#!/usr/bin/env node
// TEST RUNS MUST NOT COMPETE FOR THE 200 SLOTS THAT HOLD REAL CARD HISTORY.
//
// The write audit retains 200 slots. For most of one session 186-190 of them held test residue, and
// real card history was being evicted to make room - task_1790520029313_38a378's log unlinked while
// its card and its 18 notes survived. 450 of 667 records in that directory carried an actor that is
// not a lane.
//
// THREE ROUNDS OF SOURCE GUARDING FAILED, and the reason is structural rather than careless. The
// first guard matched test files that import updateBoardTask; the second widened to files that
// spawn bin/herdr-amq.mjs; the third checked test/e2e/. All three read SOURCE. The writers are
// subprocesses that never import the guarded module, so a source guard is blind to them by
// construction - and each round it passed while the behaviour it guarded was still happening.
//
// The fix is a property of the RUN rather than of the writer. AMQ_TEST_RUN is set by the test
// runner and inherited by every child process, so it holds no matter which route produced the
// write. A live bridge daemon never has it set, so a real lane can never be misfiled.
//
// This does NOT classify by actor name, deliberately. null/lane/alice/o covers 450 of 667 records
// today, but worker, owner and legacy are ambiguous and a real lane could be named one of them. A
// name-based rule would be a guess that fails silently on the day a lane is called "owner".
//
// Test writes are kept in a sibling directory rather than dropped, so they remain available for
// debugging while ceasing to compete for the cap.
//
// Run: node test/test-runs-do-not-evict-real-history.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CARD_WRITES = "../src/card-writes.mjs";

// The source-level guard in state-isolation-guard.test.mjs also applies to this file, because it
// calls recordCardWrite. It uses its own temporary state dirs throughout, so isolation here is
// belt and braces rather than the mechanism - the mechanism is AMQ_TEST_RUN, which cannot be
// routed around by a subprocess.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-cw-guard-"));

function withRunEnv(value, fn) {
  const prev = process.env.AMQ_TEST_RUN;
  if (value === undefined) delete process.env.AMQ_TEST_RUN;
  else process.env.AMQ_TEST_RUN = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AMQ_TEST_RUN;
    else process.env.AMQ_TEST_RUN = prev;
  }
}

test("a normal write goes to the real audit directory", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-real-"));
  const { recordCardWrite } = await import(CARD_WRITES);
  withRunEnv(undefined, () => {
    recordCardWrite(stateDir, "task_real_0001", { status: "backlog" }, { status: "in_progress" }, { actor: "coordinator" });
  });
  assert.ok(fs.existsSync(path.join(stateDir, "card-writes", "task_real_0001.jsonl")), "a live write must land in the real audit");
  assert.equal(fs.existsSync(path.join(stateDir, "card-writes-test")), false, "and not in the test directory");
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("a write during a test run goes to the sibling directory and keeps the evidence", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-test-"));
  const { recordCardWrite } = await import(CARD_WRITES);
  withRunEnv("1", () => {
    // Actor deliberately set to a REAL lane name. The discriminator is the run, not the writer, so
    // a real handle cannot smuggle a test write into the real audit - and a test cannot be excused
    // by using a plausible actor.
    recordCardWrite(stateDir, "task_fixture_0001", { status: "backlog" }, { status: "in_progress" }, { actor: "coordinator" });
  });
  assert.ok(
    fs.existsSync(path.join(stateDir, "card-writes-test", "task_fixture_0001.jsonl")),
    "the write must be kept, in the test directory",
  );
  assert.equal(
    fs.existsSync(path.join(stateDir, "card-writes", "task_fixture_0001.jsonl")),
    false,
    "and must NOT occupy a slot in the real audit, even with a real actor name",
  );
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("the test runner sets the variable in the env it hands to children", () => {
  // The guard against the guard being decorative. If someone removes this line the variable is
  // unset for every test, every write goes to the real audit, and the whole mechanism is inert -
  // with no test failing, because the unit tests above set the variable themselves.
  const src = fs.readFileSync(new URL("../tools/run-tests.mjs", import.meta.url), "utf8");
  assert.match(src, /AMQ_TEST_RUN:\s*"1"/, "run-tests.mjs must set AMQ_TEST_RUN in the child env");
  assert.match(
    src,
    /env:\s*\{\s*\.\.\.process\.env[^}]*AMQ_TEST_RUN/s,
    "and it must be inside the env object it passes to spawn, so children inherit it",
  );
});

test("the decision is the run, not the actor - which is why it cannot be routed around", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-actor-"));
  const { recordCardWrite } = await import(CARD_WRITES);
  for (const actor of [null, "lane", "alice", "o", "coordinator", "player-rig"]) {
    withRunEnv("1", () => {
      recordCardWrite(stateDir, `task_x_${String(actor)}`, { status: "backlog" }, { status: "in_progress" }, { actor });
    });
  }
  const testDir = fs.readdirSync(path.join(stateDir, "card-writes-test")).length;
  const realDir = fs.existsSync(path.join(stateDir, "card-writes")) ? fs.readdirSync(path.join(stateDir, "card-writes")).length : 0;
  assert.equal(testDir, 6, "every actor, including a real lane, is diverted during a test run");
  assert.equal(realDir, 0, "and none of them reaches the real audit");
  fs.rmSync(stateDir, { recursive: true, force: true });
});
