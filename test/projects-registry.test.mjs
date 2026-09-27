#!/usr/bin/env node
// THE REGISTRY IS FOR DISCOVERY AND MUST NEVER RESOLVE.
//
// The single most important property here is a negative one, and it is the reason this feature
// is safe to add at all: nothing outside this list may consult the list. A registry that can
// steer resolution is a stale entry pointing the bridge daemon at another project's board, and a
// doorbell about project A silently reading project B is the nested-mailbox ambiguity this repo
// already paid for once.
//
// So the first test registers a mailbox that is NOT the one in the current directory and asserts
// that resolution is unchanged. It is deliberately the first thing in the file: if it ever fails,
// nothing else in here matters.
//
// Isolated on BOTH boundaries - HERDR_PLUGIN_CONFIG_DIR for the registry, AM_ROOT for the
// mailbox. A test that touches the real ~/.config would rewrite the user's project list.
//
// Run: node test/projects-registry.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "projects-home-"));
process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(home, "config");
process.env.AM_ROOT = path.join(home, "mailboxA");

const { findAmqRoot } = await import("../src/config.mjs");
const { addProject, listProjects, removeProject, isMailboxRoot, hasMailboxShape, mailboxId, getProjectsDir, MAILBOX_MARKER } =
  await import("../src/projects.mjs");

/** A directory shaped like a mailbox, marker written. */
function makeMailbox(name) {
  const root = path.join(home, name);
  fs.mkdirSync(path.join(root, "bus", "doing"), { recursive: true });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, MAILBOX_MARKER), JSON.stringify({ schema: 1, name, id: mailboxId(root) }));
  return root;
}

test("a registered mailbox does NOT change which mailbox resolves", () => {
  // AM_ROOT only resolves if the directory EXISTS, so the "current" mailbox has to be real
  // before the first assertion. It is made here, not assumed.
  const current = path.join(home, "mailboxA");
  fs.mkdirSync(path.join(current, "bus", "doing"), { recursive: true });
  fs.mkdirSync(path.join(current, "agents"), { recursive: true });
  fs.writeFileSync(path.join(current, MAILBOX_MARKER), JSON.stringify({ schema: 1, name: "A", id: mailboxId(current) }));

  // Resolve first, from an explicit env root. This is the ground truth.
  const resolvedBefore = findAmqRoot();
  assert.equal(resolvedBefore, path.resolve(process.env.AM_ROOT));

  // Register a completely different mailbox, and make sure it is a VALID one so the test cannot
  // pass merely because the entry was rejected.
  const other = makeMailbox("mailboxB");
  const entry = addProject(other, { name: "other" });
  assert.equal(isMailboxRoot(other), true, "the other mailbox is real, so a pass cannot come from it being refused");

  // Resolution must be bit-for-bit identical afterwards.
  assert.equal(
    findAmqRoot(),
    resolvedBefore,
    "a registry entry must not redirect resolution. If this fails, the list is steering the " +
    "daemon and a stale entry will point it at the wrong board.",
  );
});

test("a STALE entry - a path that no longer exists - still cannot redirect resolution", () => {
  const doomed = makeMailbox("mailboxC");
  addProject(doomed, { name: "doomed" });
  fs.rmSync(doomed, { recursive: true, force: true });

  const rows = listProjects();
  const stale = rows.find((r) => r.name === "doomed");
  assert.ok(stale, "a moved mailbox stays in the list rather than vanishing");
  assert.equal(stale.exists, false, "and it is marked STALE, not silently dropped");

  assert.equal(findAmqRoot(), path.resolve(process.env.AM_ROOT), "and it still cannot redirect");
});

test("no registry at all behaves exactly as before", () => {
  const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), "projects-empty-"));
  const dir = path.join(freshHome, "projects");
  assert.equal(fs.existsSync(dir), false);
  // Nothing has been created on import, and listProjects on an absent dir is empty, not a throw.
  const prev = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_CONFIG_DIR = freshHome;
  assert.deepEqual(listProjects(), [], "an absent registry lists empty rather than failing");
  process.env.HERDR_PLUGIN_CONFIG_DIR = prev;
  fs.rmSync(freshHome, { recursive: true, force: true });
});

test("the nested scaffold is not a mailbox, and that is what the marker is for", () => {
  // Structurally identical to a mailbox: bus/ with stages, agents/. It is the case a dir-name
  // rule cannot settle, which is why discovery keys on the marker instead.
  const scaffold = path.join(home, "mailboxA", ".agent-mail");
  fs.mkdirSync(path.join(scaffold, "bus", "doing"), { recursive: true });
  fs.mkdirSync(path.join(scaffold, "agents"), { recursive: true });
  assert.equal(
    isMailboxRoot(scaffold),
    false,
    "a nested scaffold has the right shape and no marker, so it is not offered for adding",
  );
  assert.throws(() => addProject(scaffold), /nested inside another mailbox/, "and add refuses it, because a scaffold inside a real mailbox is a phantom project, not a second one");
  assert.equal(
    hasMailboxShape(scaffold),
    true,
    "note it still PASSES the shape test - bus/ and all. That is the point: shape alone cannot " +
    "tell a scaffold from a mailbox, which is why add needs this second rule and why the marker " +
    "exists at all",
  );
});

