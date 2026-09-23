import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findAmqRoot,
  getAgentHandles,
  getStateDir,
  getConfigDir,
  getEventContext,
} from "./config.mjs";
import {
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
  deleteBoardTask,
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
} from "./fleet.mjs";
import { getHerdrAgents } from "./herdr.mjs";

export function handleStatus() {
  const amqRoot = findAmqRoot();
  const pid = isDaemonRunning();
  const handles = amqRoot ? getAgentHandles(amqRoot) : [];

  console.log("\n📦 \x1b[1mHerdr AMQ Bridge Status\x1b[0m");
  console.log("──────────────────────────────────────────────");
  console.log(`Daemon:    ${pid ? `\x1b[32m● Running\x1b[0m (PID ${pid})` : "\x1b[33m○ Stopped\x1b[0m"}`);
  console.log(`AMQ Root:  ${amqRoot ? `\x1b[36m${amqRoot}\x1b[0m` : "\x1b[31mNot found\x1b[0m"}`);
  console.log(`State Dir: ${getStateDir()}`);
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
    console.error(`❌ Failed to start bridge daemon.`);
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

  console.log(`🔔 Checking AMQ inboxes at ${amqRoot}...`);
  const res = runDoorbellPass({ amqRoot });

  if (!res.ok) {
    console.error(`❌ Doorbell check failed: ${res.error}`);
    return;
  }

  console.log(`Checked ${res.agentsChecked} agents. Doorbelled: ${res.doorbelled} message(s).`);
  for (const r of res.results || []) {
    console.log(`  - ${r.handle} (${r.status}): ${r.count} msg(s) -> ${r.action}`);
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
      runDoorbellPass({ amqRoot, targetHandle: handle });
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

    case "assign": {
      const to = flags.to || flags.owner;
      const title = flags.title || positional.join(" ");
      const desc = flags.desc || flags.description || "";
      const status = flags.status || "backlog";

      if (!title || !title.trim()) {
        console.error("❌ Task title is required: --title <title>");
        process.exit(1);
      }
      if (!to || !to.trim()) {
        console.error("❌ Target owner is required: --to <handle>");
        process.exit(1);
      }

      const res = addBoardTask(repoRoot, amqRoot, {
        title,
        owner: to,
        status,
        description: desc,
        from: me,
        notify: flags.notify !== "false",
      });

      if (res.ok) {
        console.log(`\n✅ \x1b[32mTask created and assigned to ${to}\x1b[0m (ID: ${res.task.id})`);
        console.log(`✉️ Automail notification dispatched via AMQ to ${to}.`);
        console.log(`Title: ${res.task.title}\n`);
      } else {
        console.error(`❌ Failed to create task: ${res.error}`);
        process.exit(1);
      }
      break;
    }

    case "claim": {
      const taskId = positional[0] || flags.id;
      if (!taskId) {
        console.error("❌ Task ID is required: herdr-amq task claim <taskId> [--me <handle>]");
        process.exit(1);
      }

      const res = updateBoardTask(
        repoRoot,
        amqRoot,
        taskId,
        { status: "in_progress", owner: me },
        { from: me, notify: flags.notify !== "false" }
      );

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

      const proof = flags.proof || flags.evidence || positional.slice(1).join(" ") || "";
      const res = updateBoardTask(
        repoRoot,
        amqRoot,
        taskId,
        { status: "done" },
        { from: me, proof, notify: flags.notify !== "false" }
      );

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

      const reason = flags.reason || flags.desc || positional.slice(1).join(" ") || "Blocked";
      const res = updateBoardTask(
        repoRoot,
        amqRoot,
        taskId,
        { status: "blocked" },
        { from: me, reason, notify: flags.notify !== "false" }
      );

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
      if (found.created) console.log(`Created:     ${found.created}`);
      if (found.updated) console.log(`Updated:     ${found.updated}`);
      if (found.description) console.log(`Description: ${found.description}`);
      console.log("──────────────────────────────────────────────\n");
      break;
    }

    default:
      console.log(`\n📋 \x1b[1mAGboard Task Coordination CLI\x1b[0m`);
      console.log("────────────────────────────────────────────────────────────────────────────");
      console.log("Usage: herdr-amq task <subcommand> [options]");
      console.log("\nCommands:");
      console.log("  list [--owner <h>] [--status <s>] [--json]   List all tasks");
      console.log("  assign --to <h> --title <t> [--desc <d>]      Assign a new task to an agent");
      console.log("  claim <id> [--me <h>]                         Claim an existing task");
      console.log("  done <id> [--me <h>] [--proof <evidence>]     Complete a task with proof");
      console.log("  block <id> [--me <h>] [--reason <reason>]     Mark task blocked with reason");
      console.log("  show <id>                                     View task details");
      console.log("────────────────────────────────────────────────────────────────────────────\n");
      break;
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

    fs.mkdirSync(destDir, { recursive: true });
    const targetFile = path.join(destDir, "SKILL.md");
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
  up               Launch missing fleet agents into Herdr terminal tabs

Options:
  --kind <kind>    Agent kind to launch (default: agy, options: agy, opencode, pi)
  --agents <list>  Comma-separated handles to target (default: all)
  --dry-run        Preview actions without creating tabs or starting agents
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
        ? `\x1b[32m● ${live.agent_status} (${live.pane_id})\x1b[0m`
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

  if (subcommand === "up") {
    const kindIdx = rawArgs.indexOf("--kind");
    const kind = kindIdx !== -1 && rawArgs[kindIdx + 1] ? rawArgs[kindIdx + 1] : "agy";
    const agentsIdx = rawArgs.indexOf("--agents");
    const agents = agentsIdx !== -1 && rawArgs[agentsIdx + 1] ? rawArgs[agentsIdx + 1] : null;
    const dryRun = rawArgs.includes("--dry-run");

    console.log(`\n🚀 \x1b[1mLaunching Fleet via Herdr (kind: ${kind})\x1b[0m`);
    console.log("──────────────────────────────────────────────");
    if (dryRun) console.log("Mode: \x1b[33mDry Run (preview only)\x1b[0m\n");

    const res = await launchFleet(amqRoot, repoRoot, { kind, agents, dryRun });
    if (res.alreadyRunning.length > 0) {
      console.log(`\x1b[36m● Already running (${res.alreadyRunning.length}):\x1b[0m ${res.alreadyRunning.join(", ")}`);
    }
    if (dryRun && res.wouldLaunch.length > 0) {
      console.log(`\x1b[33m⚡ Would launch into Herdr (${res.wouldLaunch.length}):\x1b[0m ${res.wouldLaunch.join(", ")}`);
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


