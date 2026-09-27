import { createHash } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkAge, makeGitDateResolver, classifyTwoClocks } from "./work-age.mjs";

// WHERE THIS CODE LIVES IS A REPOSITORY TOO.
//
// The server asked the resolver to date commits against two repositories: the game repo it was
// handed, and `path.join(repoRoot, "..", "herdr-plugin-amq")`. That second path is a GUESS about
// the filesystem, and on this machine it is wrong - the game repo is .../coding/godot/fps-basegame,
// so the guess resolves to .../coding/godot/herdr-plugin-amq, which does not exist. The plugin
// repo is .../coding/herdr-plugin-amq, a sibling of `godot` rather than of the game repo.
//
// The failure was SILENT, which is the part that matters. execFile with a non-existent cwd simply
// fails, the resolver finds nothing, and every plugin citation reads UNDATED - so the board looks
// like it cites no tooling work when in fact it cites five cards' worth. Coordinator hit exactly
// this from the other end earlier tonight, searching for this repository and reporting absence
// from a path that was not there; the same wrong root was hardcoded in our own production code.
//
// The fix is not another guess. The running code IS the plugin, so its root is knowable from the
// module's own location - no configuration, no layout assumption, and it cannot rot when someone
// moves a directory. Guessing a sibling twice would just be a second thing to be wrong.
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A REPO PATH THAT DOES NOT EXIST IS REPORTED, NOT IGNORED.
//
// `makeGitDateResolver` filters `repos.filter(Boolean)`, which keeps a non-empty string that
// points nowhere and silently resolves nothing. A caller cannot tell "I searched two
// repositories" from "I searched one, and one of them is fiction", and the difference is the whole
// finding: five cards' evidence was invisible and the tool reported no reason. So the used and
// skipped lists travel with the metrics, which puts the limitation in the artifact a reader
// actually looks at rather than in a commit message nobody opens.
function partitionRepos(repos) {
  const used = [];
  const skipped = [];
  for (const repo of repos) {
    if (!repo) continue;
    let ok = false;
    try { ok = fsSync.statSync(repo).isDirectory(); } catch { ok = false; }
    (ok ? used : skipped).push(repo);
  }
  return { used, skipped };
}

// The columns the queue/stall/work-age signals consider "active". One list, so the
// async work-age wrapper and the sync builder cannot drift into covering different
// cards - which is how two health metrics ended up disagreeing about the same card.
// `queued` is in here because a scheduled card waiting its turn is REAL work that has
// not moved yet, and queue_age should keep ageing it. It is deliberately NOT eligible
// for stalled_work: waiting its turn is not inactivity. Admitting it to one and not the
// other is the whole point - a queue that is working as designed must not read as a lane
// that has stopped.
const ACTIVE_STAGES = Object.freeze(["backlog", "queued", "doing", "review"]);

// Stages that represent work which SHOULD have moved and has not. A card parked in a
// recorded order is not in here: it is correctly not moving.
const STALL_ELIGIBLE_STAGES = Object.freeze(["backlog", "doing", "review"]);

/**
 * Project one card's stall state. THE single definition of "stalled", used by the
 * `stalled_work` alert and by the per-agent doorbell prompt.
 *
 * It was duplicated the moment the doorbell wanted to name a stalled card, and a second
 * copy of this logic is how two metrics came to disagree about the same card at the same
 * instant before. Anything that needs to know whether a card is stalled calls this.
 */
export function projectCardStall(task, now, limits = DEFAULT_THRESHOLDS, workAgeById = null) {
  const liveness = cardLivenessState(task, now, limits.stalledWorkMs);
  const note = noteSummary(task, now);
  if (liveness.state === LIVENESS_STATES.UNKNOWN) {
    return {
      kind: "unknown",
      liveness,
      unknown: {
        id: task.id,
        title: task.title,
        owner: task.owner || null,
        stage: task.stage || task.status || null,
        liveness: liveness.state,
        via: liveness.via,
        lastActivityAt: liveness.at === null ? null : new Date(liveness.at).toISOString(),
        ...note,
      },
    };
  }
  const progressAt = cardProgressClock(task);
  const progressAgeMs = progressAt === null ? null : Math.max(0, now - progressAt);
  if (progressAgeMs === null || progressAgeMs <= limits.stalledWorkMs) return { kind: "fresh", liveness };
  return {
    kind: "stalled",
    liveness,
    stalled: {
      id: task.id,
      title: task.title,
      owner: task.owner || null,
      // The stage, on the STALLED projection as well as the fresh one. It was present on
      // one and absent on the other, so every card a consumer actually cares about - the
      // stalled ones - reported stage=undefined while the board showed the column. That
      // is a correctness bug wearing a styling costume: a reader checking whether a card
      // is parked or abandoned gets `undefined` and concludes neither, which is the same
      // unexpressible difference the `queued` stage exists to fix, reappearing as a
      // missing field instead of a missing concept.
      stage: task.stage || task.status || null,
      // The next actor, populated here for the same reason as `stage`: the BLOCKED
      // projection carried it and this one did not, so the two alerts disagreed about the
      // same underlying field and only one of them read it. The visible consequence is
      // worse than a missing field - the triage render prints "next-actor=none (blocked
      // on nobody)" for every stalled card, so seven cards were asserting something false
      // about themselves, three of them with a live actor recorded on the task.
      //
      // `null` here is a REAL, reportable state - the card genuinely has no next actor -
      // and it is deliberately different from the key being absent, which every consumer
      // had to read as "nobody" because there was nothing else to read. The renderer is
      // not being asked to infer this from `owner` again; that was the original defect,
      // and a missing field should print as unknown rather than as a person.
      nextActor: task.next_actor ?? task.nextActor ?? null,
      // Projected because the coordinator prompt reads `card.reason`; omitting it made
      // every prompted card print reason=unspecified even when one was recorded. The
      // board writes `block_reason`, so both spellings are accepted.
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
      // Report only. There is no work-age alert and no work-age threshold: a card whose
      // implementation is finished and is waiting on QA or a reviewer has no new
      // commits, so any alert here would page on exactly those cards.
      work: workAgeById?.get(task.id) || null,
      ...note,
    },
  };
}

