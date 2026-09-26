import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";
import { getStateDirDivergence } from "../src/config.mjs";

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
      delivered: { msg1: { attempts: 3, firstAttemptAt: "2026-09-24T16:50:00.000Z", at: "2026-09-24T16:59:00.000Z" } },
      deliveredTasks: { task1: { attempts: 2, firstAttemptAt: "2026-09-24T16:40:00.000Z", at: "2026-09-24T16:58:00.000Z" } },
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
          updated: "2026-09-24T16:40:00.000Z",
        }, {
          id: "blocked-triaged",
          title: "Triaged block",
          owner: "worker",
          next_actor: "spotter",
          block_reason: "Waiting on spotter for the numeric capture",
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
  // A card that already carries a triage reason is excluded from the alert.
  assert.deepEqual(blocked.cards.map((card) => card.id), ["blocked-1"]);
  assert.equal(blocked.untriagedCount, 1);
  assert.equal(blocked.triagedExcludedCount, 1);
  assert.deepEqual(blocked.excludedCards.map((card) => card.id), ["blocked-triaged"]);
  assert.match(blocked.message, /1 blocked card\(s\) are UNTRIAGED/);
  assert.match(blocked.recommendedAction, /stops alerting/);
  assert.deepEqual(blocked.cards[0].dependency, ["qa proof"]);
  assert.match(blocked.recommendedAction, /heartbeat|reason/i);
  assert.match(blocked.fingerprint, /^[a-f0-9]{16}$/);
  const blockedAge = result.alerts.find((alert) => alert.id === "blocked_age");
  assert.ok(blockedAge);
  assert.deepEqual(blockedAge.cards.map((card) => card.id), ["blocked-1"]);
  assert.notEqual(blockedAge.fingerprint, blocked.fingerprint);
});

test("a fully triaged board raises no blocked alerts", () => {
  const result = buildCoordinatorMetrics({
    handles: ["coordinator", "worker"],
    agentStatuses: { coordinator: "idle", worker: "idle" },
    board: {
      columns: {
        backlog: [],
        in_progress: [],
        blocked: [{
          id: "blocked-triaged",
          title: "Triaged block",
          owner: "worker",
          next_actor: "spotter",
          block_reason: "Waiting on spotter for the numeric capture",
          updated: "2026-09-24T16:00:00.000Z",
        }],
        done: [],
      },
    },
    now: NOW,
  });
  assert.equal(result.alerts.some((alert) => alert.id === "blocked_cards"), false);
  assert.equal(result.alerts.some((alert) => alert.id === "blocked_age"), false);
  assert.equal(result.blockedWork.length, 1);
  assert.equal(result.blockedWork[0].triaged, true);
  assert.equal(result.blockedWork[0].nextActor, "spotter");
});

test("an explicit heartbeat keeps a card out of stalled_work", () => {
  const card = {
    id: "working-card",
    title: "Actively worked",
    owner: "worker",
    // State clock is 40 minutes old, but the worker heartbeated 2 minutes ago.
    updated: "2026-09-24T16:20:00.000Z",
    last_heartbeat_at: "2026-09-24T16:58:00.000Z",
  };
  const silent = { id: "quiet-card", title: "Untouched", owner: "worker", updated: "2026-09-24T16:20:00.000Z" };
  const result = buildCoordinatorMetrics({
    handles: ["coordinator", "worker"],
    agentStatuses: { coordinator: "idle", worker: "idle" },
    board: { columns: { backlog: [], in_progress: [card, silent], blocked: [], done: [] } },
    now: NOW,
    thresholds: { stalledWorkMs: 5 * 60 * 1000 },
  });
  const stalled = result.alerts.find((alert) => alert.id === "stalled_work");
  assert.ok(stalled);
  assert.deepEqual(stalled.cards.map((c) => c.id), ["quiet-card"]);
  assert.equal(stalled.cards[0].heartbeatAt, null);
  // The snake_case field the board actually writes is the one being read.
  assert.equal(stalled.cards[0].lastActivityAt, "2026-09-24T16:20:00.000Z");

  const stale = buildCoordinatorMetrics({
    handles: ["coordinator", "worker"],
    agentStatuses: { coordinator: "idle", worker: "idle" },
    board: { columns: { backlog: [], in_progress: [{ ...card, last_heartbeat_at: "2026-09-24T16:30:00.000Z" }], blocked: [], done: [] } },
    now: NOW,
    thresholds: { stalledWorkMs: 5 * 60 * 1000 },
  });
  const staleCards = stale.alerts.find((alert) => alert.id === "stalled_work").cards;
  assert.deepEqual(staleCards.map((c) => c.id), ["working-card"]);
  assert.equal(staleCards[0].heartbeatAt, "2026-09-24T16:30:00.000Z");
  assert.equal(staleCards[0].ageMs, 30 * 60 * 1000);
});

