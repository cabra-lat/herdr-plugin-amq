// The per-card write log is the instrument the stall threshold has been missing.
//
// A card stores only its LATEST `updated`, so the interval between writes to a specific
// card is destroyed on the first write. These tests pin the properties that make the
// resulting distribution usable - and, critically, that a no-op write is not counted,
// because the log exists to measure progress and a no-op is not progress.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordCardWrite, readCardWrites, cardTransitionIntervals } from "../src/card-writes.mjs";
import { addBoardTask, updateBoardTask } from "../src/board.mjs";
// THESE TESTS EXERCISE THE PRODUCTION AUDIT PATH, so the run-level diversion is switched off
// here on purpose. run-tests.mjs sets AMQ_TEST_RUN so the suite writes to a sibling directory
// instead of evicting real card history; a test whose subject IS the real directory has to turn
// that off deliberately rather than assert against the wrong place.
delete process.env.AMQ_TEST_RUN;


let stateDir;
describe("card write log", () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cardwrites-"));
  const ev = (o = {}) => ({ updated: "2026-01-01T00:00:00.000Z", status: "in_progress", owner: "qa", ...o });
  const at = (n) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + n * 60000).toISOString();

  test("a write records the fields that actually changed", () => {
    recordCardWrite(stateDir, "card_a", ev(), ev({ status: "blocked" }), { actor: "coordinator", at: at(1) });
    const [e] = readCardWrites(stateDir, "card_a");
    assert.deepEqual(e.fields, ["status"]);
    assert.deepEqual(e.transitions, ["status"]);
    assert.equal(e.actor, "coordinator");
  });

  test("a bookkeeping write is recorded but is NOT a transition", () => {
    recordCardWrite(stateDir, "card_b", ev(), ev({ block_reason: "triaged" }), { actor: "coordinator", at: at(1) });
    const [e] = readCardWrites(stateDir, "card_b");
    assert.deepEqual(e.fields, ["block_reason"]);
    assert.deepEqual(e.transitions, [], "a reason is not progress");
  });

  test("a NO-OP write is not recorded at all", () => {
    // Recording it would inflate the very distribution this log exists to measure.
    const before = readCardWrites(stateDir, "card_c").length;
    const result = recordCardWrite(stateDir, "card_c", ev(), ev(), { at: at(1) });
    assert.equal(result, null);
    assert.equal(readCardWrites(stateDir, "card_c").length, before);
  });

  test("`updated` alone is never a change - it moves on every write by construction", () => {
    recordCardWrite(stateDir, "card_d", ev(), ev({ updated: "2026-01-01T05:00:00.000Z" }), { at: at(1) });
    assert.equal(readCardWrites(stateDir, "card_d").length, 0, "updated alone must not count as a write");
  });

  test("transition intervals are per card and exclude bookkeeping", () => {
    recordCardWrite(stateDir, "card_e", ev(), ev({ status: "blocked" }), { at: at(0) });
    recordCardWrite(stateDir, "card_e", ev({ status: "blocked" }), ev({ status: "blocked", block_reason: "note" }), { at: at(5) });
    recordCardWrite(stateDir, "card_e", ev({ status: "blocked" }), ev({ status: "done" }), { at: at(30) });
    const gaps = cardTransitionIntervals(stateDir, "card_e");
    assert.equal(gaps.length, 1, "only the transition-to-transition gap counts");
    assert.equal(gaps[0], 30 * 60000, "the intervening note must not become an interval");
  });

  test("the per-card log is bounded", () => {
    // Each write must be a REAL change. The first version of this test alternated
    // status back to its original value, which is a no-op write and is deliberately not
    // recorded - so it only ever produced 130 events, comfortably under the 200 cap,
    // and the test could not fail no matter what the cap was.
    for (let i = 0; i < 260; i++) {
      recordCardWrite(stateDir, "card_f", ev(), ev({ description: `revision ${i}` }), { at: at(i) });
    }
    const lines = fs.readFileSync(path.join(stateDir, "card-writes", "card_f.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.ok(lines.length <= 200, `expected a bounded log, got ${lines.length}`);
    assert.equal(JSON.parse(lines.at(-1)).fields[0], "description", "newest event must survive");
  });

  test("INTEGRATION: a real board write is recorded, with its fields", () => {
    // The unit tests above exercise the module. Only this goes through updateBoardTask,
    // so it is the only thing that can catch the instrumentation being present, correct,
    // and never called.
    const prevState = process.env.HERDR_PLUGIN_STATE_DIR;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cardwrites-int-"));
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(scratch, "state");
    try {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cardwrites-repo-"));
      const amqRoot = path.join(repoRoot, ".agent-mail");
      fs.mkdirSync(amqRoot, { recursive: true });
      const created = addBoardTask(repoRoot, amqRoot, { title: "instrument me", owner: "qa", status: "in_progress" });
      assert.ok(created.ok, created.error);
      const id = created.task.id;
      updateBoardTask(repoRoot, amqRoot, id, { status: "blocked", reason: "real transition" }, { from: "coordinator" });
      const events = readCardWrites(path.join(scratch, "state"), id);
      assert.ok(events.length >= 1, "a real board write must leave an event");
      assert.ok(events.some((e) => (e.transitions || []).includes("status")), "a status change must be recorded as a transition");
      assert.equal(events.at(-1).actor, "coordinator", "the event must carry the actor");
    } finally {
      if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
      else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
    }
  });

  test("an unwritable state dir never breaks a write", () => {
    // Parent must be a REGULAR FILE, not something exotic. recordCardWrite mkdirs the
    // state dir, and `mkdirSync("/proc/...", {recursive:true})` does not fail - it HANGS,
    // which takes the whole runner down reporting zero tests. I hit this exact trap
    // earlier tonight and then wrote it into this file a second time, which is worth
    // more than the bug it introduced.
    const blocker = path.join(stateDir, "not-a-directory");
    fs.writeFileSync(blocker, "x", "utf8");
    assert.doesNotThrow(() =>
      recordCardWrite(path.join(blocker, "state"), "card_g", ev(), ev({ status: "done" }), { at: at(1) })
    );
  });

  test("reading an absent card returns an empty list", () => {
    assert.deepEqual(readCardWrites(stateDir, "never_written"), []);
    assert.deepEqual(cardTransitionIntervals(stateDir, "never_written"), []);
  });
});
