import { createHash } from "node:crypto";

const DEFAULT_THRESHOLDS = Object.freeze({
  queueWarnMs: 300 * 1000,
  queueCriticalMs: 900 * 1000,
  queuePageMs: 1800 * 1000,
  blockedWarnMs: 600 * 1000,
  blockedCriticalMs: 1800 * 1000,
  staleHeartbeatMs: 30 * 1000,
  staleHeartbeatCriticalMs: 120 * 1000,
  stalledWorkMs: 600 * 1000,
  retryWarningCount: 2,
  retryCriticalCount: 3,
  retryDelayWarnMs: 300 * 1000,
  importWarnMs: 120 * 1000,
  importCriticalMs: 300 * 1000,
  cpuWarnPercent: 75,
  cpuSustainMs: 60 * 1000,
  rssWarnGiB: 1,
  rssCriticalGiB: 1.5,
  gpuVramWarnPercent: 80,
  heavyJobCap: 1,
});

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function ageMs(value, now) {
  const created = timestamp(value);
  return created === null ? null : Math.max(0, now - created);
}

function conditionFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function cardCondition(cards) {
  return (cards || []).map((card) => ({
    id: card.id,
    owner: card.owner || null,
    nextActor: card.nextActor || null,
    dependency: card.dependency || null,
    reason: card.reason || null,
  }));
}

function normalizeStatus(value) {
  const status = String(value || "unknown").toLowerCase();
  if (["active", "working"].includes(status)) return "working";
  if (["online", "idle"].includes(status)) return "idle";
  if (["stopped", "offline", "error"].includes(status)) return "stopped";
  if (["blocked"].includes(status)) return "blocked";
  if (["done"].includes(status)) return "done";
  return status;
}

function stateValue(value) {
  if (typeof value === "string") return { status: value, observedAt: null, heartbeatAt: null };
  if (!value || typeof value !== "object") return { status: "unknown", observedAt: null, heartbeatAt: null };
  return {
    status: value.status || value.herdrStatus || value.state || "unknown",
    observedAt: value.observedAt || value.herdrObservedAt || value.updatedAt || null,
    heartbeatAt: value.heartbeatAt || value.lastHeartbeat || value.observedAt || value.herdrObservedAt || null,
  };
}

/**
 * Build coordinator metrics from already-loaded board and Herdr state.
 * This is pure: callers choose when to collect state and how to alert.
 */
