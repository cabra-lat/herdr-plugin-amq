import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  generateMessageId,
  computeCanonicalThread,
  serializeMessage,
  parseMessage,
  ensureAgentMailbox,
  sendMaildirMessage,
  replyMaildirMessage,
  drainMaildir,
  findMessageById,
  markMaildirMessageRead,
} from "../src/protocol.mjs";

test("AMQ Message ID and Thread formatting", () => {
  const msgId = generateMessageId();
  assert.match(msgId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z_pid\d+_[a-f0-9]{8}$/);

  const p2pThread = computeCanonicalThread("coordinator", ["ballistics"]);
  assert.equal(p2pThread, "p2p/ballistics__coordinator");

  const groupThread = computeCanonicalThread("coordinator", ["spotter", "meta"]);
  assert.equal(groupThread, "group/coordinator__meta__spotter");
});

test("AMQ RFC 5322 JSON frontmatter serialization and parsing", () => {
  const msg = {
    id: "msg-12345",
    from: "coordinator",
    to: ["range"],
    subject: "Harness check",
    body: "Please verify arena_spawn.",
    priority: "urgent",
    kind: "todo",
    labels: ["gate", "spawn"],
    created: "2026-09-23T10:00:00.000Z",
  };

  const raw = serializeMessage(msg);
  assert.ok(raw.startsWith("---json\n"));
  assert.ok(raw.includes('"id": "msg-12345"'));
  assert.ok(raw.includes('"kind": "todo"'));
  assert.ok(raw.includes("Please verify arena_spawn."));

  const parsed = parseMessage(raw);
  assert.equal(parsed.header.id, "msg-12345");
  assert.equal(parsed.header.from, "coordinator");
  assert.deepEqual(parsed.header.to, ["range"]);
  assert.equal(parsed.header.priority, "urgent");
  assert.equal(parsed.header.kind, "todo");
  assert.equal(parsed.body.trim(), "Please verify arena_spawn.");
});

test("Native Maildir message delivery (DJB tmp -> new rename)", () => {
  const tmpAmq = fs.mkdtempSync(path.join(os.tmpdir(), "amq-proto-test-"));
  try {
    const res = sendMaildirMessage(tmpAmq, {
      from: "coordinator",
      to: ["testkit", "ballistics"],
      subject: "Test dispatch",
      body: "Verification body content.",
      priority: "normal",
      kind: "status",
    });

    assert.equal(res.ok, true);
    assert.ok(res.id);

    // Verify recipient inboxes have the message in inbox/new
    const testkitNew = path.join(tmpAmq, "agents", "testkit", "inbox", "new", `${res.id}.md`);
    const ballisticsNew = path.join(tmpAmq, "agents", "ballistics", "inbox", "new", `${res.id}.md`);
    assert.equal(fs.existsSync(testkitNew), true);
    assert.equal(fs.existsSync(ballisticsNew), true);

    // Verify sender outbox has a copy in outbox/sent
    const senderSent = path.join(tmpAmq, "agents", "coordinator", "outbox", "sent", `${res.id}.md`);
    assert.equal(fs.existsSync(senderSent), true);

    // Drain testkit mailbox (new -> cur transition)
    const drained = drainMaildir(tmpAmq, "testkit");
    assert.equal(drained.length, 1);
    assert.equal(drained[0].id, res.id);
    assert.equal(fs.existsSync(testkitNew), false);

    const testkitCur = path.join(tmpAmq, "agents", "testkit", "inbox", "cur", `${res.id}.md`);
    assert.equal(fs.existsSync(testkitCur), true);
  } finally {
    fs.rmSync(tmpAmq, { recursive: true, force: true });
  }
});

test("markMaildirMessageRead moves only the addressed message to cur", () => {
  const tmpAmq = fs.mkdtempSync(path.join(os.tmpdir(), "amq-read-test-"));
  try {
    const sent = sendMaildirMessage(tmpAmq, {
      from: "coordinator",
      to: ["user", "range"],
      subject: "Read state check",
      body: "Open me from the user mailbox.",
    });
    const userResult = markMaildirMessageRead(tmpAmq, "user", sent.id);
    assert.deepEqual(userResult, {
      ok: true,
      alreadyRead: false,
      id: sent.id,
      filePath: path.join(tmpAmq, "agents", "user", "inbox", "cur", `${sent.id}.md`),
    });
    assert.equal(fs.existsSync(path.join(tmpAmq, "agents", "user", "inbox", "new", `${sent.id}.md`)), false);
    assert.equal(fs.existsSync(path.join(tmpAmq, "agents", "range", "inbox", "new", `${sent.id}.md`)), true);
    assert.deepEqual(markMaildirMessageRead(tmpAmq, "user", sent.id), {
      ok: true,
      alreadyRead: true,
      id: sent.id,
      filePath: path.join(tmpAmq, "agents", "user", "inbox", "cur", `${sent.id}.md`),
    });
    assert.equal(markMaildirMessageRead(tmpAmq, "range", sent.id).ok, true);
  } finally {
    fs.rmSync(tmpAmq, { recursive: true, force: true });
  }
});

test("Native Maildir reply with RFC 5322 References chaining", () => {
  const tmpAmq = fs.mkdtempSync(path.join(os.tmpdir(), "amq-reply-test-"));
  try {
    // 1. Send original message from coordinator to spotter
    const orig = sendMaildirMessage(tmpAmq, {
      from: "coordinator",
      to: ["spotter"],
      subject: "Strip check",
      body: "Please run camera pitch strip.",
    });

    // 2. Spotter replies to coordinator
    const reply = replyMaildirMessage(tmpAmq, {
      from: "spotter",
      replyToId: orig.id,
      body: "Strip completed: 3/3 PASS.",
    });

    assert.equal(reply.ok, true);
    assert.deepEqual(reply.to, ["coordinator"]);
    assert.equal(reply.subject, "Re: Strip check");

    // Check delivered reply in coordinator inbox/new
    const replyFile = path.join(tmpAmq, "agents", "coordinator", "inbox", "new", `${reply.id}.md`);
    assert.equal(fs.existsSync(replyFile), true);

    const content = fs.readFileSync(replyFile, "utf8");
    const parsed = parseMessage(content);
    assert.equal(parsed.header.from, "spotter");
    assert.deepEqual(parsed.header.to, ["coordinator"]);
    assert.deepEqual(parsed.header.refs, [orig.id]);
    assert.equal(parsed.body.trim(), "Strip completed: 3/3 PASS.");
  } finally {
    fs.rmSync(tmpAmq, { recursive: true, force: true });
  }
});
