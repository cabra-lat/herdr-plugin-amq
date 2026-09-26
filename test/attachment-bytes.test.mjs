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
// *** THESE TESTS ARE NOT YET A GUARD, AND BOTH RED ARMS PROVED IT. ***
// Measured 2026-09-26, at 426/426. Injecting a text round trip at the read site produced
// 0 failures. So did a size-PRESERVING single-byte corruption at the same site, 0 failures.
// A guard that does not go red is not evidence, so these five tests currently prove that
// the recorded fingerprint matches the file on disk when nothing intervenes, and prove
// nothing about the delivery path. The recorded sha256 is evidently computed from the file
// itself rather than from the value that is attached, so corrupting the read does not move
// the hash this test compares.
//
// The arms are kept because the two results are the finding: the gap is real, the
// instrument for closing it is not built, and anyone who reads 5/5 as coverage is wrong.
// The next step is to assert on the DELIVERED BLOB, fetched back through the API, which is
// what a recipient actually opens, rather than on the header the sender wrote.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

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
    env: { ...process.env, AM_ROOT: path.join(root, ".agent-mail") },
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
