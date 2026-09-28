import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addBoardTask, appendBoardTaskNote } from "../src/board.mjs";
// THESE TESTS EXERCISE THE PRODUCTION AUDIT PATH, so the run-level diversion is switched off
// here on purpose. run-tests.mjs sets AMQ_TEST_RUN so the suite writes to a sibling directory
// instead of evicting real card history; a test whose subject IS the real directory has to turn
// that off deliberately rather than assert against the wrong place.
delete process.env.AMQ_TEST_RUN;


const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "herdr-amq.mjs");

/**
 * `task comment` wrote the card durably and left NO trace in the write audit.
 *
 * `recordCardWrite` had exactly one call site, inside `updateBoardTask`. Every other writer on
 * this board writes the card file by hand - `appendBoardTaskNote` most importantly - so a
 * `task comment` produced a durable write, a success line from the CLI, and a write log with no
 * entry and no actor for it.
 *
 * ballistics demonstrated it on one card and explicitly declined to generalise from one verb,
 * which is the right caution: the defect is not "comments are unlogged", it is "any writer that
 * does not route through updateBoardTask is invisible". So this suite checks two things - that
 * the specific reported hole is closed, and that the SHAPE cannot come back through a new writer
 * that forgets the call.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-audit-"));
  const amqRoot = path.join(root, ".agent-mail");
  fs.mkdirSync(path.join(amqRoot, "agents"), { recursive: true });
  fs.mkdirSync(path.join(amqRoot, "bus"), { recursive: true });
  // Isolate the write log, and make it small enough that a leak is obvious rather than plausible.
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(root, "state");
  fs.mkdirSync(process.env.HERDR_PLUGIN_STATE_DIR, { recursive: true });
  return { root, amqRoot };
}

const logDir = (root) => path.join(root, "state", "card-writes");
const allLogs = (root) => {
  const dir = logDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return fs.statSync(p).isDirectory()
      ? fs.readdirSync(p).map((g) => `${f}/${g}\n${fs.readFileSync(path.join(p, g), "utf8")}`).join("\n")
      : `${f}\n${fs.readFileSync(p, "utf8")}`;
  }).join("\n");
};

test("THE DEFECT: a note write now appears in the write audit, credited to its author", () => {
  const { root, amqRoot } = fixture();
  try {
    const id = addBoardTask(root, amqRoot, { title: "t", owner: "lane", description: "x", notify: false }).task.id;
    const before = allLogs(root);
    const res = appendBoardTaskNote(root, amqRoot, id, { text: "checked the card", author: "ballistics" });
    assert.ok(res.ok);
    const after = allLogs(root);
    assert.notEqual(after, before, "a durable write must leave a trace in the audit");
    assert.match(after, /ballistics/, "and it must be credited to the actor who made it");
    assert.match(after, new RegExp(id), "and it must name the card it touched");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("THE REAL CLI PATH IS COVERED, not just the API - the report was a CLI observation", () => {
  const { root, amqRoot } = fixture();
  try {
    const out = execFileSync("node", [CLI, "task", "create", "--title", "t", "--owner", "lane", "--description", "x"],
      { cwd: root, env: { ...process.env, AMQ_ME: "lane" }, encoding: "utf8" });
    const id = out.match(/task_[0-9a-f_]{8,}/)?.[0];
    const before = allLogs(root);
    execFileSync("node", [CLI, "task", "comment", id, "--text", "a note from the cli", "--me", "ballistics"],
      { cwd: root, env: { ...process.env, AMQ_ME: "ballistics" }, encoding: "utf8" });
    const after = allLogs(root);
    assert.notEqual(after, before, "`herdr-amq task comment` produced a durable write and no audit entry");
    assert.match(after, /ballistics/, "credited to the real actor");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("A NOTE WITH NO AUTHOR IS NOT ATTRIBUTED TO SOMEBODY WHO WAS NOT THERE", () => {
  // The temptation when fixing an unlogged write is to write a default like "system" or
  // "unknown", which puts a name in the audit for an actor nobody can vouch for. Null is the
  // honest value; the same rule already governs an unattributed heartbeat.
  const { root, amqRoot } = fixture();
  try {
    const id = addBoardTask(root, amqRoot, { title: "t", owner: "lane", description: "x", notify: false }).task.id;
    appendBoardTaskNote(root, amqRoot, id, { text: "anonymous" });
    const after = allLogs(root);
    assert.ok(after.length > 0, "the write is still recorded - unlogged is what we are fixing");
    const cardText = fs.readFileSync(findCard(root, id), "utf8");
    const noteAuthor = (cardText.match(/"author":\s*"([^"]*)"/) || [])[1];
    const logged = (after.match(/"actor":\s*"?([^",}]+)"?/) || [])[1];
    assert.ok(noteAuthor !== undefined, "the note itself records an author");
    assert.equal(logged, noteAuthor,
      "the audit must credit the SAME actor the card records - not a different or invented one");
    assert.doesNotMatch(after, /"actor":\s*"(coordinator|lane|system|root)"/,
      "an absent actor must never default to a handle that did not write it");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("THE SHAPE CANNOT COME BACK: every durable card write in board.mjs calls the audit", () => {
  // The defect is a class - writers that bypass updateBoardTask - so pinning the one verb leaves
  // it open. This walks the source for fs.writeFileSync of a serialised card and requires the
  // audit call in the same function body.
  const src = fs.readFileSync(path.join(HERE, "..", "src", "board.mjs"), "utf8");
  // The source-scan probe this replaces was BROKEN and reported three functions as unlogged
  // writers that are not writers: it matched `export function X(...) {` non-greedily up to the
  // first `\n}`, which spans several function bodies, so loadBoard and addBoardTask inherited
  // appendBoardTaskNote's body. A probe that cannot tell one function from the next is worse
  // than no probe, because it looks like coverage. What replaces it cannot be satisfied by a
  // scan that found nothing.
  const callSites = (src.match(/recordCardWrite\(/g) || []).length;
  assert.ok(callSites >= 2,
    `the audit must be called from more than one writer; found ${callSites} call sites`);
  assert.match(src, /export function appendBoardTaskNote[\s\S]*?recordCardWrite\(/,
    "the note writer specifically must call the audit - the reported hole, by name");
});

function findCard(root, id) {
  for (const stage of fs.readdirSync(path.join(root, ".agent-mail", "bus"))) {
    const f = path.join(root, ".agent-mail", "bus", stage, `${id}.md`);
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`card ${id} not found`);
}
