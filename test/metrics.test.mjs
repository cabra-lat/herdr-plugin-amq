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
  assert.ok(result.alerts.some((alert) => alert.id === "blocked_cards"));
  assert.ok(result.alerts.some((alert) => alert.id === "heavy_job_cap"));
  assert.ok(result.alerts.some((alert) => alert.id === "queue_age"));
  assert.ok(result.alerts.some((alert) => alert.id === "blocked_age"));
  assert.equal(result.resources.heavyJobCap, 1);
  assert.equal(result.resources.workload.activeCards, 2);
});

test("blocked cards alert separately and do not fake retry evidence", () => {
  const result = buildCoordinatorMetrics({
    handles: ["coordinator", "worker"],
    agentStatuses: { coordinator: "idle", worker: "idle" },
    board: {
      columns: {
        backlog: [],
        in_progress: [],
        blocked: [{
          id: "blocked-1",
          title: "Waiting on dependency",
          owner: "worker",
          next_actor: "coordinator",
          depends_on: ["qa proof"],
          block_reason: "Waiting for QA",
          updated: "2026-09-24T16:40:00.000Z",
        }],
        done: [],
      },
    },
    deliveredState: { delivered: { delivered_once: { attempts: 1, firstAttemptAt: "2026-09-24T16:00:00.000Z" } } },
    now: NOW,
  });

  assert.equal(result.retries.count, 0);
  assert.equal(result.alerts.some((alert) => alert.id === "retry_failure_trend"), false);
  const blocked = result.alerts.find((alert) => alert.id === "blocked_cards");
  assert.ok(blocked);
  assert.equal(blocked.cards[0].nextActor, "coordinator");
  assert.deepEqual(blocked.cards[0].dependency, ["qa proof"]);
  assert.match(blocked.recommendedAction, /next actor\/dependency/);
  assert.match(blocked.fingerprint, /^[a-f0-9]{16}$/);
  const blockedAge = result.alerts.find((alert) => alert.id === "blocked_age");
  assert.ok(blockedAge);
  assert.deepEqual(blockedAge.cards.map((card) => card.id), ["blocked-1"]);
  assert.notEqual(blockedAge.fingerprint, blocked.fingerprint);
});

test("real retry evidence still raises retry_failure_trend", () => {
  const result = buildCoordinatorMetrics({
    handles: ["coordinator"],
    agentStatuses: { coordinator: "idle" },
    board: { columns: { backlog: [], in_progress: [], blocked: [], done: [] } },
    deliveredState: { delivered: { message: { attempts: 2, firstAttemptAt: "2026-09-24T16:50:00.000Z" } } },
    now: NOW,
  });

  assert.equal(result.retries.count, 1);
  assert.ok(result.alerts.some((alert) => alert.id === "retry_failure_trend"));
  assert.match(result.alerts.find((alert) => alert.id === "retry_failure_trend").message, /1 doorbell retry/);
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

test("stalled_work surfaces note recency as evidence without making notes liveness", () => {
  const result = buildCoordinatorMetrics({
    handles: ["coordinator", "worker"],
    agentStatuses: { coordinator: "idle", worker: "idle" },
    board: {
      columns: {
        backlog: [],
        in_progress: [
          {
            id: "stalled-with-notes",
            title: "Actively worked card",
            owner: "worker",
            // `updated` is 40 minutes old: a note must NOT make this card fresh.
            updated: "2026-09-24T16:20:00.000Z",
            notes: [
              { at: "2026-09-24T16:25:00.000Z", author: "worker", text: "first progress note" },
              { at: "2026-09-24T16:50:00.000Z", author: "worker", text: "most recent progress note" },
              { at: "", author: "worker", text: "" },
            ],
          },
          {
            id: "stalled-silent",
            title: "Ignored card",
            owner: "worker",
            updated: "2026-09-24T16:10:00.000Z",
          },
        ],
        blocked: [],
        done: [],
      },
    },
    now: NOW,
    thresholds: { stalledWorkMs: 5 * 60 * 1000 },
  });

  const stalled = result.alerts.find((alert) => alert.id === "stalled_work");
  assert.ok(stalled);
  const withNotes = stalled.cards.find((card) => card.id === "stalled-with-notes");
  const silent = stalled.cards.find((card) => card.id === "stalled-silent");

  // Both cards are still stalled: notes never move `updated`.
  assert.equal(withNotes.ageMs, 40 * 60 * 1000);
  assert.equal(silent.ageMs, 50 * 60 * 1000);
  assert.deepEqual(stalled.cards.map((card) => card.id).sort(), ["stalled-silent", "stalled-with-notes"]);

  // Note evidence is surfaced, and empty notes are not counted.
  assert.equal(withNotes.noteCount, 2);
  assert.equal(withNotes.lastNoteAt, "2026-09-24T16:50:00.000Z");
  assert.equal(withNotes.noteAgeMs, 10 * 60 * 1000);
  assert.equal(silent.noteCount, 0);
  assert.equal(silent.lastNoteAt, null);
  assert.equal(silent.noteAgeMs, null);

  assert.equal(stalled.cardsWithNotes, 1);
  assert.equal(stalled.stalledCount, 2);
  assert.match(stalled.message, /1 of them carry notes/);
  assert.match(stalled.recommendedAction, /note recency/);
});
