#!/usr/bin/env node
// AN UNATTENDED STALL MUST NOT ASK FOR A TRANSITION NOBODY CAN HONESTLY MAKE.
//
// The change: the stall prompt used to ask every reader for the same thing - claim it, re-scope it,
// block it, close it - regardless of who was actually there. On 2026-07-01 a lane ran out of budget
// with its work correctly recorded, was told to "Move the card", and got that prompt roughly 340
// times. All four verbs assert something it could not assert: working, delivered, or waiting on
// someone. The menu had no item for "present, recorded, not delivering, not waiting", so every
// available answer was a lie.
//
// The measurement was never wrong. A heartbeat does not clear the stall clock, because a beat is a
// lease and not progress - verified: a card 5h old with no heartbeat is stalled, the same card with
// a 5-minute-old heartbeat is still stalled, and so is a non-owner beat. The clock already had both
// dimensions and carried liveness alongside the verdict without using it.
//
// So this file pins the part that changed: the RECOMMENDATION depends on presence, and it is
// derived from data already on the projection rather than from a new verb or a new stage.
//
// Run: node test/stall-asks-liveness-first.test.mjs

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, updateBoardTask } from "../src/board.mjs";
import { runDoorbellPass } from "../src/bridge.mjs";
import { loadBoard } from "../src/board.mjs";
import { sendMaildirMessage } from "../src/protocol.mjs";

let root;
let amqRoot;
let saved;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "stall-liveness-"));
  amqRoot = path.join(root, ".agent-mail");
  fs.mkdirSync(amqRoot, { recursive: true });
  saved = {};
  for (const k of ["HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_CONFIG_DIR", "HERDR_SOCKET_PATH"]) {
    saved[k] = process.env[k];
  }
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(root, "state");
  process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(root, "config");
  process.env.HERDR_SOCKET_PATH = path.join(root, "missing.sock");
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A card that is genuinely STALLED - every transition clock backdated 45 minutes, well past the
 * 10-minute threshold - with the owner's lease set by `leaseFresh`, so presence and progress are
 * controlled independently rather than collapsed into one timestamp.
 */
async function stalledCard(leaseFresh) {
  const created = addBoardTask(root, amqRoot, { title: "probe", owner: "worker", status: "in_progress" }, { notify: false });
  assert.ok(created.ok);
  const id = created.task.id;
  updateBoardTask(root, amqRoot, id, { status: "in_progress", owner: "worker" }, { notify: false });

  const file = path.join(amqRoot, "bus", "doing", `${id}.md`);
  const old = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  const raw = fs.readFileSync(file, "utf8")
    .replace(/^updated: .*$/m, `updated: ${old}`)
    .replace(/^created: .*$/m, `created: ${old}`)
    .replace(/^last_heartbeat_at: .*$/m, `last_heartbeat_at: ${leaseFresh ?? old}`)
    // The AUTHOR of the beat is load-bearing and this fixture got it wrong first. A beat with no
    // author is liveness UNKNOWN, and UNKNOWN is excluded from stalled entirely - so a card with an
    // unattributed beat is neither UNATTENDED nor STALLED and appears in neither line. Naming the
    // owner is what makes the beat a lease at all.
    .replace(/^last_heartbeat_by: .*$/m, `last_heartbeat_by: worker`)
    .replace(/^last_heartbeat_by: .*$/m, `last_heartbeat_by: worker`)
    .replace(/^status_at: .*$/m, `status_at: ${old}`)
    .replace(/^owner_at: .*$/m, `owner_at: ${old}`)
    .replace(/^next_actor_at: .*$/m, `next_actor_at: ${old}`);
  fs.writeFileSync(file, raw, "utf8");
  return id;
}

// Rendered through the real pass, not a builder called directly - the same route the existing
// coordinator-doorbell test takes, so this file cannot pass while the real path is broken.
async function prompt() {
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
  return prompts.map((p) => p.text).join("\n");
}

test("an UNATTENDED stall says wake or route, and does NOT ask for a transition", async () => {
  // The regression this file exists for. The owner has not renewed the lease, so every verb the old
  // prompt offered would assert something untrue.
  const id = await stalledCard(null);
  const text = await prompt();

  assert.match(text, /UNATTENDED:/, `an unattended card must be announced as such:\n${text}`);
  assert.ok(text.includes(id), `and named: ${text}`);
  assert.match(text, /WAKE|ROUTE/i, "the honest action is to wake or route, not to move it");
  assert.doesNotMatch(
    text,
    /UNATTENDED:[^\n]*Move the card/i,
    "the unattended line must not carry the transition instruction, which is the whole defect",
  );
});

test("an ATTENDED stall - owner present, work not moving - still asks for a transition", async () => {
  // The other half, so the change is not "stop asking everyone to move cards". A present owner
  // with a stalled card is the one case where a transition is the true next step.
  const id = await stalledCard(new Date(Date.now() - 60 * 1000).toISOString());
  const text = await prompt();

  assert.match(text, /STALLED:/, `an attended stall must still be announced:\n${text}`);
  assert.ok(text.includes(id), `and named: ${text}`);
  assert.match(text, /Move the card/i, "and the transition instruction belongs here");
  assert.match(text, /heartbeat will NOT clear it/i, "and the lease-is-not-progress note is retained");
});

test("liveness is read from the projection, not recomputed by the prompt", async () => {
  // If the prompt grew its own liveness arithmetic it could disagree with the projection, and the
  // two would drift the way every other duplicated rule on this board has. It must consume the
  // field the projection already computed.
  const src = fs.readFileSync(new URL("../src/bridge.mjs", import.meta.url), "utf8");
  const start = src.indexOf("const stalled = context.board.stalledCards");
  const end = src.indexOf("// THE CITATIONS A STALLED CARD", start);
  // Strip COMMENTS before the scan, because the block documents this very rule in prose and a
  // search that matched a comment would be reporting on the documentation. The rule this file
  // enforces - never read a number out of text that describes it - applies to the check as much as
  // to the code.
  const block = src.slice(start, end).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(start >= 0 && end > start, `could not locate the stall block (start=${start}, end=${end})`);
  assert.match(block, /card\.liveness/, "the partition must read the liveness the projection carries");
  assert.doesNotMatch(
    block,
    /last_heartbeat_at|stalledWorkMs|livenessState\(/,
    "and must not recompute presence from raw timestamps in the prompt - that is a second source of truth",
  );
});
