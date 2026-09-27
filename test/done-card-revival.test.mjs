import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, updateBoardTask, getBoardTask, heartbeatBoardTask } from "../src/board.mjs";

/**
 * A CARD IS EITHER DONE OR NOT, AND NO TRANSITION MAY LEAVE IT ASSERTING BOTH.
 *
 * Reported by ballistics against their own card, from the board's own instrumented event log
 * rather than a reconstruction: a card was closed with proof at 05:45:55.314Z and written back
 * to in_progress at 05:45:57.905Z, two and a half seconds later, by a caller acting on a reading
 * it had not refreshed. The result was status in_progress, a done_at stamp 2.6 seconds older,
 * sitting in doing/, owned by a lane with nothing left to do. No reader can resolve that.
 *
 * This is the same shape as the defects this board keeps meeting, which is why it is worth a
 * permanent arm rather than a fix: a tool that reports success while leaving the board in a
 * self-contradictory state. The symptom is not the contradiction, it is that a FINISHED card
 * keeps doorbelelling its owner and eventually reads as stalled - which is how one lane's
 * in_progress count became overstated without anyone touching it.
 */

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "done-revive-"));
  const amqRoot = path.join(root, ".agent-mail");
  fs.mkdirSync(amqRoot, { recursive: true });
  return { repoRoot: root, amqRoot };
}

/** Create a real card. An updateBoardTask against a card that does not exist is "Task not
 *  found" - which is exactly what the first run of this file reported, and worth noting because
 *  I read it as a broken guard before I read it as a broken fixture. */
function make(repoRoot, amqRoot) {
  const created = addBoardTask(repoRoot, amqRoot, { title: "a card", owner: "owner" });
  assert.equal(created.ok, true, created.error);
  return created;
}

describe("a claim cannot revive a done card", () => {
  test("claiming a done card is REFUSED, not obeyed", () => {
    const { repoRoot, amqRoot } = fixture();
    const { task } = make(repoRoot, amqRoot);
    const id = task.id;
    const done = updateBoardTask(repoRoot, amqRoot, id, { status: "done" },
      { from: "owner", proof: "shipped and verified", notify: false });
    assert.equal(done.ok, true, done.error);

    const claim = updateBoardTask(repoRoot, amqRoot, id, { status: "in_progress" },
      { from: "stale-caller", notify: false });
    assert.equal(claim.ok, false, "a claim after completion is a stale caller far more often than an intent");
    assert.match(claim.error, /cannot revive/i);
  });

  test("and the card on disk is left exactly as it was", () => {
    // The guard must refuse WITHOUT writing. A refusal that still moved the stage would be the
    // same defect wearing a different hat: the caller is told no while the board says otherwise.
    const { repoRoot, amqRoot } = fixture();
    const { task } = make(repoRoot, amqRoot);
    const id = task.id;
    updateBoardTask(repoRoot, amqRoot, id, { status: "done" }, { from: "o", proof: "p", notify: false });
    const before = getBoardTask(repoRoot, amqRoot, id);
    updateBoardTask(repoRoot, amqRoot, id, { status: "in_progress" }, { from: "x", notify: false });
    const after = getBoardTask(repoRoot, amqRoot, id);
    assert.equal(after.task.status, before.task.status, "status unchanged");
    assert.equal(after.task.done_at, before.task.done_at, "done_at unchanged");
    assert.equal(after.stage, "done", "and it did not move out of done/");
  });

  test("THE INVARIANT, asserted directly: never done and not-done at once", () => {
    const { repoRoot, amqRoot } = fixture();
    const { task } = make(repoRoot, amqRoot);
    const id = task.id;
    updateBoardTask(repoRoot, amqRoot, id, { status: "done" }, { from: "o", proof: "p", notify: false });
    // Every transition a racing caller could plausibly make, not just the one that was observed.
    for (const to of ["in_progress", "review", "backlog", "queued", "blocked"]) {
      updateBoardTask(repoRoot, amqRoot, id, { status: to }, { from: "racer", notify: false });
      const t = getBoardTask(repoRoot, amqRoot, id).task;
      assert.ok(!(t.status !== "done" && t.done_at),
        `after a racing move to ${to}: status=${t.status} done_at=${t.done_at} - the card asserts both`);
    }
  });

  test("the refusal NAMES the state, so the caller can tell a guard from a crash", () => {
    const { repoRoot, amqRoot } = fixture();
    const { task } = make(repoRoot, amqRoot);
    const id = task.id;
    updateBoardTask(repoRoot, amqRoot, id, { status: "done" }, { from: "o", proof: "p", notify: false });
    const t = getBoardTask(repoRoot, amqRoot, id).task;
    const r = updateBoardTask(repoRoot, amqRoot, id, { status: "in_progress" }, { from: "x", notify: false });
    assert.match(r.error, new RegExp(t.done_at.slice(0, 19)),
      "the error carries the done_at that caused it, which is what makes it diagnosable");
    assert.match(r.error, /reopen/i, "and names the way out");
  });
});

