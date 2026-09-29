import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, setTaskResumeLine, getBoardTask, appendBoardTaskNote } from "../src/board.mjs";

process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-resume-line-"));

/**
 * A RESUME LINE IS A SINGLE-VALUED FIELD, SO RE-CLAIMING REPLACES IT — AND LANES RE-PASTE.
 *
 * Observed on one card: the same text came back at least twice, each time carrying "the previous
 * version of this line was wrong on the first sentence" while reproducing the wrong content, and
 * the corrections were sitting in NOTES that the lease notice does not show. One of those stale
 * lines instructed a reader to add a red arm that provably cannot fail.
 *
 * So this is a guard at the WRITE path, not a detector at the read path: a line whose text a
 * note NEWER than the current line already contains is refused. The tests below are in the order
 * the argument needs — the field exists, the refusal fires, and a genuinely new line is accepted
 * so the guard cannot pass by refusing everything.
 */
function freshBoard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-line-"));
  const amqRoot = path.join(root, ".agent-mail");
  return { root, amqRoot };
}

test("CONTROL: a fresh line is accepted and stamped, and the write does NOT move the state clock", () => {
  const { root, amqRoot } = freshBoard();
  const created = addBoardTask(root, amqRoot, { title: "t", owner: "qa", status: "doing" });
  assert.ok(created.ok, `create should succeed: ${JSON.stringify(created.error || created)}`);
  const id = created.task.id;

  const before = getBoardTask(root, amqRoot, id).task;
  const wrote = setTaskResumeLine(root, amqRoot, id, "THE RED ARM MUST FAIL 45 TO 43", { me: "qa" });
  assert.ok(wrote.ok, `a fresh line must be accepted: ${JSON.stringify(wrote.error || wrote)}`);
  assert.equal(wrote.resume_line, "THE RED ARM MUST FAIL 45 TO 43");
  assert.ok(wrote.resume_line_at, "the line must carry its companion timestamp");

  // The property the field at :902 defends: restating owed work is not progress.
  const after = getBoardTask(root, amqRoot, id).task;
  assert.equal(after.updated, before.updated,
    "writing a resume line must not move `updated` — that is what lets an agent clear its own stall clock");
});

test("the guard FIRES on a re-paste that a newer note has already corrected", () => {
  const { root, amqRoot } = freshBoard();
  const id = addBoardTask(root, amqRoot, { title: "t", owner: "qa", status: "doing" }).task.id;

  setTaskResumeLine(root, amqRoot, id, "THE RED ARM MUST FAIL 45 TO 43", { me: "qa" });
  // A correction lands afterwards, as a note — which is where corrections actually go.
  const note = appendBoardTaskNote(root, amqRoot, id, { author: "coordinator",
    text: "That instruction is wrong and would ship a check that cannot fail. The arm is deleted, not repaired." });
  assert.ok(note?.ok ?? true, "the note should land");

  // Now the lane re-pastes the ORIGINAL line.
  const again = setTaskResumeLine(root, amqRoot, id, "THE RED ARM MUST FAIL 45 TO 43", { me: "qa" });
  assert.equal(again.ok, false,
    `a superseded line must be refused, and it was accepted: ${JSON.stringify(again.error || "")}`);
  // Asserted on the STRUCTURED field, not the prose: a message can be reworded without the
  // guard changing, and a test that pins wording breaks for the wrong reason.
  assert.ok(String(again.error).length > 0, "the refusal must carry a reason a reader can act on");
  assert.ok(again.supersededBy?.at, "the refusal must name the note that supersedes it");
  assert.ok(again.supersededBy?.count >= 1, "and how many notes landed since");

  // And the field is unchanged: a refusal moves nothing.
  const after = getBoardTask(root, amqRoot, id).task;
  assert.equal(after.resume_line, "THE RED ARM MUST FAIL 45 TO 43",
    "the refused write must not have altered the stored line");
});

test("CONTROL: a genuinely NEW obligation is still accepted after a note exists", () => {
  const { root, amqRoot } = freshBoard();
  const id = addBoardTask(root, amqRoot, { title: "t", owner: "qa", status: "doing" }).task.id;
  setTaskResumeLine(root, amqRoot, id, "FIRST OBLIGATION", { me: "qa" });
  appendBoardTaskNote(root, amqRoot, id, { author: "coordinator", text: "an unrelated note about something else entirely" });

  const next = setTaskResumeLine(root, amqRoot, id, "SECOND OBLIGATION: push the branch", { me: "qa" });
  assert.ok(next.ok,
    `a new obligation must be accepted — a guard that refuses everything is not a guard: ${JSON.stringify(next.error || "")}`);
  assert.equal(next.resume_line, "SECOND OBLIGATION: push the branch");
});

test("CONTROL: a note OLDER than the line does not block a re-write of the same text", () => {
  const { root, amqRoot } = freshBoard();
  const id = addBoardTask(root, amqRoot, { title: "t", owner: "qa", status: "doing" }).task.id;
  appendBoardTaskNote(root, amqRoot, id, { author: "coordinator", text: "SOME EARLIER NOTE MENTIONING OBLIGATION BY NAME" });
  setTaskResumeLine(root, amqRoot, id, "OBLIGATION", { me: "qa" });

  // Rewriting the SAME text is legitimate here: the note predates the line, so it cannot be a
  // correction OF this line. A guard that fired here would be a false positive.
  const again = setTaskResumeLine(root, amqRoot, id, "OBLIGATION", { me: "qa" });
  assert.ok(again.ok, `an older note must not block a rewrite: ${JSON.stringify(again.error || "")}`);
});