test("add is idempotent by path, so a picker cannot list one project twice", () => {
  const m = makeMailbox("mailboxD");
  addProject(m, { name: "dup" });
  addProject(m, { name: "dup" });
  const rows = listProjects().filter((r) => r.name === "dup");
  assert.equal(rows.length, 1, "adding the same root twice is one entry");
  assert.equal(rows[0].id, mailboxId(m), "and the id is stable across adds");
});

test("the id is stable for a path and differs for a different one", () => {
  const a = makeMailbox("mailboxE");
  const b = makeMailbox("mailboxF");
  assert.equal(mailboxId(a), mailboxId(a), "same path, same id");
  assert.notEqual(mailboxId(a), mailboxId(b), "different paths, different ids");
  assert.equal(mailboxId(a), mailboxId(path.join(a, ".")), "and a trailing / is the same path");
});

test("add writes a marker when one is missing, and never overwrites a name", () => {
  const bare = path.join(home, "mailboxG");
  fs.mkdirSync(path.join(bare, "bus"), { recursive: true });
  fs.writeFileSync(path.join(bare, MAILBOX_MARKER), JSON.stringify({ schema: 1, name: "Chosen By Hand", id: "kept" }));
  addProject(bare, { name: "something-else" });
  const marker = JSON.parse(fs.readFileSync(path.join(bare, MAILBOX_MARKER), "utf8"));
  assert.equal(marker.name, "Chosen By Hand", "a name a human set is not silently replaced");
  assert.equal(marker.id, "kept");
});

test("remove drops the entry and leaves the mailbox alone", () => {
  const m = makeMailbox("mailboxH");
  const e = addProject(m, { name: "removable" });
  const r = removeProject(e.id);
  assert.equal(r.removed, true);
  assert.equal(listProjects().some((x) => x.name === "removable"), false, "gone from the list");
  assert.equal(fs.existsSync(m), true, "but the mailbox and its cards are untouched");
  assert.equal(removeProject("no-such-thing").removed, false, "removing an unknown ref fails cleanly");
});

test("a corrupt entry does not hide the good ones", () => {
  fs.writeFileSync(path.join(getProjectsDir(), "garbage.json"), "{not json");
  assert.ok(listProjects().length > 0, "the readable entries still list");
  assert.equal(listProjects().some((r) => r.name === "garbage"), false, "the bad one is skipped");
  fs.unlinkSync(path.join(getProjectsDir(), "garbage.json"));
});

test("an UNMARKED mailbox is addable - add writes the marker, it does not require one", () => {
  // The chicken-and-egg the first version had: add refused anything without a marker, and add was
  // the only thing that wrote one, so an unmarked mailbox could never be added. Every other test
  // here made its mailbox pre-marked and sailed straight past it; only the real CLI run found it.
  const bare = path.join(home, "mailboxUnmarked");
  fs.mkdirSync(path.join(bare, "bus", "doing"), { recursive: true });
  assert.equal(isMailboxRoot(bare), false, "not registered yet");
  assert.equal(hasMailboxShape(bare), true, "but it is shaped like a mailbox");

  const entry = addProject(bare, { name: "unmarked" });
  assert.equal(fs.existsSync(path.join(bare, MAILBOX_MARKER)), true, "add wrote the marker");
  assert.equal(isMailboxRoot(bare), true, "and it is now discoverable");
  assert.equal(entry.name, "unmarked", "the requested name is used");

  // And the default name is derived, so `add` with no --name still produces something readable.
  const anon = path.join(home, "mailboxAnon");
  fs.mkdirSync(path.join(anon, "bus"), { recursive: true });
  const e2 = addProject(anon);
  assert.equal(e2.name, "mailboxAnon", "an unnamed add falls back to the directory name");

  // A root is normally called .agent-mail, so baselining the ROOT would name every project the
  // same thing and produce a picker of N rows all reading .agent-mail. The project name is the
  // one a human recognises.
  const dot = path.join(home, "fps-basegame", ".agent-mail");
  fs.mkdirSync(path.join(dot, "bus"), { recursive: true });
  assert.equal(addProject(dot).name, "fps-basegame", "a .agent-mail root is named for its PROJECT");
});

test("a directory with no bus/ is refused, with a reason rather than a stack trace", () => {
  const notMailbox = path.join(home, "just-a-folder");
  fs.mkdirSync(notMailbox, { recursive: true });
  assert.throws(() => addProject(notMailbox), /no bus\//, "the message says what is missing");
  assert.equal(hasMailboxShape(notMailbox), false);
});

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
