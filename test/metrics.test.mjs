import test from "node:test";
import assert from "node:assert/strict";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

const NOW = Date.parse("2026-09-24T17:00:00.000Z");

function board() {
  return {
    columns: {
      backlog: [{ id: "task-backlog", title: "Ready work", owner: "qa", updated: "2026-09-24T16:40:00.000Z" }],
      in_progress: [{ id: "task-doing", title: "Stalled work", owner: "range", updated: "2026-09-24T16:30:00.000Z" }],
      blocked: [{ id: "task-blocked", title: "Blocked work", owner: "meta", updated: "2026-09-24T16:45:00.000Z" }],
      done: [{ id: "task-done", title: "Finished", owner: "qa", updated: "2026-09-24T16:50:00.000Z" }],
    },
  };
}

test("coordinator metrics count stages, agent states, queue age, and stalled work", () => {
  const result = buildCoordinatorMetrics({
    handles: ["coordinator", "qa", "range", "meta", "spotter"],
    agentStatuses: {
      coordinator: { status: "working", observedAt: "2026-09-24T16:59:00.000Z" },
      qa: { status: "idle", observedAt: "2026-09-24T16:59:00.000Z" },
      range: { status: "blocked", observedAt: "2026-09-24T16:59:00.000Z" },
      meta: { status: "error", observedAt: "2026-09-24T16:59:00.000Z" },
      spotter: { status: "done", observedAt: "2026-09-24T16:40:00.000Z" },
    },
    board: board(),
    deliveredState: {
      delivered: { msg1: { attempts: 3, firstAttemptAt: "2026-09-24T16:50:00.000Z" } },
      deliveredTasks: { task1: { attempts: 2, firstAttemptAt: "2026-09-24T16:40:00.000Z" } },
    },
    resources: { cpuPercent: 80, rssGiB: 1.6, gpuVramPercent: 85, importAgeMs: 400000, heavyJobs: 3 },
    now: NOW,
    thresholds: { staleHeartbeatMs: 5 * 60 * 1000, stalledWorkMs: 10 * 60 * 1000 },
  });

  assert.deepEqual(result.agents.byStatus, { working: 1, blocked: 1, stopped: 1, idle: 1, done: 1, unknown: 0 });
  assert.deepEqual(result.cards.byStage, { backlog: 1, doing: 1, review: 0, blocked: 1, done: 1 });
  assert.equal(result.queue.activeCards, 2);
  assert.equal(result.queue.oldestAgeMs, 30 * 60 * 1000);
  assert.equal(result.retries.count, 3);
  assert.equal(result.retries.retriedItems, 2);
  assert.equal(result.retries.maxDeliveryAgeMs, 20 * 60 * 1000);
  assert.equal(result.failures.blockedCards, 1);
  assert.equal(result.stalledWork.length, 2);
  assert.ok(result.alerts.some((alert) => alert.id === "stalled_work"));
  assert.ok(result.alerts.some((alert) => alert.id === "stale_heartbeat"));
  assert.ok(result.alerts.some((alert) => alert.id === "retry_failure_trend"));
  assert.ok(result.alerts.some((alert) => alert.id === "heavy_job_cap"));
  assert.ok(result.alerts.some((alert) => alert.id === "queue_age"));
  assert.ok(result.alerts.some((alert) => alert.id === "blocked_age"));
  assert.equal(result.resources.heavyJobCap, 1);
  assert.equal(result.resources.workload.activeCards, 2);
});

test("coordinator metrics recommend action when backlog has no working agent", () => {
  const result = buildCoordinatorMetrics({
    handles: ["qa", "range"],
    agentStatuses: { qa: "idle", range: "done" },
    board: board(),
    now: NOW,
  });

  const alert = result.alerts.find((entry) => entry.id === "backlog_idle");
  assert.ok(alert);
  assert.match(alert.recommendedAction, /Assign or claim/);
  assert.doesNotMatch(alert.recommendedAction, /approve destructive/i);
});