export function buildCoordinatorMetrics({
  handles = [],
  agentStatuses = {},
  board = { columns: {} },
  deliveredState = {},
  resources = {},
  jobQueue = null,
  now = Date.now(),
  thresholds = {},
} = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const statuses = {};
  const statusCounts = { working: 0, blocked: 0, stopped: 0, idle: 0, done: 0, unknown: 0 };
  const staleHeartbeats = [];

  for (const handle of handles) {
    const raw = agentStatuses?.[handle];
    const value = stateValue(raw);
    const status = normalizeStatus(value.status);
    statuses[handle] = {
      status,
      observedAt: value.observedAt,
      heartbeatAt: value.heartbeatAt,
      ageMs: ageMs(value.heartbeatAt, now),
    };
    if (Object.hasOwn(statusCounts, status)) statusCounts[status] += 1;
    else statusCounts.unknown += 1;
    if (statuses[handle].ageMs !== null && statuses[handle].ageMs > limits.staleHeartbeatMs) {
      staleHeartbeats.push({ handle, ageMs: statuses[handle].ageMs, status });
    }
  }

  const allCards = Object.values(board.columns || {}).flat().filter(Boolean);
  const cardsByStage = { backlog: 0, doing: 0, review: 0, blocked: 0, done: 0 };
  const activeCards = [];
  for (const [columnName, columnTasks] of Object.entries(board.columns || {})) {
    const stage = columnName === "in_progress" ? "doing" : columnName;
    for (const task of (Array.isArray(columnTasks) ? columnTasks : []).filter(Boolean)) {
      if (Object.hasOwn(cardsByStage, stage)) cardsByStage[stage] += 1;
      if (["backlog", "doing", "review"].includes(stage)) activeCards.push(task);
    }
  }
  const queueAgeMs = activeCards.reduce((oldest, task) => {
    const age = ageMs(task.updated || task.created, now);
    return age === null ? oldest : Math.max(oldest, age);
  }, 0);
  const stalledCards = activeCards
    .map((task) => ({ id: task.id, title: task.title, owner: task.owner || null, ageMs: ageMs(task.updated || task.created, now) }))
    .filter((task) => task.ageMs !== null && task.ageMs > limits.stalledWorkMs);
  const blockedWork = [];
  for (const [columnName, columnTasks] of Object.entries(board.columns || {})) {
    if (columnName !== "blocked") continue;
    for (const task of (Array.isArray(columnTasks) ? columnTasks : []).filter(Boolean)) {
      const ageMsValue = Number.isFinite(Number(task.blocked_ms))
        ? Number(task.blocked_ms)
        : ageMs(task.blocked_at || task.updated || task.created, now);
      blockedWork.push({
        id: task.id,
        title: task.title,
        owner: task.owner || null,
        nextActor: task.next_actor || task.nextActor || task.owner || null,
        dependency: task.depends_on || task.dependency || null,
        reason: task.block_reason || task.reason || null,
        ageMs: ageMsValue,
      });
    }
  }

  const deliveryEntries = [
    ...Object.values(deliveredState?.delivered || {}),
    ...Object.values(deliveredState?.deliveredTasks || {}),
  ];
  const retryCount = deliveryEntries.reduce((sum, entry) => sum + Math.max(0, (Number(entry?.attempts) || 1) - 1), 0);
  const retriedItems = deliveryEntries.filter((entry) => (Number(entry?.attempts) || 1) > 1).length;
  const retryEntries = deliveryEntries.filter((entry) => (Number(entry?.attempts) || 1) > 1);
  const retryDelayMaxMs = retryEntries.reduce((max, entry) => {
    const first = timestamp(entry?.firstAttemptAt || entry?.firstDeliveredAt);
    return first === null ? max : Math.max(max, Math.max(0, now - first));
  }, 0);
  const failureCount = cardsByStage.blocked;
  const resource = {
    cpuPercent: null,
    rssGiB: null,
    gpuVramPercent: null,
    importAgeMs: null,
    heavyJobs: null,
    ...(resources || {}),
  };
  const resourceAlerts = [];
  if (Number(resource.cpuPercent) >= limits.cpuWarnPercent) {
    resourceAlerts.push({ id: "cpu_pressure", severity: "warning", message: `CPU is ${resource.cpuPercent}%, at or above the ${limits.cpuWarnPercent}% threshold.` });
  }
  if (Number(resource.rssGiB) >= limits.rssCriticalGiB) {
    resourceAlerts.push({ id: "rss_pressure", severity: "critical", message: `RSS is ${resource.rssGiB} GiB, at or above the ${limits.rssCriticalGiB} GiB threshold.` });
  } else if (Number(resource.rssGiB) >= limits.rssWarnGiB) {
    resourceAlerts.push({ id: "rss_pressure", severity: "warning", message: `RSS is ${resource.rssGiB} GiB, at or above the ${limits.rssWarnGiB} GiB threshold.` });
  }
  if (Number(resource.gpuVramPercent) >= limits.gpuVramWarnPercent) {
    resourceAlerts.push({ id: "gpu_memory_pressure", severity: "warning", message: `GPU VRAM is ${resource.gpuVramPercent}%, at or above the ${limits.gpuVramWarnPercent}% threshold.` });
  }
  if (Number(resource.importAgeMs) >= limits.importCriticalMs) {
    resourceAlerts.push({ id: "import_stall", severity: "critical", message: `Import has been running for ${resource.importAgeMs}ms, at or above the ${limits.importCriticalMs}ms threshold.` });
  } else if (Number(resource.importAgeMs) >= limits.importWarnMs) {
    resourceAlerts.push({ id: "import_stall", severity: "warning", message: `Import has been running for ${resource.importAgeMs}ms, at or above the ${limits.importWarnMs}ms threshold.` });
  }
  if (Number(resource.heavyJobs) > limits.heavyJobCap) {
    resourceAlerts.push({ id: "heavy_job_cap", severity: "critical", message: `${resource.heavyJobs} heavy jobs are active; the host cap is ${limits.heavyJobCap}.` });
  }

  const alerts = [];
  if (cardsByStage.backlog > 0 && statusCounts.working === 0) {
    alerts.push({
      id: "backlog_idle",
      severity: "warning",
      message: `${cardsByStage.backlog} backlog card(s) are waiting while no agent is working.`,
      recommendedAction: "Assign or claim a ready backlog card; escalate only if product intent is ambiguous.",
    });
  }
  if (stalledCards.length > 0) {
    alerts.push({
      id: "stalled_work",
      severity: stalledCards.some((task) => task.ageMs > limits.queueCriticalMs) ? "critical" : "warning",
      message: `${stalledCards.length} active card(s) have not moved within the stall threshold.`,
      recommendedAction: "Inspect the oldest stalled card and name its next actor or blocker.",
      cards: stalledCards,
    });
  }
  if (queueAgeMs >= limits.queueWarnMs) {
    alerts.push({
      id: "queue_age",
      severity: queueAgeMs >= limits.queuePageMs ? "page" : (queueAgeMs >= limits.queueCriticalMs ? "critical" : "warning"),
      message: `Oldest active queue age is ${queueAgeMs}ms.`,
      recommendedAction: "Assign or re-sequence the oldest ready card; page only after the critical threshold persists.",
    });
  }
  if (blockedWork.length > 0) {
    const severity = blockedWork.some((task) => task.ageMs !== null && task.ageMs >= limits.blockedCriticalMs) ? "critical" : "warning";
    alerts.push({
      id: "blocked_cards",
      severity,
      fingerprint: conditionFingerprint({ id: "blocked_cards", severity, cards: cardCondition(blockedWork) }),
      message: `${blockedWork.length} blocked card(s) need coordinator attention.`,
      recommendedAction: "Review each next actor/dependency, then delegate or explicitly re-scope the blocker.",
      cards: blockedWork,
    });
  }
  const agedBlockedWork = blockedWork.filter((task) => task.ageMs !== null && task.ageMs >= limits.blockedWarnMs);
  if (agedBlockedWork.length > 0) {
    const severity = agedBlockedWork.some((task) => task.ageMs >= limits.blockedCriticalMs) ? "critical" : "warning";
    alerts.push({
      id: "blocked_age",
      severity,
      fingerprint: conditionFingerprint({ id: "blocked_age", severity, cards: cardCondition(agedBlockedWork) }),
      message: `${agedBlockedWork.length} blocked card(s) exceed the blocked-age threshold.`,
      recommendedAction: "Name the next actor and resolve or explicitly re-scope the blocker.",
      cards: agedBlockedWork,
    });
  }
  if (staleHeartbeats.length > 0) {
    alerts.push({
      id: "stale_heartbeat",
      severity: staleHeartbeats.some((entry) => entry.ageMs > limits.staleHeartbeatCriticalMs) ? "critical" : "warning",
      message: `${staleHeartbeats.length} agent heartbeat(s) are stale.`,
      recommendedAction: "Check the affected pane and bridge delivery before re-queueing work.",
      agents: staleHeartbeats,
    });
  }
  if (retryCount >= limits.retryWarningCount || retryDelayMaxMs > limits.retryDelayWarnMs) {
    alerts.push({
      id: "retry_failure_trend",
      severity: retryCount >= limits.retryCriticalCount || retryDelayMaxMs > limits.retryDelayWarnMs ? "critical" : "warning",
      message: `Observed ${retryCount} doorbell retry/retries and ${retryDelayMaxMs}ms maximum retried-delivery age.`,
      recommendedAction: "Review the affected delivery evidence before creating a bounded retry.",
    });
  }
  alerts.push(...resourceAlerts);

  return {
    generatedAt: new Date(now).toISOString(),
    thresholds: limits,
    agents: { total: handles.length, byStatus: statusCounts, statuses, staleHeartbeats },
    cards: { total: allCards.length, byStage: cardsByStage },
    queue: { activeCards: activeCards.length, oldestAgeMs: queueAgeMs },
    retries: { count: retryCount, retriedItems, maxDeliveryAgeMs: retryDelayMaxMs },
    failures: { blockedCards: failureCount },
    blockedWork,
    stalledWork: stalledCards,
    resources: {
      ...resource,
      heavyJobCap: limits.heavyJobCap,
      workload: { workingAgents: statusCounts.working, activeCards: activeCards.length },
    },
    jobs: jobQueue?.metrics ? jobQueue.metrics() : {
      queueDepth: 0,
      active: 0,
      counts: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
      outcomes: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
      concurrency: { current: 0, max: 2, godotMax: 1, samples: [] },
      retention: { historyLimit: 500, historyCount: 0, sampleCount: 0 },
    },
    alerts,
  };
}
