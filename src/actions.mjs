import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findAmqRoot,
  getAgentHandles,
  getStateDir,
  getConfigDir,
  getEventContext,
  getPluginVersion,
  getStateDirDivergence,
} from "./config.mjs";
import {
  getUnregisteredDaemon,
  isDaemonRunning,
  startDaemonBackground,
  stopDaemon,
  runDoorbellPass,
  listInbox,
} from "./bridge.mjs";
import {
  loadBoard,
  addBoardTask,
  updateBoardTask,
  appendBoardTaskNote,
  heartbeatBoardTask,
  reassignBoardTask,
  deleteBoardTask,
  drainTasks,
} from "./board.mjs";
import {
  sendMaildirMessage,
  replyMaildirMessage,
  drainMaildir,
} from "./protocol.mjs";
import { migrateMessageAttachments } from "./migration.mjs";
import {
  discoverFleetPersonas,
  prepopulateFleet,
  launchFleet,
  stopFleet,
} from "./fleet.mjs";
import { getHerdrAgents } from "./herdr.mjs";

export function handleStatus() {
  const amqRoot = findAmqRoot();
  const pid = isDaemonRunning();
  const handles = amqRoot ? getAgentHandles(amqRoot) : [];
  const version = getPluginVersion();

  console.log(`\n📦 \x1b[1mHerdr AMQ Bridge Status\x1b[0m \x1b[2m(v${version})\x1b[0m`);
  console.log("──────────────────────────────────────────────");
  console.log(`Version:   v${version}`);
  console.log(`Daemon:    ${pid ? `\x1b[32m● Running\x1b[0m (PID ${pid})` : "\x1b[33m○ Stopped\x1b[0m"}`);
  // A daemon holding the singleton lock without being the registered one is the
  // state that used to be invisible: a duplicate overwriting the delivery map of
  // the registered daemon, unreachable by `herdr-amq stop`.
  const unregistered = getUnregisteredDaemon();
  if (unregistered) {
    console.log(`\x1b[31m⚠ WARNING: a bridge daemon holds the singleton lock (PID ${unregistered.lockHolder}) but the registered daemon is ${unregistered.registeredPid ?? "none"}\x1b[0m`);
    console.log(`  Two daemons overwrite the same delivery state. Stop PID ${unregistered.lockHolder} before starting another.`);
  }
  console.log(`AMQ Root:  ${amqRoot ? `\x1b[36m${amqRoot}\x1b[0m` : "\x1b[31mNot found\x1b[0m"}`);
  console.log(`State Dir: ${getStateDir()}`);
  const splitState = getStateDirDivergence();
  if (splitState) {
    console.log(`\x1b[31m⚠ WARNING: more than one bridge state directory exists, so processes started from different contexts read different delivery history.\x1b[0m`);
    for (const dir of splitState.directories) {
      const marker = dir === splitState.active ? " (in use here)" : "";
      console.log(`  - ${dir}${marker}`);
    }
    console.log(`  Do not compare delivery counters between these files; they are not the same history.`);
  }
  console.log(`Config:    ${getConfigDir()}`);
  console.log("──────────────────────────────────────────────");

  if (!amqRoot) {
    console.log("⚠️ No active .agent-mail directory found in current workspace or path.");
    return;
  }

  console.log(`\x1b[1mRegistered Agents (${handles.length}):\x1b[0m`);
  if (!handles.length) {
    console.log("  (no agents registered in config)");
    return;
  }

  let totalUnread = 0;
  for (const h of handles) {
    const unread = listInbox(amqRoot, h);
    const count = unread.length;
    totalUnread += count;

    const countBadge = count > 0
      ? `\x1b[33m${count} new\x1b[0m`
      : `\x1b[90m0 new\x1b[0m`;

    const senders = count > 0
      ? `(from ${[...new Set(unread.map((m) => m.from))].join(", ")})`
      : "";

    console.log(`  • \x1b[1m${h.padEnd(16)}\x1b[0m ${countBadge} ${senders}`);
  }

  console.log("──────────────────────────────────────────────");
  console.log(`Total Unread: ${totalUnread}`);
  console.log("");
}

export function handleStart() {
  const res = startDaemonBackground();
  if (res.alreadyRunning) {
    console.log(`ℹ️ Bridge daemon is already running (PID ${res.pid}).`);
  } else if (res.ok) {
    console.log(`🚀 Started bridge daemon in background (PID ${res.pid}).`);
  } else {
    console.error(`❌ Failed to start bridge daemon: ${res.error || "unknown error"}`);
    process.exit(1);
  }
}

export function handleStop() {
  const res = stopDaemon();
  if (res.ok) {
    console.log(`🛑 ${res.message}`);
  } else {
    console.error(`❌ Failed to stop daemon: ${res.error}`);
    process.exit(1);
  }
}

export function handleDoorbell() {
  const amqRoot = findAmqRoot();
  if (!amqRoot) {
    console.error("❌ No .agent-mail directory found.");
    process.exit(1);
  }

  const force = process.argv.includes("--force") || process.argv.includes("-f");
  const dryRun = process.argv.includes("--dry-run");
  console.log(`🔔 Checking AMQ inboxes at ${amqRoot}${force ? " (force=true)" : ""}${dryRun ? " [dry-run: no prompts, heals, or state writes]" : ""}...`);
  const res = runDoorbellPass({ amqRoot, force, dryRun, allowPrompt: !dryRun, persistState: !dryRun });

  if (!res.ok) {
    console.error(`❌ Doorbell check failed: ${res.error}`);
    return;
  }

  console.log(`Checked ${res.agentsChecked} agents. Doorbelled: ${res.doorbelled} message(s), ${res.doorbelledTasks || 0} task(s).`);
  for (const r of res.results || []) {
    const taskInfo = r.tasksCount ? `, ${r.tasksCount} task(s)` : "";
    console.log(`  - ${r.handle} (${r.status}): ${r.count} msg(s)${taskInfo} -> ${r.action}`);
  }
  for (const alert of res.coordinator?.alerts || []) {
    console.warn(`  ! coordinator alert [${alert.id}]: ${alert.message} Next: ${alert.recommendedAction}`);
  }
}

export function handleStartup() {
  const amqRoot = findAmqRoot();
  console.log(`[herdr-amq] Startup hook executed. Found AMQ root: ${amqRoot || "none"}`);
}

export function handleAgentStatusChanged() {
  const evt = getEventContext();
  if (!evt) return;

  const data = evt.data || evt;
  const status = data.agent_status;
  const handle = data.agent_name || data.handle || data.title;

  // If an agent transitioned to idle or done, immediately check if it has unread mail!
  if (status === "idle" || status === "done") {
    const amqRoot = findAmqRoot();
    if (amqRoot && handle) {
      runDoorbellPass({ amqRoot, targetHandle: handle, allowPrompt: true, persistState: true });
    }
  }
}

function parseTaskArgs(args = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const TASK_FLAGS = {
  list: new Set(["owner", "status", "json", "me", "from", "help"]),
  ls: new Set(["owner", "status", "json", "me", "from", "help"]),
  create: new Set(["title", "to", "owner", "desc", "description", "status", "priority", "next-actor", "depends-on", "json", "notify", "me", "from", "help"]),
  new: new Set(["title", "to", "owner", "desc", "description", "status", "priority", "next-actor", "depends-on", "json", "notify", "me", "from", "help"]),
  assign: new Set(["to", "owner", "title", "desc", "description", "status", "next-actor", "depends-on", "priority", "notify", "me", "from", "help"]),
  claim: new Set(["id", "notify", "me", "from", "help"]),
  done: new Set(["id", "proof", "evidence", "notify", "me", "from", "help"]),
  complete: new Set(["id", "proof", "evidence", "notify", "me", "from", "help"]),
  block: new Set(["id", "reason", "desc", "next-actor", "depends-on", "priority", "notify", "me", "from", "help"]),
  heartbeat: new Set(["id", "me", "from", "help"]),  reassign: new Set(["id", "to", "owner", "next-actor", "depends-on", "clear-depends-on", "notify", "me", "from", "help"]),
  show: new Set(["id", "me", "from", "help"]),
  drain: new Set(["claim", "autoClaim", "json", "notify", "me", "from", "help"]),
  next: new Set(["claim", "autoClaim", "json", "notify", "me", "from", "help"]),
  comment: new Set(["id", "text", "note", "me", "from", "help"]),
  note: new Set(["id", "text", "note", "me", "from", "help"]),
};

function taskUsage() {
  return [
    "",
    "📋 \x1b[1mAGboard Task Coordination CLI\x1b[0m",
    "────────────────────────────────────────────────────────────────────────────",
    "Usage: herdr-amq task <subcommand> [options]",
    "",
    "Commands:",
    "  list [--owner <h>] [--status <s>] [--json]   List all tasks",
    "  drain [--me <h>] [--claim] [--json]          Drain backlog tasks with full descriptions",
    "  next [--me <h>]                              Auto-claim and start next backlog task",
    "  create --title <t> [--owner <h>] [--desc <d>]  Open a card (alias of assign; owner defaults to --me)",
    "  assign --to <h> --title <t> [--desc <d>]     Assign a new task to an agent",
    "  claim <id> [--me <h>]                        Claim an existing task",
    "  heartbeat <id> [--me <h>]                    Record liveness without changing the card",
    "  reassign <id> --to <h> [--next-actor <h|none>] [--depends-on <id,...>|--clear-depends-on]",
    "                                            Change a card's owner, next actor or dependencies",
    "  comment <id> --text <text> [--me <h>]         Add a durable note without changing activity",
    "  done <id> [--me <h>] [--proof <evidence>]    Complete a task with proof",
    "  block <id> [--reason <r>] [--next-actor <h>] [--depends-on <id,...>]",
    "  show <id>                                    View task details and notes",
    "────────────────────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}

function failTask(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
  return false;
}

// `--depends-on a,b` -> ["a", "b"]. Returns null when the flag is absent so the
// caller can preserve whatever the card already recorded.
function listFlag(value) {
  if (value === undefined || value === true) return null;
  const items = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

// `--next-actor spotter` sets it; `--next-actor none` clears it; absent keeps it.
function nextActorFlag(value) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text || ["none", "null", "unknown", "unassigned"].includes(text.toLowerCase())) return null;
  return text;
}

// `--text @file` and `--reason @file` read the file, matching `amq send --body` and
// `amq reply --body`. A path that does not exist is an error rather than a literal
// "@/path" stored on the card and reported as success.
//
// `--proof @file` was NOT handled here, and it failed SILENTLY: the card was closed with
// the literal string "@/tmp/.../proof.txt" stored as its evidence, which reads like a
// reference and is not one. Two cards were closed that way before this was found. The
// expansion is silent-by-design for every other flag, so the gap was invisible from the
// card alone - which is the argument for checking what a card actually stores.
function expandAtFile(value, label) {
  if (typeof value !== "string" || !value.startsWith("@")) return { value };
  const filePath = value.slice(1);
  try {
    return { value: fs.readFileSync(filePath, "utf8") };
  } catch (error) {
    return { error: `${label} file could not be read: ${filePath} (${error.code || error.message})` };
  }
}

/**
 * CLI command handler for AGboard task management:
 *   herdr-amq task list [--owner <handle>] [--status <stage>] [--json]
 *   herdr-amq task assign --to <handle> --title <title> [--desc <desc>] [--status <stage>]
 *   herdr-amq task claim <id> [--me <handle>]
 *   herdr-amq task done <id> [--me <handle>] [--proof <proof>]
 *   herdr-amq task block <id> [--me <handle>] [--reason <reason>]
 *   herdr-amq task show <id>
 */
export function handleTaskCommand(subcommand = "list", rawArgs = []) {
  const amqRoot = findAmqRoot();
  if (!amqRoot) {
    console.error("❌ No active .agent-mail directory found.");
    process.exit(1);
  }

  const repoRoot = path.resolve(path.dirname(amqRoot));
  const { flags, positional } = parseTaskArgs(rawArgs);
  const me = flags.me || flags.from || process.env.AMQ_ME || "coordinator";

  // Help must be reachable, otherwise the unknown-subcommand diagnostic points at a
  // command that does not work. `task --help`, `task -h` and `task help` all print
  // the same list and exit 0.
  const requested = String(subcommand ?? "").trim();
  if (!requested || requested === "help" || requested === "-h" || requested === "--help" || (requested.startsWith("-") && !TASK_FLAGS[requested])) {
    console.log(taskUsage());
    return true;
  }

  const allowedFlags = TASK_FLAGS[requested];

  if (!allowedFlags) {
    return failTask(`Unknown task subcommand "${subcommand}". Run "herdr-amq task --help" for the supported commands.`);
  }
  const unknownFlags = Object.keys(flags).filter((flag) => !allowedFlags.has(flag));
  if (unknownFlags.length > 0) {
    return failTask(`Unknown option --${unknownFlags[0]} for "herdr-amq task ${subcommand}".`);
  }
  if (flags.help) {
    console.log(taskUsage());
    return true;
  }
  switch (subcommand) {
    case "list":
    case "ls": {
      const board = loadBoard(repoRoot, amqRoot);
      let allTasks = [];
      for (const [colName, list] of Object.entries(board.columns)) {
        for (const t of list) {
          allTasks.push({ ...t, column: colName });
        }
      }

      if (flags.owner) {
        allTasks = allTasks.filter((t) => t.owner?.toLowerCase() === flags.owner.toLowerCase());
      }
      if (flags.status) {
        allTasks = allTasks.filter((t) => t.status === flags.status);
      }

      if (flags.json) {
        console.log(JSON.stringify(allTasks, null, 2));
        return;
      }

      console.log(`\n📋 \x1b[1mAGboard Tasks\x1b[0m (${allTasks.length} total)`);
      console.log("────────────────────────────────────────────────────────────────────────────");

      if (allTasks.length === 0) {
        console.log("  (no matching tasks found)");
      }

      for (const t of allTasks) {
        let statusBadge = `[${t.status}]`;
        if (t.status === "in_progress") statusBadge = `\x1b[33m[in_progress]\x1b[0m`;
        else if (t.status === "blocked") statusBadge = `\x1b[31m[blocked]\x1b[0m`;
        else if (t.status === "done") statusBadge = `\x1b[32m[done]\x1b[0m`;
        else statusBadge = `\x1b[34m[backlog]\x1b[0m`;

        const idStr = `\x1b[90m${t.id.padEnd(20)}\x1b[0m`;
        const ownerStr = `\x1b[1m${(t.owner || "unassigned").padEnd(14)}\x1b[0m`;
        console.log(`  ${statusBadge.padEnd(22)} ${idStr} ${ownerStr} ${t.title}`);
      }
      console.log("────────────────────────────────────────────────────────────────────────────\n");
      break;
    }

    // `create` and `assign` are the same operation: open a card and give it an
    // owner. `assign` is the historical name; `create` is the coordinator-facing
    // spelling whose owner defaults to the caller. One implementation, so the two
    // names cannot drift apart.
    case "create":
    case "assign": {
      const isCreate = subcommand === "create" || subcommand === "new";
      const to = flags.to || flags.owner || (isCreate ? me : "");
      const title = flags.title || positional.join(" ");
      const descArg = flags.desc || flags.description || "";
      const desc = expandAtFile(descArg, "--desc");
      if (desc.error) return failTask(desc.error);

      if (!title || !title.trim()) {
        console.error(`❌ Task title is required: --title <title>`);
        process.exit(1);
      }
      if (!to || !to.trim()) {
        console.error(`❌ Target owner is required: --to <handle>`);
        process.exit(1);
      }

      let res;
      try {
        res = addBoardTask(repoRoot, amqRoot, {
          title,
          owner: to,
          status: flags.status || "backlog",
          description: desc.value || "",
          from: me,
          priority: flags.priority || undefined,
          depends_on: listFlag(flags["depends-on"]),
          next_actor: nextActorFlag(flags["next-actor"]),
          notify: flags.notify !== "false",
        });
      } catch (error) {
        return failTask(`Failed to write task: ${error.message}`);
      }

      if (!res.ok) {
        console.error(`❌ Failed to create task: ${res.error}`);
        process.exit(1);
      }
      if (flags.json) {
        console.log(JSON.stringify(res.task, null, 2));
        break;
      }
      console.log(`\n✅ \x1b[32mTask created and assigned to ${to}\x1b[0m (ID: ${res.task.id})`);
      if (res.task.next_actor) console.log(`Next actor: ${res.task.next_actor}`);
      if (res.task.depends_on?.length) console.log(`Depends on: ${res.task.depends_on.join(", ")}`);
      console.log(`Title: ${res.task.title}\n`);
      break;
    }

    case "claim": {
      const taskId = positional[0] || flags.id;
      if (!taskId) {
        console.error("❌ Task ID is required: herdr-amq task claim <taskId> [--me <handle>]");
        process.exit(1);
      }

      let res;
      try {
        res = updateBoardTask(
          repoRoot,
          amqRoot,
          taskId,
          { status: "in_progress", owner: me },
          { from: me, notify: flags.notify !== "false" }
        );
      } catch (error) {
        return failTask(`Failed to write task claim: ${error.message}`);
      }

      if (res.ok) {
        console.log(`\n🚀 \x1b[33mTask ${taskId} claimed by ${me}\x1b[0m (Status -> in_progress)`);
        console.log(`✉️ Notification dispatched to coordinator via AMQ.\n`);
      } else {
        console.error(`❌ Failed to claim task: ${res.error}`);
        process.exit(1);
      }
      break;
    }

    case "done":
    case "complete": {
      const taskId = positional[0] || flags.id;
      if (!taskId) {
        console.error("❌ Task ID is required: herdr-amq task done <taskId> [--proof <proof>]");
        process.exit(1);
      }

      const proofArg = flags.proof || flags.evidence || positional.slice(1).join(" ") || "";
      // Evidence is the one field that must never be a filename. A card closed with
      // "@some/path" stores a reference to evidence that is not on the card, and every
      // later reader sees a plausible-looking string instead of a missing proof.
      const proofExpanded = expandAtFile(proofArg, "--proof");
      if (proofExpanded.error) {
        return failTask(proofExpanded.error);
      }
      const proof = proofExpanded.value;
      let res;
      try {
        res = updateBoardTask(
          repoRoot,
          amqRoot,
          taskId,
          { status: "done" },
          { from: me, proof, notify: flags.notify !== "false" }
        );
      } catch (error) {
        return failTask(`Failed to write task completion: ${error.message}`);
      }

      if (res.ok) {
        console.log(`\n🎉 \x1b[32mTask ${taskId} marked as DONE\x1b[0m`);
        if (proof) console.log(`Evidence: ${proof}`);
        console.log(`✉️ Completion alert dispatched to coordinator via AMQ.\n`);
      } else {
        console.error(`❌ Failed to complete task: ${res.error}`);
        process.exit(1);
      }
      break;
    }

    case "block": {
      const taskId = positional[0] || flags.id;
      if (!taskId) {
        console.error("❌ Task ID is required: herdr-amq task block <taskId> --reason <reason>");
        process.exit(1);
      }

      const reasonArg = flags.reason || flags.desc || positional.slice(1).join(" ");
      const expandedReason = expandAtFile(reasonArg, "--reason");
      if (expandedReason.error) return failTask(expandedReason.error);
      const reason = (expandedReason.value ?? "").trim() || "Blocked";
      if (reason.length < 40) {
        // A silently invisible short reason is how blockers became un-actionable; a
        // warning is enough, the field is still written.
        console.warn(`⚠️  Reason is only ${reason.length} characters; a blocker that cannot name its actor and its way out is not triageable.`);
      }
      let res;
      try {
        res = updateBoardTask(
          repoRoot,
          amqRoot,
          taskId,
          {
            status: "blocked",
            next_actor: nextActorFlag(flags["next-actor"]),
            depends_on: listFlag(flags["depends-on"]) || undefined,
            priority: flags.priority || undefined,
          },
          { from: me, reason, notify: flags.notify !== "false" }
        );
      } catch (error) {
        return failTask(`Failed to write task block: ${error.message}`);
      }

      if (res.ok) {
        console.log(`\n⚠️ \x1b[31mTask ${taskId} marked as BLOCKED\x1b[0m`);
        console.log(`Reason: ${reason}`);
        console.log(`✉️ Urgent alert dispatched to coordinator via AMQ.\n`);
      } else {
        console.error(`❌ Failed to block task: ${res.error}`);
        process.exit(1);
      }
      break;
    }

    case "heartbeat": {
      const taskId = positional[0] || flags.id;
      if (!taskId) {
        console.error("❌ Task ID is required: herdr-amq task heartbeat <taskId> --me <handle>");
        process.exit(1);
      }
      // Deliberately not the defaulted `me`: that falls back to "coordinator", which
      // would attribute liveness to a handle that never sent it. A heartbeat without
      // an explicit actor is an error, so the actor is taken from --me/--from or
      // AMQ_ME and nothing else.
      const heartbeatActor = String(flags.me || flags.from || process.env.AMQ_ME || "").trim();
      if (!heartbeatActor) {
        console.error("❌ A heartbeat must name its actor: herdr-amq task heartbeat <taskId> --me <handle>");
        console.error("   A heartbeat is an accountable liveness claim; an unattributed one is rejected, not recorded as unknown.");
        process.exit(1);
      }
      let res;
      try {
        res = heartbeatBoardTask(repoRoot, amqRoot, taskId, { actor: heartbeatActor });
      } catch (error) {
        return failTask(`Failed to write task heartbeat: ${error.message}`);
      }
      if (!res.ok) {
        console.error(`❌ Failed to record heartbeat: ${res.error}`);
        process.exit(1);
      }
      console.log(`\n💓 Heartbeat recorded for task ${taskId} by ${res.actor} (liveness only; status, updated and claims unchanged).`);
      console.log(`Last heartbeat: ${res.last_heartbeat_at}`);
      console.log("──────────────────────────────────────────────");
      break;
    }

    case "reassign": {
      const taskId = positional[0] || flags.id;
      const to = flags.to || flags.owner;
      if (!taskId) {
        console.error("❌ Task ID is required: herdr-amq task reassign <taskId> --to <handle>");
        process.exit(1);
      }
      if (!to || !String(to).trim()) {
        console.error("❌ Target owner is required: herdr-amq task reassign <taskId> --to <handle>");
        process.exit(1);
      }

      // Owner, next actor and dependencies go in ONE checked write. They used to be
      // two writes with the second one's result ignored, so a failed metadata write
      // still printed "Task X reassigned to Y": a success line for a partial
      // result, leaving a card with an owner nobody asked for. One write makes that
      // failure mode impossible instead of merely detected.
      const updates = { owner: to };
      if (flags["next-actor"] !== undefined) updates.next_actor = nextActorFlag(flags["next-actor"]);
      if (flags["clear-depends-on"]) updates.depends_on = [];
      else if (flags["depends-on"] !== undefined) updates.depends_on = listFlag(flags["depends-on"]) || [];

      let res;
      try {
        res = updateBoardTask(repoRoot, amqRoot, taskId, updates, { from: me, notify: flags.notify !== "false" });
      } catch (error) {
        return failTask(`Failed to write task reassignment: ${error.message}`);
      }
      if (!res.ok) {
        console.error(`❌ Failed to reassign task: ${res.error}`);
        process.exit(1);
      }

      console.log(`\n🔀 Task ${taskId} reassigned to ${to}.`);
      if (res.task.next_actor) console.log(`Next actor: ${res.task.next_actor}`);
      if (res.task.depends_on?.length) console.log(`Depends on: ${res.task.depends_on.join(", ")}`);
      console.log("──────────────────────────────────────────────");
      break;
    }

    case "comment":
    case "note": {
      const taskId = positional[0] || flags.id;
      const textArg = flags.text || flags.note || positional.slice(1).join(" ");
      const expanded = expandAtFile(textArg, "--text");
      if (expanded.error) return failTask(expanded.error);
      const text = expanded.value;
      if (!taskId) {
        console.error("❌ Task ID is required: herdr-amq task comment <taskId> --text <text>");
        process.exit(1);
      }
      if (!text || !String(text).trim()) {
        console.error("❌ Note text is required: herdr-amq task comment <taskId> --text <text>");
        process.exit(1);
      }

      const res = appendBoardTaskNote(repoRoot, amqRoot, taskId, { text, author: me });
      if (!res.ok) {
        console.error(`❌ Failed to add note: ${res.error}`);
        process.exit(1);
      }
      console.log(`\n📝 Note added to task ${taskId} (activity timestamp unchanged).`);
      console.log("──────────────────────────────────────────────");
      break;
    }

    case "show": {
      const taskId = positional[0] || flags.id;
      if (!taskId) {
        console.error("❌ Task ID is required: herdr-amq task show <taskId>");
        process.exit(1);
      }

      const board = loadBoard(repoRoot, amqRoot);
      let found = null;
      for (const list of Object.values(board.columns)) {
        const m = list.find((t) => t.id === taskId);
        if (m) {
          found = m;
          break;
        }
      }

      if (!found) {
        console.error(`❌ Task ${taskId} not found.`);
        process.exit(1);
      }

      console.log(`\n📦 \x1b[1mTask Details: ${found.title}\x1b[0m`);
      console.log("──────────────────────────────────────────────");
      console.log(`ID:          ${found.id}`);
      console.log(`Owner:       ${found.owner}`);
      console.log(`Status:      ${found.status}`);
      console.log(`Source:      ${found.source || "custom"}`);
      if (found.priority) console.log(`Priority:    ${found.priority}`);
      if (found.created) console.log(`Created:     ${found.created}`);
      if (found.updated) console.log(`Updated:     ${found.updated}`);
      if (found.claimed_at) console.log(`Claimed:     ${found.claimed_at}`);
      if (found.blocked_at) console.log(`Blocked at:  ${found.blocked_at}`);
      if (found.done_at) console.log(`Done at:     ${found.done_at}`);
      if (found.last_heartbeat_at) console.log(`Heartbeat:   ${found.last_heartbeat_at}${found.last_heartbeat_by ? ` by ${found.last_heartbeat_by}` : ""}`);
      if (found.claims) console.log(`Claims:      ${found.claims}`);
      // Every field the CLI can write is rendered here. A field that is written but
      // not displayed is indistinguishable from a dropped write, which is how a
      // correct block reason came to be reported as lost.
      console.log(`Next actor:  ${found.next_actor || "(unset)"}`);
      console.log(`Depends on:  ${Array.isArray(found.depends_on) && found.depends_on.length ? found.depends_on.join(", ") : "(none)"}`);
      if (found.description) console.log(`Description: ${found.description}`);
      if (found.block_reason) {
        console.log(`Block reason: ${found.block_reason}`);
      } else if (found.status === "blocked") {
        console.log("Block reason: (none — UNTRIAGED; this card will raise blocked_cards)");
      }
      if (found.proof) console.log(`Proof:       ${found.proof}`);
      if (Array.isArray(found.notes) && found.notes.length > 0) {
        console.log(`Notes:      ${found.notes.length}`);
        for (const note of found.notes) {
          console.log(`  - [${note.at}] ${note.author}: ${note.text}`);
        }
      } else {
        console.log("Notes:      (none)");
      }
      console.log("──────────────────────────────────────────────\n");
      break;
    }

    case "drain": {
      const claim = Boolean(flags.claim || flags.autoClaim);
      let res;
      try {
        res = drainTasks(repoRoot, amqRoot, {
          me,
          claim,
          notify: flags.notify !== "false",
        });
      } catch (error) {
        return failTask(`Failed to write task drain: ${error.message}`);
      }

      if (flags.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(`\n📋 \x1b[1mTask Drain for ${me}\x1b[0m (${res.count} pending backlog task(s))`);
      console.log("────────────────────────────────────────────────────────────────────────────");

      if (res.activeTasks && res.activeTasks.length > 0) {
        for (const at of res.activeTasks) {
          console.log(`⚡ \x1b[33mActive task in progress (doing):\x1b[0m \x1b[1m${at.title}\x1b[0m (ID: ${at.id})`);
        }
        console.log("────────────────────────────────────────────────────────────────────────────");
      }

      if (res.tasks.length === 0) {
        console.log(`  (no pending backlog tasks assigned to ${me})`);
      } else {
        for (const t of res.tasks) {
          const isClaimed = res.claimedTask && res.claimedTask.id === t.id;
          const statusStr = isClaimed
            ? `\x1b[32m[CLAIMED -> in_progress]\x1b[0m`
            : `\x1b[34m[backlog]\x1b[0m`;

          console.log(`\n${statusStr} \x1b[1m${t.title}\x1b[0m (ID: \x1b[36m${t.id}\x1b[0m)`);
          if (t.created) console.log(`  Created: ${t.created}`);
          if (t.description) {
            console.log(`  Details:`);
            for (const line of t.description.split("\n")) {
              console.log(`    ${line}`);
            }
          }
        }

        console.log("\n────────────────────────────────────────────────────────────────────────────");
        if (res.claimedTask) {
          console.log(`🚀 \x1b[32mAuto-claimed task ${res.claimedTask.id} into doing/\x1b[0m (status: in_progress)`);
          console.log(`✉️ Notification dispatched to coordinator via AMQ.`);
        } else {
          console.log(`👉 \x1b[1mTo claim a task:\x1b[0m`);
          console.log(`   herdr-amq task claim ${res.tasks[0].id} --me ${me}`);
          console.log(`   or auto-claim next: herdr-amq task next --me ${me}`);
        }
      }
      console.log("────────────────────────────────────────────────────────────────────────────\n");
      break;
    }

    case "next": {
      handleTaskCommand("drain", [...rawArgs, "--claim"]);
      break;
    }

    default:
      return failTask(`Unknown task subcommand "${subcommand}".`);
  }
}

export function handleMailCommand(subcmd, args = []) {
  const action = subcmd || "help";

  if (action === "help" || action === "--help" || action === "-h" || (args && (args.includes("--help") || args.includes("-h")))) {
    console.log(`\n✉️  \x1b[1mAMQ Maildir Native Engine CLI\x1b[0m`);
    console.log("────────────────────────────────────────────────────────────────────────────");
    console.log("Usage: herdr-amq mail <command> [options]");
    console.log("       herdr-amq send --to <h> --subject <s> --body <b> [--attach <p>]");
    console.log("       herdr-amq reply --id <id> --body <b> [--attach <p>]");
    console.log("       herdr-amq drain --me <handle> [--include-body]");
    console.log("\nCommands:");
    console.log("  send --to <handle> --subject <subj> --body <text|@file> [--from <h>] [--attach <p>]");
    console.log("  reply --id <msg_id> --body <text|@file> [--from <h>] [--attach <p>]");
    console.log("  drain --me <handle> [--include-body]");
    console.log("────────────────────────────────────────────────────────────────────────────\n");
    return;
  }

  const amqRoot = findAmqRoot();
  if (!amqRoot) {
    console.error("❌ No .agent-mail queue found in workspace or current directory.");
    process.exit(1);
  }

  function getArg(flag, alias) {
    const idx = args.findIndex((a) => a === flag || (alias && a === alias));
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  }

  function getMultiArg(flag, alias) {
    const val = getArg(flag, alias);
    return val ? val.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }

  switch (action) {
    case "send": {
      const from = getArg("--from", "--me") || process.env.AM_ME || "coordinator";
      const to = getMultiArg("--to");
      const subject = getArg("--subject", "-s") || "(no subject)";
      const bodyArg = getArg("--body", "-b");
      let body = bodyArg || "";
      if (bodyArg && bodyArg.startsWith("@")) {
        const filePath = bodyArg.slice(1);
        if (fs.existsSync(filePath)) body = fs.readFileSync(filePath, "utf8");
      }
      const kind = getArg("--kind");
      const priority = getArg("--priority") || "normal";
      const attach = getMultiArg("--attach");

      if (!to.length) {
        console.error("❌ Missing required --to recipient.");
        process.exit(1);
      }

      try {
        const res = sendMaildirMessage(amqRoot, {
          from,
          to,
          subject,
          body,
          kind,
          priority,
          attachments: attach,
        });
        console.log(`✉️  Sent ${res.id} to ${to.join(", ")} (from: ${from}) [maildir native]`);
      } catch (err) {
        console.error(`❌ Send failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "reply": {
      const from = getArg("--from", "--me") || process.env.AM_ME;
      const id = getArg("--id");
      const bodyArg = getArg("--body", "-b");
      let body = bodyArg || "";
      if (bodyArg && bodyArg.startsWith("@")) {
        const filePath = bodyArg.slice(1);
        if (fs.existsSync(filePath)) body = fs.readFileSync(filePath, "utf8");
      }
      const attach = getMultiArg("--attach");

      if (!id) {
        console.error("❌ Missing required --id of message to reply to.");
        process.exit(1);
      }
      if (!from) {
        console.error("❌ Missing required --from / --me handle.");
        process.exit(1);
      }

      try {
        const res = replyMaildirMessage(amqRoot, {
          from,
          replyToId: id,
          body,
          attachments: attach,
        });
        console.log(`✉️  Replied ${res.id} to ${res.to.join(", ")} (in-reply-to: ${id}) [maildir native]`);
      } catch (err) {
        console.error(`❌ Reply failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "drain": {
      const me = getArg("--me", "--from") || process.env.AM_ME;
      if (!me) {
        console.error("❌ Missing required --me <handle>.");
        process.exit(1);
      }

      const includeBody = args.includes("--include-body");
      const drained = drainMaildir(amqRoot, me);
      if (!drained.length) {
        return;
      }

      console.log(`[AMQ] ${drained.length} new message(s) for ${me}:`);
      for (const m of drained) {
        const h = m.header || {};
        console.log(`\n- From: ${h.from}`);
        console.log(`  Thread: ${h.thread || ""}`);
        console.log(`  ID: ${m.id}`);
        console.log(`  Subject: ${h.subject || ""}`);
        console.log(`  Priority: ${h.priority || "normal"}`);
        if (h.kind) console.log(`  Kind: ${h.kind}`);
        console.log(`  Created: ${h.created || ""}`);
        if (includeBody && m.body) {
          console.log(`  Body:\n${m.body.trim()}`);
        }
      }
      console.log("");
      break;
    }

    default:
      console.log(`\n✉️  \x1b[1mAMQ Maildir Native Engine CLI\x1b[0m`);
      console.log("────────────────────────────────────────────────────────────────────────────");
      console.log("Usage: herdr-amq mail <command> [options]");
      console.log("\nCommands:");
      console.log("  send --to <handle> --subject <subj> --body <text|@file> [--from <h>] [--attach <p>]");
      console.log("  reply --id <msg_id> --body <text|@file> [--from <h>] [--attach <p>]");
      console.log("  drain --me <handle> [--include-body]");
      console.log("────────────────────────────────────────────────────────────────────────────\n");
      break;
  }
}

export function handleSkillCommand(args = []) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const skillFile = path.resolve(currentDir, "../skills/herdr-amq/SKILL.md");
  let content = "";
  if (fs.existsSync(skillFile)) {
    content = fs.readFileSync(skillFile, "utf-8");
  } else {
    console.error("❌ Skill file not found.");
    process.exit(1);
  }

  const installIndex = args.findIndex((a) => a === "--install" || a === "install" || a === "-i");
  if (installIndex !== -1) {
    let destDir = args[installIndex + 1];
    if (!destDir || destDir.startsWith("-")) {
      destDir = path.resolve(process.cwd(), ".opencode/skills/herdr-amq");
    } else {
      destDir = path.resolve(process.cwd(), destDir);
    }

    let targetFile;
    if (destDir.endsWith(".md")) {
      targetFile = destDir;
      destDir = path.dirname(destDir);
    } else {
      targetFile = path.join(destDir, "SKILL.md");
    }

    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(targetFile, content, "utf-8");
    console.log(`✅ Successfully installed herdr-amq skill to ${targetFile}`);
    return targetFile;
  }

  process.stdout.write(content + (content.endsWith("\n") ? "" : "\n"));
}

export function handleMigrateCommand(args = []) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
📦 AMQ Attachment Migration
──────────────────────────────────────────────
Usage: herdr-amq migrate [options]

Scan messages across all agent mailboxes and migrate legacy attachments into
immutable Content-Addressed Storage (CAS) blobs or pinned Git commits.

Options:
  --dry-run      Preview changes without modifying message files
  --verbose, -v  Log individual errors or details during processing
  --help, -h     Show this help message
`);
    return;
  }

  const amqRoot = findAmqRoot();
  if (!amqRoot) {
    console.error("❌ No active .agent-mail directory found.");
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose") || args.includes("-v");

  console.log("\n📦 \x1b[1mAMQ Attachment Migration\x1b[0m");
  console.log("──────────────────────────────────────────────");
  console.log(`AMQ Root: \x1b[36m${amqRoot}\x1b[0m`);
  console.log(`Mode:     ${dryRun ? "\x1b[33mDry Run (no changes written)\x1b[0m" : "\x1b[32mActive (in-place frontmatter migration)\x1b[0m"}`);
  console.log("──────────────────────────────────────────────\n");
  console.log("🔍 Scanning messages across all agent mailboxes...");

  const startTime = Date.now();
  const stats = migrateMessageAttachments(amqRoot, {
    dryRun,
    verbose,
    onProgress: (p) => {
      process.stdout.write(`\rProgress: ${p.current}/${p.totalScanned} messages processed...`);
    },
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stdout.write("\r" + " ".repeat(60) + "\r");

  console.log("✨ \x1b[1mMigration Summary:\x1b[0m");
  console.log(`   Total messages scanned:    ${stats.totalScanned.toLocaleString()}`);
  console.log(`   Already migrated:          ${stats.alreadyMigrated.toLocaleString()}`);
  console.log(`   Messages updated:          \x1b[32m${stats.migrated.toLocaleString()}\x1b[0m`);
  console.log(`   Git objects pinned:        \x1b[36m${stats.gitPinned.toLocaleString()}\x1b[0m`);
  console.log(`   CAS blobs stored:          \x1b[35m${stats.blobsStored.toLocaleString()}\x1b[0m`);
  if (stats.errors > 0) {
    console.log(`   Errors encountered:        \x1b[31m${stats.errors}\x1b[0m`);
  }
  console.log(`   Duration:                  ${durationSec}s`);
  console.log("\n✅ All messages are now self-contained with frozen/pinned attachments.\n");
  return stats;
}

export async function handleFleetCommand(subcommand = "status", rawArgs = []) {
  const amqRoot = findAmqRoot();
  if (!amqRoot) {
    console.error("❌ No active .agent-mail directory found.");
    process.exit(1);
  }
  const repoRoot = path.resolve(path.dirname(amqRoot));

  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(`
🚀 Herdr AMQ Fleet Management
──────────────────────────────────────────────
Usage: herdr-amq fleet <command> [options]

Commands:
  status, list     Show discovered fleet personas, worktrees, and Herdr status
  prepopulate      Create AMQ maildirs and worktrees for all fleet personas
  up               Launch missing agents and replace mismatched kinds
  down             Close fleet agent panes without removing worktrees

Options:
  --kind <kind>    Agent kind (default: agy for up, required for down)
  --agents <list>  Comma-separated handles to target (default: all)
  --no-replace     Refuse to replace agents running as another kind
  --dry-run        Preview actions without changing panes
  --help, -h       Show this help message
`);
    return;
  }

  if (subcommand === "status" || subcommand === "list") {
    const personas = discoverFleetPersonas(repoRoot);
    const herdrAgents = await getHerdrAgents();
    const liveMap = new Map(herdrAgents.map((a) => [a.name, a]));

    console.log(`\n🚀 \x1b[1mFleet Status & Personas (${personas.size} discovered)\x1b[0m`);
    console.log("────────────────────────────────────────────────────────────────────────────");
    for (const [handle, p] of personas.entries()) {
      const live = liveMap.get(handle);
      const liveBadge = live
        ? `\x1b[32m● ${live.agent || "unknown"} ${live.agent_status} (${live.pane_id})\x1b[0m`
        : `\x1b[90m○ offline\x1b[0m`;
      const wtExists = fs.existsSync(path.join(repoRoot, ".worktrees", handle));
      const wtBadge = wtExists ? "worktree: ok" : "\x1b[33mno worktree\x1b[0m";
      console.log(` • \x1b[1m${handle.padEnd(16)}\x1b[0m [${p.sourceType}] ${liveBadge.padEnd(30)} ${wtBadge}`);
      if (p.role) console.log(`   \x1b[90m↳ ${p.role.slice(0, 70)}\x1b[0m`);
    }
    console.log("────────────────────────────────────────────────────────────────────────────\n");
    return;
  }

  if (subcommand === "prepopulate") {
    console.log("\n📦 Prepopulating fleet personas and worktrees...");
    const results = prepopulateFleet(amqRoot, repoRoot);
    for (const r of results) {
      console.log(` • \x1b[1m${r.handle.padEnd(16)}\x1b[0m maildir: ${r.maildirOk ? "✓" : "✗"}  worktree: ${r.worktreeExisted ? "exists" : "created"}`);
    }
    console.log(`\n✅ Prepopulated ${results.length} fleet agents.\n`);
    return;
  }

  if (subcommand === "down") {
    const kindIdx = rawArgs.indexOf("--kind");
    const kind = kindIdx !== -1 && rawArgs[kindIdx + 1] ? rawArgs[kindIdx + 1] : null;
    const agentsIdx = rawArgs.indexOf("--agents");
    const agents = agentsIdx !== -1 && rawArgs[agentsIdx + 1] ? rawArgs[agentsIdx + 1] : null;
    const dryRun = rawArgs.includes("--dry-run");
    if (!kind) {
      console.error("❌ fleet down requires --kind <agy|opencode|pi>");
      process.exitCode = 1;
      return;
    }

    console.log(`\n🛑 \x1b[1mStopping Fleet via Herdr (kind: ${kind})\x1b[0m`);
    console.log("──────────────────────────────────────────────");
    if (dryRun) console.log("Mode: \x1b[33mDry Run (preview only)\x1b[0m\n");

    const res = await stopFleet(amqRoot, repoRoot, { kind, agents, dryRun });
    if (dryRun && res.wouldStop.length > 0) {
      console.log(`\x1b[33m⚡ Would stop (${res.wouldStop.length}):\x1b[0m ${[...new Set(res.wouldStop.map((entry) => entry.handle))].join(", ")}`);
    }
    if (res.stopped.length > 0) {
      console.log(`\x1b[32m✔ Stopped agents (${res.stopped.length}):\x1b[0m`);
      for (const entry of res.stopped) {
        console.log(`   • ${entry.handle} -> pane ${entry.paneId} (${entry.kind})`);
      }
    }
    if (res.skipped.length > 0) {
      console.log(`\x1b[33m↷ Skipped mismatched agents (${res.skipped.length}):\x1b[0m`);
      for (const entry of res.skipped) {
        console.log(`   • ${entry.handle}: ${entry.reason}`);
      }
    }
    if (res.failed.length > 0) {
      console.log(`\x1b[31m✖ Failed to stop:\x1b[0m`);
      for (const entry of res.failed) {
        console.log(`   • ${entry.handle} (${entry.paneId}): ${entry.error}`);
      }
    }
    console.log("\n✅ Fleet stop pass complete. Worktrees and maildirs were preserved.\n");
    return res;
  }

  if (subcommand === "up") {
    const kindIdx = rawArgs.indexOf("--kind");
    const kind = kindIdx !== -1 && rawArgs[kindIdx + 1] ? rawArgs[kindIdx + 1] : "agy";
    const agentsIdx = rawArgs.indexOf("--agents");
    const agents = agentsIdx !== -1 && rawArgs[agentsIdx + 1] ? rawArgs[agentsIdx + 1] : null;
    const dryRun = rawArgs.includes("--dry-run");
    const replace = !rawArgs.includes("--no-replace");

    console.log(`\n🚀 \x1b[1mLaunching Fleet via Herdr (kind: ${kind})\x1b[0m`);
    console.log("──────────────────────────────────────────────");
    if (dryRun) console.log("Mode: \x1b[33mDry Run (preview only)\x1b[0m\n");

    const res = await launchFleet(amqRoot, repoRoot, { kind, agents, dryRun, replace });
    if (res.alreadyRunning.length > 0) {
      console.log(`\x1b[36m● Already running (${res.alreadyRunning.length}):\x1b[0m ${res.alreadyRunning.join(", ")}`);
    }
    if (res.replaced.length > 0) {
      console.log(`\x1b[33m↻ Replaced mismatched agents (${res.replaced.length}):\x1b[0m`);
      for (const entry of res.replaced) {
        console.log(`   • ${entry.handle}: ${entry.fromKinds.join(", ")} -> ${kind}`);
      }
    }
    if (dryRun && res.wouldReplace.length > 0) {
      console.log(`\x1b[33m⚡ Would replace (${res.wouldReplace.length}):\x1b[0m ${res.wouldReplace.join(", ")}`);
    }
    if (dryRun && res.wouldLaunch.length > 0) {
      console.log(`\x1b[33m⚡ Would launch into Herdr (${res.wouldLaunch.length}):\x1b[0m ${res.wouldLaunch.join(", ")}`);
    }
    if (res.blocked.length > 0) {
      console.log(`\x1b[33m↷ Blocked mismatched agents (${res.blocked.length}):\x1b[0m`);
      for (const entry of res.blocked) {
        console.log(`   • ${entry.handle}: ${entry.reason}`);
      }
    }
    if (res.launched.length > 0) {
      console.log(`\x1b[32m✔ Launched agents (${res.launched.length}):\x1b[0m`);
      for (const l of res.launched) {
        console.log(`   • ${l.handle} -> pane ${l.paneId} (${l.kind})`);
      }
    }
    if (res.failed.length > 0) {
      console.log(`\x1b[31m✖ Failed to launch:\x1b[0m`);
      for (const f of res.failed) {
        console.log(`   • ${f.handle}: ${f.error}`);
      }
    }
    console.log("\n✅ Fleet launch pass complete.\n");
    return res;
  }

  console.error(`Unknown fleet command: ${subcommand}`);
  console.log("Run 'herdr-amq fleet --help' for usage.");
}

export async function handleBootstrapCommand(args = []) {
  const amqRoot = findAmqRoot();
  if (!amqRoot) {
    console.error("❌ No active .agent-mail directory found.");
    process.exit(1);
  }
  const repoRoot = path.resolve(path.dirname(amqRoot));

  console.log("\n🌟 \x1b[1mCold Start / Bootstrap Swarm\x1b[0m");
  console.log("──────────────────────────────────────────────");
  console.log("1. Prepopulating agent personas, maildirs & worktrees...");
  prepopulateFleet(amqRoot, repoRoot);

  console.log("2. Launching fleet into Herdr panes...");
  await handleFleetCommand("up", args);

  console.log("3. Ensuring AMQ Doorbell Bridge daemon is active...");
  handleStart();

  console.log("4. Performing initial doorbell sweep...");
  handleDoorbell();

  console.log("\n🚀 \x1b[32mSwarm is live and operational!\x1b[0m\n");
}


