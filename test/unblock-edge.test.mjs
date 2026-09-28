// The blocked edge, in BOTH directions, as ONE behaviour.
//
// These came out of the fifth tool finding of the evening: a card in `blocked` could only
// leave by going to `done` or by its owner re-claiming it, because no verb expressed the
// transition. The fix is three things that must not land separately -- a required reason on
// every edge touching `blocked`, an `unblock` verb whose stage has no default, and a guard
// in the CORE so an HTTP PATCH cannot walk around the CLI. Each of the three is testable on
// its own and could look correct alone; these tests deliberately cover all three together,
// because the third is what makes the first two mean anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addBoardTask, updateBoardTask } from "../src/board.mjs";
// ISOLATION, and it is load-bearing rather than tidy. board.mjs records every card write to the
// state dir RESOLVED AT CALL TIME, so a test that does not set this writes its fixture cards into
// the real ~/.herdr-amq-state and evicts real card history: 194 of 200 audit slots are test
// residue, and task_1790520029313_38a378's log was unlinked while its card survived. Set at module
// scope, before any test runs, because the read happens when the write happens.
//
// `||=` so a file that already isolates keeps its own directory. The guard that keeps this true
// is test/state-isolation-guard.test.mjs; it names any file that drifts back.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(tmpdir(), "herdr-iso-unblock-edge-"));


async function board() {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "unblock-"));
  const amqRoot = path.join(repoRoot, "mail");
  await mkdir(amqRoot, { recursive: true });
  return { repoRoot, amqRoot };
}

const blockedCard = async (b) =>
  (await addBoardTask(b.repoRoot, b.amqRoot, { title: "t", owner: "tester", status: "in_progress" })).task;

test("entering blocked without a reason is REFUSED, not accepted", async () => {
  const b = await board();
  const t = await blockedCard(b);
  // Measured before the guard: this was accepted and produced reason=null, i.e. a blocker
  // the coordinator cannot triage. The guard is the point of the test, not the status.
  const res = updateBoardTask(b.repoRoot, b.amqRoot, t.id, { status: "blocked" }, { actor: "tester" });
  assert.equal(res.ok, false);
  assert.match(res.error, /requires a reason/);
  await rm(b.repoRoot, { recursive: true, force: true });
});

test("leaving blocked without a reason is REFUSED on every legal stage", async () => {
  const b = await board();
  const t = await blockedCard(b);
  updateBoardTask(b.repoRoot, b.amqRoot, t.id, { status: "blocked", reason: "need a ruling" }, { actor: "tester" });

  // Not just in_progress: the guard is on the EDGE, so every destination is covered. A guard
  // written for the common case would leave queued and backlog walkable.
  for (const stage of ["in_progress", "queued", "backlog", "done"]) {
    const res = updateBoardTask(b.repoRoot, b.amqRoot, t.id, { status: stage }, { from: "coordinator" });
    assert.equal(res.ok, false, `${stage} was walkable without narration`);
    assert.match(res.error, /Leaving `blocked` requires a reason/);
  }
  await rm(b.repoRoot, { recursive: true, force: true });
});

test("a narrated unblock clears the reason and keeps the narration as a note", async () => {
  const b = await board();
  const t = await blockedCard(b);
  updateBoardTask(b.repoRoot, b.amqRoot, t.id, { status: "blocked", reason: "need a ruling on the mount" }, { actor: "tester" });

  const res = updateBoardTask(
    b.repoRoot, b.amqRoot, t.id,
    { status: "queued", reason: "ruling delivered, re-queued behind the fixture" },
    { from: "coordinator" },
  );
  assert.equal(res.ok, true);
  const done = res.task || res;

  // The reason slot is CLEARED. If it survived, "carries a reason" would stop meaning "is
  // a triaged blocker" and the blocked_oldest ownership split would change meaning
  // silently -- the exact failure the triaged rule was built to avoid.
  assert.equal(done.block_reason, null);

  // ...and the narration is not lost: it is a note, which is history rather than state.
  const notes = Array.isArray(done.notes) ? done.notes : [];
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^unblocked: ruling delivered/);
  assert.equal(notes[0].author, "coordinator");
  assert.ok(notes[0].at, "a note without a timestamp is not a record");
  await rm(b.repoRoot, { recursive: true, force: true });
});