/**
 * Stalled and unknown-liveness cards belonging to one owner.
 *
 * This is what lets a lane be told which of ITS cards have stopped moving. It reuses
 * projectCardStall, so the doorbell and the coordinator alert cannot disagree about
 * whether a card is stalled - the same reason queue_age follows stalled_work's clock.
 */
export function stalledCardsForOwner(board, owner, { now = Date.now(), thresholds = {}, workAgeById = null } = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const out = { stalled: [], unknown: [] };
  for (const task of activeBoardTasks(board)) {
    if ((task.owner || "") !== owner) continue;
    const projected = projectCardStall(task, now, limits, workAgeById);
    if (projected.kind === "stalled") out.stalled.push(projected.stalled);
    if (projected.kind === "unknown") out.unknown.push(projected.unknown);
  }
  return out;
}

export function activeBoardTasks(board, opts = {}) {
  // stallEligible: restrict to stages where the absence of movement is a real signal.
  // Used by stalled_work so a scheduled queue is never reported as a stalled lane, and NOT
  // used by queue_age, which ages the whole queue including what is waiting its turn.
  const stages = opts.stallEligible ? STALL_ELIGIBLE_STAGES : ACTIVE_STAGES;
  const out = [];
  for (const [columnName, columnTasks] of Object.entries(board?.columns || {})) {
    const stage = columnName === "in_progress" ? "doing" : columnName;
    if (!stages.includes(stage)) continue;
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
// Fields whose change means the card actually MOVED. A write that touches only
// bookkeeping - a reason, a note, a proof - is not progress, and advancing the progress
// clock on one makes the stall alert's membership a function of prose.
//
// The incentive this removes: if writing to a card silences the alert, the cheapest way
// to quiet it is to write to the card, and the observer starts editing instead of
// working. That is a counter the observer can move by touching the thing measured.
export const TRANSITION_FIELDS = Object.freeze(["status", "owner", "next_actor"]);

// `updated` is a general write timestamp and is read as a progress clock, so the two
// meanings have to be separated. cardProgressClock prefers a real transition when the
// card records one, and only falls back to `updated` for cards that predate this.
export function cardProgressClock(task) {
  const transitions = (TRANSITION_FIELDS || []).map((f) => timestamp(task?.[f === "next_actor" ? "next_actor_at" : `${f}_at`]));
  const transitionAt = transitions.filter((v) => v !== null);
  if (transitionAt.length > 0) return Math.max(...transitionAt);
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

/**
 * A BLOCK THAT NAMES NO CONDITION AND NO OWNER.
 *
 * This is the missing-edge case, and it is the one check that did not have to wait for a ruling
 * about prose. The rule a block has to satisfy is about AUTHORING, not reading: the edge is the
 * claim and the reason is narration, so a block is explained when it names an edge or an owner,
 * and the prose never substitutes for either. That is checkable from two fields.
 *
 * IT IS NOT THE SAME AS `stale`, AND CONFLATING THEM WOULD REINTRODUCE THE FALSE BLOCK.
 *  - STALE: the card names a real edge and every known dependency is DONE. The condition was named
 *    and has since been satisfied. Coordinator's false block, and agsuite-dev's 1b4a3e.
 *  - UNEXPLAINED: the card names nothing. No edge, no next actor. There is no condition to
 *    evaluate, so it cannot be stale and it cannot be released - it is simply unowned.
 *
 * A LEGITIMATE BLOCK WITH NO EDGE IS STILL FINE, and this is the arm that matters, because
 * coordinator corrected their own card into exactly that shape: WAIT-WITH-OWNER, next_actor set,
 * depends_on empty, because "there is no card for that answer yet and inventing a dependency for
 * an answer nobody has given is how the false block happened". So an owner alone satisfies the
 * check. Refusing to require an edge would forbid the honest state in favour of a structured lie.
 *
 * UNKNOWN EDGES DO NOT COUNT AS NAMING A CONDITION. An edge to an id that is not on the board may
 * well be remembered rather than read, which is the false-block signature, so it is reported
 * rather than credited.
 */
function isUnexplainedBlock(task, dependencyStates) {
  const nextActor = task?.next_actor ?? task?.nextActor ?? null;
  if (typeof nextActor === "string" && nextActor.trim().length > 0) return false;
  return !dependencyStates.some((d) => d.status !== "unknown");
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
  // TWO SETS, DELIBERATELY. `queueCards` is the whole queue including scheduled cards
  // waiting their turn - waiting is real work that has not moved yet, and queue_age must
  // keep ageing it. `stallableCards` excludes `queued`, because a card parked in a
  // recorded order is correctly not moving and its stillness is not a stall. Filtering
  // once and sharing the result, which is what I did first, silences BOTH: it made the
  // queue stop reporting work that is real, and it is why the first run of this test
  // showed queue_age at 0 for a card that was genuinely 126 minutes old.
  const queueCards = activeBoardTasks(board);
  const activeCards = activeBoardTasks(board, { stallEligible: true });
  const queueAgeCards = queueCards;
  // The queue age answers the same question as stalled_work, so it ages the same
  // clock: the card's own state clock. It previously read `updated` only while
  // stalled_work read the liveness clock, so the two disagreed about one card at one
  // instant; and when stalled_work moved to the state clock, queue_age moved with it
  // rather than being left behind on the heartbeat. Both progress signals now read
  // the same clock, and the liveness lease is reported separately and never alerted.
  let queueAgeMs = 0;
  let queueOldest = null;
  let queueUnknown = 0;
  for (const task of queueAgeCards) {
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
  // Blocked cards nobody can move. Reported, never alerted - see below.
  const unownedBlocked = [];
  // A card is stale when neither an explicit heartbeat nor a state change has
  // happened within the threshold. Previously this read only `updated`, so an
  // actively worked card was indistinguishable from an ignored one.
  // A lookup of every card's status by id, so a card's DEPENDENCIES can be resolved - both for
  // the blocked projection below and for the STALLED projection, which now resolves its own
  // edges. It used to be built after the active-card loop, which is why the stalled projection
  // could not read it and had to omit `dependency` entirely: the field was unreachable from
  // where it was needed, so the renderer printed null for every stalled card.
  const statusById = new Map();
  for (const [colName, colTasks] of Object.entries(board.columns || {})) {
    for (const t of colTasks || []) {
      if (t && t.id) statusById.set(t.id, { status: colName, task: t });
    }
  }

  const stalledCards = [];
  const unattributedLiveness = [];
  const livenessLease = [];
  for (const task of activeCards) {
    const projected = projectCardStall(task, now, limits, workAgeById);
    const liveness = projected.liveness;
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
    if (projected.kind === "unknown") {
      // Reported, never alerted: visible to a reader who asks, silent in the list.
      // The stage is carried so a reader can actually FIND the card - a count with no
      // id and no stage is what made two real backlog cards look like a constant.
      unattributedLiveness.push(projected.unknown);
      continue;
    }
    if (projected.kind === "stalled") {
      // DEPENDENCIES, PROJECTED HERE BECAUSE statusById IS IN SCOPE HERE AND NOT INSIDE
      // projectCardStall.
      //
      // The stalled projection carried `stage`, `nextActor` and `reason` but NOT `dependency`,
      // while the renderer printed `dependency=${JSON.stringify(card.dependency || null)}` for
      // every card. An absent key is not a null value: the render turned a MISSING FIELD into an
      // authoritative "this card has no dependencies", so three cards carrying live edges were
      // displayed as unencumbered. It is the same defect as the `stage=undefined` one recorded in
      // the projection itself, reached by the same route - one projection has a field the sibling
      // lacks - and it survived a fix that added the sibling field on the line above.
      //
      // The STATES are read from the lookup, never assumed, for the same reason the blocked
      // projection reads them from a lookup: a dependency id that is not in the table is
      // UNKNOWN, and treating unknown as done would report a correctly-gated card as free.
      const deps = Array.isArray(task.depends_on) ? task.depends_on
        : Array.isArray(task.dependency) ? task.dependency
          : (task.depends_on || task.dependency) ? [task.depends_on || task.dependency] : [];
      const dependencyStates = deps.map((d) => {
        const id = typeof d === "string" ? d : d?.id;
        return { id, status: statusById.get(id)?.status ?? "unknown" };
      });
      stalledCards.push({
        ...projected.stalled,
        dependency: deps.length ? deps : null,
        dependencyStates,
        // WHAT IS STILL GATING IT, which is the question a stall triage actually asks.
        //
        // Printing the real edge alone would be a half-fix that makes things worse: all three of
        // coordinator's cards depend on cards that are DONE, so a satisfied edge printed next to
        // a stall alert invites the reader to conclude the work is blocked when it is in fact
        // runnable. "deps all satisfied" is the most useful thing this alert can say, because it
        // is the difference between work nobody started and work nobody could start - and until
        // now the alert could not tell those apart at all.
        //
        // `unknown` counts as UNMET. A dependency that is not in the table may not exist yet, and
        // calling that satisfied would clear a card on the strength of a dangling link.
        unmetDependencies: dependencyStates.filter((d) => d.status !== "done"),
        // True only when there was at least one edge and every one resolved to done. Zero
        // dependencies is NOT "all satisfied" - it is the separate blocked-on-nobody case, and
        // conflating them would report a card with no edges as a card whose edges are fine.
        depsAllSatisfied: dependencyStates.length > 0 && dependencyStates.every((d) => d.status === "done"),
      });
      continue;
    }
  }
  // THE CHAIN LOOKUPS, AT FUNCTION SCOPE, BECAUSE TWO ALERTS ASK THE SAME QUESTION.
  //
  // These were a block-scoped const inside the blocked alert's section. The person-queued signal
  // needs the identical walk - "does this card's chain terminate at a person" - and re-declaring
  // them would have been two implementations of one rule that could disagree, which is how a
  // blocked card and a queued card end up classified differently for no reason anyone chose.
  const nextActorById = new Map(allCards.map((t) => [t.id, t.next_actor ?? t.nextActor ?? null]));
  const depsOf = (t) => (Array.isArray(t.depends_on) ? t.depends_on
    : Array.isArray(t.dependency) ? t.dependency
      : (t.depends_on || t.dependency) ? [t.depends_on || t.dependency] : []);
  const chainTerminatesAtUser = (task, seen = new Set()) => {
    if (!task || !task.id || seen.has(task.id)) return false;   // seen = cycle guard
    seen.add(task.id);
    if (nextActorById.get(task.id) === "user") return true;
    return depsOf(task).some((dep) => {
      const depTask = statusById.get(dep)?.task;
      return depTask ? chainTerminatesAtUser(depTask, seen) : false;
    });
  };


  const blockedWork = [];
  // A lookup of every card's status by id, so a blocked card's DEPENDENCIES can be resolved.
  // Without it a dependency id can only be counted, never checked, and a block whose blockers
  // are all finished is indistinguishable from one that is genuinely waiting - which is the whole
  // defect. Built from the same board the cards come from, so it cannot disagree with them.
  for (const [columnName, columnTasks] of Object.entries(board.columns || {})) {
    if (columnName !== "blocked") continue;
    for (const task of (Array.isArray(columnTasks) ? columnTasks : []).filter(Boolean)) {
      // `blocked_at` is the authoritative live age of the CURRENT blocked spell.
      // `blocked_ms` is the live age of that same spell, recomputed on every write, and
      // `blocked_total_ms` is the cumulative time across every spell the card has ever had.
      // The two used to be one field that meant the second while being named like the first,
      // which is why a card blocked 138 minutes for the first time read 0 and a card blocked
      // 9 minutes after an earlier 150-minute block read 150. The age is taken from
      // `blocked_at`, and the fallbacks are in descending order of trust.
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
        // The dependency STATES, so a block can be told apart from a stale block.
        //
        // A blocked card whose dependencies are ALL DONE is unambiguously a defect in the BOARD
        // rather than in the work: nothing is waiting on anything, so the block is simply wrong.
        // Coordinator's own false block was exactly this - waiting on a card superseded hours
        // earlier, known, noted, and never re-pointed. Both the tooling defect and the human
        // defect are the same defect: nothing releases a block when its dependency completes.
        //
        // The states are read from a lookup, not assumed, because a dependency id that is not in
        // the table is UNKNOWN rather than done - and treating unknown as done would label a
        // correctly-blocked card as stale, which is the false positive that would make this label
        // worthless on its first day.
        dependencyStates: (task.depends_on || task.dependency || []).map?.((d) => ({
          id: typeof d === "string" ? d : d?.id,
          status: statusById.get(typeof d === "string" ? d : d?.id)?.status ?? "unknown",
        })) ?? [],
        reason: task.block_reason || task.reason || null,
        triaged: isTriagedBlocked(task),
        unexplained: isUnexplainedBlock(task, (task.depends_on || task.dependency || []).map?.((d) => ({
          id: typeof d === "string" ? d : d?.id,
          status: statusById.get(typeof d === "string" ? d : d?.id)?.status ?? "unknown",
        })) ?? []),
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
    // A blocked card with NO next actor is blocked on nobody - a decision that belongs to
    // a human, not to a lane. Its age measures how long someone has been waiting, which
    // is not the board's business to page about, and there is no honest write that
    // satisfies it: resolving is false, re-scoping is false, and recording a reason is
    // exactly what has already been done. Such cards are REPORTED and never alerted on.
    //
    // A blocked card WITH a next actor has an owner who can move it, so its age is a
    // real warning and it keeps alerting. This is the same actor-or-owner distinction
    // the notification path already draws; it is not a new state, and it deliberately
    // does not exempt any card by name.
    // `owned` and `unowned` are derived from the dependency CHAIN below, not from the pointer
    // on the card. They used to be defined here as "has a next_actor" / "has none", which is the
    // load-bearing read this change removes.
    // A HUMAN-GATED WAIT IS NOT A COORDINATION FAILURE, and ranking it as one is what made
    // this alert permanently pinned. See the chain-walk above for why the decision is made by
    // the dependency chain rather than by next_actor.
    //
    // next_actor=user means the card resolves ONLY through a person acting, and when a person
    // acts the card leaves blocked. So the oldest such card is the one the alert will name on
    // every future firing, and it cannot clear while the alert exists - an alert with exactly
    // one possible exit is not measuring anything. Worse than noise: it reports a correctly
    // encoded human wait with the same urgency it would report a stale edge to a finished card,
    // so the lanes that learn to ignore it are exactly the lanes that would have caught the
    // real ones, and an alert that is always true teaches its readers that alerts are always true.
    //
    // THIS IS A CHANGE OF RANKING, NOT A SUPPRESSION, and the difference is the whole point.
    // Suppressing on age would hide a genuinely stale edge, because a card blocked on a
    // finished dependency lands in the same bucket as a card blocked on a person and only the
    // chain tells them apart. Ranking the non-human population keeps the real defects
    // visible and demotes the human waits to a count.
    // next_actor is a DISPLAY FIELD. Actionability is decided by whether the card's DEPENDENCY
    // CHAIN TERMINATES IN A USER-GATED CARD, and never by the pointer on the card itself.
    //
    // The convention is now settled and it is a good one - next_actor means WHO MUST ACT FOR THE
    // CARD TO ADVANCE, owner means who does the work - but settling a convention does not make
    // the field RELIABLE, and the two are independent failure modes. A human can misread
    // next_actor, and `task reassign` does not maintain it: it moved owner without touching
    // next_actor, so a re-pointed card kept pointing at whoever it used to wait for. An alert
    // that reads the pointer therefore pages on a card no lane can move, which is the exact
    // false signal that pinned this alert earlier tonight.
    //
    // The chain is the honest question. A card blocked behind a card that waits on a person
    // cannot be cleared by a lane no matter what its own pointer says, and that stays true when
    // the pointer is stale, wrong, or absent. So the walk decides, and next_actor is printed
    // for the human without being load-bearing - which is the belt-and-braces coordinator asked
    // for, and it is not redundancy: the pointer can be wrong while the chain is right, and the
    // chain can be right while the pointer misleads a reader.
    //
    // AN UNKNOWN DEPENDENCY DOES NOT PROVE HUMAN-GATED. A dependency may legitimately precede
    // its target and not exist yet, so a missing card leaves the chain unresolved and the card
    // stays lane-actionable. Assuming "blocked on a person" because a link dangles would demote
    // real defects into a count, which is the failure mode this whole split exists to avoid.

    const resolved = blockedWork.map((task) => ({
      task,
      human: chainTerminatesAtUser(task),
      deps: depsOf(task).length,
    }));
    // Human-gated is now a property of the CHAIN, so a card whose own pointer is a lane but
    // which waits behind a person-gated card is correctly demoted to the count - and a card
    // whose pointer says `user` while its chain reaches nothing is correctly kept actionable.
    const humanGated = resolved.filter((r) => r.human).map((r) => r.task);
    // "Blocked on nobody" is now narrower than "no next_actor": a card with a LANE dependency is
    // movable by moving that dependency, so calling it blocked-on-nobody would report a real
    // defect as nobody's problem.
    const unowned = resolved.filter((r) => !r.human && !r.task.nextActor && r.deps === 0).map((r) => r.task);
    const owned = resolved.filter((r) => !r.human && (r.task.nextActor || r.deps > 0)).map((r) => r.task);
    const actionable = owned;    if (unowned.length > 0) {
      unownedBlocked.push({
        count: unowned.length,
        oldestId: unowned.reduce((a, b) => ((a?.ageMs ?? 0) > (b?.ageMs ?? 0) ? a : b), null)?.id || null,
        oldestAgeMs: unowned.reduce((m, t) => Math.max(m, t.ageMs ?? 0), 0),
      });
    }
    // The gate fires on ANY reportable blocked card, not only on lane-actionable ones.
    //
    // It used to require `owned.length > 0`, and `owned` used to mean "has a next_actor" - which
    // INCLUDED the human-gated cards, so a board whose only blocked cards waited on a person
    // still produced an alert, saying good news. Now that human-gated cards are correctly
    // excluded from `owned`, the old gate silently stopped firing on exactly that board, and the
    // "good news, not a broken alert" branch became UNREACHABLE. Three existing tests caught it,
    // which is the argument for keeping them: the branch was not new, but its only path was.
    //
    // A silent disappearance is the dangerous shape here. The alert that says everything is
    // waiting on a person is the one that tells a reader no lane is being neglected, and losing
    // it leaves a healthy board indistinguishable from a board nobody is watching.
    // `unowned` is deliberately NOT part of the gate. A card with neither a next actor nor any
    // dependency is blocked on nobody: it is REPORTED inside the message when some other card
    // legitimately fires this alert, and it never pages on its own at any age. Letting it into
    // the gate would turn "reported, not paged" back into a page, and an existing test for
    // exactly that failed when I first wrote this too wide.
    const reportableOldestMs = Math.max(
      owned.reduce((m, t) => Math.max(m, t.ageMs ?? 0), 0),
      humanGated.reduce((m, t) => Math.max(m, t.ageMs ?? 0), 0),
    );
    if ((owned.length > 0 || humanGated.length > 0) && reportableOldestMs >= limits.blockedWarnMs) {
    // EVERYTHING THIS ALERT SAYS MUST COME FROM `owned`, not from blockedWork.
    // The gate above correctly pages only on cards someone can move, but the headline,
    // the quoted age, the severity, the fingerprint and the triage counts were all still
    // derived from every blocked card - including the unowned ones the split just decided
    // not to page about. The result was an alert that fired because of an owned card and
    // then quoted the unowned one, and worse: severity was computed from the unowned age,
    // so a card waiting on a person was escalating a real 12-minute warning to CRITICAL
    // because it had been waiting 33 minutes. An unowned card must not be able to change
    // the severity of a page a human owns. Unowned information surfaces only in
    // unownedBlocked, which is a report and not a page.
    const ownedOldestAgeMs = actionable.reduce((m, t) => Math.max(m, t.ageMs ?? 0), 0);
    const ownedOldestCard = actionable.reduce(
      (oldestCard, task) => (task.ageMs !== null && (!oldestCard || task.ageMs > oldestCard.ageMs) ? task : oldestCard),
      null,
    );
    // Deliberately independent of blocked_cards, which only counts UNTRIAGED
    // cards. A triaged blocker is still a blocker: recording a reason stops the
    // "you did not say why" alert, but it must not silence the "this has been
    // blocked for five hours" one. Reuses the existing blockedWarnMs /
    // blockedCriticalMs thresholds rather than introducing new knobs.
    const severity = ownedOldestAgeMs >= limits.blockedCriticalMs ? "critical" : "warning";
    // A card that needs a person is reported as a COUNT, never ranked. The counts below are
    // deliberately OUT of the fingerprint: a human wait that ages, changes owner or resolves
    // must not re-fire this alert, or the alert is pinned to a card it cannot escape.
    const triaged = actionable.filter((task) => task.triaged).length;
    const humanOldestAgeMs = humanGated.reduce((m, t) => Math.max(m, t.ageMs ?? 0), 0);
    alerts.push({
      id: "blocked_oldest",
      severity,
      fingerprint: conditionFingerprint({
        id: "blocked_oldest",
        severity,
        cards: cardCondition(actionable),
      }),
      message: actionable.length === 0
        ? `No blocked card is waiting on anything a lane can move: all ${humanGated.length} blocked card(s) have a dependency chain that terminates in a person-gated card, oldest ${humanOldestAgeMs}ms. That is good news, not a broken alert.${unowned.length > 0 ? ` ${unowned.length} further blocked card(s) have neither a next actor nor any dependency, and are reported, not paged: they are blocked on nobody.` : ""}`
        : `Oldest blocked card a LANE can move has been blocked for ${ownedOldestAgeMs}ms (${ownedOldestCard?.id || "unknown"}). ${triaged} of ${actionable.length} carry a triage reason, which stops the untriaged alert but not this one.${humanGated.length > 0 ? ` Separately, ${humanGated.length} blocked card(s) have a dependency chain terminating in a person-gated card, oldest ${humanOldestAgeMs}ms - reported as a count, not ranked, because a human-gated wait resolves only through a person acting and cannot clear while an alert names it. That determination comes from the CHAIN, not from each card's next_actor: reassign does not maintain next_actor, so a stale pointer cannot page the fleet. next_actor still means who must act for the card to advance, and owner still means who does the work.` : ""}${unowned.length > 0 ? ` ${unowned.length} further blocked card(s) have neither a next actor nor any dependency, and are reported, not paged: they are blocked on nobody.` : ""}`,
      recommendedAction: "Resolve it, re-scope it, or record why it is still blocked; a triage reason alone does not close an old blocker.",
      oldestCardId: ownedOldestCard?.id || null,
      oldestAgeMs: ownedOldestAgeMs,
      triagedCount: triaged,
      untriagedCount: actionable.length - triaged,
      cardCount: actionable.length,
      cards: actionable,
      humanGatedCount: humanGated.length,
      humanGatedOldestAgeMs: humanOldestAgeMs,
      unownedBlockedCount: unowned.length,
    });
    }
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
  // ---------------------------------------------------------------------------
  // QUEUED CARDS POINTED AT A PERSON. The bucket no alert aged at all.
  //
  // MEASURED BY COORDINATOR ON THE LIVE BOARD, 453 cards: all ten user decisions were status
  // QUEUED with next_actor=user, oldest ~6.5h, and NOT ONE had ever been named by an alert.
  // `blocked_oldest` ages blocked cards; the person-gated line counts blocked cards whose chain
  // ends at a person; `queue_age` covers backlog/doing/review only. Queued sits in none of them.
  // So the oldest decision on the board - one that transitively gates other cards - was
  // invisible, and the board looked healthier than it was because the person-gated line DID
  // report a count. The reporting was not wrong; it was incomplete in the direction that hides.
  //
  // THE ENCODING IS RIGHT AND IS NOT BEING CHANGED. A card waiting on a person cannot be blocked:
  // blocked requires a non-done machine-readable dependency and these are the ROOTS. Queued +
  // next_actor=user is the correct shape, and coordinator checked before filing precisely because
  // they expected a mis-encoding. There is none.
  //
  // IT IS REPORT-ONLY AND NEVER PAGES. Ten cards genuinely waiting on an owner is the correct
  // shape of a project waiting on its owner, not a delivery failure, and an alert that pages on
  // it trains people to ignore alerts. The whole value is ORDERING and OLDEST: a six-hour decision
  // that gates main must sit visibly above a two-hour one that gates nothing. A count alone is
  // what the person-gated line already does, and a count demonstrably did not surface this.
  //
  // ONE WAIT IS COUNTED ONCE. The chain-walk is reused, so a queued card behind a person-gated
  // root resolves to the same decision. Entries are GROUPED BY THE ROOT the chain terminates at,
  // which is why cd9e12 and 07e71e appear as cards waiting behind e135d1 rather than as three
  // separate waits for one answer. Counting them separately would overstate the backlog and
  // understate the leverage of the single oldest decision.
  const queuedWork = [];
  for (const [columnName, columnTasks] of Object.entries(board.columns || {})) {
    if (columnName !== "queued") continue;
    for (const task of (Array.isArray(columnTasks) ? columnTasks : []).filter(Boolean)) {
      queuedWork.push({ task, ageMs: ageMs(task.updated || task.created_at || task.createdAt || task.created, now) });
    }
  }
  // The ROOT a chain terminates at: the card whose own pointer is the person. A queued card with
  // no such root is lane-runnable even if some card further down happens to name a person.
  const personRootOf = (task, seen = new Set()) => {
    if (!task || !task.id || seen.has(task.id)) return null;          // seen = cycle guard
    seen.add(task.id);
    if (nextActorById.get(task.id) === "user") return task;
    for (const dep of depsOf(task)) {
      const depTask = statusById.get(dep)?.task;
      const root = depTask ? personRootOf(depTask, seen) : null;
      if (root) return root;
    }
    return null;
  };
  const queuedByRoot = new Map();
  for (const entry of queuedWork) {
    const root = personRootOf(entry.task);
    if (!root) continue;                                              // lane-runnable, not ours to age
    const key = root.id;
    if (!queuedByRoot.has(key)) queuedByRoot.set(key, { root, rootAgeMs: ageMs(root.updated || root.created_at || root.createdAt || root.created, now), waiting: [] });
    queuedByRoot.get(key).waiting.push({ id: entry.task.id, title: entry.task.title, ageMs: entry.ageMs });
  }
  const personQueued = [...queuedByRoot.values()].sort((a, b) => (b.rootAgeMs ?? 0) - (a.rootAgeMs ?? 0));
  if (personQueued.length > 0) {
    const oldest = personQueued[0];
    const totalWaiting = personQueued.reduce((n, e) => n + e.waiting.length, 0);
    alerts.push({
      id: "person_queued_oldest",
      // NEVER "page" or "critical": this is a person waiting, and a human-gated wait resolves only
      // through a person acting. It cannot clear while an alert names it, so paging on it would
      // page on something no lane can fix.
      severity: "warning",
      fingerprint: conditionFingerprint({ id: "person_queued_oldest", severity: "warning", cards: personQueued.map((e) => e.root.id) }),
      message: `${personQueued.length} decision(s) are waiting on a person, across ${totalWaiting} queued card(s). Oldest: ${oldest.root.id} (${oldest.root.title || "untitled"}) at ${oldest.rootAgeMs ?? "unknown"}ms.${personQueued.length > 1 ? ` Next oldest: ${personQueued[1].root.id} at ${personQueued[1].rootAgeMs ?? "unknown"}ms - the ordering is the point; a count alone is what the person-gated line already reports, and it did not surface this.` : ""} Cards behind the same decision are counted once, under the decision they wait on, not as separate waits. REPORT-ONLY: this never pages, because a project waiting on its owner is the correct shape of a project, not a delivery failure.`,
      recommendedAction: "The decision is the owner's and no lane can move it. Treat the ORDERING as the signal: the oldest person-gated decision is the one that unblocks the most work.",
      decisionCount: personQueued.length,
      waitingCardCount: totalWaiting,
      oldestDecisionId: oldest.root.id,
      oldestAgeMs: oldest.rootAgeMs ?? 0,
      decisions: personQueued,
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
      activeCards: queueAgeCards.length,
      oldestAgeMs: queueAgeMs,
      oldestCardId: queueOldest?.id || null,
      oldestCardLiveness: queueOldest ? cardLivenessState(queueOldest, now, limits.stalledWorkMs).state : null,
      unattributedExcluded: queueUnknown,
      scope: "backlog, queued, doing, review",
      clock: "card state clock (updated/created); heartbeats do not move it",
    },
    blockedOldest: {
      cards: blockedWork.length,
      oldestAgeMs: blockedOldestAgeMs,
      oldestCardId: blockedOldestCard?.id || null,
      triaged: blockedWork.filter((task) => task.triaged).length,
      untriaged: blockedWork.filter((task) => !task.triaged).length,
      // A REPORT AND NOT AN ALERT, deliberately. A block whose dependencies are all done is a
      // defect in the board, and it is the one state nobody can argue about - but alerting on it
      // would page lanes about a bookkeeping error that only a human can fix, and an alert which
      // fires on ordinary queue latency is an alert everyone learns to ignore, after which the
      // next real one is missed too. The same reasoning that made the needs_reply count a report.
      //
      // `stale` is a block with at least one dependency and EVERY dependency done or unknown-
      // but-not-blocking. `noEdge` is a block with no dependency at all: the abandonment shape,
      // a park expressed as nothing, which is indistinguishable from a card nobody came back to.
      // Both are listed so the difference between them stays visible.
      stale: blockedWork
        .filter((t) => t.dependencyStates.length > 0 && t.dependencyStates.every((d) => d.status === "done"))
        .map((t) => ({
          id: t.id,
          owner: t.owner,
          nextActor: t.nextActor,
          ageMs: t.ageMs,
          releasedBy: t.dependencyStates.map((d) => d.id).join(","),
        })),
      noEdge: blockedWork
        .filter((t) => t.dependencyStates.length === 0)
        .map((t) => ({ id: t.id, owner: t.owner, nextActor: t.nextActor, ageMs: t.ageMs })),
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
    // Blocked cards with no next actor: reported, never alerted. Exposed so the silence
    // is readable rather than merely absent - a card that stopped alerting and a card
    // that was never evaluated must not look the same.
    unownedBlocked,
    unownedBlockedCount: unownedBlocked.reduce((n, g) => n + (g.count || 0), 0),
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
  const activeCards = activeBoardTasks(board, { stallEligible: true });
  // This module's own repository is always in scope, and a caller-supplied list is additive
  // rather than authoritative - so a caller that names only the game repo still gets plugin
  // citations dated, which is the defect this fixes. A caller CAN still narrow it by passing
  // `repos: []` explicitly if it wants a board resolved against nothing.
  const requested = repos.length > 0 ? [...repos, PLUGIN_ROOT] : [PLUGIN_ROOT];
  const { used, skipped } = partitionRepos(requested);
  const resolveDate = makeGitDateResolver({ repos: used });
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
  const metrics = buildCoordinatorMetrics({ ...options, workAgeById });
  // The limitation travels WITH THE METRICS. Every work-age figure above is "as of these
  // repositories", and a reader told only the number cannot know whether an undated citation is
  // undated because the commit is unknown or because the repository was never on the list. Five
  // cards' plugin evidence read UNDATED for the second reason, invisibly.
  metrics.workAgeRepos = {
    used,
    skipped,
    note: skipped.length > 0
      ? `${skipped.length} configured repository path(s) do not exist and were NOT searched, so citations that live only there read as undated rather than absent.`
      : "All configured repository paths exist and were searched.",
  };
  return { metrics, workAgeById };
}

function nowMsOf(now) {
  return now instanceof Date ? now.getTime() : (typeof now === "number" ? now : Date.parse(now));
}

function limitsOf(options) {
  return { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
}
