import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, updateBoardTask, loadBoard, serializeTaskFile } from "../src/board.mjs";
// ISOLATION, and it is load-bearing rather than tidy. board.mjs records every card write to the
// state dir RESOLVED AT CALL TIME, so a test that does not set this writes its fixture cards into
// the real ~/.herdr-amq-state and evicts real card history: 194 of 200 audit slots are test
// residue, and task_1790520029313_38a378's log was unlinked while its card survived. Set at module
// scope, before any test runs, because the read happens when the write happens.
//
// `||=` so a file that already isolates keeps its own directory. The guard that keeps this true
// is test/state-isolation-guard.test.mjs; it names any file that drifts back.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-blocked-ms-semantics-"));


/**
 * `blocked_ms` said one thing and its name said another.
 *
 * MEASURED, by coordinator, on two live records at the same moment:
 *   task_1790472002097_3fdb93  blocked_ms 0        blocked_at 02:10:18  -> actually blocked 138 min
 *   task_1790427558484_bbbb18  blocked_ms 9037810  blocked_at 04:19:16  -> actually blocked   9 min
 * Disagreeing by ~141 minutes one way and ~138 the other, on the same board at the same time.
 *
 * THE MECHANISM, once read rather than guessed: `blocked_ms` was banked at the moment a card LEFT
 * the blocked column, so it held the total across every PREVIOUS spell and said nothing about the
 * current one. A first-time blocked card read 0 however long it had been blocked; a card blocked
 * again after a long earlier spell read the OLD spell's duration - 150 - which sorts it among the
 * oldest blockers when it is one of the newest. A field named "blocked_ms" that answers "how long
 * has this been blocked, ever" misleads every consumer, and one that sorts wrong never looks wrong.
 *
 * Three of the four blocked cards carried NO value at all: the same bug from the other side, since
 * the value is only ever written on the unblock transition, so a card that has not been unblocked
 * has nothing banked. Absence reads as zero, and zero is data.
 *
 * The ALERT was never wrong - metrics.mjs derives its age from `blocked_at` - and the coordinator
 * refuted their own hypothesis that the alerting was at fault. That is recorded in the code comment
 * so this ticket is not re-filed against the wrong component.
 *
 * Time is passed explicitly through the `now` option rather than by editing stored JSON, so these
 * arms assert the writer's arithmetic rather than a file I edited to suit it.
 */
const T0 = new Date("2026-09-27T00:00:00.000Z");
const at = (minutes) => new Date(T0.getTime() + minutes * 60 * 1000).toISOString();

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blocked-ms-"));
  const amqRoot = path.join(root, ".agent-mail");
  const created = addBoardTask(root, amqRoot, {
    title: "blocked_ms semantics",
    owner: "agsuite-dev",
    description: "probe",
  }, { notify: false, now: T0 });
  assert.equal(created.ok, true, created.error);
  return { root, amqRoot, id: created.task.id };
}

// A block needs a reason or the transition is REJECTED and returns {ok:false} with no .task -
// which is the guard doing its job, and which cost this file its first run.
const set = (root, amqRoot, id, updates, now) =>
  updateBoardTask(root, amqRoot, id, updates, {
    notify: false, now: new Date(now), reason: "waiting on a gate",
  });

