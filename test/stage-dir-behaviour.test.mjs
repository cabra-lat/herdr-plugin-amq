import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStageDir, STAGE_DIRS } from "../src/board.mjs";

/**
 * ENFORCE THE PATH RULE BEHAVIOURALLY, NOT WITH A GREP.
 *
 * Coordinator's ruling, and the trap in it: "a test that greps for path joins built from a
 * status field" is structurally identical to the guard on cd9e12, which greps for three detector
 * self-check names and would PASS on a file containing nothing but a comment saying do not
 * delete them. A grep passes on the prohibition. So the property has to be asserted by BEHAVIOUR:
 * a bus whose status has no directory must FAIL rather than invent a path.
 *
 * WHY IT MATTERS ON THIS BOARD. The live bus spells DIRECTORIES backlog blocked doing done queued
 * and STATUS backlog blocked in_progress done queued. bus/in_progress does not exist and nothing
 * reads it. So any code that builds a path by string-substituting the status targets a directory
 * that is not there - and that does not fail loudly: the write lands in a path with no reader and
 * appears to have applied. Creating the directory on a miss is how a phantom stage appears and
 * quietly absorbs writes.
 */

function busWith(dirs) {
  const bus = fs.mkdtempSync(path.join(os.tmpdir(), "bus-behave-"));
  for (const d of dirs) fs.mkdirSync(path.join(bus, d));
  return bus;
}

test("BEHAVIOUR: a status with NO directory must not resolve to an invented path", () => {
  const bus = busWith(["backlog", "blocked", "doing", "done", "queued"]);
  for (const status of Object.keys(STAGE_DIRS)) {
    const dir = resolveStageDir(bus, status);
    assert.ok(fs.existsSync(path.join(bus, dir)),
      `status "${status}" resolved to "${dir}", which does not exist - that is a fabricated path`);
  }
});

test("and specifically: in_progress resolves to doing/, never to a fabricated in_progress/", () => {
  // The live shape. bus/in_progress must not come into existence as a side effect of resolving.
  const bus = busWith(["backlog", "blocked", "doing", "done", "queued"]);
  const dir = resolveStageDir(bus, "in_progress");
  assert.equal(dir, "doing");
  assert.ok(!fs.existsSync(path.join(bus, "in_progress")),
    "and resolving must not CREATE the stray directory - that is the phantom-stage mechanism");
});

test("a bus with BOTH directories lands in doing/, never in the stray", () => {
  // A stray empty in_progress/ must not absorb writes, or a card lands where nothing reads it.
  const bus = busWith(["backlog", "blocked", "doing", "in_progress", "done", "queued"]);
  assert.equal(resolveStageDir(bus, "in_progress"), "doing");
});

test("the documented in_progress/ fallback still works, and is a NAMED behaviour", () => {
  // Kept because a bus could legitimately be laid out that way - but it is now asserted rather
  // than accidental, which is what stopped my own fixture drifting into it unnoticed.
  const bus = busWith(["in_progress"]);
  assert.equal(resolveStageDir(bus, "in_progress"), "in_progress");
});

test("every stage maps to a directory that EXISTS on the production bus", () => {
  // The invariant stated once, over the real shape, rather than per-status prose.
  const bus = busWith(["backlog", "blocked", "doing", "done", "queued"]);
  const resolved = new Set(Object.keys(STAGE_DIRS).map((s) => resolveStageDir(bus, s)));
  for (const d of resolved) {
    assert.ok(fs.existsSync(path.join(bus, d)), `"${d}" is reachable but absent`);
  }
});
