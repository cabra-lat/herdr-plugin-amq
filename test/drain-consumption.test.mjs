import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sendMaildirMessage, readMaildirMessages, commitMaildirMessages, writeDrainReceipt, markMaildirMessageRead } from "../src/protocol.mjs";

const BIN = path.resolve("bin/herdr-amq.mjs");

function fixture(count = 3) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drain-"));
  const amqRoot = path.join(root, ".agent-mail");
  for (const handle of ["coordinator", "worker"]) {
    for (const sub of ["inbox/new", "inbox/cur", "outbox/sent", "receipts"]) {
      fs.mkdirSync(path.join(amqRoot, "agents", handle, sub), { recursive: true });
    }
  }
  for (let i = 0; i < count; i += 1) {
    sendMaildirMessage(amqRoot, { from: "coordinator", to: ["worker"], subject: `Message ${i}`, body: `Testing ${i} ` + "y".repeat(300) });
  }
  return { root, amqRoot };
}

const countIn = (amqRoot, handle, sub) => {
  const dir = path.join(amqRoot, "agents", handle, "inbox", sub);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length : 0;
};
const countReceipts = (amqRoot, handle) => {
  const dir = path.join(amqRoot, "agents", handle, "receipts");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;
};
const run = (root, args) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: root, encoding: "utf8", env: { ...process.env, AM_ROOT: path.join(root, ".agent-mail") },
});

