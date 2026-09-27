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
import { getPluginVersion } from "../src/config.mjs";
import { GUARD_MANIFEST } from "../src/guards.mjs";
import { fileURLToPath } from "node:url";

const cmd = process.argv[2] || "status";

switch (cmd) {
  case "--version":
  case "version": {
    // WHICH BUILD AM I ACTUALLY? A question with a trivial answer and no command to ask it.
    //
    // Tonight's guards are a property of a FILE TREE, not of "the tool". There is a stale copy of
    // this package in the npx cache - 0.1.3, from before any of them - and `npx herdr-amq ...`
    // resolves to THAT one, while `herdr-amq` and the bridge daemon resolve to the current source
    // tree. Both write to the same bus. So "the done-card guard is in place" is, today, a
    // statement about a PATH, and this thread has spent hours on checks that pass on one path
    // while another is unguarded.
    //
    // Nothing can make the stale copy behave - it is a cache, and a fix there is not a fix. What
    // this does is make the question ANSWERABLE in one command instead of by reading paths, and
    // to print which protections this build actually carries, so a claim about the guards can be
    // paired with the evidence for which guards those were.
    const here = fileURLToPath(import.meta.url);
    console.log(`herdr-amq ${getPluginVersion()}`);
    console.log(`resolved: ${here}`);
    console.log(`guards:`);
    for (const [name, present] of Object.entries(GUARD_MANIFEST)) {
      console.log(`  ${present ? "✓" : "✗"} ${name}`);
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
