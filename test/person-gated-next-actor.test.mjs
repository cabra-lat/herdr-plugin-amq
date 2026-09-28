#!/usr/bin/env node
// A VERB THAT SAYS NOTHING ABOUT WHO ACTS NEXT MUST NOT REASSIGN THE CARD.
//
// Defect (1) of e0da0a, reproduced. In updateBoardTask the next_actor ladder read:
//     targetStatus === "done"    -> null
//     targetStatus === "blocked" -> existingTask.next_actor ?? null
//     EVERYTHING ELSE            -> owner
// so any write that did not mention next_actor - unblock, a stage change, a reason edit - moved a
// PERSON-GATED card onto a lane. The owner is a lane, so a wait only the user can clear quietly
// became that lane's problem and stopped being anybody's. The coordinator hit the identical thing:
// next_actor=user, then `unblock --stage queued`, and the card's own file read back agsuite-dev.
//
// WHY IT SURVIVED A REPRODUCTION ATTEMPT, which is the part worth keeping. I ran four fresh-mailbox
// probes and every one asserted on OWNER. The owner never moved - it was qa before and after. The
// field that moved was next_actor, and I was reading the wrong column of the file. Two lanes failed
// to reproduce it for the same reason in different costumes: testkit's half was a block-reason clear
// with the card overwritten by a re-block so no artefact survived it, and mine was four probes on
// the wrong field. The defect was not subtle. The MEASUREMENT was.
//
// The fix preserves the existing value and keeps `owner` only as the fallback for a card that has
// never had a next_actor - so a lane-owned card still gets a sensible default, and the two
// behaviours that were already correct are pinned so this cannot over-reach into them.
//
// Run: node test/person-gated-next-actor.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, updateBoardTask } from "../src/board.mjs";

// ISOLATION, required by state-isolation-guard.test.mjs: this file drives updateBoardTask, and a
// board write records into the state dir resolved at CALL TIME. Without this the test writes its
// own fixture cards into the production audit and evicts real card history - the defect that
// guard exists to stop, which I would have reintroduced by adding a test.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-nextactor-"));

// ISOLATION, required by state-isolation-guard.test.mjs: this file drives updateBoardTask, and a
// board write records into the state dir resolved at CALL TIME. Without this the test writes its
// own fixture cards into the production audit and evicts real card history - which is the defect
// that guard exists to stop, and which I would have reintroduced by adding a test.
let root;
let amqRoot;
function scratch() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "next-actor-"));
  amqRoot = path.join(root, ".agent-mail");
  fs.mkdirSync(amqRoot, { recursive: true });
  return { root, amqRoot };
}
/** Read the field off the card's OWN FILE, which is what both the owner and the coordinator did. */
function readField(id, field) {
  for (const stage of fs.readdirSync(path.join(amqRoot, "bus"))) {
    const p = path.join(amqRoot, "bus", stage, `${id}.md`);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, "utf8");
    return (t.match(new RegExp(`^${field}: (.*)$`, "m")) || [])[1]?.replace(/"/g, "") ?? null;
  }
  return null;
}
const card = (opts) => addBoardTask(scratch().root, amqRoot, { title: "t", owner: "qa", status: "in_progress", ...opts }, { notify: false }).task.id;

test("an unrelated verb does not take a person-gated card off the user", () => {
  const { root: r, amqRoot: a } = scratch();
  const id = addBoardTask(r, a, { title: "t", owner: "qa", status: "in_progress", next_actor: "user" }, { notify: false }).task.id;
  assert.equal(readField(id, "next_actor"), "user", "precondition: gated on the person");
  updateBoardTask(r, a, id, { status: "queued" }, { notify: false });
  assert.equal(readField(id, "next_actor"), "user", "the person gate must survive a stage change");
  assert.equal(readField(id, "owner"), "qa", "and the owner was never the field that moved");
  fs.rmSync(r, { recursive: true, force: true });
});

test("a card that never had a next_actor still defaults to its owner", () => {
  // The fix must not over-reach: a lane-owned card with no gate still needs a sensible default,
  // and this is the case that keeps it.
  const { root: r, amqRoot: a } = scratch();
  const id = addBoardTask(r, a, { title: "t", owner: "qa", status: "in_progress" }, { notify: false }).task.id;
  updateBoardTask(r, a, id, { status: "doing" }, { notify: false });
  assert.equal(readField(id, "next_actor"), "qa", "the owner default must remain for an ungated card");
  fs.rmSync(r, { recursive: true, force: true });
});

test("done still CLEARS next_actor and blocked still PRESERVES it", () => {
  // Both were already correct. They are pinned because a fix that over-reaches into them would be
  // as wrong as the original defect, in the other direction.
  const { root: r, amqRoot: a } = scratch();
  const done = addBoardTask(r, a, { title: "t", owner: "qa", status: "in_progress", next_actor: "user" }, { notify: false }).task.id;
  updateBoardTask(r, a, done, { status: "done" }, { notify: false });
  assert.equal(readField(done, "next_actor"), "null", "a finished card advertises nobody");

  const blocked = addBoardTask(r, a, { title: "b", owner: "qa", status: "in_progress", next_actor: "user" }, { notify: false }).task.id;
  updateBoardTask(r, a, blocked, { status: "blocked", reason: "waiting on the person" }, { notify: false });
  assert.equal(readField(blocked, "next_actor"), "user", "blocking must not steal the gate either");
  fs.rmSync(r, { recursive: true, force: true });
});

test("an EXPLICIT next_actor still wins, because some verbs mean to move it", () => {
  const { root: r, amqRoot: a } = scratch();
  const id = addBoardTask(r, a, { title: "t", owner: "qa", status: "in_progress", next_actor: "user" }, { notify: false }).task.id;
  updateBoardTask(r, a, id, { next_actor: "verifier" }, { notify: false });
  assert.equal(readField(id, "next_actor"), "verifier", "reassigning by hand must still work");
  fs.rmSync(r, { recursive: true, force: true });
});

test("the owner fall-through is gone from the source, not merely unobserved", () => {
  // A behavioural test passes on a tree where the branch is still there but unreachable. This pins
  // the shape, so a future edit cannot reintroduce a silent reassign behind a passing test.
  const src = fs.readFileSync(new URL("../src/board.mjs", import.meta.url), "utf8");
  // Anchor on the LADDER, which is the run of ternaries inside the next_actor assignment - not on
  // the first `targetStatus === "done"` in the file, which is a different site.
  const at = src.indexOf("next_actor: Object.hasOwn(updates");
  const ladder = src.slice(at, at + 1400);
  assert.doesNotMatch(
    ladder,
    /"blocked"\s*\?\s*\(existingTask\.next_actor\s*\?\?\s*null\)\s*:\s*owner/,
    "the third rung of the ladder must not fall through to owner",
  );
  assert.match(ladder, /existingTask\.next_actor \?\? owner/, "and must fall back to owner only when there is nothing to preserve");
});
