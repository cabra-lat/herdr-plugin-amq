import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  getHerdrBin,
  getStateDir,
  getConfigDir,
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

function getStateFile() {
  return path.join(getStateDir(), "bridge-state.json");
}

function getAlertLogFile() {
  return path.join(getStateDir(), "alerts.log");
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

  const scriptPath = path.resolve(import.meta.dirname, "../bin/herdr-amq.mjs");
  const child = spawn(process.execPath, [scriptPath, "bridge-daemon"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.unref();

  const pid = child.pid;
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

function sanitizeDeliveredState(value) {
  const delivered = {};
  const deliveredTasks = {};
  if (!value || typeof value !== "object") return { delivered, deliveredTasks, recoveryRequired: true };

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

  return { delivered, deliveredTasks, recoveryRequired: false };
}

function loadDeliveredState() {
  const stateFile = getStateFile();
  try {
    const content = readMaildirMessageFile(stateFile, 2 * 1024 * 1024);
    if (content === null) return { delivered: {}, deliveredTasks: {}, recoveryRequired: true };
    return sanitizeDeliveredState(JSON.parse(content));
  } catch {
    return { delivered: {}, deliveredTasks: {}, recoveryRequired: true };
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
  if (context.mail.count > 0) {
    actions.push("Reply only when a message explicitly requests action or asks a question.");
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

  if (allowPrompt && persistState && !dryRun && (doorbelledCount > 0 || doorbelledTasksCount > 0)) {
    saveDeliveredState(state);
  }

  const coordinatorMetrics = buildCoordinatorMetrics({
    handles: validHandles,
    agentStatuses: statusByHandle,
    board: loadBoard(repoRoot, amqRoot),
    deliveredState: state,
  });

  return {
    ok: true,
    amqRoot,
    agentsChecked: agentList.length,
    doorbelled: doorbelledCount,
    doorbelledTasks: doorbelledTasksCount,
    results,
    coordinator: coordinatorMetrics,
  };
}

// ─── Continuous Daemon Loop ───────────────────────────────────────────────────

export function startDaemonLoop({ interval = 3000, dryRun = false } = {}) {
  const amqRoot = findAmqRoot();
  if (!amqRoot) {
    console.error("[bridge] Fatal: could not locate .agent-mail queue directory.");
    process.exit(1);
  }

  const pid = process.pid;
  fs.writeFileSync(getPidFile(), String(pid), "utf8");

  const cleanup = () => {
    console.log(`[bridge] Stopping bridge daemon (PID ${pid})...`);
    try { fs.unlinkSync(getPidFile()); } catch {}
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
