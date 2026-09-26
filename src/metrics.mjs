import { createHash } from "node:crypto";
import { buildWorkAge, makeGitDateResolver, classifyTwoClocks } from "./work-age.mjs";

// The columns the queue/stall/work-age signals consider "active". One list, so the
// async work-age wrapper and the sync builder cannot drift into covering different
// cards - which is how two health metrics ended up disagreeing about the same card.
const ACTIVE_STAGES = Object.freeze(["backlog", "doing", "review"]);

export function activeBoardTasks(board) {
  const out = [];
  for (const [columnName, columnTasks] of Object.entries(board?.columns || {})) {
    const stage = columnName === "in_progress" ? "doing" : columnName;
    if (!ACTIVE_STAGES.includes(stage)) continue;
    for (const task of (Array.isArray(columnTasks) ? columnTasks : []).filter(Boolean)) out.push(task);
  }
  return out;
}

const DEFAULT_THRESHOLDS = Object.freeze({
  // The work axis is deliberately on a different timescale from the state axis. A card
  // should be touched as the work happens, so the state clock is measured in minutes;
  // whether a commit exists is a slower question measured in hours. Sharing one
  // threshold made `work-recent` unreachable on the live board - 0 of 6 cards with
  // dated work qualified - which silently disabled two of the five labels.
  workStaleAfterMs: 24 * 60 * 60 * 1000,
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
  // A retry only counts toward the alert while it is still being retried. Without a
  // window both the count and the age are lifetime-cumulative, so one delivery that
  // failed once keeps the alert over threshold forever and it can never clear.
  retryWindowMs: 900 * 1000,
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

// Liveness is the newest of the card's own liveness clock and its state clock.
// The board writes snake_case (`last_heartbeat_at`); the camelCase spellings are
// accepted for projections that are not read straight off disk.
//
// A liveness clock with no author is not evidence of liveness AND not evidence of
// stall: it is an unknown. Treating it as live keeps a card that nobody has touched
// looking alive; treating it as stale floods the detector with every legacy card
// the moment the behaviour changes, and a detector that cries wolf is worse than
// one that stays quiet. So the state is reported honestly as `unknown` and the card
// is excluded from the stalled list rather than counted either way. The author is
// never invented to resolve it.
const LIVENESS_STATES = { LIVE: "live", STALE: "stale", UNKNOWN: "unknown" };

function cardLivenessState(task, now, stalledWorkMs) {
  const heartbeatAt = timestamp(task?.last_heartbeat_at ?? task?.heartbeatAt ?? task?.lastHeartbeat);
  const updatedAt = timestamp(task?.updated);
  const createdAt = timestamp(task?.created);
  const via = heartbeatAt === null ? "activity" : "heartbeat";
  const at = heartbeatAt === null
    ? (updatedAt === null ? createdAt : Math.max(updatedAt ?? -Infinity, createdAt ?? -Infinity))
    : heartbeatAt;
  if (at === null || !Number.isFinite(at)) {
    return { state: LIVENESS_STATES.UNKNOWN, via, at: null, ageMs: null, by: null };
  }
  const ageMs = Math.max(0, now - at);
  const by = task?.last_heartbeat_by || null;
  // Only a clock that names nobody is unattributable. A card with no heartbeat at
  // all falls back to its own state clock, which no one has fabricated an author for.
  if (via === "heartbeat" && !by) {
    return { state: LIVENESS_STATES.UNKNOWN, via, at, ageMs, by: null };
  }
  return {
    state: ageMs > stalledWorkMs ? LIVENESS_STATES.STALE : LIVENESS_STATES.LIVE,
    via,
    at,
    ageMs,
    by,
  };
}

// The clock the stall detector ages: the card's own STATE clock, never a heartbeat.
//
// A heartbeat is an assertion that the owner is present. It was previously the newest
// event on the card, which made the detector age the very event its own recommended
// remedy writes: obeying the alert reset the clock and started the same timer again,
// so the alert was guaranteed to return one window later and carried no information
// about whether anyone was working. An assertion cannot be both the remedy and the
// trigger. Stall now means "this card has not moved", whose remedy is moving it, and
// the liveness lease is reported separately in the payload rather than alerted on.
function cardProgressClock(task) {
  const updatedAt = timestamp(task?.updated);
  const createdAt = timestamp(task?.created);
  const candidates = [updatedAt, createdAt].filter((value) => value !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function cardLiveness(task) {
  const candidates = [
    task?.last_heartbeat_at,
    task?.heartbeatAt,
    task?.lastHeartbeat,
    task?.updated,
    task?.created,
  ].map((value) => timestamp(value)).filter((value) => value !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

// A blocked card that carries a reason has been triaged: the coordinator already
// named the actor and the way out. Re-alerting on it punishes correct triage and
// trains readers to ignore the alert, so triage state, not age, gates the alert.
function isTriagedBlocked(task) {
  const reason = task?.block_reason ?? task?.reason;
  return typeof reason === "string" && reason.trim().length > 0;
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

// Notes are evidence of progress, deliberately NOT liveness: appending a note
// never moves `updated`, so commenting cannot keep a stalled card alive and the
// detector cannot be gamed. Consumers surface note recency so a reader can tell
// a moving card from an ignored one.
function noteSummary(task, now) {
  const notes = Array.isArray(task?.notes)
    ? task.notes.filter((note) => note && typeof note.text === "string" && note.text.trim())
    : [];
  const times = notes
    .map((note) => timestamp(note.at))
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const lastNoteMs = times.length > 0 ? times[times.length - 1] : null;
  return {
    noteCount: notes.length,
    lastNoteAt: lastNoteMs === null ? null : new Date(lastNoteMs).toISOString(),
    noteAgeMs: lastNoteMs === null ? null : Math.max(0, now - lastNoteMs),
  };
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
  // Pre-resolved work-age, keyed by card id. Resolving work-age needs git and is
  // therefore async, while this builder is sync and has several callers; the async
  // wrapper `buildCoordinatorMetricsWithWorkAge` resolves the dates and passes the
  // result in here rather than making every caller await.
  workAgeById = null,
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
  for (const [columnName, columnTasks] of Object.entries(board.columns || {})) {
    const stage = columnName === "in_progress" ? "doing" : columnName;
    for (const task of (Array.isArray(columnTasks) ? columnTasks : []).filter(Boolean)) {
      if (Object.hasOwn(cardsByStage, stage)) cardsByStage[stage] += 1;
    }
  }
  const activeCards = activeBoardTasks(board);
  // The queue age answers the same question as stalled_work, so it ages the same
  // clock: the card's own state clock. It previously read `updated` only while
  // stalled_work read the liveness clock, so the two disagreed about one card at one
  // instant; and when stalled_work moved to the state clock, queue_age moved with it
  // rather than being left behind on the heartbeat. Both progress signals now read
  // the same clock, and the liveness lease is reported separately and never alerted.
  let queueAgeMs = 0;
  let queueOldest = null;
  let queueUnknown = 0;
  for (const task of activeCards) {
    const liveness = cardLivenessState(task, now, limits.stalledWorkMs);
    if (liveness.state === LIVENESS_STATES.UNKNOWN) {
      queueUnknown += 1;
      continue;
    }
    const progressAt = cardProgressClock(task);
    const progressAgeMs = progressAt === null ? null : Math.max(0, now - progressAt);
    if (progressAgeMs !== null && progressAgeMs > queueAgeMs) {
      queueAgeMs = progressAgeMs;
      queueOldest = task;
    }
  }
  // Blocked cards are not waiting in a queue, so they do not belong to the queue
  // age. Before this existed they belonged to NO age signal at all: blocked_cards
  // only fires on UNTRIAGED cards, so a triaged card could sit forever unnoticed.
  // They are therefore reported by their own metric with their own thresholds,
  // computed once `blockedWork` has been built.
  let blockedOldestAgeMs = 0;
  let blockedOldestCard = null;
  // A card is stale when neither an explicit heartbeat nor a state change has
  // happened within the threshold. Previously this read only `updated`, so an
  // actively worked card was indistinguishable from an ignored one.
  const stalledCards = [];
  const unattributedLiveness = [];
  const livenessLease = [];
  for (const task of activeCards) {
    const liveness = cardLivenessState(task, now, limits.stalledWorkMs);
    const note = noteSummary(task, now);
    // The lease is reported, never alerted on. Alerting on it would recreate the
    // loop this change exists to remove: the remedy for "your lease expired" is to
    // renew the lease, so the alert would return one window later by construction.
    livenessLease.push({
      id: task.id,
      owner: task.owner || null,
      state: liveness.state,
      via: liveness.via,
      by: liveness.by,
      lastActivityAt: liveness.at === null ? null : new Date(liveness.at).toISOString(),
    });
    if (liveness.state === LIVENESS_STATES.UNKNOWN) {
      // Reported, never alerted: visible to a reader who asks, silent in the list.
      unattributedLiveness.push({
        id: task.id,
        title: task.title,
        owner: task.owner || null,
        // The stage is carried so a reader can actually FIND the card. The count was
        // reported for nine alerts with no id and no stage, which is what made two
        // real backlog cards look like a constant in the alerting code: nobody could
        // locate them without re-deriving the active-column set by hand.
        stage: task.stage || task.status || null,
        liveness: liveness.state,
        via: liveness.via,
        lastActivityAt: liveness.at === null ? null : new Date(liveness.at).toISOString(),
        ...note,
      });
      continue;
    }
    const progressAt = cardProgressClock(task);
    const progressAgeMs = progressAt === null ? null : Math.max(0, now - progressAt);
    if (progressAgeMs !== null && progressAgeMs > limits.stalledWorkMs) {      // `reason` is projected here because the coordinator prompt reads
      // `card.reason`; omitting it made every prompted card print
      // reason=unspecified even when the card carried a block reason, which is a
      // read failure rather than a missing value. The board writes
      // `block_reason`, so both spellings are accepted.
      stalledCards.push({
        id: task.id,
        title: task.title,
        owner: task.owner || null,
        reason: task.block_reason || task.reason || null,
        ageMs: progressAgeMs,
        lastActivityAt: new Date(progressAt).toISOString(),
        heartbeatAt: timestamp(task?.last_heartbeat_at) === null ? null : new Date(timestamp(task.last_heartbeat_at)).toISOString(),
        heartbeatAgeMs: ageMs(task?.last_heartbeat_at, now),
        heartbeatBy: task?.last_heartbeat_by || null,
        heartbeatByNonOwner: Boolean(task?.last_heartbeat_by && task.owner && task.last_heartbeat_by !== task.owner),
        liveness: liveness.state,
        livenessBy: liveness.by,
        livenessVia: liveness.via,
        // Report only. There is no work-age alert and no work-age threshold: a card
        // whose implementation is finished and is waiting on QA or a reviewer has no
        // new commits, so any alert here would page on exactly those cards.
        work: workAgeById?.get(task.id) || null,
        ...note,
      });
    }
  }
  const blockedWork = [];
  for (const [columnName, columnTasks] of Object.entries(board.columns || {})) {
    if (columnName !== "blocked") continue;
    for (const task of (Array.isArray(columnTasks) ? columnTasks : []).filter(Boolean)) {
      // `blocked_ms` is a snapshot written when the card was blocked, so it stops
      // counting the moment the card is written and understates by the time since.
      // The live age from `blocked_at` is preferred wherever it exists; the stored
      // figure is only a fallback for a card that has no parseable blocked_at.
      const blockedAtMs = Date.parse(task.blocked_at);
      const ageMsValue = Number.isFinite(blockedAtMs)
        ? Math.max(0, now - blockedAtMs)
        : (Number.isFinite(Number(task.blocked_ms)) && task.blocked_ms !== null && task.blocked_ms !== undefined
          ? Number(task.blocked_ms)
          : ageMs(task.updated || task.created, now));
      blockedWork.push({
        id: task.id,
        title: task.title,
        owner: task.owner || null,
        nextActor: task.next_actor ?? task.nextActor ?? null,
        dependency: task.depends_on || task.dependency || null,
        reason: task.block_reason || task.reason || null,
        triaged: isTriagedBlocked(task),
        ageMs: ageMsValue,
        ...noteSummary(task, now),
      });
    }
  }

  const deliveryEntries = [
    ...Object.values(deliveredState?.delivered || {}),
    ...Object.values(deliveredState?.deliveredTasks || {}),
  ];
  const retryEntries = deliveryEntries.filter((entry) => (Number(entry?.attempts) || 1) > 1);
  const retryWindowMs = Number(limits.retryWindowMs) > 0 ? Number(limits.retryWindowMs) : 900 * 1000;
  const windowStart = now - retryWindowMs;
  // "Still failing" means the delivery was retried inside the window. An entry whose
  // last attempt is older than that is a closed incident, and it must stop counting:
  // this is the whole difference between an alert that can clear and one that cannot.
  const retriedRecently = retryEntries.filter((entry) => {
    const last = timestamp(entry?.at);
    return last !== null && last >= windowStart;
  });
  // Upper bound: only the first and last attempt are recorded, so a single entry with
  // attempts=5 contributes 4 even if the earlier ones predate the window.
  const retryCount = retriedRecently.reduce((sum, entry) => sum + Math.max(0, (Number(entry?.attempts) || 1) - 1), 0);
  const retriedItemCount = retriedRecently.length;
  // Age of the CURRENT incident, taken over entries that are still being retried. It
  // grows while the incident is open and drops to zero once the window empties, which
  // is what makes the age disjunct self-clearing instead of monotonic.
  const retryDelayMaxMs = retriedRecently.reduce((max, entry) => {
    const first = timestamp(entry?.firstAttemptAt || entry?.firstDeliveredAt);
    return first === null ? max : Math.max(max, Math.max(0, now - first));
  }, 0);
  // Lifetime figures are reported for context and deliberately do NOT drive the
  // alert: they are monotonic by construction.
  const retryCountLifetime = retryEntries.reduce((sum, entry) => sum + Math.max(0, (Number(entry?.attempts) || 1) - 1), 0);
  const retriedItems = retryEntries.length;
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
  // Blocked age, measured over every blocked card regardless of triage.
  blockedOldestAgeMs = blockedWork.reduce(
    (oldest, task) => (task.ageMs !== null && task.ageMs > oldest ? task.ageMs : oldest),
    0,
  );
  blockedOldestCard = blockedWork.reduce(
    (oldestCard, task) => (task.ageMs !== null && (!oldestCard || task.ageMs > oldestCard.ageMs) ? task : oldestCard),
    null,
  );

  if (blockedWork.length > 0 && blockedOldestAgeMs >= limits.blockedWarnMs) {
    // Deliberately independent of blocked_cards, which only counts UNTRIAGED
    // cards. A triaged blocker is still a blocker: recording a reason stops the
    // "you did not say why" alert, but it must not silence the "this has been
    // blocked for five hours" one. Reuses the existing blockedWarnMs /
    // blockedCriticalMs thresholds rather than introducing new knobs.
    const severity = blockedOldestAgeMs >= limits.blockedCriticalMs ? "critical" : "warning";
    const triaged = blockedWork.filter((task) => task.triaged).length;
    alerts.push({
      id: "blocked_oldest",
      severity,
      fingerprint: conditionFingerprint({
        id: "blocked_oldest",
        severity,
        cards: cardCondition(blockedWork),
      }),
      message: `Oldest blocked card has been blocked for ${blockedOldestAgeMs}ms (${blockedOldestCard?.id || "unknown"}). ${triaged} of ${blockedWork.length} carry a triage reason, which stops the untriaged alert but not this one.`,
      recommendedAction: "Resolve it, re-scope it, or record why it is still blocked; a triage reason alone does not close an old blocker.",
      oldestCardId: blockedOldestCard?.id || null,
      oldestAgeMs: blockedOldestAgeMs,
      triagedCount: triaged,
      untriagedCount: blockedWork.length - triaged,
      cardCount: blockedWork.length,
      cards: blockedWork,
    });
  }

  if (cardsByStage.backlog > 0 && statusCounts.working === 0) {
    alerts.push({
      id: "backlog_idle",
      severity: "warning",
      message: `${cardsByStage.backlog} backlog card(s) are waiting while no agent is working.`,
      recommendedAction: "Assign or claim a ready backlog card; escalate only if product intent is ambiguous.",
    });
  }
  if (stalledCards.length > 0) {
    const withNotes = stalledCards.filter((task) => task.noteCount > 0);
    const noteSummary = withNotes.length > 0
      ? ` ${withNotes.length} of them carry notes; treat a recent note as evidence of progress, not as liveness.`
      : "";
    alerts.push({
      id: "stalled_work",
      severity: stalledCards.some((task) => task.ageMs > limits.queueCriticalMs) ? "critical" : "warning",
      message: `${stalledCards.length} active card(s) have not changed state within the stall threshold. This is measured on the card's own state clock, NOT on heartbeats: a heartbeat declares that an owner is present but does not move the card, so heartbeating is not a remedy for this alert and following it cannot make the number go down.${noteSummary}${unattributedLiveness.length > 0 ? ` ${unattributedLiveness.length} more active card(s) have a liveness clock that names no author, so their liveness is unknown and they are counted neither as live nor as stalled: ${unattributedLiveness.map((c) => `${c.id} (owner=${c.owner || "none"}, stage=${c.stage}, via=${c.via})`).join(", ")}.` : ""}`,
      recommendedAction: "Move the card: record a state change (claim, re-scope, block with a reason, or close). A status request is not the remedy - nothing about asking changes the clock this alert ages.",
      stalledCount: stalledCards.length,
      cardsWithNotes: withNotes.length,
      cards: stalledCards,
    });
  }
  if (queueAgeMs >= limits.queueWarnMs) {
    alerts.push({
      id: "queue_age",
      severity: queueAgeMs >= limits.queuePageMs ? "page" : (queueAgeMs >= limits.queueCriticalMs ? "critical" : "warning"),
      message: `Oldest active queue age is ${queueAgeMs}ms (backlog/doing/review only; blocked cards are reported by blocked_oldest).${queueUnknown > 0 ? ` ${queueUnknown} active card(s) have an unattributable liveness clock and are excluded from this figure.` : ""}`,
      recommendedAction: "Assign or re-sequence the oldest ready card; page only after the critical threshold persists.",
    });
  }
  const untriagedBlocked = blockedWork.filter((task) => !task.triaged);
  if (untriagedBlocked.length > 0) {
    const severity = untriagedBlocked.some((task) => task.ageMs !== null && task.ageMs >= limits.blockedCriticalMs) ? "critical" : "warning";
    const alreadyTriaged = blockedWork.length - untriagedBlocked.length;
    const excluded = alreadyTriaged > 0 ? ` ${alreadyTriaged} already carry a triage reason and are excluded.` : "";
    alerts.push({
      id: "blocked_cards",
      severity,
      fingerprint: conditionFingerprint({ id: "blocked_cards", severity, cards: cardCondition(untriagedBlocked) }),
      message: `${untriagedBlocked.length} blocked card(s) are UNTRIAGED (no reason recorded).${excluded}`,
      recommendedAction: "Name the next actor and the blocker in one `task block <id> --reason ... --next-actor <handle>` call; a card with a reason stops alerting.",
      untriagedCount: untriagedBlocked.length,
      triagedExcludedCount: alreadyTriaged,
      cards: untriagedBlocked,
      excludedCards: blockedWork.filter((task) => task.triaged),
    });
  }
  const agedBlockedWork = untriagedBlocked.filter((task) => task.ageMs !== null && task.ageMs >= limits.blockedWarnMs);
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
      message: `Observed ${retryCount} doorbell retry/retries across ${retriedItemCount} item(s) retried in the last ${Math.round(retryWindowMs / 1000)}s, and ${retryDelayMaxMs}ms maximum retried-delivery age.`,
      recommendedAction: "Review the affected delivery evidence before creating a bounded retry.",
      retryWindowMs,
      retriedItems,
      retryCount,
      retriedItemCount,
      retryDelayMaxMs,
      retryCountLifetime,
    });
  }
  alerts.push(...resourceAlerts);

  return {
    generatedAt: new Date(now).toISOString(),
    thresholds: limits,
    agents: { total: handles.length, byStatus: statusCounts, statuses, staleHeartbeats },
    cards: { total: allCards.length, byStage: cardsByStage },
    queue: {
      activeCards: activeCards.length,
      oldestAgeMs: queueAgeMs,
      oldestCardId: queueOldest?.id || null,
      oldestCardLiveness: queueOldest ? cardLivenessState(queueOldest, now, limits.stalledWorkMs).state : null,
      unattributedExcluded: queueUnknown,
      scope: "backlog, doing, review",
      clock: "card state clock (updated/created); heartbeats do not move it",
    },
    blockedOldest: {
      cards: blockedWork.length,
      oldestAgeMs: blockedOldestAgeMs,
      oldestCardId: blockedOldestCard?.id || null,
      triaged: blockedWork.filter((task) => task.triaged).length,
      untriaged: blockedWork.filter((task) => !task.triaged).length,
    },
    // `count` and `maxDeliveryAgeMs` are windowed and drive the alert; the
    // `lifetime` figures are monotonic context and are never compared to a threshold.
    retries: {
      count: retryCount,
      retriedItems,
      maxDeliveryAgeMs: retryDelayMaxMs,
      windowMs: retryWindowMs,
      lifetime: { count: retryCountLifetime, retriedItems },
    },
    failures: { blockedCards: failureCount },
    blockedWork,
    stalledWork: stalledCards,
    // Reported so a reader can see them, never alerted: see cardLivenessState.
    livenessLease,
    // Work-age, report only. Read beside the state clock and never instead of it: the
    // state clock says nobody has moved the card, work-age says nobody has committed
    // anything, and the two together are what separate a stalled card from a
    // finished-one-waiting-on-somebody-else.
    workAge: {
      reportOnly: true,
      alerts: false,
      note: "Report only, deliberately. A finished card waiting on QA or a reviewer has no new commits, so a work-age alert would fire on a timer for exactly the cards that are healthy.",
      // The two clocks, read together. Labels name CLOCKS and never agents: a verdict
      // next to a colleague's name turns the metric into a performance signal, and owners
      // respond by moving the clock instead of finishing the work.
      classification: {
        reportOnly: true,
        alerts: false,
        thresholdsPage: false,
        // The two thresholds are separate, and both are reported, so a reader who
        // disagrees with either can re-derive the observation from the raw ages.
        stateThresholdMs: limits.stalledWorkMs,
        workThresholdMs: limits.workStaleAfterMs,
        note: "Labels describe the two clocks, not the owner. Each label carries what it is ALSO consistent with, because the clocks cannot separate those cases - fresh work with a still card is equally an implemented-but-forgotten card and work that does not address this card.",
      },
      cards: workAgeById ? Object.fromEntries(workAgeById) : {},
    },
    unattributedLiveness,
    unattributedLivenessCount: unattributedLiveness.length,
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

/**
 * Async wrapper: resolve work-age for the active cards, then build the sync metrics.
 *
 * Split this way because resolving a cited commit needs git, and this builder is sync
 * with several callers. A git failure degrades to "undated" rather than failing the
 * board: the work-age signal is report-only, so it must never be able to take the
 * metrics down with it.
 */
export async function buildCoordinatorMetricsWithWorkAge({ repos = [], ...options } = {}) {
  const { board = { columns: {} }, now = Date.now() } = options;
  const activeCards = activeBoardTasks(board);
  const resolveDate = makeGitDateResolver({ repos });
  const workAgeById = new Map();
  await Promise.all(activeCards.map(async (task) => {
    try {
      const work = await buildWorkAge(task, now, { resolveDate });
      // The second clock. Both are read here so the pair can be labelled in one place
      // and the two cannot disagree about which cards are in scope.
      const stateAt = cardProgressClock(task);
      workAgeById.set(task.id, {
        ...work,
        stateAgeMs: stateAt === null ? null : Math.max(0, nowMsOf(now) - stateAt),
        observation: classifyTwoClocks({
          stateAgeMs: stateAt === null ? null : Math.max(0, nowMsOf(now) - stateAt),
          work,
          stateStaleAfterMs: limitsOf(options).stalledWorkMs,
          workStaleAfterMs: limitsOf(options).workStaleAfterMs,
        }),
      });
    } catch {
      workAgeById.set(task.id, null);
    }
  }));
  return { metrics: buildCoordinatorMetrics({ ...options, workAgeById }), workAgeById };
}

function nowMsOf(now) {
  return now instanceof Date ? now.getTime() : (typeof now === "number" ? now : Date.parse(now));
}

function limitsOf(options) {
  return { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
}
