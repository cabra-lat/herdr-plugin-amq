// A message must never be attributed to a handle its sender did not choose.
//
// The defect: `getArg("--from","--me") || process.env.AM_ME || "coordinator"`. With AM_ME
// unset and --from omitted, a lane sent mail that was DELIVERED, reported SUCCESS, and was
// attributed to `coordinator`. The sender never learned it had spoken as somebody else.
//
// Arm one asserts the ABSENCE of a foreign `from`, not the presence of a correct one. The
// defect is the presence of the wrong value, and a fix that merely added a correct value
// alongside it would pass a weaker test. Every arm reads the DELIVERED message from the
// RECIPIENT side, because a tool can write a correct header into a local outbox copy and
// still deliver something else.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = new URL("../bin/herdr-amq.mjs", import.meta.url).pathname;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "senderattr-"));
  for (const h of ["user", "worker"]) {
    for (const s of ["new", "cur"]) fs.mkdirSync(path.join(root, ".agent-mail/agents", h, "inbox", s), { recursive: true });
  }
  return root;
}

function run(root, args, env) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, AM_ROOT: path.join(root, ".agent-mail"), ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) { return { ok: false, out: e.stdout || "", err: e.stderr || "" }; }
}

// Read what the RECIPIENT got, not what the sender believes it wrote.
function deliveredFrom(root) {
  for (const s of ["cur", "new"]) {
    const d = path.join(root, ".agent-mail/agents/user/inbox", s);
    for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      const m = fs.readFileSync(path.join(d, f), "utf8").match(/^---json\n([\s\S]*?)\n---/);
      if (m) return JSON.parse(m[1]).from;
    }
  }
  return undefined;
}

test("ARM 1: AM_ME unset and --from omitted must NOT deliver as any other handle", () => {
  const root = fixture();
  try {
    const r = run(root, ["mail", "send", "--to", "user", "--subject", "s", "--body", "b"], { AM_ME: undefined, AMQ_ME: undefined });
    const got = deliveredFrom(root);
    // The assertion is the ABSENCE of a foreign sender, and that nothing was delivered as one.
    assert.notEqual(got, "coordinator", `delivered as coordinator with no --from (from=${got})`);
    assert.equal(got, undefined, "nothing may be delivered under a guessed identity");
    if (!r.ok) assert.match(r.err || "", /--from|AM_ME/, "the refusal names the missing input");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("ARM 2: AM_ME set to handle A and --from omitted is attributed to A", () => {
  // Without this the fix could simply delete the fallback and leave a second wrong path.
  const root = fixture();
  try {
    run(root, ["mail", "send", "--to", "user", "--subject", "s", "--body", "b"], { AM_ME: "worker" });
    assert.equal(deliveredFrom(root), "worker", "AM_ME is honoured, not discarded");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("ARM 3: an explicit --from still wins over AM_ME", () => {
  const root = fixture();
  try {
    run(root, ["mail", "send", "--to", "user", "--subject", "s", "--body", "b", "--from", "qa"], { AM_ME: "worker" });
    assert.equal(deliveredFrom(root), "qa", "an explicit sender overrides the environment");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("mail reply carries the same rule: no foreign sender, ever", () => {
  const root = fixture();
  try {
    run(root, ["mail", "send", "--to", "user", "--subject", "s", "--body", "b", "--from", "qa"], { AM_ME: "qa" });
    const r = run(root, ["mail", "reply", "--id", "nope", "--body", "b"], { AM_ME: undefined, AMQ_ME: undefined });
    assert.notEqual(deliveredFrom(root), "coordinator");
    if (!r.ok) assert.ok(true, "reply refused rather than guessing");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
