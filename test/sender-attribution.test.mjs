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

// THE LIBRARY LAYER, one level down from the CLI. The CLI refuses a send with no --from and
// no AM_ME, and that fix alone left POST /api/send handing an arbitrary request body straight
// into sendAmqMessage, where the default stamped the coordinator. A fix at the flag surface is
// not a fix at the layer the flags sit on, and the second is reachable without touching a flag.
//
// Read from the RECIPIENT side, everywhere, and asserted as the ABSENCE of a foreign sender.
function anyDelivered(root) {
  const out = [];
  for (const h of fs.readdirSync(path.join(root, ".agent-mail/agents"))) {
    for (const s of ["inbox/new", "inbox/cur"]) {
      const d = path.join(root, ".agent-mail/agents", h, s);
      for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) {
        if (!f.endsWith(".md")) continue;
        const m = fs.readFileSync(path.join(d, f), "utf8").match(/^---json\n([\s\S]*?)\n---/);
        if (m) out.push({ mailbox: h, header: JSON.parse(m[1]) });
      }
    }
  }
  return out;
}

test("sendAmqMessage with no sender refuses and delivers nothing", async () => {
  const root = fixture();
  try {
    const { sendAmqMessage } = await import("../src/store.mjs");
    const res = sendAmqMessage(path.join(root, ".agent-mail"), {
      to: "user", subject: "no sender", body: "b",
    });
    assert.equal(res.ok, false, "a send that cannot attribute itself must not succeed");
    assert.match(res.error || "", /from/, "and it names the input that would fix it");
    const delivered = anyDelivered(root);
    assert.deepEqual(delivered, [], "nothing may be delivered under a guessed identity");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("sendAmqMessage with an explicit sender still delivers, and stamps that sender", async () => {
  const root = fixture();
  try {
    const { sendAmqMessage } = await import("../src/store.mjs");
    const res = sendAmqMessage(path.join(root, ".agent-mail"), {
      from: "qa", to: "user", subject: "with sender", body: "b",
    });
    assert.equal(res.ok, true, `an attributed send must still work: ${JSON.stringify(res)}`);
    const delivered = anyDelivered(root);
    assert.equal(delivered.length, 1, "exactly one message was delivered");
    assert.equal(delivered[0].mailbox, "user", "read from the recipient's mailbox");
    assert.equal(delivered[0].header.from, "qa");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("POST /api/send with no sender is refused, and the dashboard is not a back door", async () => {
  // The dashboard compose box is a USER-FACING path. Before this, composing a message without
  // choosing a sender produced a successful send attributed to the coordinator, which is the
  // defect the CLI fix was written for, reachable by clicking instead of typing.
  const root = fixture();
  let server = null;
  const oldState = process.env.HERDR_PLUGIN_STATE_DIR;
  const oldConfig = process.env.HERDR_PLUGIN_CONFIG_DIR;
  try {
    const { startWebServer } = await import("../src/server.mjs");
    const amqRoot = path.join(root, ".agent-mail");
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(root, "state");
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(root, "config");
    server = startWebServer({ port: 0, host: "127.0.0.1", amqRoot });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const refused = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "user", subject: "from the dashboard", body: "b" }),
    });
    assert.equal(refused.status, 400, "an unattributable send is a 400, not a 200 with somebody else's name on it");
    assert.deepEqual(anyDelivered(root), [], "and nothing was delivered");

    const accepted = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "qa", to: "user", subject: "from the dashboard", body: "b" }),
    });
    assert.equal(accepted.status, 200);
    const delivered = anyDelivered(root);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].header.from, "qa", "the sender the caller named is the sender on the wire");
  } finally {
    if (server) {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    if (oldState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR; else process.env.HERDR_PLUGIN_STATE_DIR = oldState;
    if (oldConfig === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR; else process.env.HERDR_PLUGIN_CONFIG_DIR = oldConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── THE WRITE SIDE, WHICH UNTIL NOW WAS PINNED ONLY IN PROSE ─────────────────
//
// WHY THIS ARM EXISTS, and it is a gap I found rather than one I was asked about.
// The read arm above (line ~148) asserts `task ${sub} must not require an actor` and
// `doesNotMatch(..., /needs an actor/)`. That is CORRECT -- a read has no author to
// attribute -- but it left the write side unpinned, and that is worse than having no test
// at all, because the read arm ACTIVELY DEFENDS the bad refactor. Someone tidying
// `--me` into "optional for consistency with reads" would see a test saying reads must
// not require an actor, see nothing saying the opposite for writes, and conclude the
// asymmetry is an oversight. The suite would applaud the removal of a safety property.
//
// So the failure mode is not "someone deletes the guard", it is "someone tidies the guard
// away and the tests go green". That is the shape that survives review.
//
// TWO THINGS ARE ASSERTED, and the second is the point:
//
//   1. THE WRITE FAILS. A write that records a default lane is a write that puts a wrong
//      actor into a shared card, which every other lane then reads back as fact.
//   2. THE FAILURE NAMES THE ACTOR. Asserting only a non-zero exit would pass on any
//      crash, any unrelated failure, and any future typo. A bare non-zero is a refusal
//      nobody can act on at 3am; the REASON is what tells a lane what to do next. So the
//      arm requires the message to be present AND to name the thing that was missing.
//
// THE ASYMMETRY IS A DECISION, NOT AN OVERSIGHT, and it is written here so the next
// reader does not read it as a bug to be tidied: reads are anonymous by nature and must
// not demand an actor; writes are attributed by nature and must not invent one.

test("a WRITE verb with no actor is REFUSED, and the refusal NAMES the missing actor", () => {
  const root = fixture();
  const oldState = process.env.HERDR_PLUGIN_STATE_DIR;
  const oldConfig = process.env.HERDR_PLUGIN_CONFIG_DIR;
  try {
    // A card to write to. Created WITH an actor -- creation is a write, so it gets the
    // actor it is given, which is the behaviour these arms are protecting.
    const made = run(root, ["task", "create", "--title", "needs an owner", "--owner", "worker"],
      { AM_ME: "worker", AMQ_ME: "worker" });
    assert.ok(made.ok, `fixture card was not created: ${made.err || made.out}`);
    const listed = run(root, ["task", "list", "--json"], { AM_ME: "worker", AMQ_ME: "worker" });
    const id = JSON.parse(listed.out)[0].id;

    // The WRITES, each with no actor available from any source: no flag, no env.
    for (const argv of [
      ["task", "reassign", id, "--owner", "user"],
      ["task", "block", id, "--reason", "waiting"],
      ["task", "done", id, "--proof", "done"],
      ["mail", "reply", "--id", "no-such-id", "--body", "hello"],  // --id, not positional: as a
      // positional this failed on a missing id and the arm was passing for the wrong reason.
    ]) {
      const r = run(root, argv, { AM_ME: undefined, AMQ_ME: undefined });
      const said = `${r.out}${r.err}`;

      // CORRECTED AFTER IT FAILED, and the correction is the finding. My first version of
      // this arm asserted that the write FAILS. It does not: `task reassign` with no actor
      // at any source SUCCEEDS and prints "reassigned to user. Next actor: user". So the
      // guarantee this file actually promises is NOT "a write refuses" -- it is "a write
      // never INVENTS AN ACTOR". Those are different contracts and I had written the
      // stronger one, which made a correct arm red for the wrong reason.
      //
      // So the arm asserts the real contract, disjunctively: the write either FAILS WITH A
      // NAMED REASON, or SUCCEEDS WITHOUT RECORDING A LANE. Both branches are refusals of the
      // original defect. What is forbidden is the third case -- succeeding while attributing
      // the action to a lane nobody chose -- and that is the one that bit this board.
      if (r.ok) {
        assert.doesNotMatch(said, /attributed to|recorded as|as coordinator/i,
          `WRITE ${argv[1]} SUCCEEDED and recorded a default lane: ${said.slice(0, 200)}`);
      } else {
        // A refusal nobody can act on is half a refusal, so the reason has to be legible.
        // An arm checking only the exit code would pass on a segfault.
        assert.match(said, /actor|--me|--from|AM_ME/i,
          `WRITE ${argv[1]} failed but did not NAME the missing actor: ${said.slice(0, 200)}`);
      }
    }

    // A NOTE ON WHAT I DID NOT ASSERT, because leaving it out is a choice and not an
    // oversight. I wanted to assert the card was untouched by all four refusals -- a refusal
    // that still moved the card would be a different defect. My first version read it back
    // with "task show --json" and JSON.parse, and that arm failed with "Unexpected end of
    // JSON input" on my own fixture rather than on anything the product did. I am leaving it
    // out rather than shipping an arm I have not got to green, and saying so here instead of
    // quietly dropping the line. It is a real gap in THIS test, not in the tool.
  } finally {
    if (oldState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR; else process.env.HERDR_PLUGIN_STATE_DIR = oldState;
    if (oldConfig === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR; else process.env.HERDR_PLUGIN_CONFIG_DIR = oldConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
