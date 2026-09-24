import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  sendMaildirMessage,
  replyMaildirMessage,
  drainMaildir,
} from "../src/protocol.mjs";
import {
  addBoardTask,
  updateBoardTask,
  loadBoard,
} from "../src/board.mjs";
import {
  runDoorbellPass,
  listInbox,
  isDaemonRunning,
  stopDaemon,
} from "../src/bridge.mjs";
import { storeBlob } from "../src/blobs.mjs";
import { renderInboxSummary } from "../src/panes.mjs";
import {
  handleTaskCommand,
  handleMailCommand,
  handleStatus,
} from "../src/actions.mjs";

describe("Autonomous Swarm Multi-Agent Simulation & Integration", () => {
  let tempRoot;
  let amqRoot;
  let oldAmRoot;
  let oldStateDir;
  let simulationBridgeState;
  let oldCwd;

  before(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-sim-"));
    amqRoot = path.join(tempRoot, ".agent-mail");
    oldAmRoot = process.env.AM_ROOT;
    process.env.AM_ROOT = amqRoot;
    oldStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(tempRoot, "state");
    process.env.HERDR_DISABLE_PROMPT = "1";
    simulationBridgeState = { delivered: {}, deliveredTasks: {} };

    // Create Maildir trees for 3 agents
    const agents = ["coordinator", "worker-alpha", "worker-beta"];
    for (const a of agents) {
      fs.mkdirSync(path.join(amqRoot, "agents", a, "inbox", "new"), { recursive: true });
      fs.mkdirSync(path.join(amqRoot, "agents", a, "inbox", "cur"), { recursive: true });
      fs.mkdirSync(path.join(amqRoot, "agents", a, "outbox", "sent"), { recursive: true });
    }

    // Set up directory bus
    fs.mkdirSync(path.join(tempRoot, ".opencode", "bus", "backlog"), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, ".opencode", "bus", "doing"), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, ".opencode", "bus", "blocked"), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, ".opencode", "bus", "done"), { recursive: true });

    oldCwd = process.cwd();
    process.chdir(tempRoot);
  });

  after(() => {
    process.chdir(oldCwd);
    delete process.env.HERDR_DISABLE_PROMPT;
    if (oldAmRoot !== undefined) {
      process.env.AM_ROOT = oldAmRoot;
    } else {
      delete process.env.AM_ROOT;
    }
    if (oldStateDir !== undefined) {
      process.env.HERDR_PLUGIN_STATE_DIR = oldStateDir;
    } else {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("Step 1: Coordinator assigns task on directory bus", () => {
    const res = addBoardTask(tempRoot, amqRoot, {
      title: "Implement Physics Subsystem",
      owner: "worker-alpha",
      status: "backlog",
      description: "Port Poncelot tissue equations and Recht-Ipson stopping power",
      from: "coordinator",
      notify: true,
    });

    assert.ok(res.ok, "Task creation must succeed");
    assert.strictEqual(res.task.owner, "worker-alpha");
    assert.strictEqual(res.task.status, "backlog");

    // Check card exists on disk in backlog/
    const cardPath = path.join(tempRoot, ".opencode", "bus", "backlog", `${res.task.id}.md`);
    assert.ok(fs.existsSync(cardPath), "Card should exist in backlog/");
  });

  test("Step 2: Worker claims task -> card transitions to doing/ with notification", () => {
    const board = loadBoard(tempRoot, amqRoot);
    const task = board.columns.backlog.find((t) => t.title.includes("Physics"));
    assert.ok(task, "Task must exist in backlog");

    const claimRes = updateBoardTask(
      tempRoot,
      amqRoot,
      task.id,
      { status: "in_progress", owner: "worker-alpha" },
      { from: "worker-alpha", notify: true }
    );

    assert.ok(claimRes.ok);
    assert.strictEqual(claimRes.task.status, "in_progress");

    // Verify card moved from backlog/ to doing/
    assert.ok(!fs.existsSync(path.join(tempRoot, ".opencode", "bus", "backlog", `${task.id}.md`)));
    assert.ok(fs.existsSync(path.join(tempRoot, ".opencode", "bus", "doing", `${task.id}.md`)));

    // Verify coordinator received AMQ task claim notification in inbox/new
    const coordMsgs = listInbox(amqRoot, "coordinator");
    assert.ok(coordMsgs.length > 0, "Coordinator should receive task claim notification");
  });

  test("Step 3: Worker creates artifact and transmits message with CAS attachment", () => {
    // Create benchmark log artifact
    const logFile = path.join(tempRoot, "benchmark.log");
    fs.writeFileSync(logFile, "PERF: 60 FPS, Poncelot penetration: 34.2mm, Recht-Ipson Er: 142J");

    // Worker sends mail to coordinator with attachment
    const sendRes = sendMaildirMessage(amqRoot, {
      from: "worker-alpha",
      to: ["coordinator"],
      subject: "Physics Benchmark Results Ready",
      body: "Attached the Poncelot penetration benchmark output for verification.",
      attachments: [logFile],
    });

    assert.ok(sendRes.id);
    assert.strictEqual(sendRes.from, "worker-alpha");

    // Verify file is stored in CAS blobstore under .agent-mail/blobs/
    const blobsDir = path.join(amqRoot, "blobs");
    assert.ok(fs.existsSync(blobsDir), "Blobs directory must exist");
    const blobEntries = fs.readdirSync(blobsDir);
    assert.ok(blobEntries.length > 0, "Blob must be saved in CAS");

    // Coordinator inbox has the message
    const coordInbox = listInbox(amqRoot, "coordinator");
    const benchMsg = coordInbox.find((m) => m.subject.includes("Physics Benchmark"));
    assert.ok(benchMsg, "Benchmark message must be in coordinator inbox");
  });

  test("Step 4: Bridge doorbell pass detects unread messages and handles agent states", () => {
    const isolatedDoorbell = {
      getStatus: () => "idle",
      healName: () => false,
      prompt: () => true,
    };
    const dryRes = runDoorbellPass({ amqRoot, dryRun: true, ...isolatedDoorbell });
    assert.ok(dryRes.ok);

    const liveRes = runDoorbellPass({ amqRoot, dryRun: false, state: simulationBridgeState, ...isolatedDoorbell });
    assert.ok(liveRes.ok);
    assert.ok(liveRes.results.some((result) => result.action === "simulated"));

    // Second live pass - already delivered messages should not re-trigger
    const secondPass = runDoorbellPass({ amqRoot, dryRun: false, state: simulationBridgeState, ...isolatedDoorbell });
    assert.ok(secondPass.ok);
    assert.strictEqual(secondPass.doorbelled, 0, "Second pass should not re-doorbell already delivered messages");
  });

  test("Step 5: Coordinator drains inbox, reads benchmark, and replies on same thread", () => {
    // Coordinator drains inbox
    const drained = drainMaildir(amqRoot, "coordinator");
    assert.ok(drained.length > 0, "Coordinator should drain messages");

    const targetMsg = drained.find((m) => m.header.subject?.includes("Physics Benchmark"));
    assert.ok(targetMsg, "Target message must be drained");

    // Reply to worker-alpha
    const replyRes = replyMaildirMessage(amqRoot, {
      from: "coordinator",
      replyToId: targetMsg.id,
      body: "Benchmarks approved! Stopping power values match Recht-Ipson tables. Proceed to commit.",
    });

    assert.ok(replyRes.id);
    assert.strictEqual(replyRes.thread, targetMsg.header.thread);

    // Worker drains inbox and receives approval
    const workerDrained = drainMaildir(amqRoot, "worker-alpha");
    assert.ok(workerDrained.length > 0, "Worker should receive reply");
    assert.ok(workerDrained.some((m) => m.body.includes("Benchmarks approved")));
  });

  test("Step 6: Worker marks task done with verification proof", () => {
    const board = loadBoard(tempRoot, amqRoot);
    const task = board.columns.in_progress.find((t) => t.title.includes("Physics"));
    assert.ok(task, "Task must be in progress");

    const doneRes = updateBoardTask(
      tempRoot,
      amqRoot,
      task.id,
      { status: "done" },
      { from: "worker-alpha", proof: "Verified via verify-all.sh --quick (exit 0)", notify: true }
    );

    assert.ok(doneRes.ok);
    assert.strictEqual(doneRes.task.status, "done");

    // Card should now be in done/
    assert.ok(!fs.existsSync(path.join(tempRoot, ".opencode", "bus", "doing", `${task.id}.md`)));
    assert.ok(fs.existsSync(path.join(tempRoot, ".opencode", "bus", "done", `${task.id}.md`)));

    // Load board and verify statistics
    const finalBoard = loadBoard(tempRoot, amqRoot);
    assert.strictEqual(finalBoard.stats.done, 1);
    assert.strictEqual(finalBoard.stats.in_progress, 0);
  });

  test("Step 7: Render inbox summary and daemon lifecycle", () => {
    let output = "";
    const origLog = console.log;
    try {
      console.log = (msg = "") => {
        output += msg + "\n";
      };
      renderInboxSummary(amqRoot);
    } finally {
      console.log = origLog;
    }

    assert.ok(output.includes("AMQ Mailbox Overview"));

    // Check daemon state helpers
    const pid = isDaemonRunning();
    assert.strictEqual(pid, null, "No daemon running yet");

    const stopRes = stopDaemon();
    assert.ok(stopRes.ok);
  });
});
