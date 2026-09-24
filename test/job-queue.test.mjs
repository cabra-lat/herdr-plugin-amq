import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobQueue } from "../src/job-queue.mjs";

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-amq-jobs-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }), ...options };
}

test("durable queue enforces idempotency and explicit states", () => {
  const f = fixture();
  try {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const queue = new JobQueue({ stateFile: path.join(f.root, "jobs.json"), now: () => now });
    const job = queue.enqueue({ title: "lint", command: ["echo", "ok"], idempotencyKey: "lint-1" });
    assert.equal(job.status, "queued");
    assert.equal(queue.enqueue({ title: "lint", command: ["echo", "ok"], idempotencyKey: "lint-1" }).id, job.id);
    assert.throws(() => queue.enqueue({ command: ["echo", "different"], idempotencyKey: "lint-1" }), /different job/);
    assert.throws(() => queue.enqueue({ kind: "godot", command: ["godot"], idempotencyKey: "godot-1" }), /lockWrapper/);

    const claimed = queue.claimNext({ workerId: "w1" });
    assert.equal(claimed.status, "running");
    assert.equal(claimed.attempts, 1);
    assert.equal(queue.claimNext({ workerId: "w2" }), null);
    assert.equal(queue.heartbeat(claimed.id, "w1"), true);
    assert.equal(queue.complete(claimed.id, "w1", { exitCode: 0 }).status, "succeeded");

    const reopened = new JobQueue({ stateFile: path.join(f.root, "jobs.json"), now: () => now });
    assert.equal(reopened.get(job.id).status, "succeeded");
    assert.equal(reopened.metrics().outcomes.succeeded, 1);
    now += 1;
  } finally { f.cleanup(); }
});

test("non-Godot concurrency is bounded while Godot work is serialized", () => {
  const f = fixture();
  try {
    const queue = new JobQueue({ stateFile: path.join(f.root, "jobs.json"), maxConcurrency: 2, godotConcurrency: 1 });
    queue.enqueue({ command: ["a"], idempotencyKey: "a" });
    queue.enqueue({ command: ["b"], idempotencyKey: "b" });
    queue.enqueue({ command: ["c"], idempotencyKey: "c" });
    const first = queue.claimNext({ workerId: "w1" });
    const second = queue.claimNext({ workerId: "w2" });
    assert.ok(first && second);
    assert.equal(queue.claimNext({ workerId: "w3" }), null, "third non-Godot job waits at the concurrency cap");

    const lockWrapper = path.join(f.root, "tools", "godot-lock.sh");
    fs.mkdirSync(path.dirname(lockWrapper), { recursive: true });
    fs.writeFileSync(lockWrapper, "#!/bin/sh\nflock -w 900 9\nLOCK_FILE=\"/tmp/shooter/verify-all.$(printf '%s' \"$PWD\" | cksum | cut -d' ' -f1).lock\"\nexec \"$GODOT_BIN\" \"$@\"\n", { mode: 0o755 });
    const godotQueue = new JobQueue({ stateFile: path.join(f.root, "godot.json"), expectedLockWrapper: lockWrapper });
    godotQueue.enqueue({ kind: "godot", command: ["godot", "--headless"], lockWrapper, idempotencyKey: "g1" });
    godotQueue.enqueue({ kind: "godot", command: ["godot", "--editor"], lockWrapper, idempotencyKey: "g2" });
    assert.throws(() => godotQueue.enqueue({ kind: "godot", command: ["godot", "--headless"], lockWrapper: path.join(f.root, "other", "godot-lock.sh"), idempotencyKey: "fake" }), /canonical repository/);
    assert.equal(godotQueue.claimNext({ workerId: "g1" }).kind, "godot");
    assert.equal(godotQueue.claimNext({ workerId: "g2" }), null, "Godot jobs never bypass the one-job cap");
  } finally { f.cleanup(); }
});

test("cancellation is non-destructive and never restarts a running process", async () => {
  const f = fixture();
  try {
    let release;
    const done = new Promise((resolve) => { release = resolve; });
    const queue = new JobQueue({
      stateFile: path.join(f.root, "jobs.json"),
      runner: async () => { await done; return { exitCode: 0 }; },
    });
    const job = queue.enqueue({ command: ["long-task"], idempotencyKey: "long-1" });
    const running = queue.runOne({ workerId: "w1" });
    assert.equal(queue.get(job.id).status, "running");
    assert.equal(queue.cancel(job.id).status, "cancelled");
    release();
    assert.equal((await running).status, "cancelled");
    assert.equal(queue.metrics().counts.running, 0);
  } finally { f.cleanup(); }
});