describe("reopening is possible, and DELIBERATELY", () => {
  test("a reopen clears done_at rather than leaving a stale completion stamp", () => {
    // If reopen only moved the stage, the card would come back asserting done and in_progress
    // again - the same contradiction one command later. The invariant has to hold in BOTH
    // directions or the guard is just a delay.
    const { repoRoot, amqRoot } = fixture();
    const { task } = make(repoRoot, amqRoot);
    const id = task.id;
    updateBoardTask(repoRoot, amqRoot, id, { status: "done" }, { from: "o", proof: "real proof", notify: false });

    const r = updateBoardTask(repoRoot, amqRoot, id, { status: "doing", done_at: null },
      { from: "o", reopen: true, reason: "the fix was reverted, not done", notify: false });
    assert.equal(r.ok, true, r.error);
    const t = getBoardTask(repoRoot, amqRoot, id).task;
    // The board's vocabulary: BOTH the stage directory and the status field are in_progress
    // here, not doing/. Ballistics' report of the live card used bus/doing/, so the stage
    // naming is worth stating rather than assuming - and a test that asserts the wrong stage
    // name is a test that passes against a card in the wrong place.
    assert.equal(getBoardTask(repoRoot, amqRoot, id).stage, "in_progress", "it left done/");
    assert.equal(t.status, "in_progress");
    assert.equal(t.done_at, null, "the completion stamp is GONE - the card no longer claims to be done");
    assert.ok(!(t.status !== "done" && t.done_at), "the invariant holds after a reopen too");
  });

  test("a reopen without going through the guard is still possible, but only when asked", () => {
    // opts.reopen is the opt-in. The point of the guard is that reopening is a DECISION, and a
    // decision has to be visible in the call rather than inferred from timing.
    const { repoRoot, amqRoot } = fixture();
    const { task } = make(repoRoot, amqRoot);
    const id = task.id;
    updateBoardTask(repoRoot, amqRoot, id, { status: "done" }, { from: "o", proof: "p", notify: false });
    const r = updateBoardTask(repoRoot, amqRoot, id, { status: "doing", done_at: null },
      { from: "o", reopen: true, reason: "genuine reopen", notify: false });
    assert.equal(r.ok, true);
    assert.equal(getBoardTask(repoRoot, amqRoot, id).stage, "in_progress", "and it leaves done/");
    assert.equal(getBoardTask(repoRoot, amqRoot, id).task.done_at, null, "with the stamp cleared");
  });
});

describe("the guard matches the one that already existed", () => {
  test("a heartbeat could not revive a done card, and now neither can a claim", () => {
    // heartbeatBoardTask refused this before updateBoardTask did, which is why the contradiction
    // was reachable at all: two paths disagreed about the same rule and the one the tooling
    // actually used was the unguarded one. This asserts they now agree, so the disagreement
    // cannot come back on one side only.
    const { repoRoot, amqRoot } = fixture();
    const { task } = make(repoRoot, amqRoot);
    const id = task.id;
    updateBoardTask(repoRoot, amqRoot, id, { status: "done" }, { from: "o", proof: "p", notify: false });

    const hb = heartbeatBoardTask(repoRoot, amqRoot, id, { from: "o", lines: 1 });
    const claim = updateBoardTask(repoRoot, amqRoot, id, { status: "in_progress" }, { from: "o", notify: false });
    assert.equal(hb.ok, false, "the heartbeat path refuses");
    assert.equal(claim.ok, false, "and so does the claim path - they now agree");
  });
});