test("real retry evidence still raises retry_failure_trend", () => {
  const result = buildCoordinatorMetrics({
    handles: ["coordinator"],
    agentStatuses: { coordinator: "idle" },
    board: { columns: { backlog: [], in_progress: [], blocked: [], done: [] } },
    deliveredState: { delivered: { message: { attempts: 2, firstAttemptAt: "2026-09-24T16:50:00.000Z", at: "2026-09-24T16:59:30.000Z" } } },
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
  assert.match(stalled.recommendedAction, /heartbeat|reason/i);
});

test("retry_failure_trend self-clears once delivery stops being retried, and age alone cannot raise it", () => {
  // The defect this encodes: retryCount and retryDelayMaxMs were lifetime-cumulative,
  // and retryDelayMaxMs grew at exactly one second per second for any fixed first
  // attempt, so once any delivery had been retried the alert was over threshold
  // permanently. Time alone must never be able to raise it.
  const build = (now, delivered) => buildCoordinatorMetrics({
    handles: ["coordinator"],
    agentStatuses: { coordinator: "idle" },
    board: { columns: { backlog: [], in_progress: [], blocked: [], done: [] } },
    deliveredState: { delivered },
    now,
  });

  // Retried 1 minute before NOW: the incident is open and the alert is legitimate.
  const open = build(NOW, { stuck: { attempts: 2, firstAttemptAt: "2026-09-24T16:50:00.000Z", at: "2026-09-24T16:59:00.000Z" } });
  assert.equal(open.retries.count, 1);
  assert.equal(open.retries.retriedItems, 1);
  assert.ok(open.alerts.some((alert) => alert.id === "retry_failure_trend"), "an actively retried delivery must alert");

  // Nothing retried, but still inside the window: unchanged.
  const quiet = build(NOW + 60 * 1000, { stuck: { attempts: 2, firstAttemptAt: "2026-09-24T16:50:00.000Z", at: "2026-09-24T16:59:00.000Z" } });
  assert.equal(quiet.retries.count, 1, "still inside the window");
  assert.ok(quiet.alerts.some((alert) => alert.id === "retry_failure_trend"), "still open inside the window");

  // Past the window the incident is closed: the alert clears, and the lifetime
  // figures remain as context without ever being compared to a threshold.
  const closed = build(NOW + 20 * 60 * 1000, { stuck: { attempts: 2, firstAttemptAt: "2026-09-24T16:50:00.000Z", at: "2026-09-24T16:59:00.000Z" } });
  assert.equal(closed.retries.count, 0);
  assert.equal(closed.retries.maxDeliveryAgeMs, 0);
  assert.equal(closed.alerts.some((alert) => alert.id === "retry_failure_trend"), false, "the alert must self-clear");
  assert.equal(closed.retries.lifetime.count, 1, "lifetime context is retained");
  assert.equal(closed.retries.lifetime.retriedItems, 1);
  assert.equal(closed.retries.windowMs, 900 * 1000);

  // A four-day-old closed retry is not a trend, however old it is.
  const ancient = build(NOW, { ancient: { attempts: 2, firstAttemptAt: "2026-09-20T10:00:00.000Z", at: "2026-09-20T10:01:00.000Z" } });
  assert.equal(ancient.alerts.some((alert) => alert.id === "retry_failure_trend"), false, "a closed retry from four days ago is not a trend");
  assert.equal(ancient.retries.lifetime.count, 1);

  // A delivery still being retried keeps the alert up, and the reported age is the
  // duration of the CURRENT incident.
  const ongoing = build(NOW, { ongoing: { attempts: 4, firstAttemptAt: "2026-09-24T16:50:00.000Z", at: "2026-09-24T16:59:59.000Z" } });
  const alert = ongoing.alerts.find((entry) => entry.id === "retry_failure_trend");
  assert.ok(alert, "3 retries inside the last minute must alert");
  assert.equal(alert.retryCount, 3);
  assert.equal(alert.retryCountLifetime, 3);
  assert.equal(alert.retryDelayMaxMs, 10 * 60 * 1000, "age of the current incident");
  assert.equal(alert.retryWindowMs, 900 * 1000);
  assert.match(alert.message, /last 900s/, "the message must say the measurement is windowed");
});

test("a split state directory is reported instead of silently reading a stale file", () => {
  // getStateDir() resolves to $HERDR_PLUGIN_STATE_DIR for a process herdr spawned and
  // to ~/.herdr-amq-state for one started from a shell. Both files existed on this
  // machine, and a delivery-history comparison across the two produced a confident,
  // completely wrong conclusion. The divergence must be visible, not inferred.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "state-split-home-"));
  const herdrDir = path.join(home, ".local", "state", "herdr", "plugins", "cabra.amq");
  const legacyDir = path.join(home, ".herdr-amq-state");
  fs.mkdirSync(herdrDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(herdrDir, "bridge-state.json"), JSON.stringify({ delivered: { a: { attempts: 9 } } }));
  fs.writeFileSync(path.join(legacyDir, "bridge-state.json"), JSON.stringify({ delivered: { b: { attempts: 1 } } }));

  const env = { HOME: home };
  const split = getStateDirDivergence(env);
  assert.ok(split, "two state directories holding delivery state must be reported");
  assert.deepEqual(
    [...split.directories].sort(),
    [herdrDir, legacyDir].sort(),
    "both directories must be named so the reader knows they are different histories",
  );

  // A single state directory is not a divergence, or the warning becomes noise.
  fs.rmSync(path.join(legacyDir, "bridge-state.json"));
  assert.equal(getStateDirDivergence(env), null);

  fs.rmSync(home, { recursive: true, force: true });
});
