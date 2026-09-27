import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The WRITER. Without this file, needs_reply was a reader for a field no writer could set.
 *
 * The failure this whole file exists to prevent is the SHARPEST version of the one the card
 * warned about. The first implementation shipped the header, the total reader, findUnansweredAsks
 * and 14 green tests - and `herdr-amq send` exposed no flag to set any of it. So nothing could
 * ever declare an ask, every message stayed permanently UNKNOWN, every message was treated as
 * maybe-asking, and the system behaved exactly as it had before the field existed, with more
 * code. 550 green tests sat on top of a feature that could not fire.
 *
 * The tell was in the live report and I read past it: `declared=0 declared-no=0` across 13
 * handles looks like a clean result, and it is ALSO exactly what a build with a missing writer
 * produces. A report that cannot distinguish "nobody declared" from "nobody could" is not a
 * report. The off-disk corroboration of 0 of 14418 headers was real and still consistent with
 * both readings - the false green was the number agreeing with the broken state, not a
 * contradiction of it.
 *
 * So the positive path is now exercised by ACTUALLY RUNNING THE CLI. Not by importing the
 * library and calling the function - that would test the library while leaving the command line
 * inert, which is precisely the gap. These tests spawn the real binary and read the real headers
 * back off disk.
 */

const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "bin", "herdr-amq.mjs");

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-writer-"));
  const amqRoot = path.join(dir, ".agent-mail");
  for (const h of ["worker", "user"]) {
    for (const f of ["new", "cur"]) fs.mkdirSync(path.join(amqRoot, "agents", h, "inbox", f), { recursive: true });
  }
  return amqRoot;
}

/** Run the REAL command line, and return its receipt. */
function cli(args, amqRoot) {
  // cwd + AM_ROOT, not a --root flag: the CLI has no such flag, and inventing one in the test
  // would have made the test pass against a capability the command line does not have - which is
  // the same shape of error as the one this file exists to catch. A test that exercises a
  // surface nobody can reach is a green test about nothing.
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: path.dirname(amqRoot),
    env: { ...process.env, AM_ME: "worker", AM_ROOT: amqRoot },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

/** Read every header in a mailbox back off disk. */
function headers(amqRoot, handle) {
  const found = [];
  for (const f of ["new", "cur"]) {
    const dir = path.join(amqRoot, "agents", handle, "inbox", f);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      const t = fs.readFileSync(path.join(dir, file), "utf8");
      const m = t.match(/^---json\r?\n([\s\S]*?)\r?\n---/);
      if (m) { try { found.push(JSON.parse(m[1])); } catch { /* skip */ } }
    }
  }
  return found;
}

describe("the writer exists on the command line", () => {
  test("`send --needs-reply` actually writes needs_reply: true", () => {
    const amqRoot = root();
    const r = cli(["send", "--from", "worker", "--to", "user", "--subject", "s",
      "--body", "which kind?", "--needs-reply"], amqRoot);
    assert.equal(r.code, 0, r.out);
    const [h] = headers(amqRoot, "user");
    assert.equal(h.needs_reply, true,
      "the positive path is now exercisable, which is the whole point of this file");
  });

  test("`send --no-needs-reply` writes false, and the receipt says so", () => {
    const amqRoot = root();
    const r = cli(["send", "--from", "worker", "--to", "user", "--subject", "s",
      "--body", "fyi", "--no-needs-reply"], amqRoot);
    assert.equal(r.code, 0, r.out);
    const [h] = headers(amqRoot, "user");
    assert.equal(h.needs_reply, false);
    assert.match(r.out, /needs_reply: explicitly no/,
      "a receipt that cannot distinguish a declared no from an omission is not a receipt");
  });

  test("OMITTING the flag leaves the field ABSENT, not false", () => {
    // The safe-when-unset default has to survive the addition of a writer. A writer is exactly
    // when a default starts getting "helpfully" filled in, and needs_reply: false-by-default
    // would turn every undeclared message into a confident "no reply needed" - the original bug,
    // reintroduced through the writer that was supposed to fix it.
    const amqRoot = root();
    const r = cli(["send", "--from", "worker", "--to", "user", "--subject", "s", "--body", "b"], amqRoot);
    assert.equal(r.code, 0, r.out);
    const [h] = headers(amqRoot, "user");
    assert.equal("needs_reply" in h, false, "absent, never false");
    assert.match(r.out, /needs_reply: undeclared/);
  });

  test("both flags at once is REFUSED, not silently resolved", () => {
    const amqRoot = root();
    const r = cli(["send", "--from", "worker", "--to", "user", "--subject", "s", "--body", "b",
      "--needs-reply", "--no-needs-reply"], amqRoot);
    assert.notEqual(r.code, 0, "a message that both asks and does not ask is a contradiction");
    assert.match(r.out, /contradictory/i);
    assert.equal(headers(amqRoot, "user").length, 0, "and nothing was sent");
  });
});

