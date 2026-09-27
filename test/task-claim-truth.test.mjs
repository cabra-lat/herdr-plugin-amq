import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addBoardTask, getBoardTask } from "../src/board.mjs";

const CLI = fileURLToPath(new URL("../bin/herdr-amq.mjs", import.meta.url));

/**
 * A claim that PRINTS a transition it did not perform.
 *
 * Found on a live card, not reasoned about. At 00:12Z I re-claimed my own in-progress card and
 * the command printed
 *     "Task task_1790460648656_4a10cc claimed by agsuite-dev (Status -> in_progress)"
 *     "Notification dispatched to coordinator via AMQ."
 * while `Updated` stayed at 22:48:37.566Z, `Claims` stayed at 1, and no message reached
 * coordinator. Both halves of the printed success were fiction.
 *
 * The board layer was never the bug: `updated` moves only when the card really changed, and the
 * claim notification is gated on a real status transition. The CLI printed from `res.ok`, which
 * is true whenever the write lands - including when it writes back identical values.
 *
 * The operational cost, which is why this is not cosmetic: the stall doorbell names claiming as
 * one of four remedies. An agent that follows it, sees success, and watches the number not move
 * has been told to do something useless by the tool that raised the alarm.
 *
 * Every arm below asserts on THE CARD READ BACK FROM THE BOARD, never on the command's stdout,
 * because the command's stdout is the thing under suspicion. The output is asserted separately
 * and only for the property that matters: it must not claim a transition that did not happen.
 */
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "amq-claim-"));
  const amqRoot = path.join(repo, ".agent-mail");
  fs.mkdirSync(amqRoot, { recursive: true });
  for (const h of ["coordinator", "range", "agsuite-dev"]) {
    for (const s of ["new", "cur"]) {
      fs.mkdirSync(path.join(amqRoot, "agents", h, "inbox", s), { recursive: true });
    }
  }
  return { repo, amqRoot };
}

function addCard(repo, amqRoot, overrides = {}) {
  const res = addBoardTask(repo, amqRoot, {
    title: "A card",
    owner: "range",
    status: "backlog",
    description: "d",
    ...overrides,
  });
  assert.equal(res.ok, true);
  return res.task.id;
}

function claim(repo, amqRoot, taskId, args = []) {
  const r = spawnSync(process.execPath, [CLI, "task", "claim", taskId, "--me", "agsuite-dev", ...args], {
    env: { ...process.env, AM_ROOT: amqRoot },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

/** Read the card back off disk. Not the command's opinion of it. */
function read(repo, amqRoot, taskId) {
  return getBoardTask(repo, amqRoot, taskId).task;
}

function inboxCount(amqRoot, handle) {
  const d = path.join(amqRoot, "agents", handle, "inbox", "new");
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".md")).length : 0;
}

describe("a real claim performs the transition", () => {
  test("the claim record, the claim count and the state clock all move", () => {
    const { repo, amqRoot } = fixture();
    const id = addCard(repo, amqRoot);
    const before = read(repo, amqRoot, id);

    const r = claim(repo, amqRoot, id);
    assert.equal(r.code, 0, r.err);
    const after = read(repo, amqRoot, id);

    assert.equal(after.status, "in_progress");
    assert.equal(after.owner, "agsuite-dev");
    assert.equal(after.claims, (before.claims || 0) + 1, "the claim count moves");
    assert.notEqual(after.claimed_at, before.claimed_at, "the claim record moves");
    assert.notEqual(after.updated, before.updated, "the state clock moves");
    assert.match(r.out, /claimed by agsuite-dev/);
  });

  test("and a real claim notification is delivered", () => {
    // The card is already owned by the claiming lane and sitting in backlog, so the owner does
    // not change and the board takes its `claimed` branch, which notifies coordinator. (A claim
    // that DOES change the owner takes the `assigned` branch and notifies the new owner
    // instead - a second, separately correct path that a single assertion would have missed.)
    const { repo, amqRoot } = fixture();
    const id = addCard(repo, amqRoot, { owner: "agsuite-dev", status: "backlog" });
    const before = inboxCount(amqRoot, "coordinator");
    claim(repo, amqRoot, id);
    assert.ok(inboxCount(amqRoot, "coordinator") > before, "a claim that happened is announced");
  });

  test("a claim that changes the owner notifies the NEW owner, as an assignment", () => {
    const { repo, amqRoot } = fixture();
    const id = addCard(repo, amqRoot, { owner: "range", status: "backlog" });
    const before = inboxCount(amqRoot, "agsuite-dev");
    claim(repo, amqRoot, id);
    assert.ok(inboxCount(amqRoot, "agsuite-dev") > before, "the lane that took it is told");
  });
});

describe("a re-claim reports the truth instead of a phantom transition", () => {
  test("nothing moves, and the output does not claim that it did", () => {
    const { repo, amqRoot } = fixture();
    const id = addCard(repo, amqRoot, { status: "in_progress", owner: "agsuite-dev" });
    const before = read(repo, amqRoot, id);
    const mailBefore = inboxCount(amqRoot, "coordinator");

    const r = claim(repo, amqRoot, id);
    const after = read(repo, amqRoot, id);

    assert.equal(after.updated, before.updated, "the state clock does not move");
    assert.equal(after.claims, before.claims, "the claim count does not move");
    assert.equal(after.claimed_at, before.claimed_at, "the claim record does not move");
    assert.equal(inboxCount(amqRoot, "coordinator"), mailBefore, "no claim notification is sent");

    // The two sentences that were fiction.
    assert.doesNotMatch(r.out, /Status -> in_progress/, "no phantom transition");
    assert.doesNotMatch(r.out, /Notification dispatched/, "no phantom notification");
    // And it says the useful thing, because a truthful no-op is the fix.
    assert.match(r.out, /already claimed by you/i);
    assert.match(r.out, /does NOT clear a stall/i, "it must not read as a remedy for a stall");
  });
});

describe("a claim does not take a card from another lane", () => {
  test("it refuses, writes nothing, sends nothing, and names the owner", () => {
    const { repo, amqRoot } = fixture();
    const id = addCard(repo, amqRoot, { status: "in_progress", owner: "range" });
    const before = read(repo, amqRoot, id);
    const mailBefore = inboxCount(amqRoot, "coordinator");

    const r = claim(repo, amqRoot, id);
    const after = read(repo, amqRoot, id);

    assert.notEqual(r.code, 0, "silently taking another lane's card is not a claim");
    assert.equal(after.owner, "range", "the owner is untouched");
    assert.equal(after.status, "in_progress");
    assert.equal(after.updated, before.updated);
    assert.equal(inboxCount(amqRoot, "coordinator"), mailBefore, "no notification");
    assert.match(r.err, /already claimed by range/, "and it says who holds it");
    assert.match(r.err, /reassign/i, "and it says the honest way to take it");
  });

  test("--force takes it, and admits that it took it from someone", () => {
    const { repo, amqRoot } = fixture();
    const id = addCard(repo, amqRoot, { status: "in_progress", owner: "range" });

    const r = claim(repo, amqRoot, id, ["--force"]);
    assert.equal(r.code, 0, r.err);
    const after = read(repo, amqRoot, id);
    assert.equal(after.owner, "agsuite-dev");
    assert.match(r.out, /Taken from range/, "an override that hides who it overrode is the same defect again");
  });
});

describe("claiming a card that does not exist", () => {
  test("fails loudly rather than reporting a claim", () => {
    const { repo, amqRoot } = fixture();
    const r = claim(repo, amqRoot, "task_does_not_exist");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /not found/i);
    assert.doesNotMatch(r.out, /claimed by/);
  });
});
