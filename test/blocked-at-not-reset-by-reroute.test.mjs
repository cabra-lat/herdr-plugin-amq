import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * RE-ROUTING A BLOCKED CARD MUST NOT RESTART ITS WAIT CLOCK.
 *
 * `blocked_at` was reset to now whenever an owner or next_actor change landed on an already
 * blocked card. So any routine correction silently removed the card from the oldest-blocked
 * ranking - the fix for a stale field CAUSING the staleness. Coordinator lost 3, 54 and 113
 * minutes of wait age this way, caught by comparing two consecutive alerts: three cards at
 * 3m/54m/113m became three cards at 28-29s in one command, and three untouched controls kept
 * their original stamps.
 *
 * IT WAS NOT BANKED. blocked_total_ms stayed 0, so the wait was destroyed rather than moved, and
 * there is no verb to SET blocked_at - so those ages survive only as comments somebody happened
 * to write down. The `block` verb already did the opposite and preserved the stamp, so two verbs
 * disagreed about the same field and the destructive one is the one you reach for while FIXING
 * something.
 *
 * Run through the real CLI rather than against the library, because the defect was a verb's
 * behaviour and a library-level test would have been testing the function the verb happens to
 * call - which is exactly the assumption that made the two verbs' disagreement invisible.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "herdr-amq.mjs");

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reroute-wait-"));
  fs.mkdirSync(path.join(root, ".agent-mail", "bus"), { recursive: true });
  return root;
}
function cli(root, args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: root, env: { ...process.env, AMQ_ME: "lane" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}
const cardIn = (root, id) => {
  for (const stage of ["blocked", "doing", "backlog", "queued", "done"]) {
    const f = path.join(root, ".agent-mail", "bus", stage, `${id}.md`);
    if (fs.existsSync(f)) return { stage, text: fs.readFileSync(f, "utf8") };
  }
  throw new Error(`card ${id} not found`);
};
const field = (text, name) => text.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];
const newCard = (root) => cli(root, ["task", "create", "--title", "aged blocker", "--owner", "lane"])
  .match(/task_[0-9a-f_]{8,}/)?.[0];

test("re-pointing next_actor PRESERVES blocked_at", () => {
  const root = workspace();
  const id = newCard(root);
  cli(root, ["task", "block", id, "--reason", "waiting on a human", "--next-actor", "user"]);
  const before = field(cardIn(root, id).text, "blocked_at");
  cli(root, ["task", "reassign", id, "--to", "lane", "--next-actor", "verifier"]);
  const after = field(cardIn(root, id).text, "blocked_at");
  assert.ok(before, "the card is blocked and carries a stamp");
  assert.equal(after, before, "correcting the routing is not the same event as starting to wait");
});

test("and so does re-pointing OWNER - both fields triggered the reset", () => {
  const root = workspace();
  const id = newCard(root);
  cli(root, ["task", "block", id, "--reason", "waiting", "--next-actor", "user"]);
  const before = field(cardIn(root, id).text, "blocked_at");
  cli(root, ["task", "reassign", id, "--to", "someone-else"]);
  assert.equal(field(cardIn(root, id).text, "blocked_at"), before);
});

test("THE CONTROL: a genuine NEW block still stamps now", () => {
  // Without this, "always preserve" would satisfy every arm above while making blocked_at
  // meaningless - a card that entered blocked without a stamp cannot be ranked at all.
  const root = workspace();
  const id = newCard(root);
  cli(root, ["task", "block", id, "--reason", "first wait", "--next-actor", "user"]);
  cli(root, ["task", "unblock", id, "--stage", "doing", "--reason", "moving on"]);
  const movedAt = Date.now();
  cli(root, ["task", "block", id, "--reason", "a genuinely new wait", "--next-actor", "user"]);
  const stamp = Date.parse(field(cardIn(root, id).text, "blocked_at").replace(/"/g, ""));
  assert.ok(Number.isFinite(stamp), "a new block has a parseable stamp");
  assert.ok(stamp >= movedAt - 5_000, "and it is the NEW block's time, not the old one");
});

test("and the wait is still BANKED on the way out - preserving is not discarding", () => {
  const root = workspace();
  const id = newCard(root);
  cli(root, ["task", "block", id, "--reason", "waiting", "--next-actor", "user"]);
  cli(root, ["task", "reassign", id, "--to", "lane", "--next-actor", "verifier"]);
  cli(root, ["task", "unblock", id, "--stage", "doing", "--reason", "resolved"]);
  const text = cardIn(root, id).text;
  assert.notEqual(field(text, "blocked_total_ms"), null, "total blocked time is recorded");
  assert.notEqual(field(text, "blocked_total_ms"), "0",
    "and it is not zero - a re-route must not bank the elapsed time twice, nor lose it");
});