test("legacy array state is migrated and history retention stays bounded", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "jobs.json"), JSON.stringify([{ id: "legacy-1", status: "queued", command: ["legacy"] }]));
    const queue = new JobQueue({ stateFile: path.join(f.root, "jobs.json"), historyLimit: 10 });
    assert.equal(queue.get("legacy-1").command[0], "legacy");
    for (let index = 0; index < 12; index++) queue.enqueue({ command: ["job", String(index)], idempotencyKey: `retention-${index}` });
    const reopened = new JobQueue({ stateFile: path.join(f.root, "jobs.json"), historyLimit: 10 });
    assert.equal(reopened.get("legacy-1").command[0], "legacy");
    const history = reopened.metrics().retention;
    assert.equal(history.historyLimit, 10);
    assert.ok(history.historyCount <= 10);
  } finally { f.cleanup(); }
});

test("expired heartbeat fences the worker and persists failed state", () => {
  const f = fixture();
  try {
    let now = 1000;
    const file = path.join(f.root, "jobs.json");
    const queue = new JobQueue({ stateFile: file, leaseMs: 1000, now: () => now });
    const job = queue.enqueue({ command: ["worker"], idempotencyKey: "heartbeat-expiry" });
    queue.claimNext({ workerId: "stale-worker" });
    now += 1001;
    assert.equal(queue.heartbeat(job.id, "stale-worker"), false);
    assert.equal(queue.get(job.id).status, "failed");
    const reopened = new JobQueue({ stateFile: file, now: () => now });
    assert.equal(reopened.get(job.id).status, "failed");
  } finally { f.cleanup(); }
});

test("interrupted legacy migration leaves the prior state recoverable and upgrades idempotently", () => {
  const f = fixture();
  try {
    const file = path.join(f.root, "jobs.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "legacy-interrupted", status: "queued", command: ["legacy"] }]));
    const beforeMutation = new JobQueue({ stateFile: file });
    assert.equal(beforeMutation.get("legacy-interrupted").command[0], "legacy");
    assert.deepEqual(beforeMutation.list().map((job) => job.id), ["legacy-interrupted"]);
    beforeMutation.enqueue({ command: ["new"], idempotencyKey: "new-after-migration" });
    const firstUpgrade = new JobQueue({ stateFile: file });
    const secondUpgrade = new JobQueue({ stateFile: file });
    assert.equal(firstUpgrade.get("legacy-interrupted").command[0], "legacy");
    assert.equal(secondUpgrade.get("legacy-interrupted").command[0], "legacy");
    assert.equal(secondUpgrade.get("legacy-interrupted").status, "queued");
  } finally { f.cleanup(); }
});

test("malformed queue state fails closed without overwriting the file", () => {
  const f = fixture();
  try {
    const file = path.join(f.root, "jobs.json");
    fs.writeFileSync(file, "{ interrupted");
    const queue = new JobQueue({ stateFile: file });
    assert.deepEqual(queue.list(), []);
    assert.equal(fs.readFileSync(file, "utf8"), "{ interrupted");
  } finally { f.cleanup(); }
});

test("expired leases fail closed and remain observable", () => {
  const f = fixture();
  try {
    let now = 1000;
    const queue = new JobQueue({ stateFile: path.join(f.root, "jobs.json"), leaseMs: 1000, now: () => now });
    const job = queue.enqueue({ command: ["worker"], idempotencyKey: "lease-1" });
    queue.claimNext({ workerId: "dead-worker" });
    now += 1001;
    assert.equal(queue.metrics().counts.failed, 1, "current state is recovered before metrics are returned");
    assert.equal(queue.get(job.id).status, "failed");
    const reopened = new JobQueue({ stateFile: path.join(f.root, "jobs.json"), now: () => now });
    assert.equal(reopened.get(job.id).status, "failed");
    assert.match(reopened.get(job.id).error, /lease expired/);
    assert.equal(reopened.metrics().outcomes.failed, 1);
  } finally { f.cleanup(); }
});