test("a refused edge writes NOTHING -- the card is still blocked with its reason", async () => {
  const b = await board();
  const t = await blockedCard(b);
  updateBoardTask(b.repoRoot, b.amqRoot, t.id, { status: "blocked", reason: "need a ruling" }, { actor: "tester" });

  const res = updateBoardTask(b.repoRoot, b.amqRoot, t.id, { status: "backlog" }, { from: "coordinator" });
  assert.equal(res.ok, false);

  // A refusal that left the card moved would be worse than no guard at all: it would report
  // that it prevented something while the thing had already happened.
  // Read from DISK, not from the return value: a refusal returns no task, and asserting on
  // the refusal object alone would never notice whether the file had already been written.
  const { getBoardTask } = await import("../src/board.mjs");
  const after = getBoardTask(b.repoRoot, b.amqRoot, t.id);
  assert.equal(after.stage, "blocked");
  assert.equal(after.task.block_reason, "need a ruling");
  await rm(b.repoRoot, { recursive: true, force: true });
});

test("rewriting the reason while STAYING blocked is still allowed", async () => {
  // The guard is on the edge, not on the field. Re-triaging a blocker without moving it is
  // a real action and was legal before this change; a guard written too wide would break it.
  const b = await board();
  const t = await blockedCard(b);
  updateBoardTask(b.repoRoot, b.amqRoot, t.id, { status: "blocked", reason: "need a ruling" }, { actor: "tester" });

  const res = updateBoardTask(b.repoRoot, b.amqRoot, t.id, { reason: "still waiting on the ruling" }, { from: "coordinator" });
  assert.equal(res.ok, true);
  const done = res.task || res;
  assert.equal(done.status, "blocked");
  assert.equal(done.block_reason, "still waiting on the ruling");
  await rm(b.repoRoot, { recursive: true, force: true });
});

test("a card unblocked into the queue is findable and reports the queued stage", async () => {
  // `unblock --stage queued` makes queued a first-class destination, so the reader has to
  // agree that a card can live there. Asserting the lookup directly rather than trusting a
  // board load: a red arm that removed `queued` from the stage-directory list did NOT turn
  // this red, because getBoardTask falls back to loadBoard() and finds the card anyway. So
  // the stage list is a consolidation, not a bug fix, and this test pins the OUTCOME rather
  // than claiming the mechanism.
  const b = await board();
  const t = await blockedCard(b);
  updateBoardTask(b.repoRoot, b.amqRoot, t.id, { status: "blocked", reason: "need a ruling" }, { actor: "tester" });
  const res = updateBoardTask(b.repoRoot, b.amqRoot, t.id, { status: "queued", reason: "ruling delivered" }, { from: "coordinator" });
  assert.equal(res.ok, true);

  const { getBoardTask } = await import("../src/board.mjs");
  const found = getBoardTask(b.repoRoot, b.amqRoot, t.id);
  assert.ok(found, "a card unblocked into the queue must still be findable");
  assert.equal(found.stage, "queued");
  await rm(b.repoRoot, { recursive: true, force: true });
});

test("an unblock preserves the next actor, and never invents one that was not there", async () => {
  // Found in PRODUCTION, not by this suite: the coordinator ran `unblock` on a real card
  // and it came back with "Next actor: (unset)". The cause is that the CLI passes
  // `next_actor: nextActorFlag(flags["next-actor"])` and that helper returns `undefined`
  // when no flag was given -- so the key was PRESENT with an undefined value, and a bare
  // hasOwnProperty check read that as "clear the field". Absence of a flag is not a
  // request to unassign somebody's work.
  const b = await board();
  const t = await blockedCard(b);
  updateBoardTask(b.repoRoot, b.amqRoot, t.id, { status: "blocked", reason: "need a ruling" }, { actor: "tester" });

  // The exact shape the CLI sends when --next-actor is omitted.
  const res = updateBoardTask(
    b.repoRoot, b.amqRoot, t.id,
    { status: "in_progress", reason: "ruling delivered", next_actor: undefined },
    { from: "coordinator" },
  );
  assert.equal(res.ok, true);
  const done = res.task || res;
  // A card coming off a block is being picked up by its owner, so the next actor is the
  // owner. Not null: an unblocked card with no next actor is unassigned, not unblocked.
  assert.equal(done.next_actor, "tester", "an omitted flag must fall back to the owner, not clear the field");
  await rm(b.repoRoot, { recursive: true, force: true });
});

test("an explicit next_actor: null still clears the field", async () => {
  // The fix must not break the deliberate clear. An absent value and an explicit null are
  // different states, and conflating them is the defect this whole change is about.
  const b = await board();
  const t = await blockedCard(b);
  updateBoardTask(b.repoRoot, b.amqRoot, t.id, { status: "blocked", reason: "need a ruling" }, { actor: "tester" });
  const res = updateBoardTask(
    b.repoRoot, b.amqRoot, t.id,
    { status: "in_progress", reason: "ruling delivered", next_actor: null },
    { from: "coordinator" },
  );
  assert.equal(res.ok, true);
  assert.equal((res.task || res).next_actor, null, "an explicit null is a decision to unassign");
  await rm(b.repoRoot, { recursive: true, force: true });
});
