/**
 * board.mjs — Swarm Coordination Kanban Board
 *
 * Parses and coordinates tasks from .opencode/bus/STATUS.md and local task state.
 * Supports columns:
 *   - backlog     (Fila / queued tasks)
 *   - in_progress (Em Voo / claimed / active WIP)
 *   - blocked     (Bloqueios / hazards / awaiting verification)
 *   - done        (Concluído / resolved / shipped)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sendAmqMessage } from "./store.mjs";

export function findStatusFile(repoRoot) {
  if (!repoRoot) return null;
  const candidates = [
    path.join(repoRoot, ".opencode", "bus", "STATUS.md"),
    path.join(repoRoot, "STATUS.md"),
    path.join(repoRoot, "docs", "STATUS.md"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Locate the global bus directory for tasks.
 * Defaults to .agent-mail/bus (lives alongside agent mailboxes and blobs).
 * Falls back to legacy .opencode/bus if present.
 */
export function getBusDirectory(repoRoot, amqRoot) {
  if (process.env.AMQ_BUS_DIR) {
    return path.resolve(process.env.AMQ_BUS_DIR);
  }
  // 1. Primary: .agent-mail/bus if amqRoot is provided
  if (amqRoot) {
    const amqBus = path.join(amqRoot, "bus");
    if (fs.existsSync(amqBus)) return amqBus;
  }
  // 2. Check repoRoot/.agent-mail/bus
  if (repoRoot) {
    const repoAmqBus = path.join(repoRoot, ".agent-mail", "bus");
    if (fs.existsSync(repoAmqBus)) return repoAmqBus;
    // 3. Fallback to legacy .opencode/bus if it exists
    const opencodeBus = path.join(repoRoot, ".opencode", "bus");
    if (fs.existsSync(opencodeBus)) return opencodeBus;
  }
  // Default new creation target: .agent-mail/bus
  if (amqRoot) {
    return path.join(amqRoot, "bus");
  }
  if (repoRoot) {
    return path.join(repoRoot, ".agent-mail", "bus");
  }
  return path.join(process.cwd(), ".agent-mail", "bus");
}

export const STAGE_DIRS = {
  backlog: "backlog",
  in_progress: "doing",
  doing: "doing",
  blocked: "blocked",
  done: "done",
};

export function ensureBusDirectories(busDir) {
  if (!busDir) return;
  const stages = ["backlog", "doing", "blocked", "done"];
  for (const s of stages) {
    const d = path.join(busDir, s);
    if (!fs.existsSync(d)) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch {}
    }
  }
}

export function resolveStageDir(busDir, stage) {
  const standard = STAGE_DIRS[stage] || "backlog";
  if (standard === "doing") {
    if (busDir && fs.existsSync(path.join(busDir, "in_progress")) && !fs.existsSync(path.join(busDir, "doing"))) {
      return "in_progress";
    }
    return "doing";
  }
  return standard;
}

/**
 * Serializes a task object into a Markdown file with frontmatter.
 */
export const TASK_SCHEMA_VERSION = 1;

