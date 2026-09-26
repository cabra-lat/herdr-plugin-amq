import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addBoardTask, appendBoardTaskNote, loadBoard, updateBoardTask } from "../src/board.mjs";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";
import { runDoorbellPass, runManualCoordinatorDoorbell, sanitizeDeliveredState } from "../src/bridge.mjs";
import { sendMaildirMessage } from "../src/protocol.mjs";

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

test("doorbell prompts once without emitting an automatic acknowledgement", () => {
  const { root, amqRoot } = makeFixture();
  try {
    const message = sendMaildirMessage(amqRoot, {
      from: "coordinator",
      to: ["worker"],
      subject: "Status check",
      body: "Please continue the assigned work.",
    });
    const prompts = [];
    const result = runDoorbellPass({
      amqRoot,
      repoRoot: root,
      targetHandle: "worker",
      allowPrompt: true,
      state: { delivered: {}, deliveredTasks: {}, coordinatorAlerts: {} },
      getStatus: () => "idle",
      healName: () => false,
      prompt: (handle, text) => {
        prompts.push({ handle, text });
        return true;
      },
    });

    assert.equal(result.doorbelled, 1);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].handle, "worker");
    assert.match(prompts[0].text, /do not send an acknowledgement-only reply/i);
    assert.match(prompts[0].text, /continue the assigned work/i);
    assert.equal(fs.readdirSync(path.join(amqRoot, "agents", "worker", "outbox", "sent")).length, 0, "doorbell must not create a reply");
    assert.equal(fs.readdirSync(path.join(amqRoot, "agents", "worker", "inbox", "new")).length, 1, "doorbell must not mark the message read or drain it");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    assert.match(prompts[0].text, /Coordinator review required/);
    assert.match(prompts[0].text, /Coordinator owns triage and approvals/);
    assert.match(prompts[0].text, /decide and proceed/);
    assert.doesNotMatch(prompts[0].text, /remote deletion|remote branches|remote tags|remote refs/i);
    assert.doesNotMatch(prompts[0].text, /human confirmation|advisory; no auto-approval/i);
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
    // Change the blocked condition WITHOUT triaging it: a card that carries a
    // reason is triaged and must stop alerting instead of re-prompting.
    assert.equal(updateBoardTask(root, amqRoot, created.task.id, { next_actor: "spotter" }, { notify: false }).ok, true);
    assert.equal(runDoorbellPass(options).coordinatorDoorbell.prompted, true);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1].text, /next-actor=spotter/);
    // Triaging the same card silences the alert; correct triage must not page again.
    assert.equal(updateBoardTask(root, amqRoot, created.task.id, { status: "blocked" }, { reason: "New dependency is ready for triage.", notify: false }).ok, true);
    assert.equal(runDoorbellPass(options).coordinatorDoorbell.prompted, false);
    assert.equal(prompts.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fingerprint survives persisted state and migrates from legacy key", () => {
  const migrated = sanitizeDeliveredState({
    delivered: {},
    deliveredTasks: {},
    coordinatorAlerts: {
      "blocked_cards:abc123": {
        at: "2026-09-24T22:00:00.000Z",
        to: "coordinator",
        alert: "blocked_cards",
        fingerprint: null,
        attempts: 1,
      },
    },
  });
  assert.equal(migrated.coordinatorAlerts["blocked_cards:abc123"].fingerprint, "abc123");

  const legacy = sanitizeDeliveredState({
    delivered: {},
    deliveredTasks: {},
    coordinatorAlerts: {
      blocked_cards: {
        at: "2026-09-24T22:00:00.000Z",
        to: "coordinator",
        alert: "blocked_cards",
        attempts: 1,
      },
    },
  });
  assert.equal(legacy.coordinatorAlerts.blocked_cards.fingerprint, null);
});

