import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  getHerdrBin,
  getStateDir,
  getConfigDir,
  getCoordinatorDoorbellConfig,
  findAmqRoot,
  getRepoRootFromAmq,
  getAgentHandles,
  execCmd,
} from "./config.mjs";
import { listBacklogTasks, getAgentTaskStats, loadBoard } from "./board.mjs";
import { buildCoordinatorMetrics } from "./metrics.mjs";
import { loadLocalTemplate, renderTemplate } from "./templates.mjs";
import { isSafeMailIdentifier, listMaildirMessageFiles, readMaildirMessageFile, writeBoundedFileAtomic } from "./protocol.mjs";

const MAX_DOORBELL_PROMPT_BYTES = 64 * 1024;

function getPidFile() {
  return path.join(getStateDir(), "bridge.pid");
}

/**
 * The singleton lock file. The daemon holds an exclusive `flock` on it for its
 * whole lifetime, so the kernel releases it even if the daemon is SIGKILLed and
 * it can never go stale. Its contents are the pid of the process holding it,
 * which makes the lock holder discoverable even when the pid file is lost.
 */
function getLockFile() {
  return path.join(getStateDir(), "bridge.lock");
}

function getStateFile() {
  return path.join(getStateDir(), "bridge-state.json");
}

function getAlertLogFile() {
  return path.join(getStateDir(), "alerts.log");
}

export function getCoordinatorDoorbellLog(limit = 20) {
  const file = getAlertLogFile();
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.includes("COORDINATOR_ALERT:")).slice(-limit).reverse();
  } catch {
    return [];
  }
}

function recordCoordinatorAlert(message) {
  fs.appendFileSync(getAlertLogFile(), `${new Date().toISOString()} COORDINATOR_ALERT: ${message}\n`);
}

export function isDaemonRunning() {
  const pidFile = getPidFile();
  if (!fs.existsSync(pidFile)) return null;

  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      try { fs.unlinkSync(pidFile); } catch {}
      return null;
    }
    // Check if process exists
    process.kill(pid, 0);
    return pid;
  } catch {
    try { fs.unlinkSync(pidFile); } catch {}
    return null;
  }
}

/**
 * The pid recorded in the singleton lock file, when that process is still alive.
 * The lock file is the authority; the pid file is only a registration that a
 * superseded daemon's cleanup could previously delete.
 */
