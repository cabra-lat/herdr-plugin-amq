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
import { buildCoordinatorMetrics, buildCoordinatorMetricsWithWorkAge, stalledCardsForOwner } from "./metrics.mjs";
import { loadLocalTemplate, renderTemplate } from "./templates.mjs";
import { isSafeMailIdentifier, listMaildirMessageFiles, readMaildirMessageFile, writeBoundedFileAtomic } from "./protocol.mjs";

const MAX_DOORBELL_PROMPT_BYTES = 64 * 1024;

export function getPidFile() {
  return path.join(getStateDir(), "bridge.pid");
}

/**
 * The singleton lock file. The daemon holds an exclusive `flock` on it for its
 * whole lifetime, so the kernel releases it even if the daemon is SIGKILLed and
 * it can never go stale. Its contents are the pid of the process holding it,
 * which makes the lock holder discoverable even when the pid file is lost.
 */
export function getLockFile() {
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
  // THE OWNER-LEASE MAP IS PART OF THE STATE. It was written to disk by saveDeliveredState and
  // then thrown away here, so every pass loaded an empty map, the "already armed, stay quiet"
  // guard could never fire, and each owner was re-prompted on every pass. player-rig was
  // doorbelled roughly every 21 seconds off two cards. The guard was correct; nothing ever
  // reached it. A state file that is written but not read is a latch that does not latch.
  const ownerLeasePrompts = {};
  if (!value || typeof value !== "object") return { delivered, deliveredTasks, coordinatorAlerts, ownerLeasePrompts, recoveryRequired: true };

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

  // Owner-lease prompts are keyed `cardId@leaseEpoch`, so the key is a composite, not a bare
  // mail identifier. It is validated by shape instead: no control characters and bounded length,
  // because it is written straight into a state file that another process reads back.
  for (const [id, entry] of Object.entries(value.ownerLeasePrompts || {})) {
    if (typeof id !== "string" || id.length > 256 || /[\r\n\0]/.test(id)) continue;
    if (!entry || typeof entry !== "object" || typeof entry.at !== "string") continue;
    ownerLeasePrompts[id] = {
      at: entry.at,
      owner: isSafeMailIdentifier(entry.owner, 128) ? entry.owner : "unknown",
      leaseEpoch: Number.isFinite(entry.leaseEpoch) ? entry.leaseEpoch : null,
      reassignmentSuggested: Boolean(entry.reassignmentSuggested),
    };
  }

  return { delivered, deliveredTasks, coordinatorAlerts, ownerLeasePrompts, recoveryRequired: false };
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
    if (content === null) return { delivered: {}, deliveredTasks: {}, coordinatorAlerts: {}, ownerLeasePrompts: {}, recoveryRequired: true };
    const raw = JSON.parse(content);
    const sanitized = sanitizeDeliveredState(raw);
    const needsFingerprintMigration = Object.entries(raw.coordinatorAlerts || {}).some(([id, entry]) => {
      const inferred = coordinatorFingerprintFromKey(id, entry);
      return inferred && entry?.fingerprint !== inferred;
    });
    if (!sanitized.recoveryRequired && needsFingerprintMigration) saveDeliveredState(sanitized);
    return sanitized;
  } catch {
    return { delivered: {}, deliveredTasks: {}, coordinatorAlerts: {}, ownerLeasePrompts: {}, recoveryRequired: true };
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
  // Stalled cards are carried through as DATA, not recomputed here. The doorbell and the
  // coordinator alert must agree about whether a card is stalled; a second copy of the
  // clock is how queue_age and stalled_work came to disagree about one card at one
  // instant, and that regression is not worth repeating for a prompt.
  stats.stalledCards = Array.isArray(raw.stalledCards) ? raw.stalledCards : [];
  stats.unknownLivenessCards = Array.isArray(raw.unknownLivenessCards) ? raw.unknownLivenessCards : [];
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
    // --consume is required: the drain is a non-destructive peek by default, and the
    // doorbell is driven by inbox/new, so telling the agent to run a bare drain would
    // leave the message in new/ and re-alert on every cooldown forever.
    actions.push(`Run: herdr-amq mail drain --me ${handle} --include-body --consume.`);
  }
  if (context.board.backlog > 0) {
    actions.push(`Run: herdr-amq task drain --me ${handle}; claim with herdr-amq task next --me ${handle}.`);
  }
  // Only when a card of THIS agent's has actually stopped moving. This line used to
  // fire for every in-progress card regardless of state, which taught agents to read
  // "stalled" as boilerplate: the same sentence appeared for a card claimed thirty
  // seconds ago and for one dead for an hour, so neither was actionable.
  const stalled = context.board.stalledCards || [];
  if (stalled.length > 0) {
    // ASK LIVENESS BEFORE ASKING FOR A TRANSITION. The stall clock is the PROGRESS clock and it
    // is correct: a heartbeat does not clear it, which is right, because a beat is a lease and not
    // progress. The defect was never in the measurement - it is that this prompt asked every
    // reader for the same thing regardless of who was actually there.
    //
    // A card whose owner is NOT live is not a stall to triage. On 2026-07-01 a lane ran out of
    // budget with its work correctly recorded and got "Move the card - claim it, re-scope it, block
    // it with a reason, or close it." All four assert something it could not honestly assert:
    // working, delivered, or waiting on someone. It fired ~340 times and every offered move was a
    // lie, because the menu had no item for "present, recorded, not delivering, not waiting".
    //
    // The board already records that. liveness on this very projection is live / stale / unknown,
    // computed from last_heartbeat_at separately from the progress clock and carried here
    // unused. So the fix is to partition on data already present rather than to invent a verb:
    // a card with no live owner needs a ROUTE or a WAKE, and only a card whose owner is present
    // AND moving has a transition to be asked for.
    const isLive = (card) => String(card.liveness || "").toLowerCase() === "live";
    const unattended = stalled.filter((card) => !isLive(card));
    const attended = stalled.filter((card) => isLive(card));
    const label = (card) =>
      `${card.id} ("${String(card.title || "").slice(0, 60)}", ${Math.round((card.ageMs || 0) / 60000)}m, clock=${card.livenessVia || "state"})`;

    if (unattended.length > 0) {
      const named = unattended.slice(0, 4).map(label).join("; ");
      const more = unattended.length > 4 ? ` and ${unattended.length - 4} more` : "";
      actions.push(`UNATTENDED: ${unattended.length} of your card(s) have not CHANGED STATE and you have not renewed your lease on them: ${named}${more}. You are not present on these, so the honest next step is to WAKE yourself or ROUTE the card to a lane that is - not to move it. Claiming it, completing it or blocking it would each assert something that is not true, which is why this alert has been so hard to answer truthfully.`);
    }
    if (attended.length > 0) {
      const named = attended.slice(0, 4).map(label).join("; ");
      const more = attended.length > 4 ? ` and ${attended.length - 4} more` : "";
      // THIS TEXT USED TO DEMAND A MOVE, AND THAT WAS THE SAME LIE IN A NEW COSTUME. A present
      // owner is not necessarily an owner with something to transition, and the coordinator hit
      // exactly this: two versions of this same alert ninety seconds apart on one card with the
      // same clock and the same number, giving opposite instructions, because the lease had been
      // renewed in between. The UNATTENDED branch was right - it declines to demand a move and says
      // why - and this branch was still demanding one. So the honest instruction is the same
      // refusal with a different recommendation, and the move stays a genuine OPTION rather than the
      // only sentence in the prompt.
      actions.push(`STALLED: ${attended.length} of your card(s) have not CHANGED STATE while you ARE present: ${named}${more}. You are here, so this is yours to resolve - and if you have nothing true to say about it, that is a real state: route the card, or leave it and let the clock keep asking. Claiming, re-scoping, blocking and completing are all AVAILABLE and none of them is REQUIRED, because each asserts something and you may have nothing to assert. A heartbeat will NOT clear this: \`herdr-amq task heartbeat <id> --me ${handle}\` declares you are present (a lease, not progress) and cannot move the number. Notes are narration, never liveness.`);
    }
    // THE CITATIONS A STALLED CARD IS CARRYING, AND WHERE EACH WAS READ FROM.
    //
    // `where` shipped as payload with no consumer: produced in work-age.mjs, read by two tests,
    // shown to nobody. That is the same defect as the doorbell list - a field in the artifact
    // about the artifact - and I am not fixing it by adding a second unused field. It becomes
    // visible here, on the line where a stalled card is already being reported.
    //
    // It is worth the space because it answers a question a stalled card always raises: is this
    // card citing anything at all? An undated count alone cannot distinguish "cites nothing" from
    // "cites something nobody can date", and those need opposite responses - start work versus go
    // find the commit. Naming the source field is what separates them.
    //
    // The scope caveat travels WITH the data rather than living only in a commit message: this
    // signal covers ACTIVE cards only, because workAgeById is built from the stall-eligible set.
    // A finished card's evidence is not undated here - it is ABSENT, and a reader who is not told
    // that will read the absence as a finding.
    const cited = stalled
      .map((card) => {
        const cites = card.work?.citations || [];
        if (cites.length === 0) return null;
        return `${card.id}: ${cites.slice(0, 3).map((c) => `${c.value} (from ${c.where})`).join(", ")}${cites.length > 3 ? ` +${cites.length - 3} more` : ""}`;
      })
      .filter(Boolean);
    if (cited.length > 0) {
      actions.push(`Evidence cited by ${cited.length} stalled card(s), with the field each citation was read from: ${cited.join("; ")}. ACTIVE CARDS ONLY: this covers cards that have not finished, because the work-age signal is built from the stall-eligible set - a DONE card's evidence is ABSENT from this list, not undated, and its absence is not a finding about the card.`);
    }
  }
  const unknownLiveness = context.board.unknownLivenessCards || [];
  if (unknownLiveness.length > 0) {
    // Reported, never treated as stalled: a clock that names no author is UNKNOWN, not
    // live and not stale, and guessing either way would invent a fact about the owner.
    actions.push(`${unknownLiveness.length} of your card(s) carry a liveness clock that names no author, so their liveness is UNKNOWN and they are counted as neither live nor stalled: ${unknownLiveness.map((c) => c.id).join(", ")}. Re-claim or heartbeat them to attribute the clock.`);
  }
  if (context.board.doing > 0 && stalled.length === 0) {
    // A heartbeat is still worth recording - it is the honest declaration that the
    // owner is present, and it is read as a lease - but it is no longer what the stall
    // detector ages. The detector reads the card's STATE clock, so the instruction
    // that told agents to heartbeat in order to clear the alert was a loop: obeying it
    // could not move the number. Telling agents to move the card is the remedy that
    // actually works, and the heartbeat is offered as what it is.
    actions.push(`You own ${context.board.doing} in-progress card(s), none currently stalled. Record liveness with \`herdr-amq task heartbeat <id> --me ${handle}\` when you are still working: it is the honest declaration that you are present, and it is read as a lease, not as progress. Notes are narration, never liveness.`);
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

/**
 * A DOORBELL CANDIDATE IS NOT A DELIVERY. Membership in the list only says an alert MAY be shown;
 * it never said it WOULD be. Exported so the CHOICE is testable, which is the whole point: when
 * this selection was inline in the bridge body, the only assertion anyone could write was "the id
 * is in the list" - and that assertion passed while the signal delivered ZERO times on a live
 * board with 188 blocked_cards and 94 backlog_idle on the same day.
 *
 * The bug it replaces: alerts.find(sev === "critical") || alerts.find(id => IDS.includes(id)).
 * Array.find returns the first match IN THE ALERTS ARRAY, so the winner was decided by the order
 * metrics.mjs happens to push alerts in. person_queued_oldest is pushed at metrics.mjs:983,
 * behind backlog_idle (865), blocked_cards (900) and blocked_age (915) - so on any board where one
 * of those was present the find reached them first. Being warning by design it could never win the
 * critical find either, so there was NO PATH to it. A ranked "oldest decision" signal competing by
 * SOURCE LINE NUMBER is not a ranking anyone chose.
 *
 * THREE TIERS: SEVERITY (a critical always outranks a warning - the one place a person-gated wait
 * must never come first), then STARVATION (among equals, the candidate gone longest since its last
 * delivery wins; never-delivered sorts as infinitely old so a new signal gets its turn), then the
 * declared list order as an explicit tiebreak rather than an accident of a file. Starvation is what
 * makes the class unrepeatable: any fixed ordering eventually starves whatever sits at the end of
 * it, and an undeliverable signal is indistinguishable from one that does not exist.
 */
export const DOORBELL_ALERT_IDS = ["backlog_idle", "retry_failure_trend", "blocked_cards", "blocked_age", "person_queued_oldest"];

export function rankDoorbellAlerts(alerts, coordinatorAlerts = {}, now = Date.now(), alertKey = (a) => a.id) {
  const lastDeliveredMs = (alert) => {
    const at = Date.parse(coordinatorAlerts?.[alertKey(alert)]?.at ?? "");
    return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
  };
  const sev = (a) => (a.severity === "critical" ? 0 : 1);
  return alerts
    .filter((alert) => alert.severity === "critical" || DOORBELL_ALERT_IDS.includes(alert.id))
    .slice()
    .sort((a, b) => {
      if (sev(a) !== sev(b)) return sev(a) - sev(b);
      // DESCENDING by time-since-delivery: the longest wait goes FIRST. Ascending here is a
      // silent inversion, because a never-delivered alert is +Infinity and +Infinity sorts
      // LAST - which is exactly the defect being fixed, reintroduced inside the fix.
      //
      // THE TIE MUST BE COMPARED WITH `!==`, NOT BY SUBTRACTING. Infinity - Infinity is NaN, and a
      // comparator that returns NaN leaves Array.sort's order UNSPECIFIED - which is how the same
      // five alerts ranked differently depending only on the order they were pushed in, i.e. the
      // original defect reproduced inside its own fix. Two never-delivered alerts must fall
      // through to the declared order deterministically.
      const la = lastDeliveredMs(a);
      const lb = lastDeliveredMs(b);
      if (la !== lb) return lb - la;
      return DOORBELL_ALERT_IDS.indexOf(a.id) - DOORBELL_ALERT_IDS.indexOf(b.id);
    });
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

export function buildCoordinatorAlertPrompt(alert) {
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
        // DO NOT fall back to `owner` here. Owner and next actor are different facts, and
        // rendering the owner as the next actor asserts something the state does not
        // contain: a card with next_actor null printed as `next-actor=player-rig` read as
        // assigned to a lane that had not been assigned anything. It also hid the
        // next_actor split entirely - the whole point of that rule is that an unowned
        // blocked card has no actor, and the render was manufacturing one. The owner is
        // already printed on the line above, so nothing is lost by telling the truth here.
        // Stage-aware wording. "blocked on nobody" is a claim about a BLOCKED card, and
        // this line also renders stalled cards - where no next actor means nobody has
        // been named to move it, which is a different fact from being blocked on a
        // person. Printing the blocked wording on a stalled card is the same error as
        // printing an owner as the next actor: a confident assertion the state does not
        // support, in the same field.
        `next-actor=${card.nextActor || (card.stage === "blocked" ? "none (blocked on nobody)" : "none (no next actor)")}`,
        // WHAT IS STILL GATING THIS CARD, not merely what it points at.
        //
        // This printed `dependency=${JSON.stringify(card.dependency || null)}`, and the stalled
        // projection had no `dependency` key at all - so an ABSENT field rendered as an
        // authoritative "no dependencies", and three cards carrying live edges were displayed as
        // unencumbered. `|| null` is what did it: it cannot tell a missing key from a null value,
        // so a projection that forgot a field looks exactly like a card that has none.
        //
        // Now it reports the UNMET edges, and says so plainly when there are none to report. All
        // three of coordinator's cards depend on cards that are DONE, so printing the satisfied
        // edges would put three satisfied dependencies beside a stall alert and invite the reader
        // to conclude the work is blocked when it is in fact runnable. "deps all satisfied" is the
        // most useful thing this line can say: it is the difference between work nobody started
        // and work nobody could start, which this alert previously could not express at all.
        //
        // The three states are kept distinct because collapsing them is the bug in a new place:
        // edges exist and are all done; edges exist and some are unmet; there are no edges, which
        // is the blocked-on-nobody case and is NOT "all satisfied".
        (card.unmetDependencies && card.unmetDependencies.length > 0
          ? `deps-unmet=${card.unmetDependencies.map((d) => `${d.id} (${d.status})`).join(",")}`
          : card.depsAllSatisfied
            ? `deps=all-satisfied (${card.dependencyStates.length})`
            : card.dependencyStates && card.dependencyStates.length === 0
              ? "deps=none (this card waits on nothing, which is not the same as its deps being met)"
              : `deps=${JSON.stringify(card.dependency || null)}`),
        // A REASON THAT DOES NOT APPLY IS NOT A MISSING REASON.
        //
        // `reason` reads block_reason, which only means anything for a BLOCKED card. Printing
        // "unspecified" for an in_progress card presents an inapplicable field as a blank one,
        // and a reader triaging a stall cannot tell "nobody wrote a reason" from "a reason was
        // never the right question here" - so the column invites exactly the misreading the
        // dependency line above exists to prevent. Stage-aware, for the same reason the
        // next-actor line above is: one field, two meanings, and the wording has to say which.
        `reason=${card.reason || (card.stage === "blocked" ? "unspecified" : "n/a (not blocked; only a blocked card carries a reason)")}`,
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

/**
 * THE OWNER RE-PROMPT. Advisory, aimed at the OWNER, and deliberately NOT the coordinator.
 *
 * A compacted agent still holds a card, a live owner name and a fresh-enough heartbeat, so
 * nothing else on this board notices it is gone: the card says working and the agent has no
 * memory of working. The heartbeat cannot be the signal, because a heartbeat proves PRESENCE and
 * presence is exactly what compaction takes away.
 *
 * Four things this prompt must not do, each of which is a way to make the failure worse:
 *   - not say "restart". Discarding correct partial analysis is worse than not resuming, and an
 *     agent that is told to restart and then restarts from zero will learn to stop resuming,
 *     which is this defect manufactured by its own fix.
 *   - not invent a resume line. A fabricated next action is a confident instruction to do the
 *     wrong work; a card with no line says so and asks the owner to write one.
 *   - not go to the coordinator. Coordinator cannot resume another lane's context, so escalating
 *     turns a mechanical failure into a manual one - which is what made this slow to notice.
 *   - not repeat. Armed per (card, lease epoch), so a resumed agent is prompted at most once per
 *     claim and age growth alone never re-delivers.
 */
function buildOwnerResumePrompt(card) {
  const lines = [
    `You still own ${card.id}${card.title ? ` ("${card.title}")` : ""} and it is still in_progress.`,
    `Your lease last showed a heartbeat ${Math.round(card.leaseAgeMs / 60000)} minute(s) ago. This usually means a CONTEXT COMPACTION dropped your working context, not that you stopped.`,
  ];
  if (card.resumeLine) {
    // The mechanism: a read of the card, not a reconstruction of a conversation.
    lines.push(`Your next action, recorded on the card at claim time: ${card.resumeLine}`);
    lines.push("Read the card and continue from that line. Your earlier analysis is still valid - do not redo it.");
  } else {
    lines.push("This card has NO resume line recorded, so there is nothing to continue from on the card itself.");
    const reestablish = `herdr-amq task resume-line ${card.id} --text "<the next action>"`;
    lines.push("Re-establish it first: " + reestablish);
    lines.push("Do not start new work until the card says what is owed.");
  }
  if (card.reassignmentSuggested) {
    // The second sub-case, kept distinct: a process that is genuinely gone cannot be resumed by
    // being told to resume. Reassignment to a lane that can pick it up cold is the recoverable
    // move, and it is offered rather than taken.
    lines.push("This lease has lapsed a second time, so the card may be held by a process that is gone. If you cannot act on it, say so and it can be reassigned to a lane that can pick it up cold.");
  }
  lines.push("This is advisory. It is not an instruction to restart, and arrival is not a reason to discard anything.");
  return lines.join("\n");
}

export function runDoorbellPass({
  amqRoot = findAmqRoot(),
  handles = null,
  targetHandle = null,
  dryRun = false,
  force = false,
  allowPrompt = false,
  persistState = false,
  state: injectedState = null,
  // Supplied by the daemon, which resolves the root once at its own lifetime. Undefined for
  // every other caller, which then resolves it here.
  repoRoot: givenRepoRoot = null,
  // Precomputed full-board work age. INJECTED rather than built here because this function is
  // SYNCHRONOUS and is called from a synchronous CLI path - making it await would either break
  // that path or make it pay a ~2.9s first build. The daemon builds this once, ahead of the tick.
  workAgeById = null,
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

  // Resolved ONCE per pass, and the daemon passes the value it already holds. Two independent
  // resolutions of a pure function agree today and nothing forces them to: a second call site
  // that half-implements getRepoRootFromAmq, or a cwd that differs between the two, would make
  // the tick load one board and the pass load another, and the symptom would be citations that
  // silently resolve against nothing. The fallback keeps the standalone CLI path working, where
  // there is no daemon to hand a value down.
  const repoRoot = givenRepoRoot || getRepoRootFromAmq(amqRoot);
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

  // Loaded once for the whole pass: the doorbell needs per-card stall state, and
  // re-reading the bus per agent would be a board read per lane on every tick.
  const doorbellBoard = loadBoard(repoRoot, amqRoot);
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
    // Real stalled cards for THIS owner, from the same projection the coordinator alert
    // uses, so the lane is told which of its own cards stopped moving rather than being
    // handed a generic sentence about the concept.
    const ownerStall = stalledCardsForOwner(doorbellBoard, handle);
    taskStats.stalledCards = ownerStall.stalled;
    taskStats.unknownLivenessCards = ownerStall.unknown;

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
    // THE LINE THAT WAS MISSING. Without it every card gets `work: null` (metrics.mjs computes
    // `work: workAgeById?.get(task.id) || null`), so `card.work?.citations` is undefined and the
    // citation render can never fire from this function - no matter how correct the render is.
    workAgeById,
  });

  let coordinatorDoorbellResult = { attempted: false, prompted: false, alert: null, fingerprint: null };
  const alerts = coordinatorMetrics.alerts || [];
  // `person_queued_oldest` is in this list because of HOW IT WAS FOUND: the bridge selects a
  // single alert from a hardcoded id set, so an alert id that is not in it is invisible to the
  // human-facing view no matter how good its message is. Mine was `warning` by design - a person
  // waiting must never page - which also meant it could never win the `severity === "critical"`
  // find above, so it was technically delivered and practically unseen. That is the same class as
  const candidates = rankDoorbellAlerts(alerts, state.coordinatorAlerts, Date.now(), coordinatorAlertKey);
  const coordinatorAlert = candidates[0] || null;
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

  // OWNER RE-PROMPTS, delivered to the OWNER and to nobody else.
  const leaseAlert = alerts.find((a) => a.id === "owner_lease_lapsed");
  const ownerLeaseResult = { attempted: 0, prompted: 0, cards: [] };
  if (leaseAlert && allowPrompt && !dryRun) {
    state.ownerLeasePrompts = state.ownerLeasePrompts || {};
    for (const card of leaseAlert.cards || []) {
      ownerLeaseResult.attempted++;
      // Armed per (card, epoch). A claim bumps the epoch, so a resumed agent is re-armed exactly
      // once - and an agent that heartbeats never reaches here at all, because the metric is
      // driven by the card's own lapsed heartbeat rather than by the wall clock. That is what
      // keeps this from re-creating the alert churn this board spent a night removing: AGE ALONE
      // IS NOT A TRANSITION, and this path has no age-based key to repeat on.
      const key = `${card.id}@${card.leaseEpoch ?? "none"}`;
      if (state.ownerLeasePrompts[key]) continue;
      if (!validHandles.includes(card.owner)) {
        ownerLeaseResult.cards.push({ id: card.id, owner: card.owner, action: "owner_not_registered" });
        continue;
      }
      const ok = prompt(card.owner, buildOwnerResumePrompt(card), false);
      ownerLeaseResult.cards.push({ id: card.id, owner: card.owner, action: ok ? "prompted" : "prompt_failed" });
      if (ok) {
        state.ownerLeasePrompts[key] = {
          at: new Date().toISOString(),
          owner: card.owner,
          leaseEpoch: card.leaseEpoch ?? null,
          reassignmentSuggested: Boolean(card.reassignmentSuggested),
        };
        ownerLeaseResult.prompted++;
      }
    }
  }

  if (allowPrompt && persistState && !dryRun && (doorbelledCount > 0 || doorbelledTasksCount > 0 || coordinatorDoorbellResult.prompted || ownerLeaseResult.prompted)) {
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
    ownerLease: ownerLeaseResult,
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

  // SCOPE FIX, not a rename. 5970ae4 added `loadBoard(repoRoot, amqRoot)` to the tick below,
  // but repoRoot is declared inside runDoorbellPass (a DIFFERENT function), so every pass threw
  // "repoRoot is not defined". The try/catch around the tick swallowed it and continued, so the
  // daemon looked alive, filled the log with a repeating error, and delivered nothing at all.
  //
  // Resolved ONCE, here at daemon lifetime, and PASSED DOWN to each pass, because an earlier
  // version left runDoorbellPass resolving its own copy: two independent resolutions of a pure
  // function, which agree today and nothing forces them to.
  //
  // Scoped correctly, because I first overclaimed here: this does NOT mean the tick and the pass
  // could load DIFFERENT BOARDS. getBusDirectory prefers amqRoot/bus, so the board always comes
  // from amqRoot; repoRoot only selects the repository used to date citations. The real exposure
  // is narrower and still real - two calls could disagree about where the git history lives, and
  // citations would quietly resolve against nothing.
  //
  // The parameter is optional, so the standalone CLI path resolves its own and is unaffected.
  const repoRoot = getRepoRootFromAmq(amqRoot);
  console.log(`[bridge] Repo: ${repoRoot}`);

  // The tick is now ASYNC, and `setInterval` does not wait for it. Without a guard a tick slower
  // than the interval RE-ENTERS while the previous is still running: two passes over the same
  // undelivered mail, two prompts, two state writes. That hazard is created by the fix, so the
  // fix owns it. Skips are counted, not hidden - a daemon quietly dropping passes is
  // indistinguishable from a daemon with nothing to deliver.
  let inFlight = false;
  let skippedTicks = 0;
  const tick = async () => {
    if (inFlight) { skippedTicks++; return; }
    inFlight = true;
    try {
      const handles = getAgentHandles(amqRoot);
      // CITATION-ONLY work age, for the render. No git, so this is the ~40ms steady-state build
      // rather than the ~2.9s first build that would put a full-board resolve on a 3s tick.
      // The builder returns { metrics, workAgeById } - workAgeById is TOP LEVEL, not under
      // metrics, and reading it from the wrong place yields null and silently restores the bug.
      const workAgeById = await buildCoordinatorMetricsWithWorkAge({
        board: loadBoard(repoRoot, amqRoot),
        repos: [],
      }).then((r) => r.workAgeById ?? null).catch(() => null);
      const res = runDoorbellPass({ amqRoot, handles, dryRun, allowPrompt: true, persistState: true, workAgeById, repoRoot });
      if (res.doorbelled > 0) {
        console.log(`[bridge] Doorbelled ${res.doorbelled} message(s)`);
      }
      if (skippedTicks > 0) {
        console.log(`[bridge] ${skippedTicks} tick(s) skipped: a pass was still running`);
        skippedTicks = 0;
      }
    } catch (err) {
      console.error(`[bridge] Error in pass: ${err.message}`);
    } finally {
      inFlight = false;
    }
  };

  tick();
  setInterval(tick, interval);
}
