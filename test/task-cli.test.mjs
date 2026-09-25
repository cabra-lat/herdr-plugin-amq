import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.resolve("bin/herdr-amq.mjs");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-cli-"));
  const amqRoot = path.join(root, ".agent-mail");
  const bus = path.join(amqRoot, "bus");
  for (const stage of ["backlog", "doing", "blocked", "done"]) {
    fs.mkdirSync(path.join(bus, stage), { recursive: true });
  }
  fs.mkdirSync(path.join(amqRoot, "agents", "alice", "inbox", "new"), { recursive: true });
  fs.mkdirSync(path.join(amqRoot, "agents", "alice", "inbox", "cur"), { recursive: true });
  fs.mkdirSync(path.join(amqRoot, "agents", "alice", "outbox", "sent"), { recursive: true });
  fs.mkdirSync(path.join(amqRoot, "agents", "bob", "inbox", "new"), { recursive: true });
  fs.mkdirSync(path.join(amqRoot, "agents", "bob", "inbox", "cur"), { recursive: true });
  fs.mkdirSync(path.join(amqRoot, "agents", "bob", "outbox", "sent"), { recursive: true });
  return { root, amqRoot, bus };
}

function run(root, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    env: { ...process.env, AM_ROOT: path.join(root, ".agent-mail"), HERDR_DISABLE_PROMPT: "1" },
    encoding: "utf8",
  });
}

test("task CLI fails loudly for unknown subcommands, flags, and missing arguments", () => {
  const { root, amqRoot } = makeFixture();
  try {
    const unknown = run(root, ["task", "frobnicate", "--id", "x"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown task subcommand "frobnicate"/);

    const flag = run(root, ["task", "list", "--nope", "x"]);
    assert.notEqual(flag.status, 0);
    assert.match(flag.stderr, /Unknown option --nope/);

    const missing = run(root, ["task", "claim"]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Task ID is required/);

    fs.rmSync(path.join(amqRoot, "bus"), { recursive: true, force: true });
    fs.writeFileSync(path.join(amqRoot, "bus"), "not a directory");
    const failed = run(root, ["task", "assign", "--to", "alice", "--title", "Broken write"]);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Failed to write task/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("task comment persists notes without changing activity and show exposes them to another handle", () => {
  const { root, amqRoot, bus } = makeFixture();
  try {
    const created = run(root, ["task", "assign", "--to", "alice", "--title", "Note card", "--desc", "Initial"]);
    assert.equal(created.status, 0, created.stderr);
    const files = fs.readdirSync(path.join(bus, "backlog")).filter((name) => name.endsWith(".md"));
    assert.equal(files.length, 1);
    const taskPath = path.join(bus, "backlog", files[0]);
    const before = fs.readFileSync(taskPath, "utf8");
    const updatedBefore = before.match(/^updated: (.*)$/m)?.[1];

    const comment = run(root, ["task", "comment", files[0].replace(/\.md$/, ""), "--me", "alice", "--text", "First progress note"]);
    assert.equal(comment.status, 0, comment.stderr);

    const show = run(root, ["task", "show", files[0].replace(/\.md$/, ""), "--me", "bob"]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /First progress note/);
    assert.match(show.stdout, /Notes:\s+1/);

    const after = fs.readFileSync(taskPath, "utf8");
    assert.equal(after.match(/^updated: (.*)$/m)?.[1], updatedBefore);
    assert.match(after, /notes:/);
    assert.equal(amqRoot.length > 0, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("existing supported task subcommands retain zero exit codes", () => {
  const { root } = makeFixture();
  try {
    const created = run(root, ["task", "assign", "--to", "alice", "--title", "Compatibility card"]);
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.match(/ID: (task_[A-Za-z0-9_]+)/)?.[1];
    assert.ok(id);
    for (const args of [
      ["task", "list"],
      ["task", "drain", "--me", "alice"],
      ["task", "claim", id, "--me", "alice"],
      ["task", "show", id],
      ["task", "block", id, "--reason", "Waiting"],
      ["task", "done", id, "--proof", "Verified"],
    ]) {
      const result = run(root, args);
      assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat, reassign and block metadata verbs work and fail loudly", () => {
  const { root, amqRoot } = makeFixture();
  try {
    const assigned = run(root, ["task", "assign", "--to", "alice", "--title", "Metadata card", "--notify", "false", "--depends-on", "task_a,task_b"]);
    assert.equal(assigned.status, 0, assigned.stderr);
    const id = (assigned.stdout.match(/ID: (task_[0-9a-z_]+)/) || [])[1];
    assert.ok(id, assigned.stdout);

    const claimed = run(root, ["task", "claim", id, "--me", "alice", "--notify", "false"]);
    assert.equal(claimed.status, 0, claimed.stderr);
    const before = fs.readFileSync(path.join(amqRoot, "bus", "doing", `${id}.md`), "utf8");

    const beat = run(root, ["task", "heartbeat", id, "--me", "alice"]);
    assert.equal(beat.status, 0, beat.stderr);
    const after = fs.readFileSync(path.join(amqRoot, "bus", "doing", `${id}.md`), "utf8");
    assert.match(after, /last_heartbeat_at: "[\d-]+T/);
    // Liveness only: `updated` and claims are untouched by a heartbeat.
    const updatedBefore = (before.match(/^updated: (.*)$/m) || [])[1];
    const updatedAfter = (after.match(/^updated: (.*)$/m) || [])[1];
    assert.equal(updatedAfter, updatedBefore);
    assert.equal((after.match(/^claims: (\d+)$/m) || [])[1], "1");

    // Unknown flag on the new verbs must fail loudly too.
    const badFlag = run(root, ["task", "heartbeat", id, "--me", "alice", "--bogus", "x"]);
    assert.notEqual(badFlag.status, 0);
    assert.match(badFlag.stderr, /Unknown option --bogus/);
    const missingId = run(root, ["task", "heartbeat", "--me", "alice"]);
    assert.notEqual(missingId.status, 0);
    assert.match(missingId.stderr, /Task ID is required/);

    const moved = run(root, ["task", "reassign", id, "--to", "bob", "--me", "coordinator"]);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(fs.readFileSync(path.join(amqRoot, "bus", "doing", `${id}.md`), "utf8"), /owner: "bob"/);
    const badReassign = run(root, ["task", "reassign", id, "--me", "coordinator"]);
    assert.notEqual(badReassign.status, 0);
    assert.match(badReassign.stderr, /Target owner is required/);

    const blocked = run(root, ["task", "block", id, "--me", "bob", "--reason", "Waiting on spotter", "--next-actor", "spotter", "--notify", "false"]);
    assert.equal(blocked.status, 0, blocked.stderr);
    const card = fs.readFileSync(path.join(amqRoot, "bus", "blocked", `${id}.md`), "utf8");
    assert.match(card, /next_actor: "spotter"/);
    assert.match(card, /block_reason: "Waiting on spotter"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
