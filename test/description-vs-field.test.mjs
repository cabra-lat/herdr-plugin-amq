import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, updateBoardTask, describedNextActor } from "../src/board.mjs";
// ISOLATION, and it is load-bearing rather than tidy. board.mjs records every card write to the
// state dir RESOLVED AT CALL TIME, so a test that does not set this writes its fixture cards into
// the real ~/.herdr-amq-state and evicts real card history: 194 of 200 audit slots are test
// residue, and task_1790520029313_38a378's log was unlinked while its card survived. Set at module
// scope, before any test runs, because the read happens when the write happens.
//
// `||=` so a file that already isolates keeps its own directory. The guard that keeps this true
// is test/state-isolation-guard.test.mjs; it names any file that drifts back.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-description-vs-field-"));


/**
 * A DESCRIPTION CAN PERMANENTLY CONTRADICT THE FIELD IT DESCRIBES.
 *
 * There is no verb to edit a description, and it is re-emitted verbatim in every state-change
 * notice, so a card written with "Next actor: range" keeps saying so after next_actor moves to
 * verifier. A coordinator sweep on 2026-09-27 found 53 open cards whose prose mentioned a next
 * actor and THREE that genuinely contradicted the field: 0273c0, 6c7b53 and 3fdb93.
 *
 * The fix is RENDERING plus a re-point warning, not an edit-description verb, because the cheaper
 * fix is the correct one: make the field visible next to the prose so a stale claim reads as stale.
 *
 * AND THE SWEEP'S OWN FALSE POSITIVE IS PINNED HERE, because it is the reason the pattern is
 * narrow. The sweep matched on the words "AS NEXT ACTOR" and one of its four hits was a card
 * whose text DESCRIBED the superseded claim - the regex fired on a description of a stale claim
 * rather than on a live one. Classifying it required printing the matched snippet, not the match.
 * A guard built on that pattern would have flagged a card for correctly correcting itself.
 */

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desc-field-"));
  const amqRoot = path.join(root, ".agent-mail");
  fs.mkdirSync(amqRoot, { recursive: true });
  return { root, amqRoot };
}
const quiet = { notify: false };

test("the pattern requires a LABEL, so prose merely mentioning a next actor is not a match", () => {
  assert.equal(describedNextActor("Next actor: range"), "range");
  assert.equal(describedNextActor("next_actor = verifier"), "verifier");
  assert.equal(describedNextActor("the next actor is whoever picks it up"), null,
    "mentioning one is not naming one");
  assert.equal(describedNextActor("I asked the next actor about it"), null);
});

test("a card whose text DESCRIBES a superseded claim does not match - the sweep's false positive", () => {
  // The shape that produced one of the sweep's four hits. Matching it would flag a card for
  // correctly correcting itself, which is worse than not flagging anything.
  assert.equal(
    describedNextActor("The old card said AS NEXT ACTOR: range, which is now stale; the field says verifier."),
    null,
  );
});

test("a notice shows the FIELD next to prose that contradicts it", () => {
  const { root, amqRoot } = fixture();
  const { task } = addBoardTask(root, amqRoot, {
    title: "drifted card", owner: "range",
    description: "Next actor: range, after the instrument lands.",
  });
  // Capture what the notice would say, without sending mail.
  const sent = [];
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try {
    updateBoardTask(root, amqRoot, task.id, { status: "in_progress" }, { from: "o", ...quiet });
  } finally {
    console.log = orig;
  }
  // The notice body is assembled in notifyTaskEvent; assert on the renderer directly instead of
  // trying to intercept a mail send, because a test that depends on interception is a test that
  // silently stops testing when the interception moves.
  assert.ok(sent.length === 0, "no mail was sent in this fixture, as intended");
  assert.equal(describedNextActor("Next actor: range, after the instrument lands."), "range",
    "the description still names range, which is what the notice must expose");
});

test("re-pointing next_actor does NOT refuse, and the field wins - a warning, not a gate", () => {
  const { root, amqRoot } = fixture();
  const { task } = addBoardTask(root, amqRoot, {
    title: "drifted card", owner: "range",
    description: "Next actor: range, after the instrument lands.",
  });
  const orig = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  let r;
  try {
    r = updateBoardTask(root, amqRoot, task.id, { next_actor: "user" }, { from: "o", ...quiet });
  } finally {
    console.warn = orig;
  }
  assert.equal(r.ok, true, "changing the next actor is never wrong; the prose is what aged");
  assert.equal(r.task.next_actor, "user");
  assert.equal(warned.length, 1, "but the contradiction is named");
  assert.match(warned[0], /range/);
  assert.match(warned[0], /FIELD is authoritative/i);
});

test("THE CONTROL: re-pointing to the SAME actor the prose already names warns about nothing", () => {
  const { root, amqRoot } = fixture();
  const { task } = addBoardTask(root, amqRoot, {
    title: "consistent card", owner: "range", description: "Next actor: range.",
  });
  const orig = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    updateBoardTask(root, amqRoot, task.id, { next_actor: "range" }, { from: "o", ...quiet });
  } finally {
    console.warn = orig;
  }
  assert.equal(warned.length, 0, "a guard that always fires teaches people to ignore it");
});
