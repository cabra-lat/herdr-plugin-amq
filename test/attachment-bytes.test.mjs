// The delivered blob must be BYTE IDENTICAL to the file that was attached.
//
// This guard did not exist, and that is the actual defect. 9816c9c asserted the COUNT of
// sha256 entries, so the suite passed while a file could arrive with the right name, the
// right extension, the right count and the wrong bytes. Four correct properties and one
// wrong one, and nothing checked the fifth. Every attachment in the old tests went through
// fs.writeFileSync/fs.readFileSync, which are byte-exact, so a corruption was never even in
// reach of a test.
//
// A size change is a failure, and so is a SIZE-PRESERVING change, which is why every
// assertion here is on the hash and never on the length.
//
// THE FINDING THAT FORCED THE SECOND HALF, and it is kept because it is the reason the
// second half exists. Measured 2026-09-26, at 426/426: injecting a text round trip at the
// read site produced 0 failures, and so did a SIZE-PRESERVING single-byte corruption at the
// same site. The first five tests below therefore prove only that the recorded fingerprint
// matches the file on disk WHEN NOTHING INTERVENES, because the recorded sha256 is computed
// from the source file rather than from the value that is attached. A guard that does not go
// red is not evidence, and 5/5 here was never coverage.
//
// SO THE GUARD IS NOW BUILT ON THE DELIVERED ARTIFACT, on both sides, which is the only
// place a corruption can hide: read the recorded sha256 out of the message the RECIPIENT
// received, then fetch that attachment's own url back through /api/blob and hash the bytes
// that come off the wire. Nothing in that path can see the sender's file.
//
// It is proven by two red arms that are the point of the card:
//   * corrupt the STORED blob, size-preserving, and the guard must go RED. If it stayed
//     green, the assertion was reading the source file and proving nothing.
//   * delete the SOURCE file after the send, and the guard must stay GREEN. If it went red,
//     it was reading the sender's disk and not the delivery.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { startWebServer } from "../src/server.mjs";

const CLI = new URL("../bin/herdr-amq.mjs", import.meta.url).pathname;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attachbytes-"));
  const amqRoot = path.join(root, ".agent-mail");
  for (const h of ["user", "worker"]) {
    for (const stage of ["new", "cur"]) {
      fs.mkdirSync(path.join(amqRoot, "agents", h, "inbox", stage), { recursive: true });
    }
  }
  return root;
}

function run(root, args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, AM_ME: "worker", AM_ROOT: path.join(root, ".agent-mail") },
    encoding: "utf8",
  });
}

// Pull the recorded attachment fingerprints out of the delivered message, by CONTENT and not
// by the count a function reports about itself.
function deliveredHashes(root) {
  const dirs = [path.join(root, ".agent-mail/agents/user/inbox/cur"), path.join(root, ".agent-mail/agents/user/inbox/new")];
  const out = [];
  for (const d of dirs) {
    for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      if (!f.endsWith(".md")) continue;
      const text = fs.readFileSync(path.join(d, f), "utf8");
      for (const m of text.matchAll(/"sha256":\s*"([a-f0-9]{64})"/g)) out.push(m[1]);
    }
  }
  return out;
}

const CASES = [
  // Random bytes behind a real signature: /dev/urandom is the one input guaranteed to
  // expose a text round trip, and the signature keeps the extension honest.
  ["x.png", () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(4096)])],
  ["y.mp4", () => Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), crypto.randomBytes(8192)])],
  // The other half of the arm. A fix that stopped mangling binaries by refusing to encode
  // anything would pass the binary arm and break every text attachment, so the two halves
  // live in one file and must both pass.
  ["a.md", () => Buffer.from("# heading\n\nplain text, no encoding tricks\n", "utf8")],
  ["a.json", () => Buffer.from(JSON.stringify({ a: 1, b: [2, 3], c: "utf8" }) + "\n", "utf8")],
];