export function getLockHolder() {
  const lockFile = getLockFile();
  if (!fs.existsSync(lockFile)) return null;
  try {
    const pid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * Describe a daemon that holds the singleton lock but is not the registered one.
 * This is the state that used to be invisible: an unkillable-by-CLI duplicate
 * quietly overwriting the delivery map of the daemon that was registered.
 */
export function getUnregisteredDaemon() {
  const holder = getLockHolder();
  if (!holder) return null;
  const registered = isDaemonRunning();
  return registered === holder ? null : { lockHolder: holder, registeredPid: registered };
}

/**
 * Remove this process's daemon registration, and only this process's.
 *
 * An unconditional unlink here is what let a superseded daemon's cleanup delete
 * the LIVE daemon's pid file; the next `herdr-amq start` then spawned a second
 * daemon that nothing could stop. The lock file is truncated rather than removed
 * because flock is held on the inode.
 */
export function clearOwnedDaemonRegistration(pid = process.pid) {
  let pidFileCleared = false;
  let lockFileCleared = false;
  try {
    const current = parseInt(fs.readFileSync(getPidFile(), "utf8").trim(), 10);
    if (current === pid) { fs.unlinkSync(getPidFile()); pidFileCleared = true; }
  } catch {}
  try {
    const current = parseInt(fs.readFileSync(getLockFile(), "utf8").trim(), 10);
    if (current === pid) { fs.writeFileSync(getLockFile(), "", "utf8"); lockFileCleared = true; }
  } catch {}
  return { pidFileCleared, lockFileCleared };
}

export function stopDaemon() {
  const pid = isDaemonRunning();
  if (!pid) {
    const pidFile = getPidFile();
    if (fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch {}
    }
    return { ok: true, message: "No active bridge daemon running." };
  }

  try {
    process.kill(pid, "SIGTERM");
    const pidFile = getPidFile();
    try { fs.unlinkSync(pidFile); } catch {}
    return { ok: true, pid, message: `Stopped bridge daemon (PID ${pid}).` };
  } catch (err) {
    return { ok: false, pid, error: err.message };
  }
}

export function startDaemonBackground() {
  const existingPid = isDaemonRunning();
  if (existingPid) {
    return { ok: true, pid: existingPid, alreadyRunning: true };
  }

  // The pid file is only a registration and any daemon can delete it, so it is
  // not sufficient to prevent a second daemon. Refuse when the singleton lock is
  // already held by a live process, and say which process holds it.
  const holder = getLockHolder();
  if (holder) {
    return { ok: false, pid: holder, error: `another bridge daemon holds the singleton lock (PID ${holder})` };
  }

  const scriptPath = path.resolve(import.meta.dirname, "../bin/herdr-amq.mjs");
  // Launch under flock: the kernel drops the lock when the process exits, so the
  // lock cannot go stale, and a refused acquisition exits non-zero instead of
  // running a second daemon.
  const child = spawn("flock", ["-n", getLockFile(), process.execPath, scriptPath, "bridge-daemon"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.unref();

  const pid = child.pid;
  if (!pid || typeof pid !== "number") {
    return { ok: false, error: "failed to spawn bridge daemon" };
  }
  // A refused flock exits almost immediately. Without this short wait, "Started"
  // would be printed for a daemon that is already gone — a success line for
  // nothing. Only the liveness of the child is checked here.
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return { ok: false, pid, error: "bridge daemon exited immediately (singleton lock already held?)" };
    }
    break;
  }

  fs.writeFileSync(getPidFile(), String(pid), "utf8");
  return { ok: true, pid, alreadyRunning: false };
}

// ─── Internal Bridge Operations ───────────────────────────────────────────────

function runHerdr(args) {
  const bin = getHerdrBin();
  return execCmd(bin, args);
}

function getAgentStatus(handle) {
  try {
    const out = runHerdr(["agent", "get", handle]);
    const j = JSON.parse(out);
    return j?.result?.agent?.agent_status ?? "unknown";
  } catch {
    return "missing";
  }
}

export function healAgentName(handle, dryRun = false, run = runHerdr) {
  try {
    const out = run(["pane", "list"]);
    const panes = JSON.parse(out)?.result?.panes ?? [];
    const legacyNeedle = `- ${handle} - `;
    const piTitle = `π - ${handle}`;
    let hit = panes.find((p) => {
      const title = (p.terminal_title_stripped || p.terminal_title || "").trim();
      return title.includes(legacyNeedle) || title === piTitle;
    });
    if (!hit) {
      // Fallback: the terminal title is often overwritten by the foreground
      // program (e.g. "OpenCode"), while the tab label keeps the canonical
      // handle. Match the tab label exactly, and heal only when that tab
      // holds a single pane (multi-pane tabs are ambiguous — skip them).
      try {
        const tabsOut = run(["tab", "list"]);
        const tabs = JSON.parse(tabsOut)?.result?.tabs ?? [];
        const tab = tabs.find((t) => (t.label || "") === handle);
        if (tab) {
          const inTab = panes.filter((p) => p.tab_id === tab.tab_id);
          if (inTab.length === 1) hit = inTab[0];
        }
      } catch {}
    }
    if (!hit) return false;
    if (dryRun) {
      console.log(`[bridge] DRY: would heal name ${handle} <- pane ${hit.pane_id}`);
      return true;
    }
    run(["agent", "rename", hit.pane_id, handle]);
    console.log(`[bridge] Healed pane ${hit.pane_id} -> renamed back to '${handle}'`);
    return true;
  } catch (err) {
    return false;
  }
}

function promptAgent(handle, text, dryRun = false) {
  const boundedText = boundDoorbellPrompt(text);
  if (dryRun || process.env.HERDR_DISABLE_PROMPT === "1" || process.env.NODE_ENV === "test") {
    console.log(`[bridge] DRY: would prompt ${handle}: ${boundedText.slice(0, 60)}...`);
    return true;
  }
  try {
    runHerdr(["agent", "prompt", handle, boundedText]);
    return true;
  } catch (err) {
    console.warn(`[bridge] Warning: prompt ${handle} failed: ${err.message}`);
    return false;
  }
}

function recordAlert(handle, count, from, dryRun = false) {
  const timestamp = new Date().toISOString();
  const line =
    `${timestamp} BLOCKED: agent ${handle} has ${count} unread AMQ message(s)` +
    (from ? ` (latest from ${from})` : "") +
    `. A blocked agent requires human intervention. Inspect: herdr agent read ${handle} --lines 40`;

  console.log(`[bridge] ${line}`);
  if (dryRun) return;

  try {
    const alertFile = getAlertLogFile();
    fs.appendFileSync(alertFile, line + "\n");
  } catch {}
}

function safeStateText(value, maxLength = 512) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function sanitizeDeliveredState(value) {
  const delivered = {};
  const deliveredTasks = {};
  const coordinatorAlerts = {};
  if (!value || typeof value !== "object") return { delivered, deliveredTasks, coordinatorAlerts, recoveryRequired: true };

  for (const [id, entry] of Object.entries(value.delivered || {})) {
    if (!isSafeMailIdentifier(id) || !entry || typeof entry !== "object") continue;
    if (!isSafeMailIdentifier(entry.to, 128) || !isSafeMailIdentifier(entry.from, 128)) continue;
    if (typeof entry.at !== "string") continue;
    delivered[id] = {
      at: entry.at,
      to: entry.to,
      from: entry.from,
      attempts: Number.isFinite(entry.attempts) ? Math.max(1, Math.trunc(entry.attempts)) : 1,
      firstAttemptAt: typeof entry.firstAttemptAt === "string" ? entry.firstAttemptAt : entry.at,
    };
  }

  for (const [id, entry] of Object.entries(value.coordinatorAlerts || {})) {
    if (!isSafeMailIdentifier(id) || !entry || typeof entry !== "object") continue;
    if (entry.to !== "coordinator" || typeof entry.at !== "string") continue;
    const alert = safeStateText(entry.alert || id, 128);
    coordinatorAlerts[id] = {
      at: entry.at,
      to: "coordinator",
      alert,
      fingerprint: typeof entry.fingerprint === "string" && isSafeMailIdentifier(entry.fingerprint, 128)
        ? entry.fingerprint
        : coordinatorFingerprintFromKey(id, { alert }),
      attempts: Number.isFinite(entry.attempts) ? Math.max(1, Math.trunc(entry.attempts)) : 1,
      firstAttemptAt: typeof entry.firstAttemptAt === "string" ? entry.firstAttemptAt : entry.at,
    };
  }

  for (const [id, entry] of Object.entries(value.deliveredTasks || {})) {
    if (!isSafeMailIdentifier(id) || !entry || typeof entry !== "object") continue;
    if (!isSafeMailIdentifier(entry.to, 128) || typeof entry.at !== "string") continue;
    deliveredTasks[id] = {
      at: entry.at,
      to: entry.to,
      title: safeStateText(entry.title),
      attempts: Number.isFinite(entry.attempts) ? Math.max(1, Math.trunc(entry.attempts)) : 1,
      firstAttemptAt: typeof entry.firstAttemptAt === "string" ? entry.firstAttemptAt : entry.at,
    };
  }

  return { delivered, deliveredTasks, coordinatorAlerts, recoveryRequired: false };
}

function coordinatorFingerprintFromKey(id, entry) {
  const alert = typeof entry?.alert === "string" ? entry.alert : String(id).split(":", 1)[0];
  const prefix = `${alert}:`;
  if (!String(id).startsWith(prefix)) return null;
  const fingerprint = String(id).slice(prefix.length);
  return isSafeMailIdentifier(fingerprint, 128) ? fingerprint : null;
}

function loadDeliveredState() {
  const stateFile = getStateFile();
  try {
    const content = readMaildirMessageFile(stateFile, 2 * 1024 * 1024);
    if (content === null) return { delivered: {}, deliveredTasks: {}, coordinatorAlerts: {}, recoveryRequired: true };
    const raw = JSON.parse(content);
    const sanitized = sanitizeDeliveredState(raw);
    const needsFingerprintMigration = Object.entries(raw.coordinatorAlerts || {}).some(([id, entry]) => {
      const inferred = coordinatorFingerprintFromKey(id, entry);
      return inferred && entry?.fingerprint !== inferred;
    });
    if (!sanitized.recoveryRequired && needsFingerprintMigration) saveDeliveredState(sanitized);
    return sanitized;
  } catch {
    return { delivered: {}, deliveredTasks: {}, coordinatorAlerts: {}, recoveryRequired: true };
  }
}

function saveDeliveredState(state) {
  const stateFile = getStateFile();
  const ids = Object.keys(state.delivered || {});
  if (ids.length > 2000) {
    ids.sort();
    for (const id of ids.slice(0, ids.length - 1500)) {
      delete state.delivered[id];
    }
  }
  const taskIds = Object.keys(state.deliveredTasks || {});
  if (taskIds.length > 2000) {
    taskIds.sort();
    for (const id of taskIds.slice(0, taskIds.length - 1500)) {
      delete state.deliveredTasks[id];
    }
  }
  const alertIds = Object.keys(state.coordinatorAlerts || {});
  if (alertIds.length > 500) {
    alertIds.sort((left, right) => String(state.coordinatorAlerts[left]?.at || "").localeCompare(String(state.coordinatorAlerts[right]?.at || "")));
    for (const id of alertIds.slice(0, alertIds.length - 500)) {
      delete state.coordinatorAlerts[id];
    }
  }
  writeBoundedFileAtomic(stateFile, JSON.stringify(state, null, 1), 2 * 1024 * 1024);
}

export function listInbox(amqRoot, handle) {
  try {
    const out = execCmd("amq", [
      "list",
      "--root",
      amqRoot,
      "--me",
      handle,
      "--new",
      "--json",
    ]);
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to native pure-JS Maildir reader
  }

  try {
    const newDir = path.join(amqRoot, "agents", handle, "inbox", "new");
    if (!fs.existsSync(newDir)) return [];
    const files = listMaildirMessageFiles(newDir).filter((f) => !f.startsWith("."));
    const msgs = [];
    for (const f of files) {
      const fullPath = path.join(newDir, f);
      const content = readMaildirMessageFile(fullPath);
      if (content === null) continue;
      const jsonMatch = content.match(/^---json\r?\n([\s\S]*?)\r?\n---/);
      if (jsonMatch) {
        try {
          const header = JSON.parse(jsonMatch[1]);
          msgs.push({
            id: header.id || f,
            from: header.from,
            to: header.to,
            subject: header.subject,
            thread: header.thread,
            created: header.created,
          });
          continue;
        } catch {}
      }
      const yamlMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (yamlMatch) {
        const header = {};
        for (const line of yamlMatch[1].split("\n")) {
          const colon = line.indexOf(":");
          if (colon !== -1) {
            const k = line.slice(0, colon).trim();
            const v = line.slice(colon + 1).trim();
            header[k] = v;
          }
        }
        msgs.push({
          id: header.id || f,
          from: header.from,
          to: header.to ? [header.to] : [],
          subject: header.subject,
          thread: header.thread,
          created: header.created,
        });
        continue;
      }
      msgs.push({ id: f, from: "unknown", subject: "(raw mail)" });
    }
    return msgs;
  } catch {
    return [];
  }
}

function boundDoorbellPrompt(text, maxBytes = MAX_DOORBELL_PROMPT_BYTES) {
  const value = typeof text === "string" ? text : String(text ?? "");
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes
    ? value
    : bytes.subarray(0, Math.max(0, maxBytes)).toString("utf8");
}

function safeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function safeSender(value) {
  const sender = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sender) ? sender : "unknown";
}

function normalizeDoorbellStats(taskStatsOrBacklog) {
  const raw = Array.isArray(taskStatsOrBacklog)
    ? { backlog: taskStatsOrBacklog.length, blocked: 0, doing: 0, done: 0 }
    : taskStatsOrBacklog && typeof taskStatsOrBacklog === "object"
      ? taskStatsOrBacklog
      : { backlog: 0, blocked: 0, doing: 0, done: 0 };
  const stats = {
    backlog: safeCount(raw.backlog),
    blocked: safeCount(raw.blocked),
    doing: safeCount(raw.doing),
    done: safeCount(raw.done),
  };
  stats.total = safeCount(raw.total ?? Object.values(stats).reduce((sum, value) => sum + value, 0));
  return stats;
}

function buildDoorbellContext(handle, msgs, stats) {
  return {
    agent: { handle },
    mail: {
      count: safeCount(msgs.length),
      senders: [...new Set(msgs.map((message) => safeSender(message.from)))].slice(0, 16).join(", "),
    },
    board: stats,
  };
}

function buildRequiredDoorbellActions(handle, context) {
  const actions = [];
  if (context.mail.count > 0) {
    actions.push(`Run: herdr-amq mail drain --me ${handle} --include-body.`);
  }
  if (context.board.backlog > 0) {
    actions.push(`Run: herdr-amq task drain --me ${handle}; claim with herdr-amq task next --me ${handle}.`);
  }
  if (context.board.doing > 0) {
    // A heartbeat is still worth recording - it is the honest declaration that the
    // owner is present, and it is read as a lease - but it is no longer what the stall
    // detector ages. The detector reads the card's STATE clock, so the instruction
    // that told agents to heartbeat in order to clear the alert was a loop: obeying it
    // could not move the number. Telling agents to move the card is the remedy that
    // actually works, and the heartbeat is offered as what it is.
    actions.push(`You own ${context.board.doing} in-progress card(s). A card is reported as stalled when it has not CHANGED STATE within the threshold, so a heartbeat will not clear it - move the card (claim, re-scope, block with a reason, or close). Record liveness with \`herdr-amq task heartbeat <id> --me ${handle}\` when you are still working: it is the honest declaration that you are present, and it is read as a lease, not as progress. Notes are narration, never liveness.`);
  }
  if (context.mail.count > 0) {
    actions.push("Reply only when a message explicitly requests action or asks a question; do not send an acknowledgement-only reply. After replying, continue the assigned work.");
  }
  return actions.join(" ");
}

function buildDefaultDoorbellPrompt(handle, msgs, stats) {
  const context = buildDoorbellContext(handle, msgs, stats);
  const taskDetails = [];
  if (context.board.blocked > 0) taskDetails.push(`${context.board.blocked} blocked`);
  if (context.board.doing > 0) taskDetails.push(`${context.board.doing} in progress`);
  if (context.board.done > 0) taskDetails.push(`${context.board.done} done`);
  const details = taskDetails.length ? ` (${taskDetails.join(", ")})` : "";
  let summary;
  if (context.mail.count > 0 && context.board.backlog > 0) {
    summary = `AMQ & Task doorbell: ${context.mail.count} new message(s) from ${context.mail.senders}. You have ${context.board.backlog} task(s) in backlog${details}.`;
  } else if (context.board.backlog > 0) {
    summary = `Task doorbell: You have ${context.board.backlog} task(s) in backlog${details}.`;
  } else {
    summary = `AMQ doorbell: ${context.mail.count} new message(s) in your inbox from ${context.mail.senders}${details}.`;
  }
  return boundDoorbellPrompt(`${summary} ${buildRequiredDoorbellActions(handle, context)}`.trim());
}

export const buildDoorbellPrompt = (handle, msgs = [], taskStatsOrBacklog = null, templateSource = null) => {
  const stats = normalizeDoorbellStats(taskStatsOrBacklog);
  const context = buildDoorbellContext(handle, msgs, stats);
  const fallback = buildDefaultDoorbellPrompt(handle, msgs, stats);
  if (!templateSource) return fallback;

  try {
    const custom = renderTemplate(templateSource, context).trim();
    if (!custom) return fallback;
    const requiredActions = `Required actions: ${buildRequiredDoorbellActions(handle, context)}`;
    const bodyLimit = Math.max(0, MAX_DOORBELL_PROMPT_BYTES - Buffer.byteLength(requiredActions, "utf8") - 2);
    return `${boundDoorbellPrompt(custom, bodyLimit)}\n\n${requiredActions}`;
  } catch {
    return fallback;
  }
};

export const DEFAULT_DOORBELL_COOLDOWN_MS = 45000; // 45s cooldown window

/**
 * Determines whether an item was recently doorbelled and is still in-flight.
 * If the item has not been drained after the cooldown window, it no longer
 * counts as delivered and will be re-doorbelled.
 */
export function isItemPendingDrain(deliveryEntry, cooldownMs = DEFAULT_DOORBELL_COOLDOWN_MS, force = false) {
  if (force) return false;
  if (!deliveryEntry || !deliveryEntry.at) return false;
  const deliveredAt = new Date(deliveryEntry.at).getTime();
  if (isNaN(deliveredAt)) return false;
  return Date.now() - deliveredAt < cooldownMs;
}

function coordinatorAlertKey(alert) {
  return alert.fingerprint ? `${alert.id}:${alert.fingerprint}` : alert.id;
}

function isCoordinatorAlertPending(state, alert, cooldownMs, force = false) {
  if (force) return false;
  if (alert.fingerprint) {
    const key = coordinatorAlertKey(alert);
    if (state.coordinatorAlerts[key]) return true;
  }
  // Alerts without a condition fingerprint retain cooldown-based behavior so
  // an id:null key can never suppress them forever. Legacy alert-id state is
  // also respected while migrating to fingerprint-specific keys.
  const legacy = state.coordinatorAlerts[alert.id] || state.coordinatorAlerts[coordinatorAlertKey(alert)];
  return legacy ? isItemPendingDrain(legacy, cooldownMs, force) : false;
}

function formatAge(value) {
  if (!Number.isFinite(Number(value))) return "unknown";
  const seconds = Math.max(0, Math.round(Number(value) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

function buildCoordinatorAlertPrompt(alert) {
  const lines = [
    "Coordinator review required: inspect the alert and take ownership of the next decision.",
    `Alert: ${alert.id} — ${alert.message}`,
    alert.recommendedAction ? `Recommended action: ${alert.recommendedAction}` : "Recommended action: inspect the current board and keep work moving.",
  ];
  if (Array.isArray(alert.cards) && alert.cards.length > 0) {
    lines.push("Triage snapshot:");
    for (const card of alert.cards.slice(0, 32)) {
      lines.push([
        `- ${card.id}:`,
        `age=${formatAge(card.ageMs)}`,
        `owner=${card.owner || "unknown"}`,
        `next-actor=${card.nextActor || card.owner || "unassigned"}`,
        `dependency=${JSON.stringify(card.dependency || null)}`,
        `reason=${card.reason || "unspecified"}`,
        // Note recency is progress evidence, never liveness: notes do not move `updated`.
        (card.noteCount ? `notes=${card.noteCount} last-note=${formatAge(card.noteAgeMs)} ago` : "notes=0"),
        // A heartbeat from anyone but the owner is a real signal, but a different
        // one, and it must not read as "the owner is still on it".
        (card.heartbeatAt ? `heartbeat=${formatAge(card.heartbeatAgeMs)} ago by=${card.heartbeatBy || "unknown"}${card.heartbeatByNonOwner ? " (not the owner)" : ""}` : "heartbeat=none"),
      ].join(" "));
    }
  }
  lines.push("Classify each card as delegate, re-scope/unblock, wait-with-owner, or close/superseded; return the next actor.");
  lines.push("Coordinator owns triage and approvals; decide and proceed, recording the decision and evidence.");
  return boundDoorbellPrompt(lines.join("\n"));
}

// ─── Doorbell Pass ────────────────────────────────────────────────────────────

export function runDoorbellPass({
  amqRoot = findAmqRoot(),
  handles = null,
  targetHandle = null,
  dryRun = false,
  force = false,
  allowPrompt = false,
  persistState = false,
  state: injectedState = null,
  getStatus = getAgentStatus,
  healName = healAgentName,
  prompt = promptAgent,
  coordinatorDoorbell = getCoordinatorDoorbellConfig(),
  cooldownMs = parseInt(process.env.HERDR_DOORBELL_COOLDOWN_MS || String(DEFAULT_DOORBELL_COOLDOWN_MS), 10),
} = {}) {
  if (!amqRoot) {
    return { ok: false, error: "No .agent-mail queue found." };
  }

  const agentList = targetHandle
    ? [targetHandle]
    : (handles && handles.length > 0 ? handles : getAgentHandles(amqRoot));

  if (!agentList.length) {
    return { ok: true, checked: 0, doorbelled: 0, doorbelledTasks: 0, message: "No registered agents found." };
  }

  const repoRoot = getRepoRootFromAmq(amqRoot);
  const doorbellTemplate = loadLocalTemplate(amqRoot, "doorbell");
  const validHandles = agentList.filter((handle) => typeof handle === "string" && /^[a-z0-9_-]{1,128}$/.test(handle));
  const statusByHandle = Object.fromEntries(validHandles.map((handle) => [handle, getStatus(handle)]));
  const state = injectedState || loadDeliveredState();
  state.delivered = state.delivered || {};
  state.deliveredTasks = state.deliveredTasks || {};
  state.coordinatorAlerts = state.coordinatorAlerts || {};

  let doorbelledCount = 0;
  let doorbelledTasksCount = 0;
  const results = [];

  for (const handle of agentList) {
    if (typeof handle !== "string" || !/^[a-z0-9_-]{1,128}$/.test(handle)) {
      results.push({ handle: String(handle), status: "invalid", count: 0, tasksCount: 0, action: "invalid_handle" });
      continue;
    }
    const rawMsgs = listInbox(amqRoot, handle);
    // Ignore self-messages
    const msgs = rawMsgs.filter((m) => m.from !== handle);
    // If message is still in inbox/new after cooldown, the agent did NOT drain it!
    const undeliveredMsgs = msgs.filter((m) => !isItemPendingDrain(state.delivered[m.id], cooldownMs, force));

    const backlogTasks = listBacklogTasks(repoRoot, amqRoot, handle);
    // If task is still in backlog after cooldown, the agent did NOT claim/drain it!
    const undeliveredTasks = backlogTasks.filter((t) => !isItemPendingDrain(state.deliveredTasks?.[t.id], cooldownMs, force));

    if (!undeliveredMsgs.length && !undeliveredTasks.length) continue;

    let status = statusByHandle[handle] || getStatus(handle);
    if (status === "missing") {
      const healed = healName(
        handle,
        dryRun || !allowPrompt || process.env.HERDR_DISABLE_PROMPT === "1"
      );
      if (healed) status = getAgentStatus(handle);
    }

    const taskStats = getAgentTaskStats(repoRoot, amqRoot, handle);
    taskStats.backlog = undeliveredTasks.length > 0 ? undeliveredTasks.length : backlogTasks.length;

    if (status === "idle" || status === "done") {
      const text = buildDoorbellPrompt(handle, undeliveredMsgs, taskStats, doorbellTemplate?.source || null);
      const ok = prompt(handle, text, dryRun || !allowPrompt);
      if (ok) {
        doorbelledCount += undeliveredMsgs.length;
        doorbelledTasksCount += undeliveredTasks.length;
        if (!dryRun) {
          for (const m of undeliveredMsgs) {
            const prev = state.delivered[m.id];
            const attemptedAt = new Date().toISOString();
            state.delivered[m.id] = {
              at: attemptedAt,
              firstAttemptAt: prev?.firstAttemptAt || attemptedAt,
              to: handle,
              from: m.from,
              attempts: (prev?.attempts || 0) + 1,
            };
          }
          for (const t of undeliveredTasks) {
            const prev = state.deliveredTasks[t.id];
            const attemptedAt = new Date().toISOString();
            state.deliveredTasks[t.id] = {
              at: attemptedAt,
              firstAttemptAt: prev?.firstAttemptAt || attemptedAt,
              to: handle,
              title: t.title,
              attempts: (prev?.attempts || 0) + 1,
            };
          }
        }
        results.push({
          handle,
          status,
          count: undeliveredMsgs.length,
          tasksCount: undeliveredTasks.length,
          action: allowPrompt && !dryRun ? "prompted" : "simulated",
        });
      }
    } else if (status === "working") {
      results.push({
        handle,
        status,
        count: undeliveredMsgs.length,
        tasksCount: undeliveredTasks.length,
        action: "working_wait",
      });
    } else if (status === "blocked") {
      if (undeliveredMsgs.length) {
        recordAlert(handle, undeliveredMsgs.length, undeliveredMsgs[0]?.from, dryRun || !allowPrompt);
      }
      results.push({
        handle,
        status,
        count: undeliveredMsgs.length,
        tasksCount: undeliveredTasks.length,
        action: "alert_blocked",
      });
    } else {
      results.push({
        handle,
        status,
        count: undeliveredMsgs.length,
        tasksCount: undeliveredTasks.length,
        action: "unknown_state",
      });
    }
  }

  const coordinatorMetrics = buildCoordinatorMetrics({
    handles: validHandles,
    agentStatuses: statusByHandle,
    board: loadBoard(repoRoot, amqRoot),
    deliveredState: state,
  });

  let coordinatorDoorbellResult = { attempted: false, prompted: false, alert: null, fingerprint: null };
  const alerts = coordinatorMetrics.alerts || [];
  const coordinatorAlert = alerts.find((alert) => alert.severity === "critical")
    || alerts.find((alert) => ["backlog_idle", "retry_failure_trend", "blocked_cards", "blocked_age"].includes(alert.id));
  const coordinatorHandle = "coordinator";
  const coordinatorStatus = statusByHandle[coordinatorHandle] || (validHandles.includes(coordinatorHandle) ? getStatus(coordinatorHandle) : "missing");
  const alertKey = coordinatorAlert ? coordinatorAlertKey(coordinatorAlert) : null;
  const alertPending = coordinatorAlert
    ? isCoordinatorAlertPending(state, coordinatorAlert, coordinatorDoorbell.cooldownMs, force)
    : false;
  if (coordinatorDoorbell.enabled && coordinatorAlert && (coordinatorStatus === "idle" || coordinatorStatus === "done") && !alertPending) {
    const promptText = buildCoordinatorAlertPrompt(coordinatorAlert);
    const ok = prompt(coordinatorHandle, promptText, dryRun || !allowPrompt);
    const prompted = Boolean(ok && allowPrompt && !dryRun);
    coordinatorDoorbellResult = { attempted: true, prompted, alert: coordinatorAlert.id, fingerprint: coordinatorAlert.fingerprint || null };
    if (prompted) {
      recordCoordinatorAlert(`${coordinatorAlert.id}: ${coordinatorAlert.message}`);
      state.coordinatorAlerts[alertKey] = {
        at: new Date().toISOString(),
        firstAttemptAt: state.coordinatorAlerts[alertKey]?.firstAttemptAt || new Date().toISOString(),
        to: coordinatorHandle,
        alert: coordinatorAlert.id,
        fingerprint: coordinatorAlert.fingerprint || null,
        attempts: (state.coordinatorAlerts[alertKey]?.attempts || 0) + 1,
      };
    }
  }

  if (allowPrompt && persistState && !dryRun && (doorbelledCount > 0 || doorbelledTasksCount > 0 || coordinatorDoorbellResult.prompted)) {
    saveDeliveredState(state);
  }

  return {
    ok: true,
    amqRoot,
    agentsChecked: agentList.length,
    doorbelled: doorbelledCount,
    doorbelledTasks: doorbelledTasksCount,
    results,
    coordinator: coordinatorMetrics,
    coordinatorDoorbell: coordinatorDoorbellResult,
  };
}

export function runManualCoordinatorDoorbell({
  amqRoot = findAmqRoot(),
  dryRun = false,
  allowPrompt = true,
  prompt = promptAgent,
} = {}) {
  if (!amqRoot) return { ok: false, error: "No .agent-mail queue found." };
  const state = loadDeliveredState();
  const text = [
    "Manual coordinator doorbell requested from the AGmail dashboard.",
    "Review current swarm metrics, blocked work, and queue state, then delegate or re-scope as needed.",
    "Coordinator owns triage and approvals; decide and proceed, recording the decision and evidence.",
  ].join("\n");
  const ok = prompt("coordinator", text, dryRun || !allowPrompt);
  const prompted = Boolean(ok && allowPrompt && !dryRun);
  if (prompted) {
    state.coordinatorAlerts.manual = {
      at: new Date().toISOString(),
      to: "coordinator",
      alert: "manual",
      attempts: 1,
    };
    saveDeliveredState(state);
    recordCoordinatorAlert("manual: dashboard requested coordinator re-evaluation");
  }
  return { ok: true, prompted, manual: true };
}

// ─── Continuous Daemon Loop ───────────────────────────────────────────────────

export function startDaemonLoop({ interval = 3000, dryRun = false } = {}) {
  const amqRoot = findAmqRoot();
  if (!amqRoot) {
    console.error("[bridge] Fatal: could not locate .agent-mail queue directory.");
    process.exit(1);
  }

  const pid = process.pid;
  // Record ownership so `status` can find this daemon even if the pid file is
  // lost, and so a later `stop` knows which process to signal.
  try { fs.writeFileSync(getLockFile(), String(pid), "utf8"); } catch {}
  fs.writeFileSync(getPidFile(), String(pid), "utf8");

  const cleanup = () => {
    console.log(`[bridge] Stopping bridge daemon (PID ${pid})...`);
    clearOwnedDaemonRegistration(pid);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(`[bridge] AMQ Herdr Bridge started (PID ${pid})`);
  console.log(`[bridge] Queue: ${amqRoot}`);
  console.log(`[bridge] Interval: ${interval}ms`);

  const tick = () => {
    try {
      const handles = getAgentHandles(amqRoot);
      const res = runDoorbellPass({ amqRoot, handles, dryRun, allowPrompt: true, persistState: true });
      if (res.doorbelled > 0) {
        console.log(`[bridge] Doorbelled ${res.doorbelled} message(s)`);
      }
    } catch (err) {
      console.error(`[bridge] Error in pass: ${err.message}`);
    }
  };

  tick();
  setInterval(tick, interval);
}
