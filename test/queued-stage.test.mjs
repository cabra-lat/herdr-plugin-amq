// A queue that is working as designed must not read as a lane that has stopped.
//
// The defect, measured on live data: four cards the coordinator had deliberately parked
// in a written order, 0ed569, e48dd5, 87ab63 and 2ed343, were reported by stalled_work at
// 126, 126, 126 and 76 minutes. A 4-of-4 false-positive rate. The root cause was not the
// predicate being loose - it was that there was no way to express the difference. "MOVED
// TO QUEUED" lived in a reason field while the stored status was `backlog`, and board.mjs
// documented backlog AS the queued column. A scheduled card and an unscheduled card were
// the same row.
//
// The falsifiable acceptance, recorded before the result so neither side can read the
// outcome as the one we wanted: if ANY queued card appears in stalled_work, this change is
// wrong. That is checkable by a reader without asking the author anything.
//
// The second half is the one that would make a partial fix look broken: a queued card must
// still be aged by queue_age, because waiting its turn is real work that has not moved yet.
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildCoordinatorMetrics, activeBoardTasks } from "../src/metrics.mjs";
import { addBoardTask, updateBoardTask, loadBoard, getBoardTask } from "../src/board.mjs";
// ISOLATION, and it is load-bearing rather than tidy. board.mjs records every card write to the
// state dir RESOLVED AT CALL TIME, so a test that does not set this writes its fixture cards into
// the real ~/.herdr-amq-state and evicts real card history: 194 of 200 audit slots are test
// residue, and task_1790520029313_38a378's log was unlinked while its card survived. Set at module
// scope, before any test runs, because the read happens when the write happens.
//
// `||=` so a file that already isolates keeps its own directory. The guard that keeps this true
// is test/state-isolation-guard.test.mjs; it names any file that drifts back.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-queued-stage-"));


const NOW = Date.parse("2026-09-26T19:00:00.000Z");
const MIN = 60 * 1000;

const card = (over = {}) => ({
  id: "t1",
  title: "card",
  owner: "testkit",
  status: "queued",
  created: new Date(NOW - 200 * MIN).toISOString(),
  updated: new Date(NOW - 126 * MIN).toISOString(),
  ...over,
});

const metrics = (columns) =>
  buildCoordinatorMetrics({
    handles: ["testkit"],
    agentStatuses: { testkit: "working" },
    board: { columns: { backlog: [], queued: [], in_progress: [], blocked: [], done: [], ...columns } },
    jobQueue: { queueDepth: 0, active: 0, concurrency: { current: 0, max: 1 }, outcomes: {} },
    now: NOW,
  });

describe("queued is a real stage, not a flavour of backlog", () => {
  test("THE FALSIFIABLE ONE: no queued card may appear in stalled_work", () => {
    const m = metrics({ queued: [card({ id: "parked" }), card({ id: "parked2" })] });
    const ids = (m.stalledWork || []).map((c) => c.id);
    assert.ok(!ids.includes("parked"), `a scheduled card waiting its turn is not a stall: ${ids}`);
    assert.ok(!ids.includes("parked2"));
    const alert = (m.alerts || []).find((a) => a.id === "stalled_work");
    if (alert) assert.ok(!(alert.cards || []).some((c) => c.stage === "queued"), "the alert must not quote a queued card");
  });

  test("an UNSCHEDULED backlog card still stalls - the change did not disable the signal", () => {
    const m = metrics({ backlog: [card({ id: "ignored", status: "backlog" })] });
    const ids = (m.stalledWork || []).map((c) => c.id);
    assert.ok(ids.includes("ignored"), "a card nobody scheduled still reads as a stall - otherwise this only silences");
  });

  test("a queued card is still AGED by queue_age", () => {
    const m = metrics({ queued: [card({ id: "parked" })] });
    assert.ok(m.queue.activeCards > 0, "waiting its turn is real work that has not moved yet");
    assert.ok(m.queue.oldestAgeMs >= 120 * MIN, `queue_age must keep ageing it, got ${m.queue.oldestAgeMs}`);
  });

  test("activeBoardTasks admits queued for the queue and excludes it for the stall", () => {
    const board = { columns: { queued: [{ id: "p" }], backlog: [{ id: "b" }] } };
    assert.deepEqual(activeBoardTasks(board).map((t) => t.id).sort(), ["b", "p"], "the queue sees both");
    assert.deepEqual(activeBoardTasks(board, { stallEligible: true }).map((t) => t.id), ["b"], "the stall signal sees only the unscheduled one");
  });
});

