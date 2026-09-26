import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sendMaildirMessage, readMaildirMessages, commitMaildirMessages, writeDrainReceipt } from "../src/protocol.mjs";

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
    sendMaildirMessage(amqRoot, { from: "coordinator", to: ["worker"], subject: `Message ${i}`, body: "y".repeat(300) });
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
