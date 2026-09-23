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
import { listBacklogTasks, getAgentTaskStats } from "./board.mjs";

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

function healAgentName(handle, dryRun = false) {
  try {
    const out = runHerdr(["pane", "list"]);
    const panes = JSON.parse(out)?.result?.panes ?? [];
    const needle = `- ${handle} - `;
    const hit = panes.find((p) =>
      (p.terminal_title_stripped || p.terminal_title || "").includes(needle)
    );
    if (!hit) return false;
    if (dryRun) {
      console.log(`[bridge] DRY: would heal name ${handle} <- pane ${hit.pane_id}`);
      return true;
    }
    runHerdr(["agent", "rename", hit.pane_id, handle]);
    console.log(`[bridge] Healed pane ${hit.pane_id} -> renamed back to '${handle}'`);
    return true;
  } catch (err) {
    return false;
  }
}

function promptAgent(handle, text, dryRun = false) {
  if (dryRun || process.env.HERDR_DISABLE_PROMPT === "1" || process.env.NODE_ENV === "test") {
    console.log(`[bridge] DRY: would prompt ${handle}: ${text.slice(0, 60)}...`);
    return true;
  }
  try {
    runHerdr(["agent", "prompt", handle, text]);
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

function loadDeliveredState() {
  const stateFile = getStateFile();
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    s.delivered = s.delivered || {};
    s.deliveredTasks = s.deliveredTasks || {};
    return s;
  } catch {
    return { delivered: {}, deliveredTasks: {} };
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
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 1), "utf8");
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
    const files = fs.readdirSync(newDir).filter((f) => !f.startsWith("."));
    const msgs = [];
    for (const f of files) {
      const fullPath = path.join(newDir, f);
      const content = fs.readFileSync(fullPath, "utf8");
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

export const buildDoorbellPrompt = (handle, msgs = [], taskStatsOrBacklog = null) => {
  const senders = [...new Set(msgs.map((m) => m.from))].join(", ");
  const mCount = msgs.length;

  let stats;
  if (Array.isArray(taskStatsOrBacklog)) {
    stats = { backlog: taskStatsOrBacklog.length, blocked: 0, doing: 0, done: 0 };
  } else if (taskStatsOrBacklog && typeof taskStatsOrBacklog === "object") {
    stats = taskStatsOrBacklog;
  } else {
    stats = { backlog: 0, blocked: 0, doing: 0, done: 0 };
  }

  const bCount = stats.backlog || 0;

  // Build task numbers breakdown string: e.g. " (1 blocked, 2 in progress, 3 done)"
  const taskDetails = [];
  if (stats.blocked > 0) taskDetails.push(`${stats.blocked} blocked`);
  if (stats.doing > 0) taskDetails.push(`${stats.doing} in progress`);
  if (stats.done > 0) taskDetails.push(`${stats.done} done`);
  const detailsStr = taskDetails.length > 0 ? ` (${taskDetails.join(", ")})` : "";

  if (mCount > 0 && bCount > 0) {
    return (
      `AMQ & Task doorbell: ${mCount} new message(s) from ${senders}. You have ${bCount} task(s) in backlog${detailsStr}. ` +
      `Run: herdr-amq mail drain --me ${handle} --include-body && herdr-amq task drain --me ${handle}. ` +
      `Claim next task via: herdr-amq task next --me ${handle}, then reply on-thread with herdr-amq mail reply --id <msg_id>.`
    );
  }

  if (bCount > 0) {
    return (
      `Task doorbell: You have ${bCount} task(s) in backlog${detailsStr}. ` +
      `Run: herdr-amq task drain --me ${handle} and claim via: herdr-amq task next --me ${handle}.`
    );
  }

  return (
    `AMQ doorbell: ${mCount} new message(s) in your inbox from ${senders}${detailsStr}. ` +
    `Run: herdr-amq mail drain --me ${handle} --include-body, then reply on-thread with herdr-amq mail reply --id <msg_id>. After replying, resume your work.`
  );
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
  const state = loadDeliveredState();
  state.delivered = state.delivered || {};
  state.deliveredTasks = state.deliveredTasks || {};

  let doorbelledCount = 0;
  let doorbelledTasksCount = 0;
  const results = [];

  for (const handle of agentList) {
    const rawMsgs = listInbox(amqRoot, handle);
    // Ignore self-messages
    const msgs = rawMsgs.filter((m) => m.from !== handle);
    // If message is still in inbox/new after cooldown, the agent did NOT drain it!
    const undeliveredMsgs = msgs.filter((m) => !isItemPendingDrain(state.delivered[m.id], cooldownMs, force));

    const backlogTasks = listBacklogTasks(repoRoot, amqRoot, handle);
    // If task is still in backlog after cooldown, the agent did NOT claim/drain it!
    const undeliveredTasks = backlogTasks.filter((t) => !isItemPendingDrain(state.deliveredTasks?.[t.id], cooldownMs, force));

    if (!undeliveredMsgs.length && !undeliveredTasks.length) continue;

    let status = getAgentStatus(handle);
    if (status === "missing") {
      const healed = healAgentName(handle, dryRun);
      if (healed) status = getAgentStatus(handle);
    }

    const taskStats = getAgentTaskStats(repoRoot, amqRoot, handle);
    taskStats.backlog = undeliveredTasks.length > 0 ? undeliveredTasks.length : backlogTasks.length;

    if (status === "idle" || status === "done") {
      const text = buildDoorbellPrompt(handle, undeliveredMsgs, taskStats);
      const ok = promptAgent(handle, text, dryRun);
      if (ok) {
        doorbelledCount += undeliveredMsgs.length;
        doorbelledTasksCount += undeliveredTasks.length;
        if (!dryRun) {
          for (const m of undeliveredMsgs) {
            const prev = state.delivered[m.id];
            state.delivered[m.id] = {
              at: new Date().toISOString(),
              to: handle,
              from: m.from,
              attempts: (prev?.attempts || 0) + 1,
            };
          }
          for (const t of undeliveredTasks) {
            const prev = state.deliveredTasks[t.id];
            state.deliveredTasks[t.id] = {
              at: new Date().toISOString(),
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
          action: "prompted",
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
        recordAlert(handle, undeliveredMsgs.length, undeliveredMsgs[0]?.from, dryRun);
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

  if (!dryRun && (doorbelledCount > 0 || doorbelledTasksCount > 0)) {
    saveDeliveredState(state);
  }

  return {
    ok: true,
    amqRoot,
    agentsChecked: agentList.length,
    doorbelled: doorbelledCount,
    doorbelledTasks: doorbelledTasksCount,
    results,
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
      const res = runDoorbellPass({ amqRoot, handles, dryRun });
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
