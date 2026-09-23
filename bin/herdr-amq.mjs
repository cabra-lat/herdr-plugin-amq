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
} from "../src/actions.mjs";
import { startDaemonLoop } from "../src/bridge.mjs";
import { launchDashboardPane, launchInboxPeekPane } from "../src/panes.mjs";

const cmd = process.argv[2] || "status";

switch (cmd) {
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
  default:
    console.error(`Unknown command: ${cmd}`);
    console.log("Available commands: status, start, stop, doorbell, startup, pane-dashboard, pane-inbox, task, mail, send, reply, drain, --skill");
    process.exit(1);
}
