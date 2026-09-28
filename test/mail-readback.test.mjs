#!/usr/bin/env node
// A SEND MUST BE VERIFIED AGAINST THE DELIVERED FILE, NOT AGAINST ITS OWN RECEIPT.
//
// spotter reported the gap from the other end: "a reply of mine reported success with an empty body
// because a shell redirect failed inside a chain, which the AMQ CLI cannot detect because it has
// no read-back command." I hit the same hole twice in one session - a reply to a message I had
// already consumed returned "Original message with ID ... not found" and I only knew because I
// read the exit, and a send printed a receipt whose body I never actually read.
//
// The asymmetry is the whole point. "Sent" is an exit code and a sentence the CLI wrote about
// itself, and both are produced by the same code that might have failed. The file on disk is the
// only evidence here that the sender does not control.
//
// Run: node test/mail-readback.test.mjs

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const bin = path.resolve("bin/herdr-amq.mjs");
let tmp;
let amqRoot;
const saved = {};

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "readback-"));
  amqRoot = path.join(tmp, ".agent-mail");
  for (const h of ["coordinator", "ballistics"]) {
    fs.mkdirSync(path.join(amqRoot, "agents", h, "inbox", "new"), { recursive: true });
    fs.mkdirSync(path.join(amqRoot, "agents", h, "inbox", "cur"), { recursive: true });
    fs.mkdirSync(path.join(amqRoot, "agents", h, "outbox", "sent"), { recursive: true });
  }
  for (const k of ["AM_ROOT", "AMQ_ME", "HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_CONFIG_DIR"]) {
    saved[k] = process.env[k];
  }
  process.env.AM_ROOT = amqRoot;
  process.env.AMQ_ME = "agsuite-dev";
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(tmp, "state");
  process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(tmp, "config");
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (args) => {
  try {
    return { code: 0, out: execFileSync("node", [bin, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};

test("a send is verified against the delivered file, not just its own receipt", () => {
  const r = run(["mail", "send", "--to", "coordinator", "--from", "agsuite-dev", "--subject", "rb", "--body", "x"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /read-back VERIFIED against the delivered file/, `no verification line:\n${r.out}`);
  // It must name the actual file, not just claim success.
  const named = r.out.match(/coordinator:\s*(\S+\.md)/);
  assert.ok(named, `the read-back must name the file it found:\n${r.out}`);
  assert.ok(
    fs.existsSync(named[1]),
    "and that file must be the one on disk",
  );
});

test("every recipient is reported separately, so a partial delivery is visible", () => {
  const r = run(["mail", "send", "--to", "coordinator,ballistics", "--from", "agsuite-dev", "--subject", "two", "--body", "x"]);
  assert.match(r.out, /✓\s*coordinator:/, r.out);
  assert.match(r.out, /✓\s*ballistics:/, `both recipients must appear:\n${r.out}`);
});

test("mail verify finds a message by id and refuses one that does not exist", () => {
  const sent = run(["mail", "send", "--to", "coordinator", "--from", "agsuite-dev", "--subject", "findme", "--body", "y"]);
  const id = (sent.out.match(/Sent ([0-9]{4}-[0-9TZ_a-z.-]+) /) || [])[1];
  assert.ok(id, `no id in the receipt:\n${sent.out}`);

  const found = run(["mail", "verify", id]);
  assert.equal(found.code, 0, `a delivered message must verify:\n${found.out}`);
  assert.match(found.out, /findme/, "and it must show the subject");

  const missing = run(["mail", "verify", "task_this_does_not_exist_0000"]);
  assert.equal(missing.code, 1, "an unknown id must FAIL, not return an empty success");
  assert.match(missing.out, /unverified|NOT|not found|No message/i, "and it must say the claim is unverified");
});

test("a DRAINED recipient still verifies, because cur is a real destination", () => {
  // A message that has been drained is in cur, not new. A read-back that only looked in new would
  // report a delivered message as missing, and people would learn to ignore it.
  const sent = run(["mail", "send", "--to", "ballistics", "--from", "agsuite-dev", "--subject", "drained", "--body", "z"]);
  const id = (sent.out.match(/Sent ([0-9]{4}-[0-9TZ_a-z.-]+) /) || [])[1];
  const from = path.join(amqRoot, "agents", "ballistics", "inbox", "new", `${id}.md`);
  const to = path.join(amqRoot, "agents", "ballistics", "inbox", "cur", `${id}.md`);
  assert.ok(fs.existsSync(from), "precondition: delivered to new");
  fs.renameSync(from, to);

  const found = run(["mail", "verify", id]);
  assert.equal(found.code, 0, `a drained message must still verify:\n${found.out}`);
  // The report names the full path, so the stage is visible in it. Asserting the stage through the
  // path rather than through a separate field keeps the two from drifting apart.
  assert.match(found.out, /inbox\/cur\//, `and the report must show the RECIPIENT copy in cur:\n${found.out}`);
  // It must NOT report the sender's outbox copy as the location. That file was never in doubt - the
  // sender wrote it unconditionally - so naming it answers a question nobody asked and is silent
  // about the one that was asked: did it reach the recipient.
  assert.doesNotMatch(found.out, /^\s*location:/m, "it must not present the sender outbox copy as THE location");
});
