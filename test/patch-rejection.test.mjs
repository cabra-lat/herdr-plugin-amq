import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, updateBoardTask, getBoardTask, TASK_STATUSES } from "../src/board.mjs";
// ISOLATION, and it is load-bearing rather than tidy. board.mjs records every card write to the
// state dir RESOLVED AT CALL TIME, so a test that does not set this writes its fixture cards into
// the real ~/.herdr-amq-state and evicts real card history: 194 of 200 audit slots are test
// residue, and task_1790520029313_38a378's log was unlinked while its card survived. Set at module
// scope, before any test runs, because the read happens when the write happens.
//
// `||=` so a file that already isolates keeps its own directory. The guard that keeps this true
// is test/state-isolation-guard.test.mjs; it names any file that drifts back.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-patch-rejection-"));


// A write that returns ok:true and changes nothing converts a caller error into a
// silent divergence between intent and board state. Reported by the coordinator:
// PATCH {"status":"review"} returned ok:true, the status simply was not applied, and
// the valid enum had to be found by grepping the source because there was no error.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "patchrej-"));
  const amqRoot = path.join(root, ".agent-mail");
  for (const h of ["coordinator", "qa"]) {
    for (const sub of ["inbox/new", "inbox/cur", "outbox/sent", "receipts"]) {
      fs.mkdirSync(path.join(amqRoot, "agents", h, sub), { recursive: true });
    }
  }
  const created = addBoardTask(root, amqRoot, { title: "A card", owner: "qa" }, { notify: false });
  return { root, amqRoot, id: created.task.id };
}

const onDisk = (root, amqRoot, id) => fs.readFileSync(getBoardTask(root, amqRoot, id).filePath, "utf8");