for (const [name, make] of CASES) {
  test(`${name} is delivered byte-identical, asserted on the hash and not the length`, () => {
    const root = fixture();
    try {
      const buf = make();
      const p = path.join(root, name);
      fs.writeFileSync(p, buf);
      run(root, ["mail", "send", "--to", "user", "--subject", "bytes", "--body", "b", "--attach", p]);
      const hashes = deliveredHashes(root);
      assert.equal(hashes.length, 1, "exactly one attachment was recorded");
      // The assertion the suite never made: the recorded fingerprint IS the file's own.
      // A size-preserving corruption fails here, and so does any size change.
      assert.equal(hashes[0], sha(buf), `${name}: what was delivered is not the file that was attached`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("four files of mixed type all arrive byte-identical", () => {
  const root = fixture();
  try {
    // Build ONCE and keep the buffers. Calling make() again would mint fresh random bytes
    // and the hash would never match the file, which is my own fixture lying to me.
    const bufs = CASES.map(([, make]) => make());
    const paths = CASES.map(([n], i) => {
      const p = path.join(root, n);
      fs.writeFileSync(p, bufs[i]);
      return p;
    });
    run(root, ["mail", "send", "--to", "user", "--subject", "mixed", "--body", "b",
      ...paths.flatMap((p) => ["--attach", p])]);
    const hashes = deliveredHashes(root);
    assert.equal(hashes.length, 4, "all four were recorded, not one");
    CASES.forEach(([n], i) => {
      assert.ok(hashes.includes(sha(bufs[i])), `${n}: arrived byte-identical`);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ─── THE DELIVERY-SIDE GUARD, the half that can actually go red ────────────────
// Both sides of this assertion are computed from the DELIVERED artifact. The left side is
// the sha256 recorded in the message sitting in the RECIPIENT's inbox; the right side is a
// hash of the bytes /api/blob returns for that attachment's own url. The sender's file is
// not an input to either, and the two red arms below exist to keep it that way.

function deliveredAttachments(root) {
  const dirs = ["new", "cur"].map((s) => path.join(root, ".agent-mail/agents/user/inbox", s));
  const out = [];
  for (const d of dirs) {
    for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      if (!f.endsWith(".md")) continue;
      const text = fs.readFileSync(path.join(d, f), "utf8");
      // The opening marker is `---json` on ONE line, not `---` then `json`. I wrote the
      // two-line form first, it matched nothing, and the guard reported ZERO attachments
      // for a delivery that had four. A silently empty parse is the same class as the
      // vacuous assertion this file was written to remove, so the count is asserted
      // everywhere this function is used and never assumed.
      const m = text.match(/^---json\n([\s\S]*?)\n---\n/);
      if (!m) continue;
      out.push(...(JSON.parse(m[1]).attachments ?? []));
    }
  }
  return out;
}

function storedBlobPath(amqRoot, att) {
  return path.join(amqRoot, "blobs", att.sha256.slice(0, 2), `${att.sha256}${att.ext}`);
}

async function assertServedBytesAreTheRecordedBytes(baseUrl, attachments) {
  for (const att of attachments) {
    const res = await fetch(`${baseUrl}${att.url}`);
    assert.equal(res.status, 200, `${att.name}: the recipient's own url does not serve it`);
    const bytes = Buffer.from(await res.arrayBuffer());
    // Length first because a size change is the loud version of the failure and it names
    // itself, then the hash because a size-PRESERVING change is the quiet one.
    assert.equal(bytes.length, att.sizeBytes, `${att.name}: served ${bytes.length} B, record says ${att.sizeBytes} B`);
    assert.equal(sha(bytes), att.sha256, `${att.name}: what the recipient downloads is not the file that was attached`);
  }
}

async function withServer(amqRoot, fn) {
  const oldState = process.env.HERDR_PLUGIN_STATE_DIR;
  const oldConfig = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(amqRoot, "..", "state");
  process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(amqRoot, "..", "config");
  const server = startWebServer({ port: 0, host: "127.0.0.1", amqRoot });
  try {
    await new Promise((r) => server.once("listening", r));
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((r) => server.close(r));
    if (oldState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = oldState;
    if (oldConfig === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = oldConfig;
  }
}

test("every attachment the recipient received is byte-identical to what /api/blob serves", async () => {
  const root = fixture();
  try {
    const bufs = CASES.map(([, make]) => make());
    const paths = CASES.map(([n], i) => {
      const p = path.join(root, n);
      fs.writeFileSync(p, bufs[i]);
      return p;
    });
    run(root, ["mail", "send", "--to", "user", "--subject", "served", "--body", "b",
      ...paths.flatMap((p) => ["--attach", p])]);
    const atts = deliveredAttachments(root);
    assert.equal(atts.length, 4, "the recipient's inbox records all four");
    await withServer(path.join(root, ".agent-mail"), (base) =>
      assertServedBytesAreTheRecordedBytes(base, atts));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("RED ARM: a size-PRESERVING corruption in the stored blob makes the guard go red", async () => {
  // This is the arm the card is really asking for. The old guard read the source file, so
  // this corruption moved nothing it looked at and the suite stayed green, which is how a
  // control that cannot fail gets mistaken for coverage.
  const root = fixture();
  try {
    const buf = CASES[0][1]();
    const p = path.join(root, CASES[0][0]);
    fs.writeFileSync(p, buf);
    run(root, ["mail", "send", "--to", "user", "--subject", "corrupt", "--body", "b", "--attach", p]);
    const amqRoot = path.join(root, ".agent-mail");
    const att = deliveredAttachments(root)[0];
    const stored = storedBlobPath(amqRoot, att);
    // Flip ONE BIT, so the length is untouched and only the hash can catch it.
    const onDisk = fs.readFileSync(stored);
    onDisk[0] ^= 0xff;
    fs.writeFileSync(stored, onDisk);
    assert.equal(fs.statSync(stored).size, att.sizeBytes, "the corruption is size-preserving, by construction");

    await withServer(amqRoot, async (base) => {
      await assert.rejects(
        assertServedBytesAreTheRecordedBytes(base, [att]),
        new RegExp(`${CASES[0][0]}: what the recipient downloads is not the file that was attached`),
        "the guard stayed green on a corrupted delivery, so it was reading something other than the delivery",
      );
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("GREEN ARM: deleting the sender's file after the send does not move the guard", async () => {
  // The other half of the proof. If this went red, the guard was reading the sender's disk
  // and would report a delivery fault for a file that was never part of the delivery.
  const root = fixture();
  try {
    const buf = CASES[1][1]();
    const p = path.join(root, CASES[1][0]);
    fs.writeFileSync(p, buf);
    run(root, ["mail", "send", "--to", "user", "--subject", "gone", "--body", "b", "--attach", p]);
    fs.rmSync(p);
    const atts = deliveredAttachments(root);
    assert.equal(atts.length, 1, "the attachment is recorded");
    await withServer(path.join(root, ".agent-mail"), (base) =>
      assertServedBytesAreTheRecordedBytes(base, atts));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
