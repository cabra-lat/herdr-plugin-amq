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

// ─── the residual hole, measured by ballistics against a throwaway bus ─────────
//
// The first predicate keyed on `existingTask.status === "done"`, so it fired only when LEAVING a
// CLEAN done card. A card that is ALREADY contradictory - status not done while done_at is set -
// was unprotected, and could be written again with the contradiction intact. That is the one
// instance still standing on the live board.
//
// These four arms are promoted rather than the probe deleted, per the standing rule: a probe
// that finds something leaves its assertion behind. The shapes are exactly the four ballistics
// ran, and the ORDER of the arms matters - see the control note at the end.
describe("an ALREADY-CONTRADICTORY card is protected too", () => {
  /** A card in the broken shape: not done, but carrying a completion record. */
  function makeBad(root, amqRoot) {
    const { task } = make(root, amqRoot);
    const id = task.id;
    updateBoardTask(root, amqRoot, id, { status: "done" }, { from: "o", proof: "real proof", notify: false });
    // Reach the broken state the way history did: a claim, forced past the guard by writing
    // done_at to null alongside, which is what a pre-01aad98 caller effectively produced.
    updateBoardTask(root, amqRoot, id, { status: "blocked", done_at: null, reason: "forced" },
      { from: "legacy", reopen: true, reason: "simulating a pre-guard card", notify: false });
    const t = getBoardTask(root, amqRoot, id).task;
    // Re-stamp done_at directly to reproduce the historical shape exactly.
    updateBoardTask(root, amqRoot, id, { status: "blocked", done_at: "2026-09-27T01:37:46.824Z", reason: "forced" },
      { from: "legacy", reopen: true, reason: "simulating a pre-guard card", notify: false });
    assert.ok(getBoardTask(root, amqRoot, id).task.done_at, "fixture must actually be contradictory");
    return { id, t };
  }

  test("A: a claim on a CLEAN done card is refused", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "done-revive-"));
    const amqRoot = path.join(root, ".agent-mail");
    fs.mkdirSync(amqRoot, { recursive: true });
    const { task } = make(root, amqRoot);
    const id = task.id;
    updateBoardTask(root, amqRoot, id, { status: "done" }, { from: "o", proof: "p", notify: false });
    const r = updateBoardTask(root, amqRoot, id, { status: "in_progress" }, { from: "racer", notify: false });
    assert.equal(r.ok, false, "the original guard, unchanged");
    assert.match(r.error, /cannot revive/i);
  });

  test("B: a write on an ALREADY-BAD card is refused - the hole", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "done-revive-"));
    const amqRoot = path.join(root, ".agent-mail");
    fs.mkdirSync(amqRoot, { recursive: true });
    const { id } = makeBad(root, amqRoot);
    const before = getBoardTask(root, amqRoot, id).task;

    const r = updateBoardTask(root, amqRoot, id, { status: "blocked" }, { from: "racer", notify: false });
    assert.equal(r.ok, false, "a contradictory card must not be writable");
    assert.match(r.error, /contradicts itself/i);
    const after = getBoardTask(root, amqRoot, id).task;
    assert.equal(after.done_at, before.done_at, "and the record is not overwritten on the way");
  });

  test("C: THE CONTROL - an ordinary claim is ACCEPTED, so 'refused' is not 'not found'", () => {
    // This is ballistics' own correction to their first probe, and it is the arm that makes the
    // other three meaningful. They passed the bus DIRECTORY where getBusDirectory() expects the
    // AMQ ROOT, every arm returned "Task not found", and read carelessly that looks like a guard
    // refusing everything - a clean sweep that tested nothing. They caught it because the
    // CONTROL also refused: a guard that refuses an ordinary claim is not a guard.
    //
    // A red arm suite needs an arm that MUST PASS, or "refused" is indistinguishable from
    // "not found". Every guard in this file is only trustworthy because of this one.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "done-revive-"));
    const amqRoot = path.join(root, ".agent-mail");
    fs.mkdirSync(amqRoot, { recursive: true });
    const { task } = make(root, amqRoot);
    const id = task.id;
    const r = updateBoardTask(root, amqRoot, id, { status: "in_progress" }, { from: "worker", notify: false });
    assert.equal(r.ok, true, "an ordinary claim must not be over-blocked");
    assert.equal(getBoardTask(root, amqRoot, id).task.status, "in_progress");
  });

  test("D: a card can still be re-completed, and done_at is NOT silently refreshed", () => {
    // The other half, and a real decision rather than an oversight.
    //
    // `done_at: existing || now` records the FIRST completion. So a card that was wrongly revived
    // and then re-completed carries a done_at marking the first completion and a proof marking
    // the second, and a reader cannot tell from done_at when the card was last actually
    // completed. 11 of the 12 sweep hits are cards where that is now true.
    //
    // I am NOT changing it, and the reason is that the alternative destroys the evidence. The
    // first completion is the truthful record of when the work finished; the second is the
    // anomaly. Refreshing would make every one of those 11 cards look consistently done and
    // erase the only field that distinguishes them - which is the same failure as nulling
    // done_at, in the opposite direction: fixing the appearance by discarding the record.
    //
    // So this is a KNOWN, RECORDED divergence on historical cards, not a repair. What closes it
    // is the guard above: no NEW card can reach this shape, because leaving done now requires a
    // reopen, and a reopen clears done_at.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "done-revive-"));
    const amqRoot = path.join(root, ".agent-mail");
    fs.mkdirSync(amqRoot, { recursive: true });
    const { task } = make(root, amqRoot);
    const id = task.id;
    updateBoardTask(root, amqRoot, id, { status: "done" }, { from: "o", proof: "first", notify: false });
    const first = getBoardTask(root, amqRoot, id).task.done_at;
    const again = updateBoardTask(root, amqRoot, id, { status: "done" }, { from: "o", proof: "second", notify: false });
    assert.equal(again.ok, true, "completing an already-done card is not a revival, so it is allowed");
    assert.equal(getBoardTask(root, amqRoot, id).task.done_at, first,
      "and the FIRST completion is preserved - the divergence is deliberate and asserted here");
  });
});
