import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addBoardTask, updateBoardTask } from "../src/board.mjs";
import { runDoorbellPass, runManualCoordinatorDoorbell, sanitizeDeliveredState } from "../src/bridge.mjs";

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-doorbell-"));
  const amqRoot = path.join(root, ".agent-mail");
  for (const agent of ["coordinator", "worker"]) {
    fs.mkdirSync(path.join(amqRoot, "agents", agent, "inbox", "new"), { recursive: true });
    fs.mkdirSync(path.join(amqRoot, "agents", agent, "inbox", "cur"), { recursive: true });
    fs.mkdirSync(path.join(amqRoot, "agents", agent, "outbox", "sent"), { recursive: true });
  }
  for (const stage of ["backlog", "doing", "blocked", "done"]) {
    fs.mkdirSync(path.join(root, ".opencode", "bus", stage), { recursive: true });
  }
  return { root, amqRoot };
}

test("coordinator metrics doorbell prompts an idle coordinator once per cooldown", () => {
  const { root, amqRoot } = makeFixture();
  try {
    const task = addBoardTask(root, amqRoot, {
      title: "Stalled work needs re-evaluation",
      owner: "worker",
      status: "blocked",
      description: "The worker is blocked and needs coordinator action.",
      notify: false,
    });
    assert.ok(task.ok);

    const prompts = [];
    const state = { delivered: {}, deliveredTasks: {} };
    const options = {
      amqRoot,
      handles: ["coordinator"],
      state,
      getStatus: () => "idle",
      prompt: (handle, text) => {
        prompts.push({ handle, text });
        return true;
      },
      allowPrompt: true,
      persistState: true,
      coordinatorDoorbell: { enabled: true, cooldownMs: 60000 },
    };

    const first = runDoorbellPass(options);
    assert.equal(first.coordinatorDoorbell.prompted, true);
    assert.equal(first.coordinatorDoorbell.alert, "blocked_cards");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].handle, "coordinator");
    assert.match(prompts[0].text, /delegate.*re-scope/);
    assert.match(prompts[0].text, /Triage snapshot:/);
    assert.match(prompts[0].text, /next-actor=/);

    const second = runDoorbellPass(options);
    assert.equal(second.coordinatorDoorbell.prompted, false);
    assert.equal(prompts.length, 1, "cooldown must suppress duplicate coordinator prompts");
    const alertKey = Object.keys(state.coordinatorAlerts).find((key) => key.startsWith("blocked_cards:"));
    state.coordinatorAlerts[alertKey].at = "2000-01-01T00:00:00.000Z";
    assert.equal(runDoorbellPass(options).coordinatorDoorbell.prompted, false, "unchanged condition must remain deduplicated after cooldown");
    const reloaded = sanitizeDeliveredState(JSON.parse(JSON.stringify(state)));
    const persisted = Object.values(reloaded.coordinatorAlerts).find((entry) => entry.alert === "blocked_cards");
    assert.ok(persisted);
    assert.equal(persisted.fingerprint, first.coordinator.alerts.find((alert) => alert.id === "blocked_cards").fingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("non-fingerprinted alerts use cooldown and can recur", () => {
  const { root, amqRoot } = makeFixture();
  try {
    assert.ok(addBoardTask(root, amqRoot, {
      title: "Ready work",
      owner: "worker",
      description: "Waiting for an idle coordinator to assign it.",
      notify: false,
    }).ok);
    const prompts = [];
    const state = { delivered: {}, deliveredTasks: {} };
    const options = {
      amqRoot,
      handles: ["coordinator"],
      state,
      getStatus: () => "idle",
      prompt: (handle, text) => { prompts.push({ handle, text }); return true; },
      allowPrompt: true,
      persistState: true,
      coordinatorDoorbell: { enabled: true, cooldownMs: 60000 },
    };
    assert.equal(runDoorbellPass(options).coordinatorDoorbell.alert, "backlog_idle");
    assert.equal(runDoorbellPass(options).coordinatorDoorbell.prompted, false);
    const alertKey = Object.keys(state.coordinatorAlerts).find((key) => key === "backlog_idle");
    state.coordinatorAlerts[alertKey].at = "2000-01-01T00:00:00.000Z";
    assert.equal(runDoorbellPass(options).coordinatorDoorbell.prompted, true);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].text.includes("backlog_idle"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("changed blocked-card condition gets a new coordinator prompt", () => {
  const { root, amqRoot } = makeFixture();
  try {
    const created = addBoardTask(root, amqRoot, {
      title: "Blocked card",
      owner: "worker",
      status: "blocked",
      description: "Initial blocker.",
      notify: false,
    });
    assert.ok(created.ok);
    const prompts = [];
    const state = { delivered: {}, deliveredTasks: {} };
    const options = {
      amqRoot,
      handles: ["coordinator"],
      state,
      getStatus: () => "idle",
      prompt: (handle, text) => { prompts.push({ handle, text }); return true; },
      allowPrompt: true,
      persistState: true,
      coordinatorDoorbell: { enabled: true, cooldownMs: 60000 },
    };
    assert.equal(runDoorbellPass(options).coordinatorDoorbell.prompted, true);
    assert.equal(runDoorbellPass(options).coordinatorDoorbell.prompted, false);
    assert.equal(updateBoardTask(root, amqRoot, created.task.id, { reason: "New dependency is ready for triage." }, { notify: false }).ok, true);
    assert.equal(runDoorbellPass(options).coordinatorDoorbell.prompted, true);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1].text, /New dependency is ready for triage/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manual coordinator doorbell prompts immediately and is logged", () => {
  const { root, amqRoot } = makeFixture();
  const oldStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(root, "state");
  try {
    const prompts = [];
    const result = runManualCoordinatorDoorbell({
      amqRoot,
      prompt: (handle, text) => { prompts.push({ handle, text }); return true; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.prompted, true);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].handle, "coordinator");
    assert.match(prompts[0].text, /Manual coordinator doorbell/);
  } finally {
    if (oldStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = oldStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("coordinator metrics doorbell can be disabled without prompting", () => {
  const { root, amqRoot } = makeFixture();
  try {
    assert.ok(addBoardTask(root, amqRoot, {
      title: "Blocked card",
      owner: "worker",
      status: "blocked",
      description: "Waiting for review.",
      notify: false,
    }).ok);
    let prompted = false;
    const result = runDoorbellPass({
      amqRoot,
      handles: ["coordinator"],
      getStatus: () => "idle",
      prompt: () => { prompted = true; return true; },
      allowPrompt: true,
      coordinatorDoorbell: { enabled: false, cooldownMs: 60000 },
    });
    assert.equal(result.coordinatorDoorbell.prompted, false);
    assert.equal(prompted, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
