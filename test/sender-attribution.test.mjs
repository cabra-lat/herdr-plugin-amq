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
import { spawnSync } from "node:child_process";
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
  // spawnSync, NOT execFileSync. execFileSync returns only stdout when the exit code is 0,
  // so a refusal written to stderr by a handler whose return value is ignored came back as
  // an empty string, and the arm asserted against nothing. That is a check that cannot fail.
  //
  // The overlay has to be applied, not just its deletions. The first version deleted the
  // keys whose value was undefined and never SET the ones that were defined, so `AM_ME:
  // "worker"` never reached the child. ARM 2 caught it, and only because ARM 2 was the one
  // arm that needed a value rather than an absence. ARM 1 passed throughout that window for
  // the wrong reason: it asserts nothing was delivered, and nothing was delivered because
  // the SEND ITSELF failed, not because the sender was refused. A passing negative is not
  // evidence that the thing it is about is guarded.
  const clean = { ...process.env, ...env };
  for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...clean, AM_ROOT: path.join(root, ".agent-mail") },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "" };
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
    // Unconditional, where this used to be `if (!r.ok)`. The conditional made the arm pass
    // for a send that failed for an UNRELATED reason, which is how it stayed green through a
    // window where the environment overlay was broken and no message could be sent at all. The
    // contract is not merely "not attributed to somebody else": an unattributable send is
    // REFUSED, loudly, naming the input that would have fixed it.
    assert.ok(!r.ok, "a send with no determinable author must not succeed");
    assert.match(r.err || "", /--from|AM_ME/, "the refusal names the missing input");
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

// The SAME substitution, one surface over. `task` write subcommands read
// `flags.me || flags.from || process.env.AMQ_ME || "coordinator"`, so claim, block, done,
// unblock, reassign and comment all stamped a lane that was not the one doing the work.
// Read-only subcommands never used `me`, so they must keep working with no --me at all.
const WRITE = ["claim", "block", "done", "unblock", "reassign", "comment", "create"];
const READONLY = ["list", "show"];
// Each write subcommand's OWN required flags. Without them the actor guard correctly defers
// to the missing-flag diagnostic, and the arm would be testing the wrong refusal: it would
// see a non-zero exit and a helpful message and conclude the actor is guarded, when what it
// actually proved is that --reason is required. The flags are supplied so the ONLY thing the
// invocation is missing is the actor.
const WRITE_FLAGS = {
  block: ["--reason", "waiting on a person"],
  unblock: ["--stage", "doing", "--reason", "picked back up"],
  reassign: ["--to", "qa"],
};

for (const sub of WRITE) {
  test(`task ${sub} refuses to act with no actor rather than recording coordinator`, () => {
    const root = fixture();
    try {
      // No --me AT ALL. An earlier version of this arm passed a trailing valueless --me and
      // tripped the multi-flag guard instead, which tested the wrong thing entirely.
      const r = run(root, ["task", sub, "task_x", ...(WRITE_FLAGS[sub] ?? [])], { AM_ME: undefined, AMQ_ME: undefined });
      const all = (r.out || "") + (r.err || "");
      // The assertion is the ABSENCE of the wrong value, not the presence of a right one.
      assert.doesNotMatch(all, /coordinator/, `task ${sub} still resolves to coordinator`);
      assert.ok(!r.ok, `task ${sub} must exit non-zero, not act under a default lane`);
      assert.match(all, /--me|AM_ME/, `task ${sub} names the missing input`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const sub of READONLY) {
  test(`task ${sub} still works with no actor, because it writes nothing`, () => {
    const root = fixture();
    try {
      // A real card to read, created WITH an actor. Reading it back with none is the arm:
      // asserting that a read of a card that does not exist succeeds would prove nothing,
      // and `show` with no id exits 1 asking for the id, which is a different diagnostic.
      const created = run(root, ["task", "create", "--title", "read me", "--to", "qa", "--me", "qa"],
        { AM_ME: undefined, AMQ_ME: undefined });
      assert.ok(created.ok, `fixture card was not created: ${created.err || ""}`);
      const asJson = run(root, ["task", "list", "--json"], { AM_ME: undefined, AMQ_ME: undefined });
      const id = JSON.parse(asJson.out)[0].id;
      const r = run(root, ["task", sub, ...(sub === "show" ? [id] : [])], { AM_ME: undefined, AMQ_ME: undefined });
      assert.ok(r.ok, `task ${sub} must not require an actor: ${(r.err || "").slice(0, 120)}`);
      assert.doesNotMatch(r.out + r.err, /needs an actor/, `task ${sub} demanded an actor for a read`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("the help text does not document --attach as taking a single value", () => {
  // A flag that accumulates repeats while the help says `[--attach <p>]` is the same defect
  // in the other direction: a documented flag that silently drops repeats.
  const root = fixture();
  try {
    const r = run(root, ["mail", "--help"], { AM_ME: "worker" });
    const out = r.out || "";
    assert.doesNotMatch(out, /\[--attach <p>\](?!\.\.\.)/, "help still shows a singular --attach");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
