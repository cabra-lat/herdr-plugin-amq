import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  getHerdrBin,
  getStateDir,
  getConfigDir,
  findAmqRoot,
  getAgentHandles,
  execCmd,
} from "./config.mjs";

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
  if (dryRun) {
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
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { delivered: {} };
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

const buildDoorbellPrompt = (handle, msgs) => {
  const senders = [...new Set(msgs.map((m) => m.from))].join(", ");
  const n = msgs.length;
  return (
    `AMQ doorbell: ${n} new message(s) in your inbox (from ${senders}). ` +
    `Run: amq drain --me ${handle} --include-body, then reply to the sender on the same ` +
    `thread with amq reply --id <msg_id>. After replying, resume your work.`
  );
};

// ─── Doorbell Pass ────────────────────────────────────────────────────────────

export function runDoorbellPass({
  amqRoot = findAmqRoot(),
  handles = null,
  targetHandle = null,
  dryRun = false,
} = {}) {
  if (!amqRoot) {
    return { ok: false, error: "No .agent-mail queue found." };
  }

  const agentList = targetHandle
    ? [targetHandle]
    : (handles && handles.length > 0 ? handles : getAgentHandles(amqRoot));

  if (!agentList.length) {
    return { ok: true, checked: 0, doorbelled: 0, message: "No registered agents found." };
  }

  const state = loadDeliveredState();
  state.delivered = state.delivered || {};

  let doorbelledCount = 0;
  const results = [];

  for (const handle of agentList) {
    const rawMsgs = listInbox(amqRoot, handle);
    // Ignore self-messages
    const msgs = rawMsgs.filter((m) => m.from !== handle);

    if (!msgs.length) continue;

    // Filter messages not yet delivered
    const undelivered = msgs.filter((m) => !state.delivered[m.id]);
    if (!undelivered.length) continue;

    let status = getAgentStatus(handle);
    if (status === "missing") {
      const healed = healAgentName(handle, dryRun);
      if (healed) status = getAgentStatus(handle);
    }

    if (status === "idle" || status === "done") {
      const text = buildDoorbellPrompt(handle, undelivered);
      const ok = promptAgent(handle, text, dryRun);
      if (ok) {
        doorbelledCount += undelivered.length;
        if (!dryRun) {
          for (const m of undelivered) {
            state.delivered[m.id] = {
              at: new Date().toISOString(),
              to: handle,
              from: m.from,
            };
          }
        }
        results.push({ handle, status, count: undelivered.length, action: "prompted" });
      }
    } else if (status === "working") {
      results.push({ handle, status, count: undelivered.length, action: "working_wait" });
    } else if (status === "blocked") {
      recordAlert(handle, undelivered.length, undelivered[0]?.from, dryRun);
      results.push({ handle, status, count: undelivered.length, action: "alert_blocked" });
    } else {
      results.push({ handle, status, count: undelivered.length, action: "unknown_state" });
    }
  }

  if (!dryRun && doorbelledCount > 0) {
    saveDeliveredState(state);
  }

  return {
    ok: true,
    amqRoot,
    agentsChecked: agentList.length,
    doorbelled: doorbelledCount,
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
