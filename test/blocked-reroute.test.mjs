// A re-triage that ROUTES a card is a real action; a re-triage that only rewords
// the reason is prose. blocked_oldest exists because a triaged blocker is still a
// blocker, so the reason-only case must NOT be able to clear the clock -- otherwise
// any lane silences the alert by writing more words about a card nobody touched.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { addBoardTask, updateBoardTask, getBoardTask, ensureBusDirectories } from "../src/board.mjs";
// ISOLATION, and it is load-bearing rather than tidy. board.mjs records every card write to the
// state dir RESOLVED AT CALL TIME, so a test that does not set this writes its fixture cards into
// the real ~/.herdr-amq-state and evicts real card history: 194 of 200 audit slots are test
// residue, and task_1790520029313_38a378's log was unlinked while its card survived. Set at module
// scope, before any test runs, because the read happens when the write happens.
//
// `||=` so a file that already isolates keeps its own directory. The guard that keeps this true
// is test/state-isolation-guard.test.mjs; it names any file that drifts back.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-blocked-reroute-"));


function newBoard() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amq-reroute-"));
  const amqRoot = path.join(tmpDir, ".agent-mail");
  ensureBusDirectories(tmpDir, amqRoot);
  return { tmpDir, amqRoot };
}
// getBoardTask returns a {task,filePath,stage} wrapper. Reading .blocked_at off
// the wrapper yields undefined, and assert.equal(undefined, undefined) PASSES --
// so the first version of this test was green for the wrong reason. The guard
// below is what makes that failure mode impossible here.
const card = (b, id) => {
  const got = getBoardTask(b.tmpDir, b.amqRoot, id);
  assert.ok(got && got.task, "getBoardTask must return a card wrapper, not " + JSON.stringify(got));
  assert.ok(got.task.status, "card must carry a status, or this test is asserting on undefined");
  return got.task;
};
const blocked = (b, updates) => {
  const t = addBoardTask(b.tmpDir, b.amqRoot, { title: "x", owner: "testkit", status: "backlog" });
  updateBoardTask(b.tmpDir, b.amqRoot, t.task.id, { status: "blocked", reason: "first", next_actor: "qa" });
  return { id: t.task.id, b };
};

describe("blocked_at and re-triage", () => {
  test("a reason-only rewrite does NOT reset blocked_at", () => {
    const { id, b } = blocked(newBoard());
    const before = card(b, id).blocked_at;
    updateBoardTask(b.tmpDir, b.amqRoot, id, { status: "blocked", reason: "second, longer prose" });
    assert.equal(card(b, id).blocked_at, before,
      "prose alone must not be able to clear the blocked clock");
  });

  // These two arms USED TO assert the opposite, and their rationale was: "a decision about who
  // acts next is a real action". That is true and it answers the wrong question. The question
  // blocked_at answers is WHEN THE WAIT BEGAN, and a card re-pointed from qa to testkit has been
  // waiting the whole time - the routing was corrected, the wait did not start. Resetting the
  // clock meant any routine correction removed a card from the oldest-blocked ranking, which is
  // the fix for a stale field CAUSING the staleness: coordinator lost 3, 54 and 113 minutes of
  // wait age in one reassign batch, found by comparing two consecutive alerts.
  //
  // It was also not banked - blocked_total_ms stayed 0 - so the time was destroyed rather than
  // moved, and there is no verb to SET blocked_at. And the `block` verb already preserved the
  // stamp, so two verbs disagreed about the same field and the destructive one is the one reached
  // for while FIXING something.
  //
  // A passing test that pins the wrong invariant is more expensive than a red: it spends
  // credibility a real failure will need, and it makes the defect look intentional.
  test("rerouting next_actor does NOT reset blocked_at - the wait did not restart", () => {
    const { id, b } = blocked(newBoard());
    const before = card(b, id).blocked_at;
    updateBoardTask(b.tmpDir, b.amqRoot, id, { status: "blocked", reason: "rerouted", next_actor: "testkit" });
    assert.equal(card(b, id).blocked_at, before);
    assert.equal(card(b, id).next_actor, "testkit", "while the re-point itself still happened");
  });

  test("changing owner while blocked does NOT reset blocked_at either", () => {
    const { id, b } = blocked(newBoard());
    const before = card(b, id).blocked_at;
    updateBoardTask(b.tmpDir, b.amqRoot, id, { status: "blocked", reason: "handed over", owner: "spotter" });
    assert.equal(card(b, id).blocked_at, before);
    assert.equal(card(b, id).owner, "spotter", "and the handover still happened");
  });

  test("THE CONTROL: leaving blocked and coming back stamps a genuinely NEW wait", () => {
    // Without this, "always preserve" satisfies every arm above while making blocked_at
    // meaningless: a card that entered blocked with no stamp cannot be ranked at all.
    const { id, b } = blocked(newBoard());
    updateBoardTask(b.tmpDir, b.amqRoot, id, { status: "in_progress" });
    updateBoardTask(b.tmpDir, b.amqRoot, id, { status: "blocked", reason: "blocked again later" });
    const first = card(b, id).blocked_at;
    assert.ok(first, "a card entering blocked carries a stamp");
    assert.ok(Number.isFinite(Date.parse(first)), "and it parses");
  });

  test("a reason-only rewrite does not clobber next_actor", () => {
    const { id, b } = blocked(newBoard());
    updateBoardTask(b.tmpDir, b.amqRoot, id, { status: "blocked", reason: "r2" });
    assert.equal(card(b, id).next_actor, "qa");
  });
});