// The hazard: a pipe that accepts the bytes and then discards them. `head -3` reads all
// 118KB and shows three lines, and NO error is raised anywhere - a successful write
// proves the reader accepted the data, not that a human saw it. Two earlier fixes failed
// on exactly this, so the rule is that consuming is never a side effect of looking.
// A message appearing twice in one drain is indistinguishable from a message delivered
// twice. That ambiguity is not cosmetic: it is what let a mis-diagnosis look confirmed,
// because a reader could not tell one message from two.
test("each message is printed exactly once, on a single file on disk", () => {
  const { root, amqRoot } = fixture(1);
  try {
    const out = run(root, ["mail", "drain", "--me", "worker", "--include-body"]);
    assert.equal(out.status, 0, out.stderr);
    const onDisk = fs.readdirSync(path.join(amqRoot, "agents", "worker", "inbox", "new"))
      .filter((f) => f.endsWith(".md"));
    assert.equal(onDisk.length, 1, "the fixture must really contain a single message");
    const id = onDisk[0].replace(/\.md$/, "");
    const occurrences = (out.stdout.match(new RegExp(`ID: ${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g")) || []).length;
    assert.equal(occurrences, 1, "the one message must be printed exactly once, not twice");
    assert.equal((out.stdout.match(/Testing/g) || []).length, 1, "and its body must appear once");
    assert.equal((out.stdout.match(/^\[AMQ\]/gm) || []).length, 1, "one header, not two");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the same holds for a multi-message drain", () => {
  const { root, amqRoot } = fixture(6);
  try {
    const out = run(root, ["mail", "drain", "--me", "worker"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal((out.stdout.match(/^\[AMQ\]/gm) || []).length, 1, "exactly one header line");
    for (const f of fs.readdirSync(path.join(amqRoot, "agents", "worker", "inbox", "new")).filter((f) => f.endsWith(".md"))) {
      const id = f.replace(/\.md$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.equal((out.stdout.match(new RegExp(`ID: ${id}`, "g")) || []).length, 1, `${id} printed once`);
    }
    assert.equal((out.stdout.match(/^  Subject:/gm) || []).length, 6, "six subjects, not twelve");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("--consume prints each message once as well", () => {
  const { root } = fixture(3);
  try {
    const out = run(root, ["mail", "drain", "--me", "worker", "--consume"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal((out.stdout.match(/^\[AMQ\]/gm) || []).length, 1);
    assert.equal((out.stdout.match(/^  Subject:/gm) || []).length, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


// Marking a single message read is the OTHER way mail leaves new/, and it used to write
// no receipt - so a message promoted this way was indistinguishable, in the filesystem,
// from one that had actually been displayed. Same gap the drain had.
test("marking a single message read records a receipt with stage 'read'", () => {
  const { amqRoot } = fixture(1);
  try {
    const waiting = readMaildirMessages(amqRoot, "worker");
    assert.equal(waiting.length, 1);
    const res = markMaildirMessageRead(amqRoot, "worker", waiting[0].id);
    assert.equal(res.ok, true, res.error);
    assert.equal(countIn(amqRoot, "worker", "cur"), 1, "the message is promoted");
    const files = fs.readdirSync(path.join(amqRoot, "agents", "worker", "receipts"));
    assert.equal(files.length, 1, "and the promotion left a record");
    const receipt = JSON.parse(fs.readFileSync(path.join(amqRoot, "agents", "worker", "receipts", files[0]), "utf8"));
    assert.equal(receipt.stage, "read");
    assert.equal(receipt.consumer, "worker");
    assert.equal(receipt.sender, "coordinator");
    assert.equal(receipt.msg_id, waiting[0].id);
    // A read receipt must not be mistakable for a drain receipt.
    assert.ok(files[0].endsWith("__read.json"));
  } finally { fs.rmSync(amqRoot, { recursive: true, force: true }); }
});

test("re-marking an already-read message does not fabricate a second receipt", () => {
  const { amqRoot } = fixture(1);
  try {
    const waiting = readMaildirMessages(amqRoot, "worker");
    assert.equal(markMaildirMessageRead(amqRoot, "worker", waiting[0].id).ok, true);
    assert.equal(countReceipts(amqRoot, "worker"), 1);
    const again = markMaildirMessageRead(amqRoot, "worker", waiting[0].id);
    assert.equal(again.ok, true);
    assert.equal(again.alreadyRead, true, "it was already in cur/");
    assert.equal(countReceipts(amqRoot, "worker"), 1, "no second, invented consumption");
  } finally { fs.rmSync(amqRoot, { recursive: true, force: true }); }
});

test("drain does NOT consume by default, so a truncated read cannot lose mail", () => {
  const { root, amqRoot } = fixture(40);
  try {
    const out = spawnSync(process.execPath, [BIN, "mail", "drain", "--me", "worker"], {
      cwd: root, encoding: "utf8", env: { ...process.env, AM_ROOT: amqRoot },
    });
    // A reader that goes away after three lines.
    spawnSync("sh", ["-c", `node ${BIN} mail drain --me worker | head -3 > /dev/null`], {
      cwd: root, encoding: "utf8", env: { ...process.env, AM_ROOT: amqRoot },
    });
    assert.equal(countIn(amqRoot, "worker", "new"), 40, "every message must still be in new/");
    assert.equal(countIn(amqRoot, "worker", "cur"), 0, "nothing may be promoted as consumed");
    assert.equal(countReceipts(amqRoot, "worker"), 0, "and nothing may claim to have been read");
    assert.ok(out.status === 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the default drain says plainly that nothing was consumed", () => {
  const { root, amqRoot } = fixture(2);
  try {
    const out = run(root, ["mail", "drain", "--me", "worker"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /not consumed/i, "the reader must be told the inbox is unchanged");
    assert.match(out.stdout, /--consume/, "and told how to actually mark them read");
    assert.equal(countIn(amqRoot, "worker", "new"), 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("--consume promotes and writes an auditable receipt", () => {
  const { root, amqRoot } = fixture(3);
  try {
    const out = run(root, ["mail", "drain", "--me", "worker", "--consume"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(countIn(amqRoot, "worker", "new"), 0);
    assert.equal(countIn(amqRoot, "worker", "cur"), 3);
    assert.equal(countReceipts(amqRoot, "worker"), 3, "consumption must leave a record");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the receipt records who consumed it, when, and which message", () => {
  const { amqRoot } = fixture(1);
  try {
    const waiting = readMaildirMessages(amqRoot, "worker");
    assert.equal(waiting.length, 1);
    const at = new Date("2026-09-26T07:00:00.000Z");
    assert.ok(writeDrainReceipt(amqRoot, "worker", waiting[0], { now: at }));
    const file = fs.readdirSync(path.join(amqRoot, "agents", "worker", "receipts"))[0];
    const receipt = JSON.parse(fs.readFileSync(path.join(amqRoot, "agents", "worker", "receipts", file), "utf8"));
    assert.equal(receipt.consumer, "worker");
    assert.equal(receipt.sender, "coordinator");
    assert.equal(receipt.stage, "drained");
    assert.equal(receipt.emitted_at, "2026-09-26T07:00:00.000Z");
    assert.equal(receipt.msg_id, waiting[0].id);
    // The filename must name the message, the consumer and the stage, so a receipt is
    // findable from a cur/ file without opening either.
    assert.ok(file.includes(waiting[0].id) && file.includes("worker") && file.includes("drained"));
  } finally { fs.rmSync(amqRoot, { recursive: true, force: true }); }
});

test("a message in cur/ WITHOUT a receipt is now distinguishable from one that was read", () => {
  const { amqRoot } = fixture(2);
  try {
    const waiting = readMaildirMessages(amqRoot, "worker");
    commitMaildirMessages(amqRoot, "worker", [waiting[0]]);
    const cur = fs.readdirSync(path.join(amqRoot, "agents", "worker", "inbox", "cur"));
    const receipts = new Set(fs.readdirSync(path.join(amqRoot, "agents", "worker", "receipts")).map((f) => f.split("__")[0]));
    // This is the whole point of the receipt: "present in cur/" alone used to be
    // ambiguous between read and swallowed.
    const withReceipt = cur.filter((f) => receipts.has(f.replace(/\.md$/, "")));
    assert.equal(withReceipt.length, 1, "exactly the consumed message has a receipt");
    assert.equal(cur.length, 1);
  } finally { fs.rmSync(amqRoot, { recursive: true, force: true }); }
});

test("reading does not consume: the read phase alone leaves everything in new/", () => {
  const { amqRoot } = fixture(3);
  try {
    const waiting = readMaildirMessages(amqRoot, "worker");
    assert.equal(waiting.length, 3);
    assert.equal(countIn(amqRoot, "worker", "new"), 3, "a read must not promote");
    assert.equal(countIn(amqRoot, "worker", "cur"), 0);
  } finally { fs.rmSync(amqRoot, { recursive: true, force: true }); }
});

test("draining another agent's inbox does not mark their mail as read by default", () => {
  // The verification move that made this whole incident: checking whether somebody ELSE
  // received a message by draining their inbox. Non-destructive by default, so checking
  // can no longer be the thing that consumes.
  const { root, amqRoot } = fixture(2);
  try {
    const out = run(root, ["mail", "drain", "--me", "worker"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(countIn(amqRoot, "worker", "new"), 2, "a peek at another inbox must not consume it");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
