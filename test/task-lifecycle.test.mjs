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
