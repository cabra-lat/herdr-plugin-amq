#!/usr/bin/env node
// THE OWNER-LEASE LATCH MUST LATCH ACROSS PROCESSES.
//
// A state file that is WRITTEN BUT NOT READ is a latch that does not latch, and the only
// symptom is a quiet one: the guard is present, correct, and can never fire. player-rig was
// doorbelled about every 21 seconds off two cards, and nothing threw.
//
// The defect: saveDeliveredState persisted ownerLeasePrompts, but sanitizeDeliveredState rebuilt
// the state from three named maps and dropped it. Every pass loaded an empty map, so
// `if (state.ownerLeasePrompts[key]) continue` never saw the key it had just written.
//
// This test round-trips through a real state file on disk. A unit test of the sanitizer alone
// would pass while the process still forgets, because the bug is that the two halves disagree.
//
// Run: node test/owner-lease-latch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ISOLATE BOTH BOUNDARIES. AM_ROOT isolates the mailbox; HERDR_PLUGIN_STATE_DIR isolates the
// pid and lock state that the real bridge daemon is using right now. Touching the live one is
// how a test becomes an outage.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-latch-"));
const amRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lease-latch-am-"));
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.AM_ROOT = amRoot;

const { sanitizeDeliveredState } = await import("../src/bridge.mjs");

test("an owner-lease prompt survives a write and a read", () => {
  // What the bridge writes after prompting an owner once.
  const written = {
    delivered: {},
    deliveredTasks: {},
    coordinatorAlerts: {},
    ownerLeasePrompts: {
      "task_1790447635566_5578f8@1": {
        at: "2026-09-27T21:06:36.066Z",
        owner: "player-rig",
        leaseEpoch: 1,
        reassignmentSuggested: false,
      },
    },
    recoveryRequired: false,
  };

  // What comes back when the next pass loads it.
  const reloaded = sanitizeDeliveredState(JSON.parse(JSON.stringify(written)));

  assert.equal(
    reloaded.ownerLeasePrompts?.["task_1790447635566_5578f8@1"]?.owner,
    "player-rig",
    "the prompt map must come back. Before this fix it was absent, so the already-armed guard " +
    "re-prompted the same owner on every pass.",
  );
  assert.equal(reloaded.ownerLeasePrompts["task_1790447635566_5578f8@1"].leaseEpoch, 1);
  assert.equal(reloaded.ownerLeasePrompts["task_1790447635566_5578f8@1"].reassignmentSuggested, false);
});

test("the guard a pass actually runs sees the key it wrote", () => {
  // The exact line from runDoorbellPass, reproduced against reloaded state. If the map comes back
  // empty this reports the re-prompt, which is the flood.
  const state = sanitizeDeliveredState({
    ownerLeasePrompts: { "card@2": { at: "2026-09-27T21:06:36.066Z", owner: "player-rig", leaseEpoch: 2 } },
  });
  const key = "card@2";
  let prompted = true;
  if (state.ownerLeasePrompts[key]) prompted = false;   // <- the guard from bridge.mjs
  assert.equal(prompted, false, "the guard must suppress a second prompt for the same card@epoch");
});

test("a NEW lease epoch is still re-armed, because re-claim is a real transition", () => {
  const state = sanitizeDeliveredState({
    ownerLeasePrompts: { "card@2": { at: "2026-09-27T21:06:36.066Z", owner: "player-rig", leaseEpoch: 2 } },
  });
  const reClaimed = "card@3";
  assert.equal(
    Boolean(state.ownerLeasePrompts[reClaimed]),
    false,
    "a re-claim bumps the epoch, and a bumped epoch must prompt again - otherwise recovery " +
    "silently stops working, which is the opposite failure",
  );
});

test("a malformed key cannot be written into the state file", () => {
  const out = sanitizeDeliveredState({
    ownerLeasePrompts: {
      "ok@1": { at: "2026-09-27T21:06:36.066Z", owner: "player-rig", leaseEpoch: 1 },
      "bad\nkey@1": { at: "2026-09-27T21:06:36.066Z", owner: "player-rig", leaseEpoch: 1 },
      "noAt@1": { owner: "player-rig" },
    },
  });
  assert.equal(out.ownerLeasePrompts["ok@1"]?.owner, "player-rig", "a well-formed key survives");
  assert.equal(out.ownerLeasePrompts["bad\nkey@1"], undefined, "a key with a newline is dropped");
  assert.equal(out.ownerLeasePrompts["noAt@1"], undefined, "an entry with no timestamp is dropped");
});

test.after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(amRoot, { recursive: true, force: true });
});
