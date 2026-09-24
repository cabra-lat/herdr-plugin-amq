import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addBoardTask } from "../src/board.mjs";
import { runDoorbellPass } from "../src/bridge.mjs";

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
    assert.equal(first.coordinatorDoorbell.alert, "retry_failure_trend");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].handle, "coordinator");
    assert.match(prompts[0].text, /delegate or re-scope cards/);

    const second = runDoorbellPass(options);
    assert.equal(second.coordinatorDoorbell.prompted, false);
    assert.equal(prompts.length, 1, "cooldown must suppress duplicate coordinator prompts");
  } finally {
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
