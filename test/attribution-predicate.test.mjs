// A lane cannot legitimately mail itself. One predicate, no call-site knowledge, every handle.
//
// The predicate is the coordinator's and it is the right one: a message whose `from` is one of
// its own `to` addresses, and whose subject is not a board notification, is a
// MISATTRIBUTION. It needs no knowledge of which function stamped the value, which is why it
// survives a refactor that moves the default, and why it catches the case nobody was looking
// at: a QA verdict stamped from=coordinator is indistinguishable by eye from the 447 board
// notifications that also said coordinator, which is exactly how 447 lies hid a real one.
//
// The arms below are the two halves that make it an instrument rather than a rule:
//
//   * the predicate must FLAG a planted self-mail. A detector that cannot flag anything is a
//     detector that has never been tested, and this file has been written after a session in
//     which two such instruments passed;
//   * the predicate must NOT flag the legitimate cases, and the list is not short. A board
//     notification from `board` TO the coordinator pages the coordinator on purpose and is the
//     single most common notification the system sends; a lane replying to a message that
//     coordinator sent them addresses coordinator legitimately. Flagging either would train
//     everyone to ignore the output.
//
// Set AMQ_SCAN_ROOT to point the same predicate at a live tree, optionally with
// AMQ_SCAN_SINCE=<iso> to fail only on messages at or after a fix.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMisattribution, isBoardNotification, scanTree, report } from "../tools/scan-attribution.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attribscan-"));
  const amqRoot = path.join(root, ".agent-mail");
  for (const h of ["coordinator", "qa", "worker"]) {
    for (const s of ["inbox/new", "inbox/cur", "outbox/sent"]) {
      fs.mkdirSync(path.join(amqRoot, "agents", h, s), { recursive: true });
    }
  }
  return { root, amqRoot };
}

function deliver(amqRoot, header, body = "b") {
  const dir = path.join(amqRoot, "agents", header.to[0], "inbox", "new");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${header.id}.md`), `---json\n${JSON.stringify(header, null, 2)}\n---\n${body}\n`, "utf8");
}

const msg = (over = {}) => ({
  schema: 1, id: "2026-09-26T00-00-00-000Z_x", from: "qa", to: ["coordinator"],
  subject: "a real message", thread: "p2p/qa__coordinator", created: "2026-09-26T00:00:00.000Z", ...over,
});

test("the predicate flags a lane mailing itself", () => {
  assert.equal(isMisattribution(msg({ from: "coordinator", to: ["coordinator"] })), true);
  assert.equal(isMisattribution(msg({ from: "coordinator", to: ["coordinator", "qa"] })), true, "one self-address among several is still a self-mail");
});

test("the predicate does NOT flag the two legitimate self-addressed shapes", () => {
  // A board notification pages the coordinator, so board -> coordinator is the normal case and
  // is by far the most common message the system sends. A lane replying to a coordinator
  // message addresses the coordinator: on 13 real instances that address was CORRECT and only
  // the sender was wrong, which is a different defect caught by a different predicate.
  assert.equal(isMisattribution(msg({ from: "board", to: ["coordinator"], subject: "[AGboard] [BLOCKED] thing" })), false);
  assert.equal(isMisattribution(msg({ from: "coordinator", to: ["coordinator"], subject: "[AGboard] [ASSIGNED] thing" })), false,
    "even a coordinator-stamped notification is exempt, because a notification has no human sender to be wrong about");
  assert.equal(isMisattribution(msg({ from: "qa", to: ["coordinator"], subject: "Re: a real message" })), false);
  assert.equal(isMisattribution(msg({ from: "qa", to: ["coordinator", "worker"] })), false);
});

test("the predicate scans a tree, dedupes the outbox copy, and finds a planted instance", () => {
  const { root, amqRoot } = fixture();
  try {
    deliver(amqRoot, msg({ id: "m-ok-1" }));
    deliver(amqRoot, msg({ id: "m-ok-2", from: "board", to: ["coordinator"], subject: "[AGboard] [ASSIGNED] x" }));
    // The same message in the sender's outbox, as every delivered message really is. If the
    // scan did not dedupe, this would report 2 findings for 1 message and the counts would be
    // double the truth, which is how a measurement gets disbelieved.
    const outbox = path.join(amqRoot, "agents", "qa", "outbox", "sent");
    fs.writeFileSync(path.join(outbox, "m-ok-1.md"), `---json\n${JSON.stringify(msg({ id: "m-ok-1" }), null, 2)}\n---\nb\n`, "utf8");
    assert.equal(report(amqRoot).selfMail, 0, "nothing planted yet");

    deliver(amqRoot, msg({ id: "m-bad-1", from: "coordinator", to: ["coordinator"] }));
    const stats = report(amqRoot);
    assert.equal(stats.total, 3, "three unique messages, not four");
    assert.equal(stats.selfMail, 1, "the planted self-mail is found");
    assert.equal(stats.selfMailAfter, 1);
    assert.equal(stats.missingFrom, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("--since separates the historical population from the one that matters", () => {
  // The 31 real instances all predate the fix, and a tool that fails on them is a tool nobody
  // runs. The question that matters is whether any are still being produced.
  const { root, amqRoot } = fixture();
  try {
    deliver(amqRoot, msg({ id: "m-old", from: "coordinator", to: ["coordinator"], created: "2026-09-20T00:00:00.000Z" }));
    deliver(amqRoot, msg({ id: "m-new", from: "coordinator", to: ["coordinator"], created: "2026-09-26T22:00:00.000Z" }));
    assert.equal(report(amqRoot).selfMail, 2, "both are real instances");
    assert.equal(report(amqRoot, "2026-09-26T00:00:00.000Z").selfMailAfter, 1, "only the recent one is a live defect");
    assert.equal(report(amqRoot, "2027-01-01T00:00:00.000Z").selfMailAfter, 0, "and after the next fix, none");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a message with no sender is reported separately, not as a self-mail", () => {
  // A missing `from` is a different defect from a wrong one, and folding it into the same
  // count would hide which one is present. Measured 0 tree-wide on the live root, which is
  // what makes the reply-recipient fallback in protocol.mjs unreachable rather than merely rare.
  assert.equal(isMisattribution({ to: ["coordinator"], subject: "x" }), false);
  const { root, amqRoot } = fixture();
  try {
    const dir = path.join(amqRoot, "agents", "coordinator", "inbox", "new");
    fs.writeFileSync(path.join(dir, "m-nofrom.md"), `---json\n${JSON.stringify({ schema: 1, id: "m-nofrom", to: ["coordinator"], subject: "x", created: "2026-09-26T00:00:00.000Z" })}\n---\nb\n`, "utf8");
    const stats = report(amqRoot);
    assert.equal(stats.missingFrom, 1);
    assert.equal(stats.selfMail, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the live tree, when pointed at, is clean of new misattributions", { skip: !process.env.AMQ_SCAN_ROOT }, () => {
  const stats = report(process.env.AMQ_SCAN_ROOT, process.env.AMQ_SCAN_SINCE || null);
  assert.equal(
    stats.selfMailAfter,
    0,
    `misattributed messages at or after ${process.env.AMQ_SCAN_SINCE || "the beginning of time"}:\n` +
      stats.selfMailAfterMessages.map((h) => `  ${h.created} ${h.id} from=${h.from} to=${JSON.stringify(h.to)} ${h.subject}`).join("\n"),
  );
});