export function serializeTaskFile(task) {
  const safeId = task.id || `task_${Date.now()}`;
  const safeTitle = task.title || "(sem título)";
  const safeOwner = canonicalizeOwner(task.owner || "coordinator");
  const rawStatus = task.status === "doing" ? "doing" : (task.status || "backlog");
  const now = new Date().toISOString();
  const dependsOn = Array.isArray(task.depends_on) ? task.depends_on : [];

  const lines = [
    "---",
    `schema_version: ${TASK_SCHEMA_VERSION}`,
    `id: ${JSON.stringify(safeId)}`,
    `title: ${JSON.stringify(safeTitle)}`,
    `owner: ${JSON.stringify(safeOwner)}`,
    `status: ${JSON.stringify(rawStatus)}`,
    `priority: ${JSON.stringify(task.priority || "normal")}`,
    `created: ${JSON.stringify(task.created || now)}`,
    `updated: ${JSON.stringify(task.updated || now)}`,
    `claimed_at: ${JSON.stringify(task.claimed_at || null)}`,
    `blocked_at: ${JSON.stringify(task.blocked_at || null)}`,
    `done_at: ${JSON.stringify(task.done_at || null)}`,
    `last_heartbeat_at: ${JSON.stringify(task.last_heartbeat_at || null)}`,
    `last_heartbeat_by: ${JSON.stringify(task.last_heartbeat_by || null)}`,
    `claims: ${Number.isFinite(Number(task.claims)) ? Number(task.claims) : 0}`,
    `blocked_ms: ${Number.isFinite(Number(task.blocked_ms)) ? Number(task.blocked_ms) : 0}`,
    `block_reason: ${JSON.stringify(task.block_reason || null)}`,
    `proof: ${JSON.stringify(task.proof || null)}`,
    `notes: ${JSON.stringify(Array.isArray(task.notes) ? task.notes : [])}`,
    `depends_on: ${JSON.stringify(dependsOn)}`,
    `next_actor: ${JSON.stringify(task.next_actor || null)}`,
    `thread: ${JSON.stringify(task.thread || `agboard/${safeId}`)}`,
    `source: "bus"`,
    "---",
    "",
  ];

  const body = (task.description || "").trim();
  if (body) {
    lines.push(body);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Parses a task Markdown file with frontmatter into a task object.
 */
export function parseTaskFile(filePath, defaultStage = "backlog") {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    let meta = {};
    let body = "";

    if (match) {
      const frontmatter = match[1];
      body = (match[2] || "").trim();

      for (const line of frontmatter.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          let val = line.slice(colonIdx + 1).trim();
          if (val === "null" || val === "true" || val === "false") {
            val = JSON.parse(val);
          } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")) || val.startsWith("[") || val.startsWith("{")) {
            try {
              val = JSON.parse(val);
            } catch {
              if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
            }
          }
          meta[key] = val;
        }
      }
    } else {
      body = raw.trim();
    }

    const baseName = path.basename(filePath, ".md");
    const id = meta.id || baseName;
    const title = meta.title || baseName;
    const owner = canonicalizeOwner(meta.owner || "coordinator");
    const rawStatus = meta.status || defaultStage;
    const status = ["backlog", "in_progress", "doing", "blocked", "done"].includes(rawStatus)
      ? (rawStatus === "doing" ? "in_progress" : rawStatus)
      : defaultStage;

    const dependsOn = Array.isArray(meta.depends_on) ? meta.depends_on : [];
    return {
      schema_version: Number.isFinite(Number(meta.schema_version)) ? Number(meta.schema_version) : 0,
      id,
      title,
      owner,
      status,
      priority: meta.priority || "normal",
      description: body || meta.description || "",
      created: meta.created || null,
      updated: meta.updated || null,
      claimed_at: meta.claimed_at || null,
      blocked_at: meta.blocked_at || null,
      done_at: meta.done_at || null,
      last_heartbeat_at: meta.last_heartbeat_at || null,
      last_heartbeat_by: meta.last_heartbeat_by || null,
      claims: Number.isFinite(Number(meta.claims)) ? Number(meta.claims) : 0,
      blocked_ms: Number.isFinite(Number(meta.blocked_ms)) ? Number(meta.blocked_ms) : 0,
      block_reason: meta.block_reason || null,
      proof: meta.proof || null,
      notes: Array.isArray(meta.notes) ? meta.notes : [],
      depends_on: dependsOn,
      next_actor: meta.next_actor || null,
      thread: meta.thread || `agboard/${id}`,
      source: "bus",
      filePath,
    };
  } catch {
    return null;
  }
}

export function getCustomBoardPath(amqRoot) {
  if (!amqRoot) return null;
  return path.join(amqRoot, "board_custom.json");
}

function loadCustomTasks(amqRoot) {
  const p = getCustomBoardPath(amqRoot);
  if (!p || !fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCustomTasks(amqRoot, tasks) {
  const p = getCustomBoardPath(amqRoot);
  if (!p) return false;
  try {
    fs.writeFileSync(p, JSON.stringify(tasks, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}


/**
 * Deduplicate and normalize agent owner strings to clean canonical handles.
 * e.g. "ballistics (fix)" -> "ballistics"
 *      "B - Ballistics" -> "ballistics"
 *      "player-rig (plano)" -> "player-rig"
 *      "range (achado) -> FALSO" -> "range"
 *      "coordinator / infra" -> "coordinator"
 *      "testkit (dono do verify-all.sh)" -> "testkit"
 */
export function canonicalizeOwner(rawOwner = "") {
  if (!rawOwner || typeof rawOwner !== "string") return "coordinator";

  let s = rawOwner.trim();
  // Strip leading single-letter badge/prefix like "B - " or "B: " or "[B] "
  s = s.replace(/^[a-zA-Z]\s*[-–—:]\s*/i, "");
  s = s.replace(/^\[[a-zA-Z]\]\s*/i, "");

  // Take first owner if delimited by +, →, ->, or /
  s = s.split(/[+→/,]|->/)[0].trim();

  // Strip parenthetical annotations: (fix), (plano), (achado..., (dono...
  s = s.replace(/\s*\([^)]*\)?/g, "").trim();

  // Strip markdown formatting characters
  s = s.replace(/[`*_~:]/g, "").trim();

  const lower = s.toLowerCase().trim();

  if (!lower || lower === "todos" || lower === "all" || lower === "infra") {
    return "coordinator";
  }

  // Canonical swarm mapping
  if (lower.includes("ballistics")) return "ballistics";
  if (lower.includes("player-rig") || lower === "player") return "player-rig";
  if (lower.includes("npc-body") || lower === "npc" || lower === "bot") return "npc-body";
  if (lower.includes("testkit") || lower === "test") return "testkit";
  if (lower.includes("range")) return "range";
  if (lower.includes("spotter")) return "spotter";
  if (lower.includes("inventory-ux") || lower.includes("inventory")) return "inventory-ux";
  if (lower.includes("verifier")) return "verifier";
  if (lower.includes("meta")) return "meta";
  if (lower.includes("qa")) return "qa";
  if (lower.includes("coord")) return "coordinator";

  return lower;
}

/**
 * Classify a table row into one of the 4 Kanban columns
 */
export function classifyStatus(itemText = "", statusText = "") {
  const e = (statusText || "").toLowerCase().trim();
  const it = (itemText || "").toLowerCase().trim();

  // Struck through items are resolved/done
  if (it.startsWith("~~")) return "done";

  // Blocked: Explicit block, hazard, deadlock, fail
  if (
    it.includes("bloqueio") ||
    e.includes("bloqueio") ||
    e.includes("blocked") ||
    e.includes("hazard") ||
    e.includes("grave") ||
    e.includes("fail") ||
    e.includes("falha") ||
    e.includes("deadlock")
  ) {
    return "blocked";
  }

  // In Progress: Actively ongoing, WIP, diagnosed, partial phase
  if (
    e.includes("em curso") ||
    e.includes("em andamento") ||
    e.includes("causa achada") ||
    e.includes("diagnosticado") ||
    e.includes("wip") ||
    e.includes("aguarda") ||
    e.includes("claimed") ||
    e.includes("re-validar") ||
    e.includes("plano entregue") ||
    e.startsWith("**fase 1") ||
    e.startsWith("fase 1")
  ) {
    return "in_progress";
  }

  // Done: Completed / resolved / shipped
  if (
    e.startsWith("**done") ||
    e.startsWith("done") ||
    e.includes("resolvido") ||
    e.includes("fechado") ||
    e.includes("sucesso") ||
    e.includes("pushed") ||
    e.includes("pass exit 0")
  ) {
    return "done";
  }

  // Backlog: queued, future, unstarted
  return "backlog";
}


/**
 * Parse STATUS.md into structured card items
 */
export function parseStatusMd(content) {
  if (!content || typeof content !== "string") return [];
  const tasks = [];

  // 1. Parse "## EM VOO (claimed)" section
  const emVooMatch = content.match(/## EM VOO \(claimed\)\s*([\s\S]*?)(?=\n>|\n##|\n\| Item)/);
  if (emVooMatch) {
    const lines = emVooMatch[1].split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("**CLAIMED by")) continue;
      const m = trimmed.match(/\*\*CLAIMED by (\S+)(?: ([^*]+))?\*\*\s*—?\s*([\s\S]*)/);
      if (m) {
        const owner = canonicalizeOwner(m[1]);
        const timestamp = m[2] ? m[2].trim() : "";
        const desc = m[3] ? m[3].trim() : "";
        const titleMatch = desc.match(/^([^—:;.]+)/);
        const title = titleMatch ? titleMatch[1].trim() : `Task claimed by ${owner}`;
        const id = `claimed_${owner}_${crypto.createHash("md5").update(trimmed).digest("hex").slice(0, 8)}`;

        tasks.push({
          id,
          title: `[EM VOO] ${title}`,
          owner,
          status: "in_progress",
          timestamp,
          description: desc,
          source: "status_em_voo",
        });
      }
    }
  }

  // 2. Parse Markdown Table: | Item | Dono | Estado | line-by-line
  const lines = content.split("\n");
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|\s*Item\s*\|\s*Dono\s*\|\s*Estado\s*\|/i.test(trimmed)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/^\|[-:\s|]+\|$/.test(trimmed)) continue; // divider row
    if (!trimmed.startsWith("|")) {
      if (trimmed.startsWith("#")) inTable = false;
      continue;
    }

    const parts = trimmed
      .split("|")
      .map((p) => p.trim())
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);

    if (parts.length >= 3) {
      const itemText = parts[0];
      const ownerText = parts[1];
      const statusText = parts[2];

      if (itemText === "Item" || itemText.startsWith("---")) continue;

      const cleanTitle = itemText.replace(/^\*\*|\*\*$/g, "").trim();
      const column = classifyStatus(itemText, statusText);
      const id = `task_${crypto.createHash("md5").update(itemText + ownerText).digest("hex").slice(0, 10)}`;

      // Extract deduplicated canonical owner
      const primaryOwner = canonicalizeOwner(ownerText);

      tasks.push({
        id,
        title: cleanTitle,
        rawTitle: itemText,
        owner: primaryOwner,
        owners: ownerText,
        status: column,
        description: statusText,
        source: "status_table",
      });
    }
  }


  return tasks;
}

/**
 * Load the complete board from the global bus directories: backlog, doing, blocked, done.
 * Seeds from STATUS.md if bus directories are empty.
 */
export function loadBoard(repoRoot, amqRoot) {
  const busDir = getBusDirectory(repoRoot, amqRoot);
  ensureBusDirectories(busDir);

  const statusFile = findStatusFile(repoRoot);
  const busTasks = [];
  const seenIds = new Set();

  const stageScanMap = [
    { dir: "backlog", stage: "backlog" },
    { dir: "doing", stage: "in_progress" },
    { dir: "in_progress", stage: "in_progress" },
    { dir: "blocked", stage: "blocked" },
    { dir: "done", stage: "done" },
  ];

  for (const { dir, stage } of stageScanMap) {
    const fullDir = path.join(busDir, dir);
    if (!fs.existsSync(fullDir)) continue;
    try {
      const files = fs.readdirSync(fullDir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
      for (const file of files) {
        const fullPath = path.join(fullDir, file);
        const parsed = parseTaskFile(fullPath, stage);
        if (parsed && !seenIds.has(parsed.id)) {
          seenIds.add(parsed.id);
          busTasks.push(parsed);
        }
      }
    } catch {}
  }

  // If bus has no tasks yet, but STATUS.md exists: seed the bus!
  if (busTasks.length === 0 && statusFile && fs.existsSync(statusFile)) {
    try {
      const content = fs.readFileSync(statusFile, "utf8");
      const seedTasks = parseStatusMd(content);
      for (const task of seedTasks) {
        const destDir = resolveStageDir(busDir, task.status);
        const taskPath = path.join(busDir, destDir, `${task.id}.md`);
        fs.writeFileSync(taskPath, serializeTaskFile(task), "utf8");
        busTasks.push({ ...task, filePath: taskPath, source: "bus" });
        seenIds.add(task.id);
      }
    } catch (err) {
      console.warn(`[board] Failed to seed bus from ${statusFile}: ${err.message}`);
    }
  }

  // Also check if any custom overlay tasks exist and migrate them into bus
  const customTasks = loadCustomTasks(amqRoot);
  for (const ct of customTasks) {
    if (!seenIds.has(ct.id)) {
      const destDir = resolveStageDir(busDir, ct.status);
      const taskPath = path.join(busDir, destDir, `${ct.id}.md`);
      try {
        fs.writeFileSync(taskPath, serializeTaskFile(ct), "utf8");
        busTasks.push({ ...ct, filePath: taskPath, source: "bus" });
        seenIds.add(ct.id);
      } catch {}
    }
  }

  const columns = {
    backlog: [],
    in_progress: [],
    blocked: [],
    done: [],
  };

  const ownersSet = new Set();

  for (const task of busTasks) {
    const col = columns[task.status] ? task.status : "backlog";
    columns[col].push(task);
    if (task.owner) ownersSet.add(task.owner);
  }

  return {
    columns,
    stats: {
      total: busTasks.length,
      backlog: columns.backlog.length,
      in_progress: columns.in_progress.length,
      blocked: columns.blocked.length,
      done: columns.done.length,
    },
    owners: Array.from(ownersSet).sort(),
    busDir,
    statusFilePath: statusFile || null,
  };
}

/**
 * Dispatch automailing notification via AMQ for task life-cycle events
 */
export function notifyTaskEvent(amqRoot, eventType, task, opts = {}) {
  if (!amqRoot || !task) return { ok: false, error: "Missing amqRoot or task" };

  const sender = opts.from || "coordinator";
  let to = [];
  let subject = "";
  let body = "";
  let priority = "normal";

  switch (eventType) {
    case "assigned": {
      to = [task.owner || "coordinator"];
      subject = `[AGboard] [ASSIGNED] ${task.title}`;
      body = [
        `You have been assigned a task on AGboard:`,
        ``,
        `• Task: ${task.title}`,
        `• ID: ${task.id}`,
        `• Assigned Owner: ${task.owner}`,
        `• Status: ${task.status}`,
        task.description ? `• Description: ${task.description}` : "",
        ``,
        `To synchronize without editing STATUS.md directly:`,
        `  herdr-amq task claim ${task.id} --me ${task.owner}`,
        `  herdr-amq task done ${task.id} --me ${task.owner} --proof "<proof>"`,
        `  herdr-amq task block ${task.id} --me ${task.owner} --reason "<reason>"`,
      ].filter(Boolean).join("\n");
      break;
    }

    case "claimed": {
      to = ["coordinator"];
      subject = `[AGboard] [CLAIMED] ${task.title}`;
      body = [
        `Task claimed by ${sender}:`,
        ``,
        `• Task: ${task.title}`,
        `• ID: ${task.id}`,
        `• Status: in_progress`,
        task.description ? `• Details: ${task.description}` : "",
        ``,
        `Track or complete via:`,
        `  herdr-amq task done ${task.id} --me ${sender} --proof "<evidence>"`,
      ].filter(Boolean).join("\n");
      break;
    }

    case "blocked": {
      to = ["coordinator"];
      priority = "urgent";
      subject = `[AGboard] [BLOCKED] ${task.title}`;
      body = [
        `⚠️ TASK BLOCKED by ${sender}:`,
        ``,
        `• Task: ${task.title}`,
        `• ID: ${task.id}`,
        `• Reason: ${opts.reason || task.description || "Unspecified blocker"}`,
        ``,
        `Needs coordination / unblock review.`,
      ].filter(Boolean).join("\n");
      break;
    }

    case "done": {
      to = ["coordinator"];
      subject = `[AGboard] [COMPLETED] ${task.title}`;
      body = [
        `✅ Task completed by ${sender}:`,
        ``,
        `• Task: ${task.title}`,
        `• ID: ${task.id}`,
        opts.proof ? `• Evidence / Proof: ${opts.proof}` : "",
        task.description ? `• Details: ${task.description}` : "",
      ].filter(Boolean).join("\n");
      break;
    }

    default:
      return { ok: false, error: `Unknown eventType: ${eventType}` };
  }

  return sendAmqMessage(amqRoot, {
    from: sender,
    to,
    subject,
    body,
    thread: `agboard/${task.id}`,
    priority,
    kind: eventType === "blocked" ? "status" : "todo",
  });
}

/**
 * Add a new task card directly to the global bus stage directory (backlog, doing, blocked, done)
 */
export function addBoardTask(
  repoRoot,
  amqRoot,
  { title, owner = "coordinator", status = "backlog", priority = "normal", description = "", depends_on = [], next_actor, notify, from } = {},
  opts = {}
) {
  if (!title || !title.trim()) {
    return { ok: false, error: "Task title is required" };
  }

  const busDir = getBusDirectory(repoRoot, amqRoot);
  ensureBusDirectories(busDir);

  const cleanOwner = canonicalizeOwner(owner);
  const cleanStatus = ["backlog", "in_progress", "doing", "blocked", "done"].includes(status)
    ? (status === "doing" ? "in_progress" : status)
    : "backlog";
  const id = `task_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const now = opts.now instanceof Date ? opts.now.toISOString() : new Date().toISOString();

  const newTask = {
    schema_version: TASK_SCHEMA_VERSION,
    id,
    title: title.trim(),
    owner: cleanOwner,
    status: cleanStatus,
    priority: priority || "normal",
    description: description.trim(),
    created: now,
    updated: now,
    claimed_at: null,
    blocked_at: null,
    done_at: null,
    last_heartbeat_at: null,
    last_heartbeat_by: null,
    claims: 0,
    blocked_ms: 0,
    block_reason: null,
    proof: null,
    notes: [],
    depends_on: Array.isArray(depends_on) ? depends_on : [],
    // Never invent a next actor for a blocked card: absent beats confidently wrong.
    next_actor: next_actor === undefined ? (cleanStatus === "blocked" ? null : cleanOwner) : next_actor,
    thread: `agboard/${id}`,
    source: "bus",
  };

  const stageDir = resolveStageDir(busDir, cleanStatus);
  const filePath = path.join(busDir, stageDir, `${id}.md`);
  fs.writeFileSync(filePath, serializeTaskFile(newTask), "utf8");
  newTask.filePath = filePath;

  const shouldNotify = (notify !== undefined ? notify : opts.notify) ?? true;
  const sender = from || opts.from || "coordinator";

  if (shouldNotify && amqRoot && newTask.owner && newTask.owner !== "coordinator") {
    try {
      notifyTaskEvent(amqRoot, "assigned", newTask, { from: sender });
    } catch {}
  }

  return { ok: true, task: newTask };
}

/**
 * Update a task's status / stage or attributes.
 * Atomically moves the task file between stage directories (backlog, doing, blocked, done).
 */
export function updateBoardTask(repoRoot, amqRoot, taskId, updates = {}, opts = {}) {
  if (!taskId) return { ok: false, error: "taskId is required" };

  const busDir = getBusDirectory(repoRoot, amqRoot);
  ensureBusDirectories(busDir);

  const stageDirs = ["backlog", "doing", "in_progress", "blocked", "done"];
  let existingPath = null;
  let currentStage = "backlog";
  let existingTask = null;

  for (const s of stageDirs) {
    const candidate = path.join(busDir, s, `${taskId}.md`);
    if (fs.existsSync(candidate)) {
      existingPath = candidate;
      currentStage = s === "doing" ? "in_progress" : s;
      existingTask = parseTaskFile(candidate, currentStage);
      break;
    }
  }

  if (!existingTask) {
    const board = loadBoard(repoRoot, amqRoot);
    for (const [col, list] of Object.entries(board.columns)) {
      const match = list.find((t) => t.id === taskId);
      if (match) {
        existingTask = match;
        currentStage = col;
        existingPath = match.filePath || null;
        break;
      }
    }
  }

  if (!existingTask) {
    return { ok: false, error: "Task not found" };
  }

  const oldTask = { ...existingTask };
  const requestedStatus = updates.status
    ? (updates.status === "doing" ? "in_progress" : updates.status)
    : existingTask.status;
  const targetStatus = ["backlog", "in_progress", "blocked", "done"].includes(requestedStatus)
    ? requestedStatus
    : existingTask.status;
  const now = opts.now instanceof Date ? opts.now.toISOString() : new Date().toISOString();
  const nowMs = Date.parse(now);
  const wasBlocked = existingTask.status === "blocked";
  const isBlocked = targetStatus === "blocked";
  let blockedMs = Number.isFinite(Number(existingTask.blocked_ms)) ? Number(existingTask.blocked_ms) : 0;
  if (wasBlocked && !isBlocked && existingTask.blocked_at) {
    const blockedAtMs = Date.parse(existingTask.blocked_at);
    if (Number.isFinite(blockedAtMs)) blockedMs += Math.max(0, nowMs - blockedAtMs);
  }

  const owner = updates.owner ? canonicalizeOwner(updates.owner) : existingTask.owner;
  const enteringProgress = targetStatus === "in_progress" && existingTask.status !== "in_progress";
  // A liveness clock is only ever written together with the actor that produced it.
  // A clock with no author is a liveness claim no reader can discount, and the stall
  // detector still honours it, so a heartbeat that cannot name its author must not
  // silently reset the clock. If there is no actor to name, the clock stays unset.
  const heartbeatActor = String(opts.from || updates.owner || existingTask.owner || "").trim();
  const nextHeartbeatAt = enteringProgress ? now : (existingTask.last_heartbeat_at || null);
  const nextHeartbeatBy = existingTask.last_heartbeat_by || (enteringProgress ? heartbeatActor || null : null);
  const updatedTask = {
    ...existingTask,
    ...updates,
    schema_version: TASK_SCHEMA_VERSION,
    owner,
    status: targetStatus,
    priority: updates.priority || existingTask.priority || "normal",
    updated: now,
    claimed_at: enteringProgress ? now : (existingTask.claimed_at || null),
    blocked_at: isBlocked ? (wasBlocked ? existingTask.blocked_at : now) : existingTask.blocked_at,
    done_at: targetStatus === "done" ? (existingTask.done_at || now) : existingTask.done_at,
    // A claim is a liveness signal, an in-progress update is not: only a fresh
    // claim (or an explicit `task heartbeat`) sets the liveness clock.
    last_heartbeat_at: nextHeartbeatAt,
    last_heartbeat_by: nextHeartbeatBy,
    claims: enteringProgress ? (Number(existingTask.claims) || 0) + 1 : (Number(existingTask.claims) || 0),
    blocked_ms: blockedMs,
    block_reason: updates.reason ?? opts.reason ?? existingTask.block_reason ?? null,
    proof: updates.proof ?? opts.proof ?? existingTask.proof ?? null,
    notes: Array.isArray(updates.notes) ? updates.notes : (Array.isArray(existingTask.notes) ? existingTask.notes : []),
    depends_on: Array.isArray(updates.depends_on) ? updates.depends_on : (Array.isArray(existingTask.depends_on) ? existingTask.depends_on : []),
    // A blocked card is triaged when it carries a reason. There is no reliable way
    // to infer a next actor from a reason string, so an untriaged block reports no
    // next actor rather than a confidently wrong one (for example "coordinator").
    // An explicit `next_actor: null` in the update clears a persisted value.
    next_actor: Object.hasOwn(updates, "next_actor")
      ? updates.next_actor
      : (Object.hasOwn(opts, "next_actor") ? opts.next_actor : (
        targetStatus === "done" ? null
          : (targetStatus === "blocked" ? (existingTask.next_actor ?? null) : owner)
      )),
    source: "bus",
  };

  const destStageDir = resolveStageDir(busDir, targetStatus);
  const newFilePath = path.join(busDir, destStageDir, `${taskId}.md`);

  fs.writeFileSync(newFilePath, serializeTaskFile(updatedTask), "utf8");
  updatedTask.filePath = newFilePath;

  if (existingPath && existingPath !== newFilePath && fs.existsSync(existingPath)) {
    try {
      fs.unlinkSync(existingPath);
    } catch {}
  }

  const shouldNotify = (updates.notify !== undefined ? updates.notify : opts.notify) ?? true;
  const sender = updates.from || opts.from || updatedTask.owner || "coordinator";

  if (shouldNotify && amqRoot && oldTask) {
    try {
      if (updates.owner && updates.owner !== oldTask.owner && updates.owner !== "coordinator") {
        notifyTaskEvent(amqRoot, "assigned", updatedTask, { from: sender });
      } else if (updatedTask.status === "in_progress" && oldTask.status !== "in_progress") {
        notifyTaskEvent(amqRoot, "claimed", updatedTask, { from: sender });
      } else if (updatedTask.status === "blocked" && oldTask.status !== "blocked") {
        notifyTaskEvent(amqRoot, "blocked", updatedTask, { from: sender, reason: updatedTask.block_reason || updates.description });
      } else if (updatedTask.status === "done" && oldTask.status !== "done") {
        notifyTaskEvent(amqRoot, "done", updatedTask, { from: sender, proof: updatedTask.proof || updates.description });
      }
    } catch {}
  }

  return { ok: true, taskId, updates, task: updatedTask };
}

/**
 * Record an explicit liveness signal for a card.
 *
 * A heartbeat only moves `last_heartbeat_at`. It deliberately does not change
 * `updated`, the stage, the claim count, or the notes, so it cannot be used to
 * fake progress on the board; it exists so the stall detector can measure liveness
 * instead of measuring claim bookkeeping.
 */
export function heartbeatBoardTask(repoRoot, amqRoot, taskId, { actor, now } = {}) {
  if (!taskId) return { ok: false, error: "taskId is required" };

  const busDir = getBusDirectory(repoRoot, amqRoot);
  const stageDirs = ["backlog", "doing", "in_progress", "blocked", "done"];
  let existingPath = null;
  let existingTask = null;
  let stage = "backlog";

  for (const candidateStage of stageDirs) {
    const candidate = path.join(busDir, candidateStage, `${taskId}.md`);
    if (fs.existsSync(candidate)) {
      existingPath = candidate;
      stage = candidateStage === "doing" ? "in_progress" : candidateStage;
      existingTask = parseTaskFile(candidate, stage);
      break;
    }
  }

  if (!existingTask) return { ok: false, error: "Task not found" };
  if (existingTask.status === "done") return { ok: false, error: "Task is done; a heartbeat cannot revive it" };

  // The author is mandatory. A heartbeat is an accountable claim that the card is
  // alive, and the whole reason the board carries an author is that a liveness
  // signal from someone other than the worker must be visible as such. Guessing an
  // author (falling back to the owner, or to the literal string "unknown") produced
  // liveness the detector honoured and no reader could discount, so an unnamed
  // heartbeat now fails loudly and moves nothing.
  const heartbeatActor = String(actor ?? "").trim();
  if (!heartbeatActor) {
    return { ok: false, error: "a heartbeat must name its actor: pass --me <handle>" };
  }

  const timestamp = now instanceof Date ? now.toISOString() : new Date().toISOString();
  // The verb is deliberately not restricted: a coordinator legitimately needs to
  // signal "I am actively working this", but that signal must not be
  // indistinguishable from the owner's.
  const updatedTask = { ...existingTask, last_heartbeat_at: timestamp, last_heartbeat_by: heartbeatActor };

  try {
    fs.writeFileSync(existingPath, serializeTaskFile(updatedTask), "utf8");
  } catch (error) {
    return { ok: false, error: `failed to write heartbeat: ${error.message}` };
  }

  return { ok: true, taskId, actor: heartbeatActor, last_heartbeat_at: timestamp, last_heartbeat_by: updatedTask.last_heartbeat_by, task: { ...updatedTask, filePath: existingPath } };
}

/**
 * Change a card's owner without churning its id or claim history.
 */
export function reassignBoardTask(repoRoot, amqRoot, taskId, { owner, from, now, notify = false } = {}) {
  if (!taskId) return { ok: false, error: "taskId is required" };
  const cleanOwner = String(owner || "").trim();
  if (!cleanOwner) return { ok: false, error: "owner is required" };
  return updateBoardTask(repoRoot, amqRoot, taskId, { owner: cleanOwner }, { from, now, notify });
}

/**
 * Append a durable note to a task without changing its activity timestamp.
 * Notes are intentionally not notifications and do not update `updated` or heartbeat fields.
 */
export function appendBoardTaskNote(repoRoot, amqRoot, taskId, { text, author = "unknown", now } = {}) {
  if (!taskId) return { ok: false, error: "taskId is required" };
  if (!text || !String(text).trim()) return { ok: false, error: "note text is required" };

  const busDir = getBusDirectory(repoRoot, amqRoot);
  const stageDirs = ["backlog", "doing", "in_progress", "blocked", "done"];
  let existingPath = null;
  let existingTask = null;
  let stage = "backlog";

  for (const candidateStage of stageDirs) {
    const candidate = path.join(busDir, candidateStage, `${taskId}.md`);
    if (fs.existsSync(candidate)) {
      existingPath = candidate;
      stage = candidateStage === "doing" ? "in_progress" : candidateStage;
      existingTask = parseTaskFile(candidate, stage);
      break;
    }
  }

  if (!existingTask) return { ok: false, error: "Task not found" };

  const timestamp = now instanceof Date ? now.toISOString() : new Date().toISOString();
  const note = { at: timestamp, author: String(author || "unknown"), text: String(text).trim() };
  const notes = [...(Array.isArray(existingTask.notes) ? existingTask.notes : []), note];
  const updatedTask = { ...existingTask, notes };

  try {
    fs.writeFileSync(existingPath, serializeTaskFile(updatedTask), "utf8");
  } catch (error) {
    return { ok: false, error: `failed to write note: ${error.message}` };
  }

  return { ok: true, taskId, note, notes, task: { ...updatedTask, filePath: existingPath } };
}

/**
 * Delete a task directly from the global bus
 */
export function deleteBoardTask(repoRoot, amqRoot, taskId) {
  if (!taskId) return { ok: false, error: "taskId is required" };

  const busDir = getBusDirectory(repoRoot, amqRoot);
  const stageDirs = ["backlog", "doing", "in_progress", "blocked", "done"];
  let deleted = false;

  for (const s of stageDirs) {
    const candidate = path.join(busDir, s, `${taskId}.md`);
    if (fs.existsSync(candidate)) {
      try {
        fs.unlinkSync(candidate);
        deleted = true;
      } catch {}
    }
  }

  const customTasks = loadCustomTasks(amqRoot);
  const filtered = customTasks.filter((t) => t.id !== taskId);
  if (filtered.length !== customTasks.length) {
    saveCustomTasks(amqRoot, filtered);
  }

  return { ok: true, taskId, deleted };
}

/**
 * List pending backlog tasks assigned to a specific handle (or all backlog tasks if null/all).
 */
export function listBacklogTasks(repoRoot, amqRoot, handle = null) {
  const busDir = getBusDirectory(repoRoot, amqRoot);
  const backlogDir = path.join(busDir, "backlog");
  if (!fs.existsSync(backlogDir)) return [];

  try {
    const files = fs.readdirSync(backlogDir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
    const tasks = [];
    const target = handle && handle !== "all" ? canonicalizeOwner(handle) : null;

    for (const f of files) {
      const fullPath = path.join(backlogDir, f);
      const parsed = parseTaskFile(fullPath, "backlog");
      if (parsed) {
        if (!target || parsed.owner === target) {
          tasks.push(parsed);
        }
      }
    }
    tasks.sort((a, b) => (a.created || "").localeCompare(b.created || ""));
    return tasks;
  } catch {
    return [];
  }
}

/**
 * Drain tasks for an agent: returns all pending backlog tasks with full descriptions,
 * optionally auto-claiming the first available task if claim: true.
 */
export function drainTasks(repoRoot, amqRoot, { me, claim = false, notify = true } = {}) {
  const target = me ? canonicalizeOwner(me) : "coordinator";
  const tasks = listBacklogTasks(repoRoot, amqRoot, target);

  let claimedTask = null;
  if (claim && tasks.length > 0) {
    const toClaim = tasks[0];
    const res = updateBoardTask(
      repoRoot,
      amqRoot,
      toClaim.id,
      { status: "in_progress", owner: target },
      { from: target, notify }
    );
    if (res.ok) {
      claimedTask = res.task;
    }
  }

  // Also discover any active tasks currently in doing/in_progress
  const busDir = getBusDirectory(repoRoot, amqRoot);
  const doingDir = path.join(busDir, resolveStageDir(busDir, "doing"));
  const activeTasks = [];
  if (fs.existsSync(doingDir)) {
    try {
      const files = fs.readdirSync(doingDir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
      for (const f of files) {
        const fullPath = path.join(doingDir, f);
        const parsed = parseTaskFile(fullPath, "in_progress");
        if (parsed && parsed.owner === target) {
          activeTasks.push(parsed);
        }
      }
    } catch {}
  }

  return {
    ok: true,
    owner: target,
    count: tasks.length,
    tasks,
    activeTasks,
    claimedTask,
  };
}

/**
 * Fast query of task numbers/statistics for an agent across stages:
 * { backlog, doing, blocked, done, total }
 */
export function getAgentTaskStats(repoRoot, amqRoot, handle) {
  const target = handle ? canonicalizeOwner(handle) : null;
  const busDir = getBusDirectory(repoRoot, amqRoot);
  const stages = [
    { dir: "backlog", key: "backlog" },
    { dir: "doing", key: "doing" },
    { dir: "in_progress", key: "doing" },
    { dir: "blocked", key: "blocked" },
    { dir: "done", key: "done" },
  ];

  const stats = {
    backlog: 0,
    doing: 0,
    blocked: 0,
    done: 0,
    total: 0,
  };

  const seenIds = new Set();

  for (const { dir, key } of stages) {
    const fullDir = path.join(busDir, dir);
    if (!fs.existsSync(fullDir)) continue;
    try {
      const files = fs.readdirSync(fullDir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
      for (const f of files) {
        const fullPath = path.join(fullDir, f);
        const parsed = parseTaskFile(fullPath, key);
        if (parsed && (!target || parsed.owner === target)) {
          if (!seenIds.has(parsed.id)) {
            seenIds.add(parsed.id);
            stats[key]++;
            stats.total++;
          }
        }
      }
    } catch {}
  }

  return stats;
}
