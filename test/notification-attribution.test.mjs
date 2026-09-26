import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, updateBoardTask, notifyTaskEvent } from "../src/board.mjs";
import { readMaildirMessages } from "../src/protocol.mjs";

// A board notification that names the wrong agent is not a formatting problem. It puts a
// durable record asserting an action somebody did not take, and it pages that agent
// about work they cannot clear. The owner is NOT the actor, and the board must never
// borrow the owner's identity to fill a missing one.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attrib-"));
  const amqRoot = path.join(root, ".agent-mail");
  for (const h of ["coordinator", "testkit", "qa"]) {
    for (const sub of ["inbox/new", "inbox/cur", "outbox/sent", "receipts"]) {
      fs.mkdirSync(path.join(amqRoot, "agents", h, sub), { recursive: true });
    }
  }
  return { root, amqRoot };
}

function notifications(amqRoot) {
  return readMaildirMessages(amqRoot, "coordinator");
}
const bySubject = (amqRoot, re) => notifications(amqRoot).find((m) => re.test(m.header?.subject || ""))?.body || "";

test("a status change with no supplied actor is NOT attributed to the card owner", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Fix the thing", owner: "testkit" }, { notify: false });
    assert.ok(created.ok);
    // Exactly the coordinator's call: no `from`, because the PATCH body did not carry one.
    const res = updateBoardTask(root, amqRoot, created.task.id, { status: "blocked", next_actor: "qa" }, {
      reason: "Waiting on a qa sign-off that qa owns.",
    });
    assert.equal(res.ok, true);
    const body = bySubject(amqRoot, /\[BLOCKED\]/);
    assert.ok(body, "a blocked notification should have been sent");
    assert.ok(
      !/TASK BLOCKED by testkit/i.test(body),
      `the notification invents an action by the owner: ${JSON.stringify(body)}`,
    );
    assert.ok(
      !/\bby testkit\b/i.test(body),
      `testkit is named as the actor anywhere in: ${JSON.stringify(body)}`,
    );
    // Unattributed, and honest about being unattributed.
    assert.match(body, /changed by:?\s*not recorded/i, "a missing actor must be stated, not invented");
    // The ENVELOPE matters as much as the body: this is a durable record, and a record
    // reading "from: testkit" asserts a testkit action whatever the body says. Asserting
    // only the body let a break that restored the owner fallback come back green.
    const msg = notifications(amqRoot).find((m) => /\[BLOCKED\]/.test(m.header?.subject || ""));
    assert.ok(msg, "the notification itself must exist");
    assert.notEqual(msg.header?.from, "testkit", "the message must not be sent AS the owner");
    assert.match(String(msg.header?.from || ""), /^(board|coordinator)$/,
      "an unattributed change carries the board's own identity, never a named agent");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the notification separates who changed the state from who owns the card", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Second thing", owner: "testkit" }, { notify: false });
    updateBoardTask(root, amqRoot, created.task.id, { status: "blocked", next_actor: "qa" }, {
      from: "coordinator", reason: "Waiting on a qa sign-off that qa owns.",
    });
    const body = bySubject(amqRoot, /\[BLOCKED\]/);
    assert.ok(body);
    assert.match(body, /changed by:?\s*coordinator/i, "the actor must be named when it is known");
    assert.match(body, /card owner:?\s*testkit/i, "and the owner stated separately, not as the actor");
    assert.ok(!/TASK BLOCKED by testkit/i.test(body));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a block whose next actor is not the owner does not tell the owner to unblock it", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Third thing", owner: "testkit" }, { notify: false });
    updateBoardTask(root, amqRoot, created.task.id, { status: "blocked", next_actor: "qa" }, {
      from: "coordinator", reason: "Waiting on a qa sign-off that qa owns.",
    });
    const body = bySubject(amqRoot, /\[BLOCKED\]/);
    assert.match(body, /next actor:?\s*qa/i, "the notification must name who is actually on the hook");
    // Strict, not an "either/or": an unblock-review demand aimed at an owner who is not
    // the next actor is the entire harm. An assertion satisfied merely by the next-actor
    // line EXISTING let a break that removed the distinction stay green.
    assert.ok(
      !/needs coordination \/ unblock review/i.test(body),
      `demands an unblock review from an owner who is not the next actor: ${JSON.stringify(body)}`,
    );
    assert.match(body, /not expected to unblock/i, "and says the owner is not on the hook");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an untriaged block names no next actor and does ask for triage", () => {
  const { root, amqRoot } = fixture();
  try {
    // next_actor: null at creation, so this is genuinely untriaged. (A card created with
    // an owner but no explicit next_actor defaults to the owner, and then the owner IS
    // on the hook - which is truthful, so this test must not pretend otherwise.)
    const created = addBoardTask(root, amqRoot, { title: "Fourth thing", owner: "testkit", next_actor: null }, { notify: false });
    updateBoardTask(root, amqRoot, created.task.id, { status: "blocked" }, {
      from: "coordinator", reason: "No qa sign-off has been requested yet, so this needs triage.",
    });
    const body = bySubject(amqRoot, /\[BLOCKED\]/);
    assert.match(body, /changed by:?\s*coordinator/i);
    assert.match(body, /card owner:?\s*testkit/i);
    assert.ok(!/TASK BLOCKED by testkit/i.test(body));
    assert.match(body, /next actor:?\s*unassigned/i, "an untriaged block must not invent a next actor");
    assert.match(body, /needs coordination \/ unblock review/i, "an untriaged block does need triage");
    // The actor IS known here, so the envelope should carry it.
    const msg = notifications(amqRoot).find((m) => /\[BLOCKED\]/.test(m.header?.subject || ""));
    assert.equal(msg?.header?.from, "coordinator", "a known actor is credited in the envelope");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a block whose next actor really is the owner still asks the owner to act", () => {
  const { root, amqRoot } = fixture();
  try {
    // Created with the owner as next actor, so nobody is being misdirected here.
    const created = addBoardTask(root, amqRoot, { title: "Owner-on-the-hook", owner: "testkit" }, { notify: false });
    updateBoardTask(root, amqRoot, created.task.id, { status: "blocked" }, {
      from: "coordinator", reason: "Blocked on something only the owner can clear, pending their input.",
    });
    const body = bySubject(amqRoot, /\[BLOCKED\]/);
    assert.match(body, /next actor:?\s*testkit/i);
    assert.match(body, /needs coordination \/ unblock review/i,
      "the fix must not silence a genuine request to the person who is on the hook");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a claim with no supplied actor is not attributed to the owner either", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Fifth thing", owner: "testkit" }, { notify: false });
    updateBoardTask(root, amqRoot, created.task.id, { status: "in_progress" });
    const body = bySubject(amqRoot, /\[CLAIMED\]/);
    assert.ok(body, "a claim notification should have been sent");
    assert.ok(!/claimed by testkit/i.test(body), `claims a testkit action: ${JSON.stringify(body)}`);
    assert.match(body, /changed by:?\s*not recorded/i, "an unclaimed actor is not the owner's name");
    const msg = notifications(amqRoot).find((m) => /\[CLAIMED\]/.test(m.header?.subject || ""));
    assert.notEqual(msg?.header?.from, "testkit", "and the envelope is not the owner's either");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The ENVELOPE, not only the body. Every arm above reads the notification's text, and the
