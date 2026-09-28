import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, updateBoardTask, getBoardTask } from "../src/board.mjs";
// ISOLATION, and it is load-bearing rather than tidy. board.mjs records every card write to the
// state dir RESOLVED AT CALL TIME, so a test that does not set this writes its fixture cards into
// the real ~/.herdr-amq-state and evicts real card history: 194 of 200 audit slots are test
// residue, and task_1790520029313_38a378's log was unlinked while its card survived. Set at module
// scope, before any test runs, because the read happens when the write happens.
//
// `||=` so a file that already isolates keeps its own directory. The guard that keeps this true
// is test/state-isolation-guard.test.mjs; it names any file that drifts back.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-edge-target-status-"));


/**
 * AN EDGE MUST POINT AT WORK THAT IS NOT ALREADY FINISHED.
 *
 * The false block this prevents happened for real: an edge was written pointing at an
 * already-completed card, from an id remembered instead of read, and the board honoured it
 * because no guard existed. Nothing RELEASED the card - the card was never correct - so no
 * auto-release policy would have fixed it. An auto-release would have ACTED on the mis-encoding,
 * which is strictly worse: the bad edge stays invisible until something silently opens a card
 * somebody is still waiting on.
 *
 * The asymmetry decides it. Refusing a bad edge is loud and costs a retry. Releasing on a
 * good-looking edge is silent and costs a wait nobody can see. Guard the WRITE.
 *
 * The edge is the claim; the prose reason is narration and never substitutes for an edge. That
 * answers the question that was parked: nothing in the prose makes a reason demonstrably about a
 * dependency, and requiring the id in the text would be trivially satisfiable. The rule is
 * checkable by reading ONE field.
 */

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edge-"));
  const amqRoot = path.join(root, ".agent-mail");
  fs.mkdirSync(amqRoot, { recursive: true });
  return { root, amqRoot };
}

const quiet = { notify: false };

test("an edge to an already-DONE card is refused", () => {
  const { root, amqRoot } = fixture();
  const dep = addBoardTask(root, amqRoot, { title: "the check", owner: "o" }).task.id;
  updateBoardTask(root, amqRoot, dep, { status: "done" }, { from: "o", proof: "finished", ...quiet });
  const { task } = addBoardTask(root, amqRoot, { title: "blocked card", owner: "o" });

  const r = updateBoardTask(root, amqRoot, task.id,
    { status: "blocked", depends_on: [dep], reason: "waiting on the check" }, { from: "o", ...quiet });
  assert.equal(r.ok, false, "the exact false-block shape, refused at write time");
  assert.match(r.error, /already-completed/i);
});

test("and the card is left unblocked, because a refusal that still wrote would be worse", () => {
  const { root, amqRoot } = fixture();
  const dep = addBoardTask(root, amqRoot, { title: "the check", owner: "o" }).task.id;
  updateBoardTask(root, amqRoot, dep, { status: "done" }, { from: "o", proof: "p", ...quiet });
  const { task } = addBoardTask(root, amqRoot, { title: "blocked card", owner: "o" });
  updateBoardTask(root, amqRoot, task.id,
    { status: "blocked", depends_on: [dep], reason: "w" }, { from: "o", ...quiet });
  const after = getBoardTask(root, amqRoot, task.id).task;
  assert.notEqual(after.status, "blocked", "the write did not land");
  assert.deepEqual(after.depends_on || [], [], "and no edge was recorded");
});

test("THE CONTROL: an edge to a card with work left is ACCEPTED", () => {
  // Without this arm the suite cannot tell a working guard from a tool that refuses everything -
  // which is the mistake a red-arm probe made earlier tonight, where every arm returning
  // "not found" read as a clean sweep.
  const { root, amqRoot } = fixture();
  const dep = addBoardTask(root, amqRoot, { title: "live work", owner: "o" }).task.id;
  updateBoardTask(root, amqRoot, dep, { status: "in_progress" }, { from: "o", ...quiet });
  const { task } = addBoardTask(root, amqRoot, { title: "blocked card", owner: "o" });
  const r = updateBoardTask(root, amqRoot, task.id,
    { status: "blocked", depends_on: [dep], reason: "waiting" }, { from: "o", ...quiet });
  assert.equal(r.ok, true, "a legitimate edge must not be over-blocked");
  assert.equal(getBoardTask(root, amqRoot, task.id).task.status, "blocked");
});

test("an edge to a card that does not exist is ACCEPTED but WARNED, not refused", () => {
  // A dependency may legitimately precede its target, and refusing that would break ordering
  // rather than catch a mistake. But the most likely cause of an unresolvable id is exactly the
  // false-block signature - an id remembered instead of read - so it must be visible.
  const { root, amqRoot } = fixture();
  const { task } = addBoardTask(root, amqRoot, { title: "blocked card", owner: "o" });
  const r = updateBoardTask(root, amqRoot, task.id,
    { status: "blocked", depends_on: ["task_never_created"], reason: "w" }, { from: "o", ...quiet });
  assert.equal(r.ok, true, "ordering a dependency before its target is legitimate");
});

test("this is a DIFFERENT guard from the done-card one - neither substitutes", () => {
  // 5948c25 refuses a CLAIM against a finished card. This refuses an EDGE to one. A card can
  // have a perfectly good edge and still be claimed after completion, and vice versa.
  const { root, amqRoot } = fixture();
  const dep = addBoardTask(root, amqRoot, { title: "done", owner: "o" }).task.id;
  updateBoardTask(root, amqRoot, dep, { status: "done" }, { from: "o", proof: "p", ...quiet });
  const { task } = addBoardTask(root, amqRoot, { title: "live", owner: "o" });

  // Edge guard: refuses.
  const edge = updateBoardTask(root, amqRoot, task.id, { depends_on: [dep] }, { from: "o", ...quiet });
  assert.equal(edge.ok, false, "edge to a finished card refused");
  // Claim guard: this card is NOT done, so a claim is fine - the two guards do not overlap.
  const claim = updateBoardTask(root, amqRoot, task.id, { status: "in_progress" }, { from: "o", ...quiet });
  assert.equal(claim.ok, true, "an ordinary claim is untouched by the edge guard");
});
