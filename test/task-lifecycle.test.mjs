import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  addBoardTask,
  heartbeatBoardTask,
  parseTaskFile,
  reassignBoardTask,
  updateBoardTask,
  loadBoard,
} from "../src/board.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amq-lifecycle-"));
  const amqRoot = path.join(root, ".agent-mail");
  fs.mkdirSync(amqRoot, { recursive: true });
  return { root, amqRoot };
}

test("task lifecycle persists v1 fields and proof/reason with fake clock", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, {
      title: "Lifecycle proof",
      owner: "qa",
      priority: "P1",
      depends_on: ["task_prerequisite"],
      next_actor: "qa",
      description: "Persist the lifecycle contract.",
    }, { notify: false, now: new Date("2026-09-24T10:00:00.000Z") });
    assert.equal(created.ok, true);

    const claimed = updateBoardTask(root, amqRoot, created.task.id, { status: "in_progress", owner: "qa" }, {
      notify: false,
      now: new Date("2026-09-24T10:01:00.000Z"),
    });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.task.claimed_at, "2026-09-24T10:01:00.000Z");
    assert.equal(claimed.task.claims, 1);
    assert.equal(claimed.task.last_heartbeat_at, "2026-09-24T10:01:00.000Z");

    const blocked = updateBoardTask(root, amqRoot, created.task.id, { status: "blocked" }, {
      reason: "Waiting for numeric capture",
      notify: false,
      now: new Date("2026-09-24T10:02:00.000Z"),
    });
    assert.equal(blocked.ok, true);
    assert.equal(blocked.task.blocked_at, "2026-09-24T10:02:00.000Z");
    assert.equal(blocked.task.block_reason, "Waiting for numeric capture");
    // Blocking no longer invents a next actor: the field keeps the claim-time
    // value instead of a confidently wrong "coordinator".
    assert.equal(blocked.task.next_actor, "qa");

    updateBoardTask(root, amqRoot, created.task.id, { status: "in_progress" }, {
      notify: false,
      now: new Date("2026-09-24T10:04:00.000Z"),
    });
    const done = updateBoardTask(root, amqRoot, created.task.id, { status: "done" }, {
      proof: "3/3 checks passed",
      notify: false,
      now: new Date("2026-09-24T10:05:00.000Z"),
    });
    assert.equal(done.ok, true);
    assert.equal(done.task.proof, "3/3 checks passed");
    assert.equal(done.task.block_reason, "Waiting for numeric capture");
    assert.equal(done.task.blocked_ms, 2 * 60 * 1000);
    assert.equal(done.task.done_at, "2026-09-24T10:05:00.000Z");
    assert.deepEqual(done.task.depends_on, ["task_prerequisite"]);
    assert.equal(done.task.priority, "P1");

    const file = path.join(amqRoot, "bus", "done", `${created.task.id}.md`);
    const parsed = parseTaskFile(file, "done");
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.proof, "3/3 checks passed");
    assert.equal(parsed.block_reason, "Waiting for numeric capture");
    assert.equal(parsed.next_actor, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy task cards remain readable and are upgraded on next update", () => {
  const { root, amqRoot } = fixture();
  try {
    const bus = path.join(amqRoot, "bus", "backlog");
    fs.mkdirSync(bus, { recursive: true });
    const id = "task-legacy";
    fs.writeFileSync(path.join(bus, `${id}.md`), [
      "---",
      `id: ${id}`,
      'title: "Legacy card"',
      'owner: "range"',
      'status: "backlog"',
      'created: "2026-01-01T00:00:00.000Z"',
      'updated: "2026-01-01T00:00:00.000Z"',
      "---",
      "Legacy description",
      "",
    ].join("\n"));

    const board = loadBoard(root, amqRoot);
    const legacy = board.columns.backlog.find((task) => task.id === id);
    assert.ok(legacy);
    assert.equal(legacy.schema_version, 0);
    assert.equal(legacy.priority, "normal");
    assert.deepEqual(legacy.depends_on, []);

    const updated = updateBoardTask(root, amqRoot, id, { status: "in_progress" }, {
      notify: false,
      now: new Date("2026-01-01T00:01:00.000Z"),
    });
    assert.equal(updated.task.schema_version, 1);
    assert.equal(updated.task.claims, 1);
    assert.equal(updated.task.priority, "normal");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat records liveness without touching card activity", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Heartbeat", owner: "qa", description: "Liveness." }, {
      notify: false,
      now: new Date("2026-09-24T10:00:00.000Z"),
    });
    updateBoardTask(root, amqRoot, created.task.id, { status: "in_progress", owner: "qa" }, {
      notify: false,
      now: new Date("2026-09-24T10:01:00.000Z"),
    });

    const beat = heartbeatBoardTask(root, amqRoot, created.task.id, {
      actor: "qa",
      now: new Date("2026-09-24T10:20:00.000Z"),
    });
    assert.equal(beat.ok, true);
    assert.equal(beat.last_heartbeat_at, "2026-09-24T10:20:00.000Z");
    // Liveness only: no state change, no claim churn, no `updated` bump.
    assert.equal(beat.task.updated, "2026-09-24T10:01:00.000Z");
    assert.equal(beat.task.status, "in_progress");
    assert.equal(beat.task.claims, 1);
    assert.equal(beat.task.claimed_at, "2026-09-24T10:01:00.000Z");

    // A second in-progress update must not clobber a newer heartbeat.
    const again = updateBoardTask(root, amqRoot, created.task.id, { status: "in_progress" }, {
      notify: false,
      now: new Date("2026-09-24T10:21:00.000Z"),
    });
    assert.equal(again.task.last_heartbeat_at, "2026-09-24T10:20:00.000Z");

    const done = updateBoardTask(root, amqRoot, created.task.id, { status: "done" }, {
      proof: "ok",
      notify: false,
      now: new Date("2026-09-24T10:30:00.000Z"),
    });
    assert.equal(done.ok, true);
    const refused = heartbeatBoardTask(root, amqRoot, created.task.id, { actor: "qa" });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /done/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reassign changes owner and blocked next actor is explicit or absent", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Ownership", owner: "qa", description: "Fields." }, {
      notify: false,
      now: new Date("2026-09-24T10:00:00.000Z"),
    });
    const moved = reassignBoardTask(root, amqRoot, created.task.id, {
      owner: "coordinator",
      from: "coordinator",
      now: new Date("2026-09-24T10:01:00.000Z"),
    });
    assert.equal(moved.ok, true);
    assert.equal(moved.task.owner, "coordinator");
    // Same id, no claim churn from a metadata-only change.
    assert.equal(moved.task.id, created.task.id);
    assert.equal(moved.task.claims, 0);

    // Blocking without an explicit next actor leaves the field absent rather than
    // inventing one, and the value is queryable.
    const blocked = updateBoardTask(root, amqRoot, created.task.id, {
      status: "blocked",
      next_actor: "spotter",
      depends_on: ["task_123"],
    }, { reason: "Waiting on spotter", notify: false, now: new Date("2026-09-24T10:02:00.000Z") });
    assert.equal(blocked.task.next_actor, "spotter");
    assert.deepEqual(blocked.task.depends_on, ["task_123"]);

    const cleared = updateBoardTask(root, amqRoot, created.task.id, { next_actor: null }, {
      notify: false,
      now: new Date("2026-09-24T10:03:00.000Z"),
    });
    assert.equal(cleared.task.next_actor, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a heartbeat by a non-owner is recorded as such", async () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Ownership of liveness", owner: "worker", description: "Who said it is alive." }, {
      notify: false,
      now: new Date("2026-09-24T10:00:00.000Z"),
    });
    updateBoardTask(root, amqRoot, created.task.id, { status: "in_progress", owner: "worker" }, {
      notify: false,
      now: new Date("2026-09-24T10:01:00.000Z"),
    });

    const byOther = heartbeatBoardTask(root, amqRoot, created.task.id, {
      actor: "coordinator",
      now: new Date("2026-09-24T10:10:00.000Z"),
    });
    assert.equal(byOther.last_heartbeat_by, "coordinator");
    assert.equal(byOther.task.owner, "worker");

    const { buildCoordinatorMetrics } = await import("../src/metrics.mjs");
    const result = buildCoordinatorMetrics({
      handles: ["coordinator", "worker"],
      agentStatuses: { coordinator: "idle", worker: "idle" },
      board: { columns: { backlog: [], in_progress: [byOther.task], blocked: [], done: [] } },
      now: new Date("2026-09-24T10:12:00.000Z"),
      thresholds: { stalledWorkMs: 5 * 60 * 1000 },
    });
    // Fresh liveness, so it is not stalled, but the author is still visible.
    assert.equal(result.stalledWork.length, 0);

    const stale = { ...byOther.task, last_heartbeat_at: "2026-09-24T10:00:30.000Z" };
    const stalled = buildCoordinatorMetrics({
      handles: ["coordinator", "worker"],
      agentStatuses: { coordinator: "idle", worker: "idle" },
      board: { columns: { backlog: [], in_progress: [stale], blocked: [], done: [] } },
      now: new Date("2026-09-24T10:12:00.000Z"),
      thresholds: { stalledWorkMs: 5 * 60 * 1000 },
    });
    const card = stalled.alerts.find((alert) => alert.id === "stalled_work").cards[0];
    assert.equal(card.heartbeatBy, "coordinator");
    assert.equal(card.heartbeatByNonOwner, true);
    assert.equal(card.heartbeatAgeMs, 11.5 * 60 * 1000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A liveness clock without an attributable author is a claim no reader can
// discount, and the stall detector honours the clock regardless. These tests
// were written after the finding that 128 of 138 live cards carried a
// last_heartbeat_at with last_heartbeat_by: null, so the clock that makes a
// card look alive had no accountable source.
test("a first claim records BOTH the liveness clock and the actor who set it", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Attributed claim", owner: "spotter" }, { notify: false });
    assert.equal(created.task.last_heartbeat_at, null);

    const claimed = updateBoardTask(root, amqRoot, created.task.id, { status: "in_progress", owner: "spotter" }, {
      from: "spotter",
      notify: false,
      now: new Date("2026-09-24T11:00:00.000Z"),
    });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.task.last_heartbeat_at, "2026-09-24T11:00:00.000Z");
    // The whole defect: this was null, so the detector reported "by=unknown".
    assert.equal(claimed.task.last_heartbeat_by, "spotter");

    // A coordinator claiming on someone's behalf records the coordinator, not the owner.
    const other = addBoardTask(root, amqRoot, { title: "Claimed by proxy", owner: "range" }, { notify: false });
    const proxied = updateBoardTask(root, amqRoot, other.task.id, { status: "in_progress", owner: "range" }, {
      from: "coordinator",
      notify: false,
    });
    assert.equal(proxied.task.last_heartbeat_by, "coordinator");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an ordinary in-progress update does not invent a liveness clock", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "No invented liveness", owner: "qa" }, { notify: false });
    const claimed = updateBoardTask(root, amqRoot, created.task.id, { status: "in_progress", owner: "qa" }, { from: "qa", notify: false });

    // A later in-progress update by a different handle must not restamp the clock,
    // which would make the card look alive to whoever last edited it.
    const later = updateBoardTask(root, amqRoot, created.task.id, { status: "in_progress" }, {
      from: "coordinator",
      notify: false,
      now: new Date("2026-09-24T12:00:00.000Z"),
    });
    assert.equal(later.task.last_heartbeat_at, claimed.task.last_heartbeat_at);
    assert.equal(later.task.last_heartbeat_by, "qa");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a heartbeat with no actor is refused and moves nothing", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Unnamed heartbeat", owner: "qa" }, { notify: false });
    const claimed = updateBoardTask(root, amqRoot, created.task.id, { status: "in_progress", owner: "qa" }, { from: "qa", notify: false });

    for (const missing of [undefined, null, "", "   "]) {
      const res = heartbeatBoardTask(root, amqRoot, created.task.id, { actor: missing });
      assert.equal(res.ok, false, `actor ${JSON.stringify(missing)} must be refused`);
      assert.match(res.error, /must name its actor/);
    }

    // Refused means untouched: the clock is still the claim's, and the author is still qa.
    const cardPath = path.join(root, ".agent-mail", "bus", "doing", `${created.task.id}.md`);
    assert.ok(fs.existsSync(cardPath), `expected the card in doing/, found ${cardPath}`);
    const after = parseTaskFile(cardPath, "in_progress");
    assert.equal(after.last_heartbeat_at, claimed.task.last_heartbeat_at);
    assert.equal(after.last_heartbeat_by, "qa");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a heartbeat never records the literal string 'unknown' as its author", () => {
  // "unknown" reads as a name to a human reader and is truthy, so it survives the
  // metrics `last_heartbeat_by || null` projection and is displayed as an author.
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "No unknown authors", owner: "" }, { notify: false });
    const res = heartbeatBoardTask(root, amqRoot, created.task.id, { actor: "coordinator" });
    assert.equal(res.ok, true);
    assert.equal(res.last_heartbeat_by, "coordinator");
    assert.notEqual(res.last_heartbeat_by, "unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