describe("blocked_ms is the live age of the CURRENT spell", () => {
  test("a card blocked 138 minutes reads 138 minutes, not 0", () => {
    // THE ARM, instance one: first blocked spell. The old writer only banked on the way OUT, so
    // this stayed 0 for the whole 138 minutes and the record said so.
    const { root, amqRoot, id } = setup();
    set(root, amqRoot, id, { status: "blocked" }, at(0));
    const later = set(root, amqRoot, id, { notes: ["still waiting"] }, at(138));
    assert.equal(later.ok, true);
    assert.equal(later.task.blocked_ms, 138 * 60 * 1000,
      `a card blocked 138 minutes must say so; got ${later.task.blocked_ms}`);
  });

  test("a card blocked again after a long earlier spell reports THIS spell, not the old one", () => {
    // THE ARM, instance two, and the dangerous one: 150 minutes blocked, unblocked, then blocked
    // again 9 minutes ago used to read 150. A board sorted by that puts a fresh blocker among the
    // oldest, which is precisely how a real blocker gets ignored.
    const { root, amqRoot, id } = setup();
    set(root, amqRoot, id, { status: "blocked" }, at(0));
    const unblocked = set(root, amqRoot, id, { status: "in_progress" }, at(150));
    assert.equal(unblocked.task.blocked_total_ms, 150 * 60 * 1000,
      "the 150-minute spell is preserved, under a name that says so");
    assert.equal(unblocked.task.blocked_ms, 0, "and the live age is 0 while not blocked");

    set(root, amqRoot, id, { status: "blocked" }, at(159));
    const reblocked = set(root, amqRoot, id, { notes: ["re-blocked"] }, at(168));
    assert.equal(reblocked.task.blocked_ms, 9 * 60 * 1000,
      `the live age must be this spell, 9 minutes; got ${reblocked.task.blocked_ms}`);
    assert.equal(reblocked.task.blocked_total_ms, 150 * 60 * 1000,
      "and the cumulative total still stands at 150");
  });

  test("a card that is not blocked reports 0, because it is not blocked now", () => {
    const { root, amqRoot, id } = setup();
    const r = set(root, amqRoot, id, { status: "in_progress" }, at(5));
    assert.equal(r.task.blocked_ms, 0);
  });

  test("the age keeps growing across a long block, with no write needed to be honest", () => {
    // The property the old field could not have: a consumer reading the file between writes must
    // not see a stale number. `blocked_at` is what makes that true, and blocked_ms now agrees.
    const { root, amqRoot, id } = setup();
    set(root, amqRoot, id, { status: "blocked" }, at(0));
    const a = set(root, amqRoot, id, { notes: ["a"] }, at(10)).task.blocked_ms;
    const b = set(root, amqRoot, id, { notes: ["b"] }, at(70)).task.blocked_ms;
    assert.equal(a, 10 * 60 * 1000);
    assert.equal(b, 70 * 60 * 1000);
  });
});

describe("the field is never left unwritten", () => {
  test("both fields exist on a card that has never been blocked", () => {
    // Three of four blocked cards had no value at all. A field that exists on some cards and not
    // others cannot be sorted on, and its absence reads as 0 - which is data wearing a hole.
    const { root, amqRoot, id } = setup();
    const r = set(root, amqRoot, id, { notes: ["touched"] }, at(1));
    assert.ok("blocked_ms" in r.task, "blocked_ms must be present even at 0");
    assert.ok("blocked_total_ms" in r.task, "and so must the cumulative total");
  });

  test("the board listing a reader sees carries both", () => {
    const { root, amqRoot, id } = setup();
    set(root, amqRoot, id, { status: "blocked" }, at(0));
    set(root, amqRoot, id, { notes: ["x"] }, at(30));
    const board = loadBoard(root, amqRoot);
    const listed = board.columns.blocked.find((t) => t.id === id);
    assert.ok(listed, "the card is in the blocked column");
    assert.equal(listed.blocked_ms, 30 * 60 * 1000);
    assert.ok("blocked_total_ms" in listed);
  });

  test("the card file a human reads carries the live age, not a stale one", () => {
    // The human surface is where this did real damage: a card blocked 138 minutes printed
    // \`blocked_ms: 0\`, and a card blocked 9 minutes after an earlier 150-minute block printed
    // \`blocked_ms: 9037810\`. serializeTaskFile is what writes each card's own markdown block,
    // which is what STATUS.md is generated from - so this is the number a reader ends up seeing.
    const { root, amqRoot, id } = setup();
    set(root, amqRoot, id, { status: "blocked" }, at(0));
    const card = set(root, amqRoot, id, { notes: ["x"] }, at(42)).task;
    const rendered = serializeTaskFile(card);
    const shown = (rendered.split("\n").find((l) => l.startsWith("blocked_ms:")) || "").trim();
    assert.equal(shown, "blocked_ms: " + 42 * 60 * 1000,
      "the rendered card must show the live age for this card");
    assert.match(rendered, /blocked_total_ms: \d+/, "and the cumulative total, by name");
  });
});
