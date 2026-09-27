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
import { getStateDir } from "./config.mjs";
import { recordCardWrite } from "./card-writes.mjs";

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
// ONE source of truth for the directories a card can physically live in.
//
// This list had drifted in four places and omitted `queued`. To be precise about what that
// was and was not: it was NOT an observable bug, because getBoardTask falls back to
// loadBoard() when the fast path misses, so a queued card was still found (verified: a
// red arm that removed `queued` from this list still returned stage=queued, and no test
// went red). It is a consolidation so the next stage cannot be added to three of four
// lists, not a fix for cards going missing.
const STAGE_DIRS_FOR_LOOKUP = ["backlog", "queued", "doing", "in_progress", "blocked", "done"];

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
  queued: "queued",
  in_progress: "doing",
  doing: "doing",
  blocked: "blocked",
  done: "done",
};

export function ensureBusDirectories(busDir) {
  if (!busDir) return;
  // `queued` is a real directory, not a flavour of backlog. A scheduled card waiting its
  // turn has to live somewhere the board can count it as scheduled; without a directory
  // the status would be a word in a field with nowhere to go, which is the same defect as
  // a queued concept that only lives in a reason string.
  const stages = ["backlog", "queued", "doing", "blocked", "done"];
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
    // Transition stamps: what the stall metric reads as progress. Persisted explicitly
    // because the serializer writes a fixed key list.
    `status_at: ${JSON.stringify(task.status_at || task.updated || now)}`,
    `owner_at: ${JSON.stringify(task.owner_at || task.updated || now)}`,
    `next_actor_at: ${JSON.stringify(task.next_actor_at || task.updated || now)}`,
    `done_at: ${JSON.stringify(task.done_at || null)}`,
    `last_heartbeat_at: ${JSON.stringify(task.last_heartbeat_at || null)}`,
    `last_heartbeat_by: ${JSON.stringify(task.last_heartbeat_by || null)}`,
    `claims: ${Number.isFinite(Number(task.claims)) ? Number(task.claims) : 0}`,
    `blocked_ms: ${Number.isFinite(Number(task.blocked_ms)) ? Number(task.blocked_ms) : 0}`,
    `blocked_total_ms: ${Number.isFinite(Number(task.blocked_total_ms)) ? Number(task.blocked_total_ms) : 0}`,
    `block_reason: ${JSON.stringify(task.block_reason || null)}`,
    `proof: ${JSON.stringify(task.proof || null)}`,
    `notes: ${JSON.stringify(Array.isArray(task.notes) ? task.notes : [])}`,
    `depends_on: ${JSON.stringify(dependsOn)}`,
    `next_actor: ${JSON.stringify(task.next_actor || null)}`,
    // The ORDER is state. Writing "queued" into a reason field is the defect this stage
    // exists to fix, so the position has to be a real field on the card.
    `queue_sequence: ${task.queue_sequence === undefined || task.queue_sequence === null ? "null" : JSON.stringify(task.queue_sequence)}`,
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
    const status = TASK_STATUSES.includes(rawStatus)
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
      // Transition stamps must be read back, or they are written and then silently
      // dropped on the next parse - the card would look unstamped and the progress
      // clock would fall back to `updated`, restoring the defect invisibly.
      status_at: meta.status_at || null,
      owner_at: meta.owner_at || null,
      next_actor_at: meta.next_actor_at || null,
      done_at: meta.done_at || null,
      last_heartbeat_at: meta.last_heartbeat_at || null,
      last_heartbeat_by: meta.last_heartbeat_by || null,
      claims: Number.isFinite(Number(meta.claims)) ? Number(meta.claims) : 0,
      blocked_ms: Number.isFinite(Number(meta.blocked_ms)) ? Number(meta.blocked_ms) : 0,
      blocked_total_ms: Number.isFinite(Number(meta.blocked_total_ms)) ? Number(meta.blocked_total_ms) : 0,
      block_reason: meta.block_reason || null,
      proof: meta.proof || null,
      notes: Array.isArray(meta.notes) ? meta.notes : [],
      depends_on: dependsOn,
      next_actor: meta.next_actor || null,
      queue_sequence: meta.queue_sequence === null || meta.queue_sequence === undefined ? null : Number(meta.queue_sequence),
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
    { dir: "queued", stage: "queued" },
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
          // `heartbeatAgeMs` is DERIVED here rather than left to each consumer to subtract,
          // because the subtraction is where the defect came from. A reader that wanted an
          // age had to write `card.heartbeat || card.heartbeatAt || 0`, and when both keys
          // were absent the fallback produced a NUMBER: Date.parse(0) is 946692000000, which
          // rendered as an age of 14062699 minutes and was then reported as a measurement.
          // An absent key wearing a zero is worse than a wrong value, because a wrong value
          // is checkable. So the age travels with the timestamp, and an absent heartbeat
          // stays absent instead of becoming 0.
          const hb = Date.parse(parsed.last_heartbeat_at || "");
          busTasks.push({
            ...parsed,
            heartbeatAgeMs: Number.isFinite(hb) ? Math.max(0, Date.now() - hb) : null,
          });
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
    queued: [],
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
/**
 * THE MACHINE FIELDS, EMITTED NEXT TO THE PROSE THAT MAY CONTRADICT THEM.
 *
 * A card's description is re-emitted verbatim in every state-change notice, and there is no verb
 * to edit it, so a description written at creation time can permanently advertise a next actor
 * that is no longer correct - while owner, next_actor, depends_on and status have all moved on.
 * A coordinator sweep on 2026-09-27 found 53 open cards whose prose mentioned a next actor, of
 * which three genuinely contradicted the field: 0273c0 said "range" where the field said
 * "verifier", and 6c7b53 and 3fdb93 both said "agsuite-dev" where the field said "user".
 *
 * THE FIX IS RENDERING, not an edit-description verb, because the cheaper fix is the correct one:
 * put the authoritative field adjacent to the prose, so a stale claim is VISIBLY stale rather
 * than silently authoritative. A reader who sees "Next actor: range" in the description and
 * "next actor: verifier" in the field two lines below is not misled; a reader who sees only the
 * description is.
 *
 * The field is the authority and the prose is not - the same rule as an edge: the machine field
 * is the claim, and text written at creation time is narration that has since aged.
 */
function machineFieldLines(task) {
  return [
    `• Next actor (FIELD, authoritative): ${task.next_actor ?? "unset"}`,
    `• Card owner (field): ${task.owner || "unassigned"}`,
    Array.isArray(task.depends_on) && task.depends_on.length
      ? `• Depends on (field): ${task.depends_on.join(", ")}`
      : `• Depends on (field): none`,
    `  (The Details above are written once at creation and never rewritten. Where they`,
    `   disagree with the fields here, the fields are right.)`,
  ];
}

/**
 * A DESCRIPTION THAT NAMES A NEXT ACTOR.
 *
 * Used at re-point time, where the contradiction becomes detectable for the first time: until
 * now the two were only visible by sweeping every card. A sweep finds yesterday's drift; this
 * catches the write that CAUSES it, which is the only version that can be prevented.
 *
 * The pattern is deliberately narrow, and my first version of it was NOT - the test caught both
 * failures. It missed `next_actor = verifier`, because `\s+` does not match the underscore, so
 * the machine field's own spelling was invisible to a guard about the machine field. And it
 * MATCHED the sweep's false positive: "The old card said AS NEXT ACTOR: range" returns "range",
 * which would have flagged a card for correctly describing a correction it had already made.
 * Naming requires a label that is not being QUOTED or REPORTED, so a reporting verb in front of
 * it disqualifies the match.
 */
const REPORTING_BEFORE_LABEL = /\b(said|says|stated|states|previously|formerly|old|older|was|were|as|called|used\s+to)\b[^.]{0,40}$/i;

export function describedNextActor(description) {
  if (typeof description !== "string") return null;
  const re = /next[\s_]*actor\s*[:=-]\s*([A-Za-z][\w-]*)/gi;
  let m;
  while ((m = re.exec(description)) !== null) {
    const before = description.slice(Math.max(0, m.index - 48), m.index);
    if (REPORTING_BEFORE_LABEL.test(before)) continue;
    return m[1];
  }
  return null;
}

export function notifyTaskEvent(amqRoot, eventType, task, opts = {}) {
  if (!amqRoot || !task) return { ok: false, error: "Missing amqRoot or task" };

  // Default sender for a board notification. `board`, for the same reason as the create path
  // below and the update path in updateBoardTask: a notification has no human sender and the
  // coordinator did not send it.
  //
  // All five internal callers pass `from` explicitly (addBoardTask:770 and the four
  // updateBoardTask edges at 1108-1114), so this default is reached only by an external
  // caller that omits it. It is kept rather than turned into a throw for the reason above:
  // the honest thing for a notification is to name the automation, not to refuse to notify.
  const sender = opts.from || "board";
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
        `Task state changed to in_progress:`,
        ``,
        `• Task: ${task.title}`,
        `• ID: ${task.id}`,
        `• Status: in_progress`,
        `• Changed by: ${opts.actor || "not recorded (no actor supplied with the change)"}`,
        `• Card owner: ${task.owner || "unassigned"}`,
        task.description ? `• Details (written at creation, never rewritten):` : "",
        task.description ? `${task.description}` : "",
        task.description ? machineFieldLines(task).join("\n") : "",
        ``,
        `Track or complete via:`,
        `  herdr-amq task done ${task.id} --me ${task.owner} --proof "<evidence>"`,
      ].filter(Boolean).join("\n");
      break;
    }

    case "blocked": {
      to = ["coordinator"];
      priority = "urgent";
      subject = `[AGboard] [BLOCKED] ${task.title}`;
      // WHO CHANGED THE STATE and WHO OWNS THE CARD are different facts, and a
      // notification that conflates them asserts an action somebody never took. It also
      // pages the owner to clear a blocker they did not create and cannot clear, which
      // is worse than the wrong text: it sends a healthy agent to debug a problem that
      // was never theirs.
      const nextActor = task.next_actor || null;
      const ownerIsOnTheHook = !nextActor || nextActor === task.owner;
      body = [
        `⚠️ TASK BLOCKED:`,
        ``,
        `• Task: ${task.title}`,
        `• ID: ${task.id}`,
        `• Changed by: ${opts.actor || "not recorded (no actor supplied with the change)"}`,
        `• Card owner: ${task.owner || "unassigned"}`,
        `• Next actor: ${nextActor || "unassigned - needs triage"}`,
        `• Reason: ${opts.reason || task.description || "Unspecified blocker"}`,
        ``,
        ownerIsOnTheHook
          ? `The owner is on the hook for this. Needs coordination / unblock review.`
          : `Next actor is ${nextActor}, not the owner. The owner is NOT expected to unblock this.`,
      ].join("\n");
      break;
    }

    case "done": {
      to = ["coordinator"];
      subject = `[AGboard] [COMPLETED] ${task.title}`;
      body = [
        `✅ Task state changed to done:`,
        ``,
        `• Task: ${task.title}`,
        `• ID: ${task.id}`,
        `• Changed by: ${opts.actor || "not recorded (no actor supplied with the change)"}`,
        `• Card owner: ${task.owner || "unassigned"}`,
        opts.proof ? `• Evidence / Proof: ${opts.proof}` : "",
        task.description ? `• Details (written at creation, never rewritten):` : "",
        task.description ? `${task.description}` : "",
        task.description ? machineFieldLines(task).join("\n") : "",
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
  { title, owner = "coordinator", status = "backlog", priority = "normal", description = "", depends_on = [], next_actor, notify, from, queue_sequence } = {},
  opts = {}
) {
  if (!title || !title.trim()) {
    return { ok: false, error: "Task title is required" };
  }

  const busDir = getBusDirectory(repoRoot, amqRoot);
  ensureBusDirectories(busDir);

  const cleanOwner = canonicalizeOwner(owner);
  const cleanStatus = TASK_STATUSES.includes(status)
    ? (status === "doing" ? "in_progress" : status)
    : "backlog";
  const id = `task_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const now = opts.now instanceof Date ? opts.now.toISOString() : new Date().toISOString();
  // Same atomic-validation rule as updateBoardTask: an order that cannot be compared is
  // not an order, and a silently-stored "later" makes a queue look sorted when it is not.
  const seqCheck = validateQueueSequence(queue_sequence);
  if (!seqCheck.ok) return seqCheck;

  const newTask = {
    schema_version: TASK_SCHEMA_VERSION,
    id,
    title: title.trim(),
    owner: cleanOwner,
    status: cleanStatus,
    priority: priority || "normal",
    queue_sequence: seqCheck.value === undefined ? null : seqCheck.value,
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
    blocked_total_ms: 0,
    block_reason: null,
    proof: null,
    notes: [],
    depends_on: Array.isArray(depends_on) ? depends_on : [],
    // Never invent a next actor for a blocked card: absent beats confidently wrong.
    next_actor: next_actor === undefined ? (cleanStatus === "blocked" ? null : cleanOwner) : next_actor,
    // Stamped at creation. If these are left unset, the FIRST write to the card sets
    // them - so a reason edit on a fresh card would stamp it as progress, which is the
    // exact defect being removed, just relocated to the first write.
    status_at: now,
    owner_at: now,
    next_actor_at: now,
    thread: `agboard/${id}`,
    source: "bus",
  };

  const stageDir = resolveStageDir(busDir, cleanStatus);
  const filePath = path.join(busDir, stageDir, `${id}.md`);
  fs.writeFileSync(filePath, serializeTaskFile(newTask), "utf8");
  newTask.filePath = filePath;

  const shouldNotify = (notify !== undefined ? notify : opts.notify) ?? true;
  // The board's own automation identity, NOT the coordinator. A notification has no human
  // sender, and `coordinator` is a lane like any other: stamping it puts a durable record
  // asserting that the coordinator sent every assignment alert, which is a lie of
  // attribution, and it HIDES the real misattributions, because 894 of these were
  // indistinguishable from a message a lane actually wrote.
  //
  // A throw would be the wrong fix here, and this is why: the board notifying at all is more
  // valuable than the sender being honest about having no sender, so refusing would stop
  // AGboard from paging anybody. `updateBoardTask` already stamps `board` (see the `actor`
  // handling above); the create path was the asymmetric half.
  //
  // MEASURED over the live tree, 6577 unique messages across 14 mailboxes: of 283
  // [ASSIGNED] notifications, 247 carried from=coordinator and 2 carried from=board.
  const sender = from || opts.from || "board";

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
// Fields that are bookkeeping about the write rather than state of the card: they
// must not, on their own, make a no-op look like progress.
const WRITE_METADATA = new Set(["filePath", "file_path"]);

// True when `next` differs from `previous` in any field that describes the card.
// `updated` is excluded on both sides because it is the field being decided here.
export function cardStateChanged(previous, next) {
  if (!previous || !next) return true;
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  for (const key of keys) {
    if (key === "updated" || WRITE_METADATA.has(key)) continue;
    const before = previous[key];
    const after = next[key];
    if (before === after) continue;
    // Distinguish absent from null so clearing a field counts as a change.
    if (before === undefined || after === undefined) return true;
    if (before === null || after === null) return true;
    if (typeof before === "object" || typeof after === "object") {
      if (JSON.stringify(before) !== JSON.stringify(after)) return true;
      continue;
    }
    return true;
  }
  return false;
}

// The single task lookup. Extracted so the read path and the write path resolve a card
// the same way; when only the write path existed, "GET returns Not Found" was
// indistinguishable from "this card does not exist" for a card that plainly did.
export function getBoardTask(repoRoot, amqRoot, taskId) {
  if (!taskId) return null;
  const busDir = getBusDirectory(repoRoot, amqRoot);
  const stageDirs = STAGE_DIRS_FOR_LOOKUP;
  for (const s of stageDirs) {
    const candidate = path.join(busDir, s, `${taskId}.md`);
    if (fs.existsSync(candidate)) {
      const stage = s === "doing" ? "in_progress" : s;
      return { task: parseTaskFile(candidate, stage), filePath: candidate, stage };
    }
  }
  const board = loadBoard(repoRoot, amqRoot);
  for (const [col, list] of Object.entries(board.columns)) {
    const match = (list || []).find((t) => t.id === taskId);
    if (match) return { task: match, filePath: match.filePath || null, stage: col };
  }
  return null;
}

/** The statuses a card may legally hold. `doing` is an accepted alias of `in_progress`. */
export const TASK_STATUSES = ["backlog", "queued", "in_progress", "doing", "blocked", "done"];

function normalizeTaskStatus(status) {
  return status === "doing" ? "in_progress" : status;
}

// `queued` means SCHEDULED: in a recorded order, waiting its turn. `backlog` means UNSCHEDULED:
// nobody has picked it up. Collapsing the two is what made a deliberately parked card
// indistinguishable from an abandoned one, so a queue working as designed read as a queue
// that had stopped - a 4-of-4 false-positive rate, measured on live data.
//
// It carries a SEQUENCE, not a date. A queue is an order, not a schedule: a card is not
// "parked until Thursday", it is parked behind another card. A date would be wrong the
// first time someone used it literally, and the order is what actually exists.
function validateQueueSequence(value) {
  if (value === undefined || value === null || value === "") return { ok: true };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    return {
      ok: false,
      error: `queue_sequence must be a non-negative integer, got ${JSON.stringify(value)}. Nothing was written.`,
      rejected: ["queue_sequence"],
    };
  }
  return { ok: true, value: n };
}

export function updateBoardTask(repoRoot, amqRoot, taskId, updates = {}, opts = {}) {
  if (!taskId) return { ok: false, error: "taskId is required" };

  const busDir = getBusDirectory(repoRoot, amqRoot);
  ensureBusDirectories(busDir);

  const located = getBoardTask(repoRoot, amqRoot, taskId);
  const existingTask = located?.task || null;
  const existingPath = located?.filePath || null;
  const currentStage = located?.stage || "backlog";

  if (!existingTask) {
    return { ok: false, error: "Task not found" };
  }

  // A CARD IS EITHER DONE OR NOT, AND NO TRANSITION MAY LEAVE IT ASSERTING BOTH.
  //
  // Reproduced on a real card, from the board's own instrumented event log rather than a
  // reconstruction: a card was closed with proof at 05:45:55.314Z and written back to
  // in_progress at 05:45:57.905Z - two and a half seconds later, by a stale caller acting on
  // a reading it had not refreshed. The result was a card with status in_progress, a done_at
  // stamp 2.6 seconds older, sitting in doing/, owned by a lane with nothing left to do. No
  // reader can resolve that: `done` and `in_progress` are both true and the stage directory
  // says doing/.
  //
  // The cause was that done_at is PRESERVED on every non-done transition, so leaving done did
  // not clear the completion record; the claim simply manufactured a contradiction.
  //
  // REFUSING IS THE HONEST DEFAULT, and it is also what the neighbouring function already
  // does - heartbeatBoardTask refuses a done card outright. The two paths disagreed about the
  // same rule and the claim path was the one the tooling actually used, which is why the
  // contradiction was reachable at all. Reopening now requires saying so on purpose.
  //
  // The alternative - silently nulling done_at - is weaker and was rejected deliberately: a
  // racing caller would erase a real completion record, including its proof, and a card whose
  // proof has been quietly discarded is worse than a card that refused a write.
  if (existingTask.status === "done" && updates.status && updates.status !== "done" && !opts.reopen) {
    return {
      ok: false,
      error: `Task is done (done_at ${existingTask.done_at || "unknown"}); ` +
        "a claim cannot revive it. Use `task reopen` if reopening is a real intent.",
    };
  }

  // The FIRST predicate only fires when LEAVING A CLEAN done card, so a card that is ALREADY
  // contradictory - status not done while done_at is set - was unprotected, and could be written
  // again with the contradiction intact. ballistics measured this rather than inferring it: a
  // write of status -> blocked on an already-bad card was ACCEPTED and left done_at in place,
  // violating the invariant in a new way.
  //
  // That is live card queued/task_1790452331402_0273c0, range's profiler card, and it is the one
  // instance still standing after 11 others self-healed. The refusal is what stops anyone
  // touching it further; the sweep is what finds it, and it will not prevent the next write.
  //
  // Keying on the PRESENCE of done_at rather than on the status field is the whole point: a
  // contradictory card is precisely one where status and done_at disagree, so a predicate that
  // reads status cannot see it.
  if (existingTask.done_at && existingTask.status !== "done" && updates.status !== "done" && !opts.reopen) {
    return {
      ok: false,
      error: `Task carries a completion record (done_at ${existingTask.done_at}) but is not ` +
        `done (status ${existingTask.status}) - the card contradicts itself. Refusing to ` +
        "write over it. Repair it explicitly: `task reopen` clears the stale record.",
    };
  }

  // AN EDGE MUST POINT AT WORK THAT IS NOT ALREADY FINISHED.
  //
  // A block is a claim about what a card is waiting for, and the edge is the claim - the prose
  // reason is narration, never the claim. So when a caller authors an edge, the target's actual
  // status has to agree that there is something left to wait for. Coordinator adopted this after
  // the fourth occurrence of the same failure, phrased as: resolve the target and read its status
  // in the same command, because a plausible-looking id is not a status.
  //
  // IT WAS A MIS-ENCODED EDGE, NOT A MISSING AUTO-RELEASE. No policy released coordinator's false
  // block; they wrote an edge pointing at an already-done card, from an id they remembered
  // instead of read, and the board honoured it because no guard existed. An auto-release would
  // not have fixed that - it would have ACTED on the mis-encoding, which is strictly worse: the
  // bad edge stays invisible until something silently opens a card someone is still waiting on.
  // Refusing a bad edge is loud and costs a retry; releasing on a good-looking edge is silent
  // and costs a wait. That asymmetry is the whole ruling.
  //
  // This is a DIFFERENT guard from the done-card one. That refuses a CLAIM against a finished
  // card; this refuses an EDGE to one. Neither substitutes for the other.
  if (Array.isArray(updates.depends_on) && updates.depends_on.length) {
    const finished = [];
    const unknown = [];
    for (const dep of updates.depends_on) {
      const depId = typeof dep === "string" ? dep : dep?.id;
      if (!depId || depId === taskId) continue;
      const target = getBoardTask(repoRoot, amqRoot, depId);
      if (!target) { unknown.push(depId); continue; }
      if (target.task.status === "done") finished.push(depId);
    }
    if (finished.length) {
      return {
        ok: false,
        error: `Edge points at already-completed card(s): ${finished.join(", ")}. ` +
          "A dependency is a claim that there is work left to wait for; this one has none. " +
          "Re-point the edge at the real blocker, or drop it and say so in the reason.",
      };
    }
  }

  // REJECT WHAT WE CANNOT HONOUR, BY NAME.
  //
  // A write that reports ok:true and quietly does nothing is worse than one that fails:
  // it turns a caller error into a silent divergence between what was asked for and what
  // the board now says, and the caller has no way to find out. Two ways that happened
  // here, both reported by the coordinator against a PATCH of {"status":"review"}:
  //
  //   1. An unrecognised status fell through to the card's existing status. The response
  //      said ok:true, the field simply did not appear in the updates, and the enum had
  //      to be discovered by grepping the source because there was no error to read.
  //   2. Worse, and found while fixing (1): `...updates` spreads into the card, so an
  //      unrecognised FIELD was not ignored at all - it was written into the card file
  //      as a new, meaningless key. The same caller error was corrupting the record
  //      rather than merely losing an assignment.
  //
  // Both are refused now, and the error names what was wrong and what is accepted, so a
  // caller never has to read the source to discover the rules.
  const writableFields = new Set([
    ...Object.keys(existingTask),
    "title", "status", "owner", "priority", "description", "next_actor", "reason",
    "block_reason", "proof", "notes", "depends_on", "notify", "from", "queue_sequence",
  ]);
  const unknownFields = Object.keys(updates || {}).filter((key) => !writableFields.has(key));
  if (unknownFields.length) {
    return {
      ok: false,
      error: `Unrecognised field(s): ${unknownFields.join(", ")}. Nothing was written.`,
      rejected: unknownFields,
      hint: "A misspelled field would be stored as a meaningless key rather than ignored.",
    };
  }

  if (updates.status !== undefined && !TASK_STATUSES.includes(normalizeTaskStatus(updates.status))) {
    return {
      ok: false,
      error: `Unrecognised status: ${JSON.stringify(updates.status)}. Nothing was written.`,
      rejected: ["status"],
      accepted: [...TASK_STATUSES],
      hint: '"doing" is accepted as an alias of "in_progress".',
    };
  }

  // Reject a non-numeric or negative sequence rather than storing it: an order that
  // cannot be compared is not an order, and a silently-stored "later" would make the
  // queue look sorted when it is not. Fails atomically with the rest of the validation.
  const sequenceCheck = validateQueueSequence(updates.queue_sequence);
  if (!sequenceCheck.ok) return sequenceCheck;
  if (updates.queue_sequence !== undefined && sequenceCheck.value !== undefined) {
    updates = { ...updates, queue_sequence: sequenceCheck.value };
  }

  const oldTask = { ...existingTask };
  const requestedStatus = updates.status
    ? normalizeTaskStatus(updates.status)
    : existingTask.status;
  const targetStatus = TASK_STATUSES.includes(requestedStatus) ? requestedStatus : existingTask.status;
  const now = opts.now instanceof Date ? opts.now.toISOString() : new Date().toISOString();
  const nowMs = Date.parse(now);
  const wasBlocked = existingTask.status === "blocked";
  const isBlocked = targetStatus === "blocked";

  // TREATMENT B: a reason is the NARRATION of the edge, and both edges touching `blocked`
  // require one. Refused HERE rather than in the CLI, because the CLI is not the only
  // door -- an HTTP PATCH reaches this same function, and a guard that only exists in one
  // door is a guard that will be walked around the same evening it was written.
  //
  // Entering blocked without a reason produces a blocker the coordinator cannot triage,
  // and it is silently accepted today (measured, not assumed). Leaving blocked without one
  // discards the answer to "why was this stuck, and what resolved it" -- and the reason
  // field is what the alert reads, so an un-narrated exit also strands the history.
  //
  // The exit reason is NOT kept as `block_reason`: a card that is no longer blocked must
  // not carry a reason slot, or "carries a reason" stops meaning "is a triaged blocker"
  // and the blocked_oldest ownership split silently changes meaning. It is appended to
  // `notes` as history instead, which is what notes are for.
  if (wasBlocked !== isBlocked) {
    const narration = String(updates.reason ?? opts.reason ?? "").trim();
    if (!narration) {
      return {
        ok: false,
        error: isBlocked
          ? "Entering `blocked` requires a reason. Nothing was written."
          : "Leaving `blocked` requires a reason explaining what resolved it. Nothing was written.",
        rejected: ["reason"],
        hint: "The reason is the narration of the transition; an edge that can be walked without one will be.",
      };
    }
    updates = { ...updates, reason: narration };
  }
  // Re-triaging a blocker is a real action, but only when it ROUTES the card.
  // Rewriting the reason on its own is prose: the blocked_oldest alert exists
  // precisely because a triaged blocker is still a blocker, and if a reason
  // rewrite reset this clock then any lane could silence the alert by saying
  // more words about a card nobody had touched. Changing who is next, or who
  // owns it, is a different thing -- somebody made a decision about who acts
  // next, and the age from that point is the honest one. Without this the
  // alert reports "blocked for 117 minutes" about a card that was correctly
  // re-routed three minutes ago, which is a false stale reading, not a stale
  // card.
  const nextActor = updates.next_actor ? canonicalizeOwner(updates.next_actor) : existingTask.next_actor;
  // Presence, not value: an ABSENT key means "leave it alone", and comparing the
  // absent case against "" would report a change on every patch that simply did
  // not mention the field. That is what the reason-only control caught.
  const touches = (k) => Object.prototype.hasOwnProperty.call(updates, k) && updates[k] !== undefined;
  const reroutedWhileBlocked =
    wasBlocked &&
    isBlocked &&
    ((touches("next_actor") && canonicalizeOwner(updates.next_actor) !== canonicalizeOwner(existingTask.next_actor || "")) ||
      (touches("owner") && canonicalizeOwner(updates.owner) !== canonicalizeOwner(existingTask.owner || "")));
  // `blocked_ms` used to be the TOTAL time a card had ever spent blocked, banked at the moment
  // the card LEFT the blocked column. That made a field named "blocked_ms" read as "how long has
  // this been blocked" while actually answering "how long has this been blocked across every
  // spell it has ever had", and the two disagree by however long the previous spells were:
  //
  //   a card blocked 138 min for the first time   -> blocked_ms 0        (nothing banked yet)
  //   a card blocked 9 min after 150 min blocked  -> blocked_ms 9037810 (the OLD spell, not this one)
  //
  // A consumer sorting by it orders the board wrongly while never looking wrong, which is the
  // whole failure class. So the live age lives in `blocked_ms`, where the name points, and the
  // cumulative figure is preserved as `blocked_total_ms` for anyone who really wants it.
  // The ALERT was never wrong: metrics.mjs derives its age from `blocked_at` and only falls back
  // to blocked_ms when blocked_at is unparseable. The defect was the field and the human-facing
  // render, not the alerting.
  const priorTotalMs = Number.isFinite(Number(existingTask.blocked_total_ms))
    ? Number(existingTask.blocked_total_ms)
    : (Number.isFinite(Number(existingTask.blocked_ms)) ? Number(existingTask.blocked_ms) : 0);
  let blockedTotalMs = priorTotalMs;
  if (wasBlocked && !isBlocked && existingTask.blocked_at) {
    const blockedAtMs = Date.parse(existingTask.blocked_at);
    if (Number.isFinite(blockedAtMs)) blockedTotalMs += Math.max(0, nowMs - blockedAtMs);
  }
  // A card that has just entered blocked starts its first spell now, so its age is 0 - and it
  // grows from here on every render, which is the entire point of a live figure. When the card is
  // NOT blocked the live age is 0: it is not blocked for zero milliseconds, it is not blocked now.
  const blockedMs = isBlocked
    ? (wasBlocked && existingTask.blocked_at
      ? Math.max(0, nowMs - (Number.isFinite(Date.parse(existingTask.blocked_at)) ? Date.parse(existingTask.blocked_at) : nowMs))
      : 0)
    : 0;

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
    claimed_at: enteringProgress ? now : (existingTask.claimed_at || null),
    next_actor: nextActor,
    blocked_at: isBlocked
      ? (wasBlocked ? (reroutedWhileBlocked ? now : existingTask.blocked_at) : now)
      : existingTask.blocked_at,
    // An EXPLICIT null in the updates wins, and that is the reopen path. done_at is otherwise
    // preserved on every non-done transition, which is what let a claim leave a card asserting
    // done and in_progress at once; a deliberate reopen has to be the one write that CLEARS the
    // completion stamp, or the card comes back with a stale done_at and the contradiction simply
    // reappears one command later.
    done_at: Object.prototype.hasOwnProperty.call(updates, "done_at")
      ? (updates.done_at || null)
      : (targetStatus === "done" ? (existingTask.done_at || now) : existingTask.done_at),
    // A claim is a liveness signal, an in-progress update is not: only a fresh
    // claim (or an explicit `task heartbeat`) sets the liveness clock.
    last_heartbeat_at: nextHeartbeatAt,
    last_heartbeat_by: nextHeartbeatBy,
    claims: enteringProgress ? (Number(existingTask.claims) || 0) + 1 : (Number(existingTask.claims) || 0),
    blocked_ms: blockedMs,
    blocked_total_ms: blockedTotalMs,
    // `block_reason` lives on blocked cards and NOWHERE ELSE. A reason supplied on any
    // transition that does not land on `blocked` must not linger in the field the alert
    // reads, or "carries a reason" stops meaning "is a triaged blocker" and the
    // blocked_oldest ownership split changes meaning without anyone changing it.
    block_reason: isBlocked
      ? (updates.reason ?? opts.reason ?? existingTask.block_reason ?? null)
      : null,
    notes: wasBlocked && !isBlocked
      ? [...(Array.isArray(existingTask.notes) ? existingTask.notes : []), {
        at: now,
        author: String(opts.from || updates.owner || existingTask.owner || "unknown"),
        text: `unblocked: ${updates.reason ?? opts.reason}`,
      }]
      : (Array.isArray(updates.notes) ? updates.notes : (Array.isArray(existingTask.notes) ? existingTask.notes : [])),
    proof: updates.proof ?? opts.proof ?? existingTask.proof ?? null,
    depends_on: Array.isArray(updates.depends_on) ? updates.depends_on : (Array.isArray(existingTask.depends_on) ? existingTask.depends_on : []),
    // A blocked card is triaged when it carries a reason. There is no reliable way
    // to infer a next actor from a reason string, so an untriaged block reports no
    // next actor rather than a confidently wrong one (for example "coordinator").
    // An explicit `next_actor: null` in the update clears a persisted value.
    // PRESENCE must mean "a real value was supplied", not merely "the key is there".
    // The CLI passes `next_actor: nextActorFlag(flags["next-actor"])`, and that helper
    // returns `undefined` when no flag was given -- so the key is present with an undefined
    // value and a bare hasOwnProperty check treated "nobody said anything" as "clear it".
    // An unblocked card then came back with no next actor, which reads as a live card with
    // nobody on it. Only an explicit `null` clears the field.
    next_actor: Object.hasOwn(updates, "next_actor") && updates.next_actor !== undefined
      ? updates.next_actor
      : (Object.hasOwn(opts, "next_actor") && opts.next_actor !== undefined ? opts.next_actor : (
        targetStatus === "done" ? null
          : (targetStatus === "blocked" ? (existingTask.next_actor ?? null) : owner)
      )),
    // Transition stamps. These are what the stall metric reads as PROGRESS, as distinct
    // from `updated`, which only records that something was written. Without them a
    // reason edit and a status change are the same event, so the alert can be silenced
    // by writing prose on the card - which pays the observer to touch the thing being
    // measured.
    status_at: targetStatus !== existingTask.status ? now : (existingTask.status_at || now),
    owner_at: owner !== existingTask.owner ? now : (existingTask.owner_at || now),
    next_actor_at: Object.hasOwn(updates, "next_actor") && updates.next_actor !== existingTask.next_actor
      ? now
      : (existingTask.next_actor_at || now),
    source: "bus",
  };

  const destStageDir = resolveStageDir(busDir, targetStatus);
  const newFilePath = path.join(busDir, destStageDir, `${taskId}.md`);

  // `updated` is the card's state clock, and the stall detector ages exactly that
  // clock. It is therefore moved only when the card actually changed: an update that
  // rewrites identical values, or an empty PATCH, is a no-op and must not look like
  // progress. `heartbeatBoardTask` was built to avoid exactly this, and this path was
  // the hole beside it - found by a live probe whose empty PATCH reset a real card's
  // `updated` to the probe's own timestamp.
  updatedTask.updated = cardStateChanged(existingTask, updatedTask) ? now : (existingTask.updated || now);

  // Record the write as an EVENT. A card keeps only its latest `updated`, so the history
  // of how it moves is destroyed on the first write.
  //
  // WHAT THIS IS, precisely, because the previous version of this comment was false and
  // false in a way that matters: it said "This is the instrument that makes it measurable",
  // which claimed a consumer that does not exist. The stall path does NOT read this store -
  // `readCardWrites` and `cardTransitionIntervals` are exported and called from nothing in
  // src/ or bin/ except their own test - so the interval the stall threshold depends on is
  // still not measurable, and this write does not change that.
  //
  // It is a WRITE-SIDE TRACE for post-hoc inspection: capped at MAX_EVENTS_PER_CARD and
  // MAX_TOTAL_CARDS, evicted oldest-first, and read by nobody in production. Raising the
  // cap would make the trace more durable without making it more true.
  //
  // THE RETENTION BIAS IS THE PART TO KNOW BEFORE RELYING ON IT. Oldest-mtime-first eviction
  // means a log survives for cards that are STILL MOVING and disappears first for cards that
  // have STOPPED - which is precisely the population whose history you want afterwards. That
  // is why the proof-erasure question had to be deduced from card state rather than read
  // from here: 12 of 12 logs were already evicted, and the instrumentation was shaped so it
  // could not answer the question it was built to answer.
  //
  // If a consumer is ever wired up, THIS comment is where the claim becomes true, and it
  // should be written then - not asserted now by a mechanism that has no reader.
  try {
    recordCardWrite(getStateDir(), taskId, existingTask, updatedTask, {
      actor: String(updates.from || opts.from || "") || null,
      at: now,
    });
  } catch {
    // Never let instrumentation fail a board write.
  }

  fs.writeFileSync(newFilePath, serializeTaskFile(updatedTask), "utf8");
  updatedTask.filePath = newFilePath;

  if (existingPath && existingPath !== newFilePath && fs.existsSync(existingPath)) {
    try {
      fs.unlinkSync(existingPath);
    } catch {}
  }

  const shouldNotify = (updates.notify !== undefined ? updates.notify : opts.notify) ?? true;
  // NEVER fall back to the card owner here. The owner is whoever the work belongs to;
  // the actor is whoever performed this particular change, and when nobody says, the
  // board does not get to pick the owner's name and assert an action they never took.
  // The board's own automation identity stands in, and the body says the actor was not
  // recorded, so the record is honest about being incomplete rather than confidently
  // wrong. This was the third instance of "an unnamed clock/actor borrows an identity":
  // the liveness clock (opts.from), then the notification sender, both fixed by
  // refusing to invent one.
  const actor = String(updates.from || opts.from || "").trim();
  const sender = actor || "board";

  if (shouldNotify && amqRoot && oldTask) {
    try {
      if (updates.owner && updates.owner !== oldTask.owner && updates.owner !== "coordinator") {
        notifyTaskEvent(amqRoot, "assigned", updatedTask, { from: sender, actor: actor || null });
      } else if (updatedTask.status === "in_progress" && oldTask.status !== "in_progress") {
        notifyTaskEvent(amqRoot, "claimed", updatedTask, { from: sender, actor: actor || null });
      } else if (updatedTask.status === "blocked" && oldTask.status !== "blocked") {
        notifyTaskEvent(amqRoot, "blocked", updatedTask, { from: sender, actor: actor || null, reason: updatedTask.block_reason || updates.description });
      } else if (updatedTask.status === "done" && oldTask.status !== "done") {
        notifyTaskEvent(amqRoot, "done", updatedTask, { from: sender, actor: actor || null, proof: updatedTask.proof || updates.description });
      }
    } catch {}
  }

  // An edge to an id that does not resolve is NOT refused - a legitimate workflow creates a
  // dependency on a card that does not exist yet, and refusing that would break ordering rather
  // than catch a mistake. But it is REPORTED rather than silent, because the most likely cause of
  // an unresolvable id is exactly coordinator's: an id remembered instead of read. A warning nobody
  // receives is the same as no warning, and the point of the ruling is that the bad edge should be
  // visible rather than acted upon.
  if (Array.isArray(updates.depends_on)) {
    const unresolved = updates.depends_on
      .map((d) => (typeof d === "string" ? d : d?.id))
      .filter((id) => id && id !== taskId && !getBoardTask(repoRoot, amqRoot, id));
    if (unresolved.length) {
      console.warn(`⚠️  edge target(s) not found on the board: ${unresolved.join(", ")} — ` +
        "written anyway, because a dependency may legitimately precede its target. " +
        "If the id was remembered rather than read, that is the false-block signature.");
    }
  }

  // A RE-POINT THAT LEAVES THE DESCRIPTION NAMING SOMEBODY ELSE.
  //
  // The fields and the prose drift apart silently: there is no verb to edit a description, so a
  // card keeps advertising whoever it named at creation while next_actor moves on. A sweep finds
  // that drift afterwards; this catches the WRITE THAT CAUSES IT, which is the only version that
  // can be prevented, and it is the same write-time guard shape as the edge-to-finished-card
  // refusal.
  //
  // A WARNING, NOT A REFUSAL. The field is authoritative and the description is narration, so
  // changing the next actor is never wrong - the prose is simply now visibly wrong, and refusing
  // would force people to delete the sentence instead of correcting the field. The message names
  // both values so the reader knows which one to believe.
  if (updates.next_actor !== undefined && updates.next_actor !== existingTask.next_actor) {
    const described = describedNextActor(existingTask.description || "");
    if (described && described !== updates.next_actor) {
      console.warn(
        `⚠️  ${taskId}: next_actor is now "${updates.next_actor}", but the card description still ` +
        `says "Next actor: ${described}". The description is written once and never rewritten, ` +
        `so notices will show both. The FIELD is authoritative - act on "${updates.next_actor}". ` +
        `There is no verb to edit a description; coordinator has that as a known gap.`
      );
    }
  }

  return { ok: true, taskId, updates, task: updatedTask };
}

/**
 * Record an explicit liveness signal for a card.
 *
 * A heartbeat only moves `last_heartbeat_at`. It deliberately does not change
 * `updated`, the stage, the claim count, or the notes, so it cannot be used to
 * fake progress on the board.
 *
 * It is reported as a liveness LEASE and is never alerted on. It used to be the clock
 * the stall detector aged, which made the alert's own remedy (heartbeat) the event
 * being timed: obeying it reset the timer and guaranteed the same alert one window
 * later, so a working owner and an ignoring one looked identical. The detector now
 * ages the card's state clock, and this exists to answer a different question -
 * whether the owner says they are there - which no amount of heartbeating can answer
 * about the work.
 */
export function heartbeatBoardTask(repoRoot, amqRoot, taskId, { actor, now } = {}) {
  if (!taskId) return { ok: false, error: "taskId is required" };

  const busDir = getBusDirectory(repoRoot, amqRoot);
  const stageDirs = STAGE_DIRS_FOR_LOOKUP;
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
  const stageDirs = STAGE_DIRS_FOR_LOOKUP;
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
  const stageDirs = STAGE_DIRS_FOR_LOOKUP;
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
