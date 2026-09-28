// The progress clock must advance on TRANSITIONS, not on any write.
//
// The defect: `updated` records that something was written, and cardProgressClock read
// it, so a reason edit and a status change were the same event. That made the cheapest
// way to silence a stall alert be to write prose on the card - a counter the observer
// can move by touching the thing being measured.
//
// BOTH halves matter. Asserting only that a reason write does not move the clock would
// also pass if the clock simply stopped, which is a different bug. So: reason/note/
// proof do NOT move it, and status/owner/next_actor DO.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, updateBoardTask, getBoardTask } from "../src/board.mjs";
import { cardProgressClock, TRANSITION_FIELDS } from "../src/metrics.mjs";
// ISOLATION, and it is load-bearing rather than tidy. board.mjs records every card write to the
// state dir RESOLVED AT CALL TIME, so a test that does not set this writes its fixture cards into
// the real ~/.herdr-amq-state and evicts real card history: 194 of 200 audit slots are test
// residue, and task_1790520029313_38a378's log was unlinked while its card survived. Set at module
// scope, before any test runs, because the read happens when the write happens.
//
// `||=` so a file that already isolates keeps its own directory. The guard that keeps this true
// is test/state-isolation-guard.test.mjs; it names any file that drifts back.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-progress-clock-"));


let root;
let amqRoot;
describe("progress clock", () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "progress-clock-"));
  amqRoot = path.join(root, ".agent-mail");
  fs.mkdirSync(amqRoot, { recursive: true });

  const tick = (ms = 1100) => new Promise((r) => setTimeout(r, ms));
  const load = (id) => {
    const g = getBoardTask(root, amqRoot, id);
    return g.task || g;
  };
  const makeCard = (extra = {}) => {
    const c = addBoardTask(root, amqRoot, { title: "progress clock probe", owner: "testkit", status: "in_progress", ...extra });
    return c.task.id;
  };

  test("NEGATIVE ARM: a reason write does NOT move the progress clock", async () => {
    const id = makeCard();
    const before = cardProgressClock(load(id));
    await tick();
    updateBoardTask(root, amqRoot, id, { reason: "COORDINATOR TRIAGE - correcting a note" }, { from: "coordinator" });
    const after = cardProgressClock(load(id));
    assert.equal(after, before, "writing prose must not count as progress");
  });

  test("NEGATIVE ARM: a notes write does NOT move the progress clock", async () => {
    const id = makeCard();
    const before = cardProgressClock(load(id));
    await tick();
    updateBoardTask(root, amqRoot, id, { notes: [{ at: new Date().toISOString(), author: "coordinator", text: "note" }] }, { from: "coordinator" });
    assert.equal(cardProgressClock(load(id)), before, "a note is evidence, not progress");
  });

  test("NEGATIVE ARM: a proof write does NOT move the progress clock", async () => {
    const id = makeCard();
    const before = cardProgressClock(load(id));
    await tick();
    updateBoardTask(root, amqRoot, id, { proof: "npm test 351/351" }, { from: "coordinator" });
    assert.equal(cardProgressClock(load(id)), before, "a proof is evidence, not progress");
  });

  test("POSITIVE ARM: a status change DOES move the progress clock", async () => {
    const id = makeCard();
    const before = cardProgressClock(load(id));
    await tick();
    updateBoardTask(root, amqRoot, id, { status: "blocked" }, { from: "coordinator", reason: "real transition" });
    const after = cardProgressClock(load(id));
    assert.ok(after > before, "a status change is progress and must advance the clock");
  });

  test("POSITIVE ARM: an owner change DOES move the progress clock", async () => {
    const id = makeCard();
    const before = cardProgressClock(load(id));
    await tick();
    updateBoardTask(root, amqRoot, id, { owner: "qa" }, { from: "coordinator" });
    assert.ok(cardProgressClock(load(id)) > before, "reassigning a card is progress");
  });

  test("POSITIVE ARM: an explicit next_actor change DOES move the clock", async () => {
    const id = makeCard();
    const before = cardProgressClock(load(id));
    await tick();
    updateBoardTask(root, amqRoot, id, { next_actor: "spotter" }, { from: "coordinator" });
    assert.ok(cardProgressClock(load(id)) > before, "handing a card on is progress");
  });

  test("the incentive is gone: a write to a card cannot buy silence", async () => {
    // The property that actually broke: the observer could move the metric by touching
    // the thing measured. Asserted as a permanent invariant, not just described.
    const id = makeCard();
    const before = cardProgressClock(load(id));
    await tick();
    for (const write of [{ reason: "r" }, { proof: "p" }, { description: "d" }]) {
      updateBoardTask(root, amqRoot, id, write, { from: "coordinator" });
    }
    assert.equal(cardProgressClock(load(id)), before, "repeated bookkeeping must not advance progress");
  });

  test("a card with no transition stamps still yields a usable clock", async () => {
    // Legacy cards predate the stamps. They must not read as stalled-by-null or NaN.
    const id = makeCard();
    const t = load(id);
    delete t.status_at;
    delete t.owner_at;
    delete t.next_actor_at;
    const c = cardProgressClock(t);
    assert.ok(c === null || Number.isFinite(c), `expected null or a finite time, got ${c}`);
  });

  test("TRANSITION_FIELDS is exactly status/owner/next_actor", () => {
    // If this list ever grows to include a bookkeeping field the defect returns, and
    // the negative arms above will catch it. This is the tripwire for the tripwire.
    assert.deepEqual([...TRANSITION_FIELDS].sort(), ["next_actor", "owner", "status"]);
  });
});
