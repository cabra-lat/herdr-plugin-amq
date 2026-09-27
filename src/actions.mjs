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
import { describeCaller, recordStopAttempt, readStopLog } from "./stop-attribution.mjs";
import {
  getUnregisteredDaemon,
  isDaemonRunning,
  startDaemonBackground,
  stopDaemon,
  runDoorbellPass,
  listInbox,
} from "./bridge.mjs";
import { loadTransportIdentities } from "./store.mjs";
import { healFleet } from "./fleet-heal.mjs";
import {
  loadBoard,
  addBoardTask,
  updateBoardTask,
  appendBoardTaskNote,
  heartbeatBoardTask,
  reassignBoardTask,
  deleteBoardTask,
  drainTasks,
  getBoardTask,
  canonicalizeOwner,
} from "./board.mjs";
import {
  sendMaildirMessage,
  replyMaildirMessage,
  drainMaildir,
  readMaildirMessages,
  commitMaildirMessages,
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
  const transportIdentities = amqRoot ? loadTransportIdentities(amqRoot) : [];
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
  }

  // The label above says REGISTERED, so the list under it has to be the registered set and not
  // every directory that has ever been addressed. `getAgentHandles` is the addressable set, and
  // it contained `board` (a sender identity) and `worker` (a probe mailbox) on the live tree.
  // They are listed separately and labelled, rather than dropped: unread mail in them is real
  // and a reader who cannot account for it will assume it is being hidden from them.
  let transportTotal = 0;
  for (const t of transportIdentities) {
    transportTotal += t.inboxMessages;
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
  if (transportIdentities.length) {
    console.log(`\x1b[1mMailboxes that are not agents (${transportIdentities.length}):\x1b[0m`);
    for (const t of transportIdentities) {
      const detail = [
        t.sentMessages ? `${t.sentMessages} sent` : null,
        t.inboxMessages ? `${t.inboxMessages} unread` : null,
      ].filter(Boolean).join(", ") || "empty";
      console.log(`  • \x1b[90m${t.handle.padEnd(16)}\x1b[0m \x1b[90m${detail} — addressable, not a teammate\x1b[0m`);
    }
  }
  console.log(`Total Unread: ${totalUnread + transportTotal}`);
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
  // Record BEFORE stopping: once the daemon is gone, the context worth having is exactly
  // what can no longer be read.
  recordStopAttempt({ ...describeCaller({ source: "cli:stop" }), outcome: "requested" });
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

export function handleStartup() {  const amqRoot = findAmqRoot();
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
  claim: new Set(["id", "notify", "me", "from", "force", "help"]),
  // `--reason` exists so a card can be completed FROM `blocked`: leaving blocked is an edge
  // and every edge is narrated. Without it the core guard refuses the exit and the only way
  // out would be a manufactured intermediate stage.
  done: new Set(["id", "proof", "evidence", "reason", "notify", "me", "from", "help"]),
  complete: new Set(["id", "proof", "evidence", "reason", "notify", "me", "from", "help"]),
  block: new Set(["id", "reason", "desc", "next-actor", "depends-on", "priority", "notify", "me", "from", "help"]),
  // The stage is REQUIRED and has no default. Defaulting an unblock to in_progress is the
  // same class of assumption as defaulting next_actor to owner: it invents a decision the
  // person leaving the block did not make. doing = picking it up now, queued = scheduled
  // behind other work, backlog = nobody is coming back to it.
  unblock: new Set(["id", "reason", "stage", "next-actor", "priority", "notify", "me", "from", "help"]),
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
    "  block <id> --reason <r> [--next-actor <h>] [--depends-on <id,...>]",
    "  unblock <id> --stage <doing|queued|backlog> --reason <r>",
    "                                            Leave `blocked`. --stage has NO default:",
    "                                            doing=pick it up now, queued=scheduled behind",
    "                                            other work, backlog=nobody is coming back.",
    "                                            The reason is kept as a note; block_reason is",
    "                                            cleared, because the card is no longer blocked.",
    "  done <id> [--me <h>] [--proof <evidence>] [--reason <r>]",
    "                                            Complete a task. --reason is required to",
    "                                            complete a card that is currently blocked.",
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
  // NO FALLBACK TO ANOTHER HANDLE. This read `|| "coordinator"`, so a write subcommand run
  // with no --me recorded `coordinator` as the actor: claim, block, done, unblock, reassign
  // and comment all stamped a lane that was not the one doing the work. The same silent
  // attribution substitution fixed in `mail send` at line 947, one surface over.
  //
  // Read-only subcommands (list, ls, show, drain, next) never used `me` for anything, so they
  // are unaffected and must keep working without --me. Only the subcommands that actually
  // WRITE an actor require one, and they require it loudly rather than guessing.
  const me = flags.me || flags.from || process.env.AMQ_ME;
  const TASK_WRITE_SUBCOMMANDS = new Set([
    "create", "assign", "claim", "done", "complete", "unblock",
    "block", "heartbeat", "reassign", "comment", "note",
  ]);
  // Subcommands that take a task id as their first positional, and report a missing one
  // themselves. The actor guard DEFERS to that check: an earlier version fired first and
  // turned "task assign" with no id into "needs an actor", which masks the more useful
  // diagnostic. A caller who omitted the id must be told about the id.
  const TASK_ID_SUBCOMMANDS = new Set([
    "claim", "done", "complete", "unblock", "block", "reassign", "comment", "note",
  ]);
  // The same rule applies to a subcommand's OWN required flags, and the first version of this
  // guard got that wrong too: it deferred to the missing-task-id diagnostic but not to the
  // missing-flag one, so `task unblock <id>` with no --reason and no --me reported "needs an
  // actor" and masked "--reason is required". A caller who omitted the reason must be told
  // about the reason. Keys are flag names as parseTaskArgs returns them, without the dashes.
  const TASK_REQUIRED_FLAGS = {
    unblock: ["stage", "reason"],
    block: ["reason"],
    reassign: ["to"],
  };
  const sub = String(subcommand ?? "").trim();
  const missingRequiredFlag = (TASK_REQUIRED_FLAGS[sub] ?? []).some((f) => !flags[f]);
  const argumentErrorWins =
    (TASK_ID_SUBCOMMANDS.has(sub) && !positional[0]) || missingRequiredFlag;
  if (!me && TASK_WRITE_SUBCOMMANDS.has(sub) && !argumentErrorWins) {
    // Name the variable THIS command actually reads. `task` reads AMQ_ME and `mail send`
    // reads AM_ME; an error message that names the wrong one sends the caller to fix an
    // export that changes nothing, and it is the same absent-key class as the rest of this:
    // a message that looks authoritative and does not describe the thing it is about.
    const actorVar = "AMQ_ME";
    console.error(`❌ task ${subcommand} needs an actor: pass --me <handle> or set ${actorVar}.`);
    console.error("   Refusing rather than recording a default lane: a wrong actor here is");
    console.error("   written into the card and read back by every other agent as fact.");
    process.exitCode = 1;
    return 1;
  }

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

      // WHAT THE CARD LOOKS LIKE BEFORE WE TOUCH IT, because whether this command did
      // anything is not a property of its exit code.
      //
      // The board layer is correct and was not the bug: `updated` moves only when the card
      // actually changed, and the claim notification is gated on a real status transition. But
      // this command printed its success from `res.ok`, which is true whenever the write
      // succeeded - INCLUDING when it wrote back identical values. Measured on a live card at
      // 00:12Z, re-claiming my own in-progress card printed
      //   "claimed by agsuite-dev (Status -> in_progress)" and
      //   "Notification dispatched to coordinator via AMQ."
      // while `Updated` stayed at 22:48:37.566Z, `Claims` stayed at 1, and no message reached
      // coordinator at all. So the transition and the notification were both fiction.
      //
      // Why that is worse than a cosmetic lie: the stall doorbell tells an agent that claiming
      // is one of the four ways to move a stalled card. An agent that follows the instruction,
      // sees success, and watches the number not move has been told to do something useless by
      // the tool that raised the alarm. And because the message reads as a claim, the attempt
      // looks like progress in the lane's own history.
      const located = getBoardTask(repoRoot, amqRoot, taskId);
      const existing = located?.task || null;
      if (!existing) {
        return failTask(`Task not found: ${taskId}. Nothing was claimed and no notification was sent.`);
      }

      const currentOwner = canonicalizeOwner(existing.owner || "");
      const heldByMe = currentOwner === me;
      const alreadyInProgress = String(existing.status || "").replace(/-/g, "_") === "in_progress"
        || String(existing.status || "") === "doing";
      // HELD is not the same as ASSIGNED, and conflating them was the first bug in this guard:
      // it refused any card with an owner, which made an ordinary unstarted backlog card
      // unclaimable by anyone but its assignee - and picking up unstarted work is the normal
      // path, not a theft. A card is held once it has been CLAIMED (claimed_at is set) or is
      // already in progress. Before that it is merely addressed to somebody, and the owner field
      // records who the work belongs to, not who is holding it.
      const everClaimed = Boolean(existing.claimed_at);
      const held = everClaimed || alreadyInProgress;

      // A claim that would take a card another lane is actually holding is a REASSIGNMENT
      // wearing a claim's clothes, and the board will happily overwrite the owner. It refuses
      // unless the operator says so explicitly, for the same reason `fleet up --replace` is
      // opt-in: the destructive direction is never inferred.
      if (held && !heldByMe && currentOwner && !flags.force) {
        console.error(`❌ Task ${taskId} is already claimed by ${currentOwner} (status: ${existing.status}).`);
        console.error(`   Nothing was written and no notification was sent. A claim does not take a card from another lane.`);
        console.error(`   Reassign it on purpose:  herdr-amq task reassign ${taskId} --me ${me} --to ${me} --reason "<why>"`);
        console.error(`   Or override the guard:  herdr-amq task claim ${taskId} --me ${me} --force`);
        process.exit(1);
      }

      // The transition that will ACTUALLY happen. A fresh claim on a card this lane does not
      // already hold in progress is the only thing that moves claimed_at, the claim count and
      // the state clock - see `enteringProgress` in updateBoardTask, which is gated on the
      // status genuinely changing.
      const performedClaim = !heldByMe || !alreadyInProgress;
      const takingFrom = performedClaim && held && !heldByMe && currentOwner ? currentOwner : null;

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

      if (!res.ok) {
        console.error(`❌ Failed to claim task: ${res.error}`);
        process.exit(1);
      }

      if (performedClaim) {
        console.log(`\n🚀 \x1b[33mTask ${taskId} claimed by ${me}\x1b[0m (Status -> in_progress)`);
        if (takingFrom) {
          console.log(`\x1b[33m⚠️  Taken from ${takingFrom} via --force.\x1b[0m`);
        }
        console.log(`✉️ Notification dispatched to coordinator via AMQ.\n`);
      } else {
        // The truth, including the part that is inconvenient: this did not move the card, and
        // claiming again is not a remedy for a stall. Saying so is the whole fix - a command
        // that reports a no-op honestly is debuggable, and one that reports a phantom
        // transition sends the next lane looking for a change that was never made.
        console.log(`\nℹ️  Task ${taskId} is already claimed by you and already in_progress.`);
        console.log(`   Nothing changed: the claim record, the claim count (${existing.claims ?? 0}) and the`);
        console.log(`   state clock (updated ${existing.updated}) are all exactly as they were.`);
        console.log(`   No notification was sent, because no claim happened.`);
        console.log(`   \x1b[33mClaiming again does NOT clear a stall\x1b[0m - the stall ages the state clock, and only a`);
        console.log(`   real change moves it. To move this card: re-scope it, block it with a reason,`);
        console.log(`   or close it with --proof.`);
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
          { from: me, proof, reason: (flags.reason || "").trim() || undefined, notify: flags.notify !== "false" }
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

    case "unblock": {
      const taskId = positional[0] || flags.id;
      if (!taskId) {
        console.error("❌ Task ID is required: herdr-amq task unblock <taskId> --stage <doing|queued|backlog> --reason <reason>");
        process.exit(1);
      }

      // No default, on purpose. See the verb's flag set.
      const stageArg = String(flags.stage || "").trim();
      if (!stageArg) {
        console.error(
          "❌ --stage is required: herdr-amq task unblock <taskId> --stage <doing|queued|backlog> --reason <reason>\n" +
          "   A card coming off a block is `doing` if it is being picked up now, `queued` if it is\n" +
          "   scheduled behind other work, and `backlog` if nobody is coming back to it. There is no\n" +
          "   default because choosing one here would record a decision you did not make."
        );
        process.exit(1);
      }
      const STAGE_ALIASES = { doing: "in_progress", in_progress: "in_progress", queued: "queued", backlog: "backlog" };
      const stage = STAGE_ALIASES[stageArg];
      if (!stage) {
        console.error(`❌ Unrecognised --stage ${JSON.stringify(stageArg)}. Legal values: doing, queued, backlog.`);
        process.exit(1);
      }

      const reasonArg = flags.reason || positional.slice(1).join(" ");
      const expandedReason = expandAtFile(reasonArg, "--reason");
      if (expandedReason.error) return failTask(expandedReason.error);
      const reason = (expandedReason.value ?? "").trim();
      if (!reason) {
        console.error(
          "❌ --reason is required: leaving `blocked` is an edge, and an edge without narration\n" +
          "   is an edge that gets walked without narration. Say what resolved the block."
        );
        process.exit(1);
      }

      let res;
      try {
        res = updateBoardTask(
          repoRoot,
          amqRoot,
          taskId,
          {
            status: stage,
            next_actor: nextActorFlag(flags["next-actor"]),
            priority: flags.priority || undefined,
          },
          { from: me, reason, notify: flags.notify !== "false" }
        );
      } catch (error) {
        return failTask(`Failed to write task unblock: ${error.message}`);
      }

      if (res.ok) {
        const done = res.task || res;
        console.log(`\n✅ \x1b[32mTask ${taskId} unblocked → ${done.stage || stage}\x1b[0m`);
        console.log(`Reason: ${reason}`);
        console.log(`\x1b[2mRecorded as a note; the reason field is cleared because the card is no longer blocked.\x1b[0m\n`);
      } else {
        console.error(`❌ Failed to unblock task: ${res.error}`);
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
      // No synthetic default. The core now requires a real reason to enter `blocked`, and a
      // literal "Blocked" would satisfy that guard while carrying no information - which is
      // the same hole the guard was added to close.
      const reason = (expandedReason.value ?? "").trim();
      if (!reason) {
        console.error(
          "❌ --reason is required: herdr-amq task block <taskId> --reason <reason>\n" +
          "   The reason is the narration of the edge. A blocker that cannot say what it is\n" +
          "   waiting on is indistinguishable from one nobody has triaged."
        );
        process.exit(1);
      }
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

/**
 * Write everything to stdout synchronously, reporting whether all of it landed.
 *
 * Returns false on a failed or partial write. A short write means the reader went away,
 * which means the content was NOT fully shown - and an unshown message must not be
 * marked consumed. Node's process.stdout.write cannot answer this question: to a pipe
 * it is asynchronous, so EPIPE arrives as a later stream event rather than a throw, and
 * a try/catch around it never fires.
 */
function writeAllToStdout(text) {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  try {
    while (offset < buffer.length) {
      offset += fs.writeSync(process.stdout.fd, buffer, offset, buffer.length - offset);
    }
    return true;
  } catch (error) {
    if (error && error.code === "EPIPE") return false;
    if (error && (error.code === "EAGAIN" || error.code === "EINTR")) return true;
    throw error;
  }
}

export function handleMailCommand(subcmd, args = []) {
  const action = subcmd || "help";

  if (action === "help" || action === "--help" || action === "-h" || (args && (args.includes("--help") || args.includes("-h")))) {
    console.log(`\n✉️  \x1b[1mAMQ Maildir Native Engine CLI\x1b[0m`);
    console.log("────────────────────────────────────────────────────────────────────────────");
    console.log("Usage: herdr-amq mail <command> [options]");
    // The usage lines carry the SAME `[--attach <p>]...` as the command list below. They were
    // left singular while the command list was corrected, so a reader who read only the top of
    // the help still learned that repeats are dropped. A flag is documented in every place it
    // appears or it is documented wrongly somewhere.
    console.log("       herdr-amq send --to <h> --subject <s> --body <b> [--attach <p>]...");
    console.log("       herdr-amq reply --id <id> --body <b> [--attach <p>]...");
    console.log("       herdr-amq drain --me <handle> [--include-body]");
    console.log("\nCommands:");
    // --attach REPEATS. The parser accumulates repeated flags and also accepts a
    // comma-separated list; the help used to say `[--attach <p>]`, singular, which is the
    // same defect in the other direction: a documented flag that silently drops repeats.
    // 9816c9c fixed the behaviour, and the documentation was what was left wrong.
    console.log("  send --to <handle> --subject <subj> --body <text|@file> [--from <h>] [--attach <p>]...");
    console.log("  reply --id <msg_id> --body <text|@file> [--from <h>] [--attach <p>]...");
    console.log("    --attach may be repeated, or given comma-separated. Every value is delivered.");
    console.log("    --from defaults to AM_ME. Without either, the send is refused, never attributed");
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

  // A REPEATED flag used to be silently truncated to its first occurrence, because this
  // called getArg(), which does findIndex and takes one value. `send --attach a --attach b
  // --attach c` therefore delivered ONE file, reported success and exited 0, and `--to` had
  // the same defect, which is worse: a silently dropped RECIPIENT. Both forms are accepted
  // now: repeated flags, and the pre-existing comma-separated form.
  function getMultiArg(flag, alias) {
    const values = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== flag && !(alias && args[i] === alias)) continue;
      const value = args[i + 1];
      // A flag with nothing after it is a caller error, not an empty list entry. Skipping
      // it silently would repeat the defect this function exists to remove.
      if (value === undefined || value.startsWith("--")) {
        console.error(`❌ ${flag} was given with no value. Nothing was sent.`);
        process.exit(1);
      }
      values.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
      i++; // consume the value so it is not re-read as a flag
    }
    return values;
  }

  // A SUCCESS SIGNAL THAT DOES NOT DEPEND ON THE THING IT REPORTS, third instance in this
  // codebase after godot-lock.sh's "lock acquired" and a gate printing "bot_direction ? checks".
  // The cost is always the same: the sender concludes the payload went, and the recipient has a
  // subset. So the count is stated, and a file that is not there stops the send.
  function attachmentCountLabel(count) {
    return `${count} attachment${count === 1 ? "" : "s"}`;
  }

  // Validated BEFORE anything is sent, because a partial send that reports success is the exact
  // failure: the other files arrive, the missing one does not, and the sender is told it worked.
  // A file that cannot be read is a caller error, and like the valueless-flag case above it exits
  // non-zero rather than delivering a bundle with a hole in it.
  function requireReadableAttachments(attach) {
    const missing = attach.filter((p) => {
      try {
        return !fs.statSync(p).isFile();
      } catch {
        return true;
      }
    });
    if (missing.length === 0) return;
    console.error(
      `❌ ${missing.length} of ${attach.length} attached file(s) could not be read, so NOTHING was sent:\n` +
      missing.map((p) => `     ${p}`).join("\n")
    );
    process.exit(1);
  }

  switch (action) {
    case "send": {
      // NO FALLBACK TO ANOTHER HANDLE. This used to be
      //   || process.env.AM_ME || "coordinator"
      // which meant that with AM_ME unset and --from omitted, a lane sent mail that was
      // delivered, reported success, and was attributed to `coordinator`. The sender never
      // learned it had spoken as somebody else.
      //
      // That is worse than losing an attachment, because attribution is what every
      // coordination decision here rests on: cards are claimed against a sender, replies go
      // to whoever sent something, and the wrong lane is judged on the content. And the
      // failure is self-concealing, because the send SUCCEEDED.
      //
      // Resolve to this process's own identity when it can be determined, and fail loudly
      // with the name of the missing variable when it cannot. Mirrors the `mail reply`
      // guard below, which already had this shape and is correct.
      const from = getArg("--from", "--me") || process.env.AM_ME;
      if (!from) {
        console.error("❌ Missing required --from / --me handle.");
        console.error("   Refusing to send rather than guess: a defaulted sender would attribute this");
        console.error("   message to another lane, and a successful send would hide that.");
        console.error("   Set --from <handle>, or export AM_ME, and try again.");
        process.exitCode = 1;
        return 1;
      }
      const to = getMultiArg("--to");
      const subject = getArg("--subject", "-s") || "(no subject)";
      const bodyArg = getArg("--body", "-b");
      let body = bodyArg || "";
      // `@file` is RESOLVED OR REFUSED. This used to be `if (existsSync) body = read(...)`,
      // which meant an unreadable path fell through with the literal "@/no/such/file" still in
      // `body` - and the message was delivered, with a receipt, a message id and exit 0. The
      // recipient got a pathname. That is a SUCCESS SIGNAL THAT DOES NOT DEPEND ON THE THING IT
      // REPORTS, the same class as the --attach partial send, and the operations reference used
      // to LICENSE it: "a literal string or @file is used as-is". A documented permission is a
      // mechanism, so the doc was corrected first and the code second; expandAtFile has always
      // failed closed and was simply not used on this path.
      if (typeof bodyArg === "string" && bodyArg.startsWith("@")) {
        const expanded = expandAtFile(bodyArg, "--body");
        if (expanded.error) {
          console.error(`❌ ${expanded.error}. Nothing was sent.`);
          process.exit(1);
        }
        body = expanded.value;
      }
      const kind = getArg("--kind");
      const priority = getArg("--priority") || "normal";
      const attach = getMultiArg("--attach");

      if (!to.length) {
        console.error("❌ Missing required --to recipient.");
        process.exit(1);
      }
      requireReadableAttachments(attach);

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
        // The count is part of the receipt, not a nicety: "Sent" alone is what let a dropped file
        // pass for a delivered one.
        console.log(`✉️  Sent ${res.id} to ${to.join(", ")} (from: ${from}) [maildir native]` +
          (attach.length ? ` [${attachmentCountLabel(attach.length)}]` : ""));
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
      // Same fail-closed contract as `send`, and the coordinator flagged that they had NOT tested
      // `mail reply` because it may take a different path. It took the same path, with the same
      // bug: an unreadable @file left the literal "@path" as the body and reported success. A
      // reply that ships a pathname is worse than a send that does, because it also lands in a
      // thread as if it were an answer.
      if (typeof bodyArg === "string" && bodyArg.startsWith("@")) {
        const expanded = expandAtFile(bodyArg, "--body");
        if (expanded.error) {
          console.error(`❌ ${expanded.error}. Nothing was sent.`);
          process.exit(1);
        }
        body = expanded.value;
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
      requireReadableAttachments(attach);

      try {
        const res = replyMaildirMessage(amqRoot, {
          from,
          replyToId: id,
          body,
          attachments: attach,
        });
        console.log(`✉️  Replied ${res.id} to ${res.to.join(", ")} (in-reply-to: ${id}) [maildir native]` +
          (attach.length ? ` [${attachmentCountLabel(attach.length)}]` : ""));
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
      // NOT CONSUMED UNLESS ASKED. Two fixes were tried before this one, and both were
      // wrong in instructive ways.
      //
      // First: promote only after a successful write. It still consumed everything
      // under `| head -3`, because a successful write to a pipe proves the READER
      // accepted the bytes, not that anyone saw them - head accepts all 118KB and then
      // discards it. No error occurs, so no write check can detect it.
      //
      // Second: detect EPIPE with fs.writeSync instead of process.stdout.write. That
      // made a full drain silently consume NOTHING (the helper was not even defined,
      // because a patch script reported success while half its edits failed to match).
      //
      // So the hazard is not a write failure at all: a pipe cannot report that its
      // consumer threw the data away. The only sound rule is that consuming is a
      // deliberate act by the owner, never a side effect of looking.
      const consume = args.includes("--consume");
      const waiting = readMaildirMessages(amqRoot, me);
      if (!waiting.length) {
        return;
      }

      const out = [];
      out.push(`[AMQ] ${waiting.length} new message(s) for ${me}:`);
      for (const m of waiting) {
        const h = m.header || {};
        out.push(`\n- From: ${h.from}`);
        out.push(`  Thread: ${h.thread || ""}`);
        out.push(`  ID: ${m.id}`);
        out.push(`  Subject: ${h.subject || ""}`);
        out.push(`  Priority: ${h.priority || "normal"}`);
        if (h.kind) out.push(`  Kind: ${h.kind}`);
        out.push(`  Created: ${h.created || ""}`);
        if (includeBody && m.body) {
          out.push(`  Body:\n${m.body.trim()}`);
        }
      }
      out.push("");

      if (!writeAllToStdout(out.join("\n"))) {
        console.error("❌ Could not write drained messages; nothing was consumed. Re-run to read them.");
        process.exit(1);
      }
      if (consume) {
        commitMaildirMessages(amqRoot, me, waiting);
      } else {
        // The notice ALONE. The first version pushed it onto `out` and wrote that buffer
        // again, which reprinted every message in full: one file on disk, printed twice
        // in a single pass. That is worse than a cosmetic slip, because a message
        // appearing twice in a drain is indistinguishable from a message delivered
        // twice - exactly the ambiguity that made a mis-diagnosis look confirmed for an
        // hour.
        writeAllToStdout(
          `  (not consumed: ${waiting.length} message(s) still in new/. Re-run with --consume to mark them read.)\n`,
        );
      }
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
  heal             Wire up agents that exist but are not in the roster
  up               Launch missing agents and replace mismatched kinds
  down             Close fleet agent panes without removing worktrees

Options:
  --kind <kind>    Agent kind (default: agy for up, required for down)
  --agents <list>  Comma-separated handles to target (default: all)
  --replace         Replace agents running as another kind (destructive, opt-in)
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

  if (subcommand === "heal") {
    const dryRun = rawArgs.includes("--dry-run") || rawArgs.includes("-n");
    const res = healFleet({ amqRoot, repoRoot, dryRun });
    if (!res.ok) {
      console.error(`❌ heal failed: ${res.error}`);
      process.exit(1);
    }
    const { rosterAdded, panesRenamed, registered, skipped } = res.actions;
    const total = rosterAdded.length + panesRenamed.length + registered.length;
    const prefix = res.dryRun ? "\x1b[90m[DRY RUN]\x1b[0m" : "";
    console.log(`\n🩹 \x1b[1mFleet heal${res.dryRun ? " (dry run)" : ""}\x1b[0m`);
    console.log("──────────────────────────────────────────────────────────────────────────────");
    console.log(`  ${res.observedOpenHandles.length} tab(s) open: ${res.observedOpenHandles.join(", ") || "none"}`);
    for (const h of rosterAdded) {
      console.log(`  ${prefix} roster   + ${h}`);
    }
    for (const p of panesRenamed) {
      console.log(`  ${prefix} pane     rename ${p.paneId} -> '${p.handle}'  \x1b[90m(was: ${(p.title || "").slice(0, 40)})\x1b[0m`);
    }
    for (const h of registered) {
      console.log(`  ${prefix} register   + ${h}`);
    }
    for (const s of skipped) {
      console.log(`  \x1b[33mskipped  ${s.what}: ${s.reason}\x1b[0m`);
    }
    if (total === 0) {
      console.log("  \x1b[32mnothing to heal — every open agent is already wired\x1b[0m");
    }
    if (rosterAdded.length && !res.dryRun) {
      console.log(`  \x1b[90mroster: ${res.rosterPath}\x1b[0m`);
    }
    console.log("──────────────────────────────────────────────────────────────────────────────\n");
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
  // Replacement is OPT-IN. It used to be the default, which meant a plain `fleet up` closed
  // running agents - how the user lost a fleet's in-flight context on 2026-09-26, with the
  // command reporting success while it happened. The user chose this on 2026-09-27 and confirmed
  // no scripts rely on the old behaviour.
  //
  // `--no-replace` is still accepted and now means the same as omitting `--replace`, i.e. the
  // default. It is kept so an old invocation does not become an unknown-flag failure and so the
  // flag people already reach for keeps working - but it is no longer what makes the command
  // safe, because the safe direction no longer needs a flag.
  const replace = rawArgs.includes("--replace");

    console.log(`\n🚀 \x1b[1mLaunching Fleet via Herdr (kind: ${kind})\x1b[0m`);
    console.log("──────────────────────────────────────────────");
    if (dryRun) console.log("Mode: \x1b[33mDry Run (preview only)\x1b[0m\n");

    const res = await launchFleet(amqRoot, repoRoot, { kind, agents, dryRun, replace });
    // The header shows the fleet-wide DEFAULT, which after per-agent kinds is no longer the whole
    // story: one line per agent, so a brief that declared its own kind is visible rather than
    // inferred. Without this the output says "kind: agy" above a fleet where one agent was
    // launched as something else, which is the kind of summary that is technically accurate and
    // practically misleading.
    if (res.kinds && Object.keys(res.kinds).length > 0) {
      const spread = new Set(Object.values(res.kinds));
      if (spread.size > 1) {
        console.log(`\x1b[90mResolved per agent:\x1b[0m ${Object.entries(res.kinds).map(([h, k]) => `${h}=${k}`).join(", ")}`);
      } else if (res.kinds[Object.keys(res.kinds)[0]] !== kind) {
        console.log(`\x1b[90mResolved per agent:\x1b[0m every target overrides --kind (${Object.values(res.kinds)[0]})`);
      }
    }
    if (res.alreadyRunning.length > 0) {
      console.log(`\x1b[36m● Already running (${res.alreadyRunning.length}):\x1b[0m ${res.alreadyRunning.join(", ")}`);
    }
    if (res.replaced.length > 0) {
      console.log(`\x1b[33m↻ Replaced mismatched agents (${res.replaced.length}):\x1b[0m`);
      for (const entry of res.replaced) {
        console.log(`   • ${entry.handle}: ${entry.fromKinds.join(", ")} -> ${res.kinds?.[entry.handle] ?? kind}`);
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