describe("queued round-trips through the real board", () => {
  let repoRoot;
  let amqRoot;

  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agmail-queued-"));
    repoRoot = tmp;
    amqRoot = path.join(tmp, ".agent-mail");
    fs.mkdirSync(amqRoot, { recursive: true });
  });
  after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  test("a card created as queued survives the write, the parse and the column map", () => {
    const made = addBoardTask(repoRoot, amqRoot, { title: "parked work", owner: "testkit", status: "queued", queue_sequence: 2 });
    assert.ok(made.task?.id, "creation must succeed");
    // The parser has its own status whitelist. A status the validator accepts and the
    // parser drops would silently become `backlog`, which is the original defect wearing
    // a new name.
    const read = getBoardTask(repoRoot, amqRoot, made.task.id);
    assert.equal(read.task.status, "queued", "queued must survive the round trip");
    const board = loadBoard(repoRoot, amqRoot);
    assert.ok(board.columns.queued.some((c) => c.id === made.task.id), "and it must appear in the queued column");
  });

  test("the sequence round-trips and is an integer", () => {
    const made = addBoardTask(repoRoot, amqRoot, { title: "second in order", owner: "testkit", status: "queued", queue_sequence: 1 });
    const read = getBoardTask(repoRoot, amqRoot, made.task.id);
    assert.equal(read.task.queue_sequence, 1, "the order must be state, not a reason string");
  });

  test("a non-integer or negative sequence is rejected atomically, not stored", () => {
    const made = addBoardTask(repoRoot, amqRoot, { title: "bad order", owner: "testkit", status: "queued" });
    for (const bad of ["later", -1, 1.5]) {
      const r = updateBoardTask(repoRoot, amqRoot, made.task.id, { queue_sequence: bad });
      assert.equal(r.ok, false, `must reject ${JSON.stringify(bad)}`);
      assert.match(r.error, /queue_sequence/);
    }
    const after = getBoardTask(repoRoot, amqRoot, made.task.id);
    assert.equal(after.task.queue_sequence, null, "nothing may be written by a rejected update; null is an honest absence");
  });

  test("queued is in the accepted status list the API advertises", async () => {
    const { TASK_STATUSES } = await import("../src/board.mjs");
    assert.ok(TASK_STATUSES.includes("queued"), "an unadvertised status is a status a caller cannot discover");
  });
});

// Kept SEPARATE from the queued change on the coordinator's instruction, because folding a
// correctness fix into a status-vocabulary change is how it gets lost.
//
// The defect: `stage` was projected on the FRESH path and not on the STALLED path, so
// every card a consumer actually cares about - the stalled ones - reported
// stage=undefined while the board showed the column correctly. A reader asking "is this
// parked or abandoned?" got undefined and concluded neither.
describe("the stalled projection carries the stage", () => {
  test("a stalled card reports its stage, not undefined", () => {
    const m = metrics({ backlog: [card({ id: "ignored", status: "backlog" })] });
    const stalled = (m.stalledWork || [])[0];
    assert.ok(stalled, "the card is well past the threshold and must be reported stalled");
    assert.equal(stalled.stage, "backlog", "an undefined stage is how parked and abandoned became indistinguishable");
  });

  test("a queued card would report queued if it ever reached this projection", () => {
    const m = metrics({ queued: [card({ id: "parked" })] });
    // It must not be here at all - that is the other test - but the field is populated on
    // the same projection, so the two are consistent.
    assert.equal((m.stalledWork || []).length, 0, "queued is not stalled work");
  });
});