// text was fixed while the sender field kept borrowing the coordinator's identity: 247 of 283
// [ASSIGNED] notifications on the live tree carried from=coordinator. A notification has no
// human sender, and the coordinator did not send them.
//
// Asserted on the DELIVERED header, read from the recipient's mailbox, and the assertion is
// the ABSENCE of the wrong value: an arm that merely checked for `board` would still pass if
// the fix had added `board` alongside a coordinator that was still there.
function deliveredSender(amqRoot, mailbox, re) {
  return readMaildirMessages(amqRoot, mailbox).find((m) => re.test(m.header?.subject || ""))?.header?.from;
}

test("a card created with no sender notifies as the board, not as the coordinator", () => {
  const { root, amqRoot } = fixture();
  try {
    const created = addBoardTask(root, amqRoot, { title: "Sixth thing", owner: "testkit" });
    assert.ok(created.ok);
    const from = deliveredSender(amqRoot, "testkit", /\[ASSIGNED\]/);
    assert.ok(from, "the assignment notification was delivered");
    assert.notEqual(from, "coordinator", "the coordinator did not send this, and the record says it did");
    assert.equal(from, "board", "the board's own automation identity is the honest sender");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an explicit sender on card creation is still honoured", () => {
  // The stamp replaces a DEFAULT, not the ability to say who acted. Without this arm, "always
  // board" would pass the arm above and lose the attribution that makes a board action
  // traceable to a lane.
  const { root, amqRoot } = fixture();
  try {
    addBoardTask(root, amqRoot, { title: "Seventh thing", owner: "testkit", from: "coordinator" });
    assert.equal(deliveredSender(amqRoot, "testkit", /\[ASSIGNED\]/), "coordinator");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("notifyTaskEvent called with no sender at all notifies as the board", () => {
  // The only way to REACH notifyTaskEvent's own default, because all five internal callers
  // pass `from` explicitly. It is exported, so an external caller can omit it, and the arm
  // above cannot see it: with the default sabotaged back to `coordinator` the create-path arm
  // stayed green, which is exactly how a default nobody exercises survives a review.
  const { root, amqRoot } = fixture();
  try {
    const res = notifyTaskEvent(amqRoot, "blocked", {
      id: "task-external-1", title: "External caller", owner: "qa", status: "blocked",
    }, { reason: "Waiting on something." });
    assert.ok(res.ok, `the notification should still be sent: ${JSON.stringify(res)}`);
    // A [BLOCKED] notification is addressed to the coordinator on purpose: it PAGES them, and
    // the bridge reads entries addressed to coordinator. So the recipient is the coordinator
    // and the sender must be the board, and reading any other mailbox here would assert on an
    // empty list and pass for the wrong reason - which is what it did on the first draft.
    const from = deliveredSender(amqRoot, "coordinator", /\[BLOCKED\]/);
    assert.notEqual(from, "coordinator", "no human sent this");
    assert.equal(from, "board");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