test("real state load migrates and reloads a fingerprinted alert entry", () => {
  const { root, amqRoot } = makeFixture();
  const oldStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const stateDir = path.join(root, "state");
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
  try {
    assert.ok(addBoardTask(root, amqRoot, {
      title: "Blocked card",
      owner: "worker",
      status: "blocked",
      description: "Waiting for triage.",
      notify: false,
    }).ok);
    const board = loadBoard(root, amqRoot);
    const metrics = buildCoordinatorMetrics({
      handles: ["coordinator"],
      agentStatuses: { coordinator: "working" },
      board,
      now: Date.now(),
    });
    const alert = metrics.alerts.find((entry) => entry.id === "blocked_cards");
    assert.ok(alert?.fingerprint);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "bridge-state.json"), JSON.stringify({
      delivered: {},
      deliveredTasks: {},
      coordinatorAlerts: {
        [`${alert.id}:${alert.fingerprint}`]: {
          at: "2026-09-24T22:00:00.000Z",
          to: "coordinator",
          alert: alert.id,
          fingerprint: null,
          attempts: 1,
        },
      },
    }, null, 2), "utf8");

    const options = {
      amqRoot,
      handles: ["coordinator"],
      getStatus: () => "working",
      allowPrompt: false,
      persistState: false,
    };
    runDoorbellPass(options);
    const firstLoad = JSON.parse(fs.readFileSync(path.join(stateDir, "bridge-state.json"), "utf8"));
    const key = `${alert.id}:${alert.fingerprint}`;
    assert.equal(firstLoad.coordinatorAlerts[key].fingerprint, alert.fingerprint);

    runDoorbellPass(options);
    const secondLoad = JSON.parse(fs.readFileSync(path.join(stateDir, "bridge-state.json"), "utf8"));
    assert.equal(secondLoad.coordinatorAlerts[key].fingerprint, alert.fingerprint);
    assert.equal(secondLoad.coordinatorAlerts[key].attempts, 1);
  } finally {
    if (oldStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = oldStateDir;
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
    assert.match(prompts[0].text, /Coordinator owns triage and approvals/);
    assert.doesNotMatch(prompts[0].text, /remote deletion|remote branches|remote tags|remote refs/i);
    assert.doesNotMatch(prompts[0].text, /human confirmation|advisory only; do not auto-approve/i);
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

test("coordinator triage snapshot reports note count and note recency per card", () => {
  const { root, amqRoot } = makeFixture();
  try {
    const task = addBoardTask(root, amqRoot, {
      title: "Actively worked but stalled card",
      owner: "worker",
      status: "blocked",
      description: "Blocked, but the worker keeps leaving progress notes.",
      notify: false,
    });
    assert.ok(task.ok);
    const note = appendBoardTaskNote(root, amqRoot, task.task.id, { text: "still working through the integration", author: "worker" });
    assert.equal(note.ok, true);

    const prompts = [];
    runDoorbellPass({
      amqRoot,
      handles: ["coordinator"],
      state: { delivered: {}, deliveredTasks: {} },
      getStatus: () => "idle",
      prompt: (handle, text) => {
        prompts.push({ handle, text });
        return true;
      },
      allowPrompt: true,
      persistState: true,
      coordinatorDoorbell: { enabled: true, cooldownMs: 60000 },
      thresholds: { blockedWarnMs: 0 },
    });

    assert.equal(prompts.length, 1);
    const line = prompts[0].text.split("\n").find((text) => text.includes(task.task.id));
    assert.ok(line, `expected a triage line for ${task.task.id}\n${prompts[0].text}`);
    assert.match(line, /notes=1/);
    assert.match(line, /last-note=/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an owner with in-progress cards is told to MOVE the card, not to heartbeat it", () => {
  // The prompt used to instruct agents to heartbeat in order to clear the stall
  // alert. The detector aged that same clock, so obeying could not reduce the count -
  // the instruction was a loop dressed as a remedy. The heartbeat survives in the
  // prompt only as the honest liveness declaration it actually is.
  const { root, amqRoot } = makeFixture();
  try {
    const task = addBoardTask(root, amqRoot, { title: "Work in flight", owner: "worker", description: "Still being worked." }, { notify: false });
    assert.ok(task.ok);
    updateBoardTask(root, amqRoot, task.task.id, { status: "in_progress", owner: "worker" }, { notify: false });
    sendMaildirMessage(amqRoot, { from: "coordinator", to: ["worker"], subject: "Check in", body: "Status please." });

    const prompts = [];
    runDoorbellPass({
      amqRoot,
      handles: ["worker"],
      state: { delivered: {}, deliveredTasks: {} },
      getStatus: () => "idle",
      prompt: (handle, text) => { prompts.push({ handle, text }); return true; },
      allowPrompt: true,
      persistState: true,
    });

    assert.equal(prompts.length, 1);
    const line = prompts[0].text.split("\n").find((text) => text.includes("task heartbeat"));
    assert.ok(line, `expected a heartbeat instruction\n${prompts[0].text}`);
    // The instruction must name the verb and the agent, and say why notes are not enough.
    assert.match(line, /herdr-amq task heartbeat <id> --me worker/);
    assert.match(line, /Notes are narration, never liveness/);

    // And it must NOT tell them a heartbeat clears the alert, because it does not.
    assert.match(line, /heartbeat will not clear it/);
    assert.doesNotMatch(line, /The stall detector reads that clock/,
      "the prompt must not claim the detector reads the heartbeat clock; it reads the state clock");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