test("an unrecognised status is rejected, not silently dropped", () => {
  const { root, amqRoot, id } = fixture();
  try {
    const before = onDisk(root, amqRoot, id);
    const res = updateBoardTask(root, amqRoot, id, { status: "review", next_actor: "qa" });
    assert.equal(res.ok, false, "a status that cannot be honoured must not report success");
    assert.match(res.error, /unrecognised status/i);
    assert.match(res.error, /review/, "the error names the value that was rejected");
    assert.equal(getBoardTask(root, amqRoot, id).task.status, "backlog", "status is unchanged");
    assert.equal(onDisk(root, amqRoot, id), before, "and nothing at all was written to disk");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the rejection names the accepted values, so nobody has to read the source", () => {
  const { root, amqRoot, id } = fixture();
  try {
    const res = updateBoardTask(root, amqRoot, id, { status: "review" });
    assert.equal(res.ok, false);
    for (const status of TASK_STATUSES) {
      assert.ok(res.accepted.includes(status), `the error must list ${status}`);
    }
    assert.deepEqual(res.rejected, ["status"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an unrecognised FIELD is rejected instead of being written into the card", () => {
  const { root, amqRoot, id } = fixture();
  try {
    // The worse half of the same bug, found while fixing the status half: `...updates`
    // spreads into the card, so a typo was not ignored - it was persisted as a new,
    // meaningless key, corrupting the record rather than merely losing an assignment.
    const res = updateBoardTask(root, amqRoot, id, { statuz: "done" });
    assert.equal(res.ok, false, "a misspelled field must not be stored");
    assert.match(res.error, /statuz/, "and the error must name it");
    assert.deepEqual(res.rejected, ["statuz"]);
    const raw = onDisk(root, amqRoot, id);
    assert.ok(!/statuz/.test(raw), `the card must not contain the typo: ${raw}`);
    assert.equal(getBoardTask(root, amqRoot, id).task.status, "backlog", "and no status was inferred from it");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a mixed PATCH with one bad field writes nothing at all", () => {
  const { root, amqRoot, id } = fixture();
  try {
    const before = onDisk(root, amqRoot, id);
    const res = updateBoardTask(root, amqRoot, id, { next_actor: "qa", bogus: 1 });
    assert.equal(res.ok, false);
    assert.equal(onDisk(root, amqRoot, id), before,
      "a partly-invalid write must not apply the valid half: partial success is its own divergence");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("legal statuses are still accepted, including the doing alias", () => {
  const { root, amqRoot, id } = fixture();
  try {
    assert.equal(updateBoardTask(root, amqRoot, id, { status: "in_progress" }).ok, true);
    assert.equal(getBoardTask(root, amqRoot, id).task.status, "in_progress");
    assert.equal(updateBoardTask(root, amqRoot, id, { status: "doing" }).ok, true, "doing is an accepted alias");
    assert.equal(getBoardTask(root, amqRoot, id).task.status, "in_progress", "and normalises to in_progress");
    // Entering blocked now REQUIRES a reason: the narration of the edge is enforced in the
    // core, not the CLI. See test/unblock-edge.test.mjs.
    assert.equal(updateBoardTask(root, amqRoot, id, { status: "blocked" }).ok, false, "entering blocked without a reason must be refused");
    assert.equal(updateBoardTask(root, amqRoot, id, { status: "blocked", reason: "waiting on a ruling" }).ok, true);
    assert.equal(getBoardTask(root, amqRoot, id).task.status, "blocked");
    // Leaving blocked requires a reason too, so both edges out of here are narrated.
    assert.equal(updateBoardTask(root, amqRoot, id, { status: "done" }).ok, false, "leaving blocked without a reason must be refused");
    assert.equal(updateBoardTask(root, amqRoot, id, { status: "done", reason: "ruling delivered" }).ok, true);
    assert.equal(getBoardTask(root, amqRoot, id).task.status, "done");
    // The card is DONE at this point, so the trailing line of this vocabulary sweep is no longer
    // a statement about which statuses are legal - it is a claim moving a finished card back to
    // backlog, which is the exact operation that used to leave a card asserting done and
    // in_progress at once (done_at was preserved on every non-done transition). It is now
    // refused, and this line asserts the refusal rather than being deleted, so the guard is
    // pinned here too and not only in test/done-card-revival.test.mjs.
    assert.equal(updateBoardTask(root, amqRoot, id, { status: "backlog" }).ok, false,
      "a done card must not be claimable back into the queue");
    assert.equal(getBoardTask(root, amqRoot, id).task.status, "done", "and the card is untouched");
    // With the deliberate reopen, the same move is available on purpose.
    assert.equal(updateBoardTask(root, amqRoot, id, { status: "backlog", done_at: null },
      { reopen: true, reason: "reopening deliberately" }).ok, true, "reopen is the way through");
    assert.equal(getBoardTask(root, amqRoot, id).task.status, "backlog");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the fields the dashboard and CLI actually send are all still accepted", () => {
  const { root, amqRoot, id } = fixture();
  try {
    // The dashboard PATCHes {status, from, notify}; the CLI sends reason, next-actor,
    // depends-on, priority, proof and notes. A strict rule that rejected real traffic
    // would be worse than the bug, so the accepted set is pinned here.
    for (const payload of [
      { status: "in_progress", from: "coordinator", notify: true },
      { next_actor: "qa" },
      { priority: "P0" },
      { depends_on: ["task_1"] },
      { reason: "A reason long enough to be useful and to survive triage review." },
      { notes: [{ at: "2026-09-26T00:00:00Z", author: "qa", text: "a note" }] },
      { title: "Renamed" },
      { description: "A description." },
      { proof: "evidence" },
      { owner: "coordinator" },
    ]) {
      const res = updateBoardTask(root, amqRoot, id, payload, { notify: false });
      assert.equal(res.ok, true, `${JSON.stringify(payload)} must be accepted: ${res.error || ""}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an update with no fields is still a harmless no-op, not a rejection", () => {
  const { root, amqRoot, id } = fixture();
  try {
    const before = getBoardTask(root, amqRoot, id).task.updated;
    const res = updateBoardTask(root, amqRoot, id, {}, { notify: false });
    assert.equal(res.ok, true, "an empty PATCH is not an error");
    assert.equal(getBoardTask(root, amqRoot, id).task.updated, before, "and must not move the state clock");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
