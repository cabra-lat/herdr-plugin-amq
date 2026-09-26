// A repeated flag used to be silently truncated to its first occurrence. `send --attach a
// --attach b --attach c` delivered ONE file, printed success and exited 0. The caller
// believed a bundle was delivered and the recipient silently received a subset.
//
// This is the same shape as three other defects tonight: a SUCCESS SIGNAL THAT DOES NOT
// DEPEND ON THE THING IT REPORTS. Hence the guard asserts on the DELIVERED message, not on
// the return value, and not on a count the function reports about itself.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = new URL("../bin/herdr-amq.mjs", import.meta.url).pathname;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multiflag-"));
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

test("N repeated --attach flags deliver N attachments, not one", () => {
  const root = fixture();
  try {
    const files = [1, 2, 3, 4].map((i) => {
      const p = path.join(root, `f${i}.txt`);
      fs.writeFileSync(p, `payload ${i}`);
      return p;
    });
    const out = run(root, ["mail", "send", "--to", "user", "--subject", "bundle", "--body", "b",
      ...files.flatMap((f) => ["--attach", f])]);

    // The assertion that matters is on the DELIVERED message, not on stdout. stdout said
    // "Sent" in the broken version too.
    const dir = path.join(root, ".agent-mail", "agents", "user", "inbox", "new");
    const delivered = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
    const withHashes = delivered.filter((m) => m.includes("sha256"));
    assert.equal(withHashes.length, 1, "exactly one delivered message");
    const count = (withHashes[0].match(/sha256/g) || []).length;
    assert.equal(count, files.length, `4 files were attached, ${count} arrived`);
    assert.match(out, /Sent/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a repeated --to reaches BOTH recipients", () => {
  // The same defect on the recipient flag, which is worse: a silently dropped RECIPIENT.
  // Found by the grep the card asked for, not by a user report.
  const root = fixture();
  try {
    run(root, ["mail", "send", "--to", "user", "--to", "worker", "--subject", "both", "--body", "b"]);
    for (const h of ["user", "worker"]) {
      const dir = path.join(root, ".agent-mail", "agents", h, "inbox", "new");
      const got = fs.readdirSync(dir).some((f) => fs.readFileSync(path.join(dir, f), "utf8").includes("both"));
      assert.ok(got, `${h} did not receive a message sent with two --to flags`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the comma-separated form still works", () => {
  // Backward compatibility. Fixing truncation must not break the form people already use.
  const root = fixture();
  try {
    run(root, ["mail", "send", "--to", "user,worker", "--subject", "comma", "--body", "b"]);
    for (const h of ["user", "worker"]) {
      const dir = path.join(root, ".agent-mail", "agents", h, "inbox", "new");
      const got = fs.readdirSync(dir).some((f) => fs.readFileSync(path.join(dir, f), "utf8").includes("comma"));
      assert.ok(got, `${h} lost the comma-separated --to`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a flag with no value fails loudly instead of dropping payload", () => {
  // The other half of the rule: if we cannot carry it, say so. A tool that cannot attach
  // three files must say so rather than exit 0 having attached one.
  const root = fixture();
  try {
    assert.throws(
      () => run(root, ["mail", "send", "--to", "user", "--subject", "s", "--body", "b", "--attach"]),
      (e) => e.status === 1 && /no value/.test(String(e.stderr)),
      "a trailing --attach with no value must exit non-zero and explain itself",
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