describe("the reply surface has both writers", () => {
  test("`reply --answers` records that the ask was answered", () => {
    // Without this writer, an UNANSWERED ask is indistinguishable from an answered one, because
    // "ack, looking" is a body and the existence of a reply is the only record there is.
    const amqRoot = root();
    cli(["send", "--from", "user", "--to", "worker", "--subject", "q", "--body", "which?",
      "--needs-reply"], amqRoot);
    const r = cli(["reply", "--from", "worker", "--id", headers(amqRoot, "worker")[0].id,
      "--body", "pi, the brief declares it", "--answers"], amqRoot);
    assert.equal(r.code, 0, r.out);
    const reply = headers(amqRoot, "user").find((h) => h.answers_ask);
    assert.ok(reply, "the reply must carry the answer verdict");
    assert.equal(reply.answers_ask.answered, true);
    assert.match(r.out, /answers_ask: yes/);
  });

  test("`reply` WITHOUT --answers records the honest default", () => {
    const amqRoot = root();
    cli(["send", "--from", "user", "--to", "worker", "--subject", "q", "--body", "which?",
      "--needs-reply"], amqRoot);
    const r = cli(["reply", "--from", "worker", "--id", headers(amqRoot, "worker")[0].id,
      "--body", "ack, looking"], amqRoot);
    assert.equal(r.code, 0, r.out);
    const reply = headers(amqRoot, "user").find((h) => h.asks_reply !== undefined);
    assert.ok(reply, "the reply still records what the ask said");
    assert.equal(reply.answers_ask, undefined,
      "and declares no answer - a body is not an answer, and this code is not judging prose");
    assert.match(r.out, /answers_ask: no/);
  });

  test("a reply can also declare its OWN needs_reply", () => {
    const amqRoot = root();
    cli(["send", "--from", "user", "--to", "worker", "--subject", "q", "--body", "which?"], amqRoot);
    const r = cli(["reply", "--from", "worker", "--id", headers(amqRoot, "worker")[0].id,
      "--body", "and which branch?", "--needs-reply"], amqRoot);
    assert.equal(r.code, 0, r.out);
    const reply = headers(amqRoot, "user").find((h) => h.subject.startsWith("Re:"));
    assert.equal(reply.needs_reply, true, "a reply can ask a question of its own");
  });
});

describe("the receipt is what makes a declaration auditable", () => {
  test("all three states are distinguishable in the receipt text", () => {
    // After the fact, a reader has only the header. But the sender has the receipt, and a receipt
    // that says "Sent" for all three states is why nobody could tell a declared ask from an
    // undeclared one when the 0/0 report came in.
    for (const [flag, expect] of [
      [["--needs-reply"], /needs_reply: yes/],
      [["--no-needs-reply"], /needs_reply: explicitly no/],
      [[], /needs_reply: undeclared/],
    ]) {
      const amqRoot = root();
      const r = cli(["send", "--from", "worker", "--to", "user", "--subject", "s", "--body", "b", ...flag], amqRoot);
      assert.match(r.out, expect, `receipt for ${flag.join(" ") || "(no flag)"}`);
    }
  });
});
