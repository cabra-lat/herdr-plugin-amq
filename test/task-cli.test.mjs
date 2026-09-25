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
