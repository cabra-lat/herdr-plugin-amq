import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";
import { addBoardTask, updateBoardTask, getBoardTask, cardStateChanged } from "../src/board.mjs";

const NOW = new Date("2026-09-24T17:00:00.000Z");
const OLD = "2026-09-24T16:00:00.000Z";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agmail-unattr-"));
  return { root, amqRoot: path.join(root, ".agent-mail") };
}

// The count was reported for nine alerts with no id and no stage. A count a reader
// cannot act on is what made two real backlog cards look like a constant in the
// alerting code: the number was true, and unfalsifiable from the alert itself.
test("the alert NAMES the unattributable cards, with owner, stage and id", () => {
  const result = buildCoordinatorMetrics({
    handles: ["testkit"],
    agentStatuses: { testkit: "idle" },
    board: {
      columns: {
        backlog: [{
          id: "task_backlog_1", title: "Legacy backlog card", owner: "testkit",
          stage: "backlog", status: "backlog",
          created: OLD, updated: OLD,
          last_heartbeat_at: OLD, last_heartbeat_by: null,
        }],
        in_progress: [{
          // Attributed and old, so it is genuinely STALLED: the alert has to exist
          // before it can be asked to name anything.
          id: "task_doing_1", title: "Real work", owner: "testkit",
          stage: "in_progress", status: "in_progress",
          created: OLD, updated: OLD,
          last_heartbeat_at: OLD, last_heartbeat_by: "testkit",
        }],
        blocked: [], done: [],
      },
    },
    now: NOW,
    thresholds: { stalledWorkMs: 5 * 60 * 1000 },
  });

  const alert = result.alerts.find((a) => a.id === "stalled_work");
  // The id must be in the text, or the reader cannot go and look at it.
  assert.match(alert.message, /task_backlog_1/);
  assert.match(alert.message, /stage=backlog/);
  assert.match(alert.message, /owner=testkit/);
  // And it must name the STAGE, which is the whole reason the card could not be found:
  // activeCards spans backlog/doing/review, but a search of in_progress misses it.
  const entry = result.unattributedLiveness.find((c) => c.id === "task_backlog_1");
  assert.equal(entry.stage, "backlog");
  assert.equal(entry.owner, "testkit");
});

test("a card in backlog is counted even though no in_progress search finds it", () => {
  const board = {
    columns: {
      backlog: [
        { id: "b1", title: "a", owner: "t", stage: "backlog", created: OLD, updated: OLD, last_heartbeat_at: OLD, last_heartbeat_by: null },
        { id: "b2", title: "b", owner: "t", stage: "backlog", created: OLD, updated: OLD, last_heartbeat_at: OLD, last_heartbeat_by: null },
      ],
      in_progress: [], blocked: [], done: [],
    },
  };
  const result = buildCoordinatorMetrics({
    handles: ["t"], agentStatuses: { t: "idle" }, board, now: NOW,
    thresholds: { stalledWorkMs: 5 * 60 * 1000 },
  });
  // The count is stable because the SET is stable, not because anything is hardcoded.
  assert.equal(result.unattributedLivenessCount, 2);
  assert.deepEqual(result.unattributedLiveness.map((c) => c.id).sort(), ["b1", "b2"]);
});

// Found by a live probe: an empty PATCH against the running server reset a real card's
// `updated` to the probe's timestamp. `updated` is the clock the stall detector ages, so
// a no-op write that moves it is fake progress - the exact thing heartbeatBoardTask was
// built to avoid, in the path beside it.
test("an empty PATCH does not move the card's state clock", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "No-op probe", owner: "worker", description: "d" }, { notify: false });
    assert.ok(created.ok);
    const id = created.task.id;
    const before = getBoardTask(root, amqRoot, id).task.updated;
    const later = new Date(Date.parse(before) + 60_000).toISOString();

    updateBoardTask(root, amqRoot, id, {}, { now: new Date(later) });
    assert.equal(getBoardTask(root, amqRoot, id).task.updated, before, "an empty update must not move updated");

    // Rewriting identical values is also a no-op.
    updateBoardTask(root, amqRoot, id, { title: "No-op probe" }, { now: new Date(later) });
    assert.equal(getBoardTask(root, amqRoot, id).task.updated, before, "an identical rewrite must not move updated");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a real change DOES move the state clock, so the fix is not a frozen card", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Real change", owner: "worker", description: "d" }, { notify: false });
    const id = created.task.id;
    const before = getBoardTask(root, amqRoot, id).task.updated;
    const later = new Date(Date.parse(before) + 60_000).toISOString();
    updateBoardTask(root, amqRoot, id, { title: "Renamed" }, { now: new Date(later) });
    assert.equal(getBoardTask(root, amqRoot, id).task.updated, later);
    assert.equal(getBoardTask(root, amqRoot, id).task.title, "Renamed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("clearing a field counts as a change, not as a no-op", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Clearing", owner: "worker", description: "d" }, { notify: false });
    const id = created.task.id;
    const before = getBoardTask(root, amqRoot, id).task.updated;
    const later = new Date(Date.parse(before) + 60_000).toISOString();
    updateBoardTask(root, amqRoot, id, { description: null }, { now: new Date(later) });
    assert.equal(getBoardTask(root, amqRoot, id).task.updated, later, "nulling a field is a change");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("cardStateChanged ignores `updated` itself, which is the field being decided", () => {
  const base = { id: "x", title: "t", owner: "w", updated: "A" };
  assert.equal(cardStateChanged(base, { ...base, updated: "B" }), false);
  assert.equal(cardStateChanged(base, { ...base, title: "t2" }), true);
  assert.equal(cardStateChanged({ ...base }, { ...base, filePath: "/somewhere" }), false, "filePath is write bookkeeping");
});

test("getBoardTask resolves a card the write path can update, and null for one that does not exist", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Readable", owner: "worker", description: "d" }, { notify: false });
    const found = getBoardTask(root, amqRoot, created.task.id);
    assert.ok(found, "a card that updateBoardTask can write must be readable");
    assert.equal(found.task.id, created.task.id);
    assert.equal(getBoardTask(root, amqRoot, "task_does_not_exist"), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
