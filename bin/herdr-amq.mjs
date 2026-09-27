#!/usr/bin/env node
import {
  handleStatus,
  handleStart,
  handleStop,
  handleDoorbell,
  handleStartup,
  handleAgentStatusChanged,
  handleTaskCommand,
  handleMailCommand,
  handleSkillCommand,
  handleMigrateCommand,
  handleFleetCommand,
  handleBootstrapCommand,
} from "../src/actions.mjs";
import { startDaemonLoop } from "../src/bridge.mjs";
import { launchDashboardPane, launchInboxPeekPane } from "../src/panes.mjs";
import { GUARD_MANIFEST, GUARD_LOCATIONS } from "../src/guards.mjs";
import { getPluginVersion } from "../src/config.mjs";
import { handleProjectsCommand } from "../src/projects-cli.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** The commit this build was read at, so "which tree am I in" has an answer that ages. */
function readCommit(repoRoot) {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown (not a git checkout)";
  }
}

const cmd = process.argv[2] || "status";

switch (cmd) {
  case "--version":
  case "version": {
    // WHICH BUILD AM I ACTUALLY, AND WHERE IS THE TEXT I AM CLAIMING ABOUT?
    //
    // Tonight's guards are a property of a FILE TREE. There is a stale copy of this package in
    // the npx cache - 0.1.3, from before any of them - and an npx invocation resolves to THAT
    // one, while `herdr-amq` and the bridge daemon resolve to the current source tree. Both write
    // to the same bus. So "the done-card guard is in place" is a statement about a PATH unless
    // somebody can ask which path was used.
    //
    // Nothing can make the stale copy behave - it is a cache, and a fix there is not a fix. What
    // this does is make the question ANSWERABLE in one command instead of by reading paths.
    //
    // WHAT THE LIST BELOW IS NOT, printed here because the artifact is what a tired person reads
    // at 06:00 and not the message that explains it: it is TEXTUAL PRESENCE OF A STRING IN A
    // FILE TREE. It does not report that a guard is in place, it does not know whether a guard is
    // reachable, enabled, or even called. The TEST SUITES hold the guards. This only tells you
    // which tree you are standing in, and it can be wrong in either direction - a refactor that
    // moves a literal reads ABSENT while the guard is healthy.
    const here = fileURLToPath(import.meta.url);
    const repoRoot = path.resolve(path.dirname(here), "..");
    console.log(`herdr-amq ${getPluginVersion()}`);
    console.log(`resolved: ${here}`);
    console.log(`commit:   ${readCommit(repoRoot)}`);
    console.log("");
    console.log("Guard SOURCE locations found in this tree. This is not a claim that a guard is");
    console.log("in place: it is string presence in a file, and the test suites are what hold the");
    console.log("guards. A refactor that moves a literal would read ABSENT with the guard healthy.");
    for (const [name, present] of Object.entries(GUARD_MANIFEST)) {
      console.log(`  ${present ? "found" : "ABSENT"}  ${GUARD_LOCATIONS[name] || "(not found)"}  ${name}`);
    }
    break;
  }
  case "status":
    handleStatus();
    break;
  case "start":
    handleStart();
    break;
  case "stop":
    handleStop();
    break;
  case "doorbell":
    handleDoorbell();
    break;
  case "startup":
    handleStartup();
    break;
  case "on-agent-status-changed":
    handleAgentStatusChanged();
    break;
  case "bridge-daemon":
    startDaemonLoop();
    break;
  case "dashboard":
  case "server":
  case "pane-dashboard":
    launchDashboardPane();
    break;
  case "pane-inbox":
    launchInboxPeekPane();
    break;
  case "task":
  case "tasks":
  case "board":
    handleTaskCommand(process.argv[3], process.argv.slice(4));
    break;
  case "projects":
  case "mailboxes":
    process.exit(handleProjectsCommand(process.argv[3], process.argv.slice(4)) || 0);
    break;
  case "next":
    handleTaskCommand("next", process.argv.slice(3));
    break;
  case "task-drain":
    handleTaskCommand("drain", process.argv.slice(3));
    break;
  case "mail":
    handleMailCommand(process.argv[3], process.argv.slice(4));
    break;
  case "send":
    handleMailCommand("send", process.argv.slice(3));
    break;
  case "reply":
    handleMailCommand("reply", process.argv.slice(3));
    break;
  case "drain":
    handleMailCommand("drain", process.argv.slice(3));
    break;
  case "--skill":
  case "-s":
  case "skill":
    handleSkillCommand(process.argv.slice(3));
    break;
  case "migrate":
    handleMigrateCommand(process.argv.slice(3));
    break;
  case "fleet":
    await handleFleetCommand(process.argv[3], process.argv.slice(4));
    break;
  case "bootstrap":
  case "cold-start":
    await handleBootstrapCommand(process.argv.slice(3));
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.log("Available commands: status, start, stop, doorbell, startup, pane-dashboard, pane-inbox, task, mail, send, reply, drain, migrate, fleet, bootstrap, --skill");
    process.exit(1);
}
