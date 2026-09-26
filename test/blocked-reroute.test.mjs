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

  test("rerouting next_actor DOES reset blocked_at", () => {
    const { id, b } = blocked(newBoard());
    const before = card(b, id).blocked_at;
    updateBoardTask(b.tmpDir, b.amqRoot, id, { status: "blocked", reason: "rerouted", next_actor: "testkit" });
    assert.notEqual(card(b, id).blocked_at, before,
      "a decision about who acts next is a real action");
  });

  test("changing owner while blocked DOES reset blocked_at", () => {
    const { id, b } = blocked(newBoard());
    const before = card(b, id).blocked_at;
    updateBoardTask(b.tmpDir, b.amqRoot, id, { status: "blocked", reason: "handed over", owner: "spotter" });
    assert.notEqual(card(b, id).blocked_at, before);
  });

  test("a reason-only rewrite does not clobber next_actor", () => {
    const { id, b } = blocked(newBoard());
    updateBoardTask(b.tmpDir, b.amqRoot, id, { status: "blocked", reason: "r2" });
    assert.equal(card(b, id).next_actor, "qa");
  });
});
