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

test("reply and read resolve IDs when AMQ filename uses dot milliseconds", () => {
  const tmpAmq = fs.mkdtempSync(path.join(os.tmpdir(), "amq-wire-id-test-"));
  try {
    const sent = sendMaildirMessage(tmpAmq, {
      from: "coordinator",
      to: ["spotter"],
      subject: "Wire ID compatibility",
      body: "Please verify the original message.",
    });
    const canonical = path.join(tmpAmq, "agents", "spotter", "inbox", "new", `${sent.id}.md`);
    const wireId = sent.id.replace(/-(\d{3}Z_pid)/, ".$1");
    const wireName = `${wireId}.md`;
    const canonicalContent = fs.readFileSync(canonical, "utf8").replace(sent.id, wireId);
    fs.writeFileSync(canonical, canonicalContent);
    fs.renameSync(canonical, path.join(tmpAmq, "agents", "spotter", "inbox", "new", wireName));

    const reply = replyMaildirMessage(tmpAmq, {
      from: "spotter",
      replyToId: sent.id,
      body: "Reply found the wire-format message.",
    });
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.to, ["coordinator"]);
    assert.deepEqual(reply.refs, [sent.id]);

    const read = markMaildirMessageRead(tmpAmq, "spotter", sent.id);
    assert.equal(read.ok, true);
    assert.equal(read.alreadyRead, false);
    assert.equal(read.filePath.endsWith(wireName), true);
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

test("every id spelling resolves to the same message AND the same counterpart, with a bogus-id control", () => {
  // The form that failed live: dots for EVERY time separator, not just the
  // milliseconds. Resolution is only half the contract — a normaliser that finds
  // the right message and hands the reply to a default recipient is a new defect
  // wearing the fix's clothes.
  //
  // The original sender is deliberately NOT the default reply target: if the
  // fixture's sender happens to be the fallback, a build that always replies to
  // the default passes, which is a fixed answer reading as a passing answer.
  const tmpAmq = fs.mkdtempSync(path.join(os.tmpdir(), "amq-id-spelling-test-"));
  try {
    const sent = sendMaildirMessage(tmpAmq, {
      from: "qa",
      to: ["spotter"],
      subject: "Spelling variants",
      body: "Original.",
    });
    const allDots = sent.id.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1.$2.$3");
    const colons = sent.id.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
    assert.notEqual(allDots, sent.id, "the all-dots spelling must differ from the canonical id");
    assert.notEqual(colons, sent.id, "the colon spelling must differ from the canonical id");

    for (const [label, id] of [["canonical", sent.id], ["all-dots", allDots], ["colon-separated", colons]]) {
      const found = findMessageById(tmpAmq, id);
      assert.ok(found, `${label} id did not resolve`);
      // Same object, not merely a hit: same message, same sender.
      assert.equal(found.header.id, sent.id, `${label} resolved to a different message`);
      assert.equal(found.header.from, "qa", `${label} resolved to a different sender`);

      // Same object on the write side: the reply must go back to THIS message's
      // sender, which is not the tool's default reply target.
      const reply = replyMaildirMessage(tmpAmq, { from: "spotter", replyToId: id, body: `via ${label}` });
      assert.equal(reply.ok, true, `${label} reply failed`);
      assert.deepEqual(reply.to, ["qa"], `${label} reply went to the wrong recipient`);
    }

    // Negative control: an unknown id resolves to nothing rather than to something.
    assert.equal(findMessageById(tmpAmq, "2020-01-01T00-00-00-000Z_pid1_deadbeef"), null);
    assert.equal(findMessageById(tmpAmq, "not-an-id-at-all"), null);
  } finally {
    fs.rmSync(tmpAmq, { recursive: true, force: true });
  }
});
