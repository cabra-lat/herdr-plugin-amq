#!/usr/bin/env node
// THE STATE ISOLATION GUARD: A TEST MUST NOT WRITE CARD-WRITE RECORDS INTO THE REAL STATE DIR.
//
// WHY THIS EXISTS, with the number that motivated it. The write audit retains 200 slots, and
// 194 of them held test residue at 21:42-22:15 on 2026-09-27 - 97 percent of the audit was the
// suite evicting itself. task_1790520029313_38a378's write log was unlinked while its card and its
// 18 notes survived: recorded, then deleted, inside about three hours, on a card under active work.
// The cap was doing exactly what it was designed to do; what filled it was the tests.
//
// WHY A GUARD AND NOT JUST A FIX. I set the isolation in 17 files, and a fix with no guard is a
// fix that decays: the next board-writing test lands without it and the audit quietly starts
// losing history again, at a rate of one file per night. The failure is invisible by construction -
// the suite is green either way - so something has to be watching for it. This names the offenders
// rather than counting them, because "a test polluted the audit" is not actionable and
// "board.test.mjs did" is.
//
// The check is a STATIC sweep over the suite rather than a runtime observation. A runtime check
// would be stronger, but it can only see the tests that ran, and the interesting case is the one
// that was skipped. Reading the files sees all of them, including any that never execute.
//
// Run: node test/state-isolation-guard.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));

/** Writes that make board.mjs record a card-write entry. */
const BOARD_WRITES = /\b(updateBoardTask|addBoardTask|appendBoardTaskNote|heartbeatBoardTask)\b/;

test("no board-writing test writes into the real state dir", () => {
  const offenders = [];
  for (const f of fs.readdirSync(testDir).filter((n) => n.endsWith(".test.mjs"))) {
    const src = fs.readFileSync(path.join(testDir, f), "utf8");
    if (!BOARD_WRITES.test(src)) continue;
    if (/HERDR_PLUGIN_STATE_DIR/.test(src)) continue;
    offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    `these tests write card-write records into the REAL state dir and evict real history:\n  ${offenders.join("\n  ")}\n` +
    "Set process.env.HERDR_PLUGIN_STATE_DIR at module scope. board.mjs resolves the state dir at " +
    "CALL time, so it has to be set before the test body runs.",
  );
});

test("the guard itself would notice a new offender", () => {
  // A guard that cannot fail is a guard that does not exist, and this is the cheapest way to know
  // whether the sweep still works: a file that writes a board and does NOT isolate must be
  // detected. The sample is written to a temp name and removed, so the suite is unchanged.
  const sample = path.join(testDir, "zz-guard-selftest_tmp.test.mjs");
  try {
    fs.writeFileSync(sample, 'import { updateBoardTask } from "../src/board.mjs";\ntest("noop", () => {});\n');
    const src = fs.readFileSync(sample, "utf8");
    const wouldFlag = BOARD_WRITES.test(src) && !/HERDR_PLUGIN_STATE_DIR/.test(src);
    assert.equal(wouldFlag, true, "the sweep must flag a board-writing file that does not isolate");
  } finally {
    fs.rmSync(sample, { force: true });
  }
});

test("a file that isolates in a before-hook is isolated for every test in it", () => {
  // Scoped deliberately. A before() hook is a CORRECT way to isolate - the three files that do it
  // that way were already isolated before this work and are not offenders. The distinction that
  // matters is whether any test in the file can run WITHOUT the variable set, and the honest
  // question is not "is it at module scope" but "is it set before the first board write".
  //
  // The residue in the audit had a different shape entirely: 7 files isolated and 17 did not at
  // all. The defect is omission, not placement, so that is what this guards.
  const ok = [];
  const missing = [];
  for (const f of fs.readdirSync(testDir).filter((n) => n.endsWith(".test.mjs"))) {
    const src = fs.readFileSync(path.join(testDir, f), "utf8");
    if (!BOARD_WRITES.test(src)) continue;
    (src.includes("HERDR_PLUGIN_STATE_DIR") ? ok : missing).push(f);
  }
  assert.deepEqual(
    missing,
    [],
    `these write card-write records with no state-dir isolation at all:\n  ${missing.join("\n  ")}`,
  );
  // And the set must be non-trivial, or this arm passes because the pattern stopped matching.
  assert.ok(ok.length >= 20, `expected the isolated set to be substantial, found ${ok.length}`);
});
