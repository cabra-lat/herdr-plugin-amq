import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, updateBoardTask, getBoardTask } from "../src/board.mjs";
// ISOLATION, and it is load-bearing rather than tidy. board.mjs records every card write to the
// state dir RESOLVED AT CALL TIME, so a test that does not set this writes its fixture cards into
// the real ~/.herdr-amq-state and evicts real card history: 194 of 200 audit slots are test
// residue, and task_1790520029313_38a378's log was unlinked while its card survived. Set at module
// scope, before any test runs, because the read happens when the write happens.
//
// `||=` so a file that already isolates keeps its own directory. The guard that keeps this true
// is test/state-isolation-guard.test.mjs; it names any file that drifts back.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-proof-durability-api-"));


/**
 * THE API-LEVEL CONTRACT FOR proof, STACKED BESIDE test/proof-durability.test.mjs.
 *
 * Arms promoted from ballistics' probe at their request rather than re-derived, so the numbers
 * in their report are the numbers this file pins.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT A MERGE, which is ballistics' argument and it is right:
 * the two suites are at DIFFERENT LEVELS and merging them would delete a coverage arm.
 *  - test/proof-durability.test.mjs is CLI-LEVEL. It builds the real binary path and execs it,
 *    so it catches a regression in actions.mjs - the CLI re-introducing an empty proof.
 *  - THIS file is API-LEVEL. It calls updateBoardTask directly, so it catches a regression in
 *    the `??` chain itself.
 * These fail independently. If board.mjs:1175 changed so `opts.proof` stopped falling through
 * to the existing value, the CLI test would still PASS - the CLI would still be omitting the
 * key correctly while the contract underneath it had changed underneath it. One test cannot
 * stand in for the other, and a green suite that only has one of them is green for a reason
 * nobody chose.
 *
 * The deleted measurement arm, recorded so the next person does not have to re-derive it:
 *   1. re-done with proof:""  (the CLI default) -> ACCEPTED, resulting proof: null. ORIGINAL ERASED.
 *   2. re-done with a real proof                  -> replaced with the second proof.
 *   3. re-done with opts.proof UNDEFINED          -> ORIGINAL PRESERVED.
 * Arm 3 is the control that makes arm 1 mean something, and it is the arm that pins the ?? chain.
 * Arm 1 is pinned below as a DOCUMENTED DEFECT, not as correct behaviour - see the comment there.
 */

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-api-"));
  const amqRoot = path.join(root, ".agent-mail");
  fs.mkdirSync(amqRoot, { recursive: true });
  return { root, amqRoot };
}

const quiet = { notify: false };

test("ARM 3 (the control): opts.proof UNDEFINED PRESERVES an existing proof", () => {
  // This is the whole contract, and it is the arm that makes arm 1 mean something. The resolution
  // is `updates.proof ?? opts.proof ?? existingTask.proof`, so an undefined opts.proof must fall
  // through rather than short-circuit.
  const { root, amqRoot } = fixture();
  const { task } = addBoardTask(root, amqRoot, { title: "c", owner: "o" });
  updateBoardTask(root, amqRoot, task.id, { status: "done", proof: "THE ORIGINAL PROOF" }, { from: "o", ...quiet });
  updateBoardTask(root, amqRoot, task.id, { status: "in_progress" }, { from: "o", ...quiet });

  const r = updateBoardTask(root, amqRoot, task.id, { status: "done" }, { from: "o", ...quiet });
  assert.equal(r.ok, true);
  assert.equal(getBoardTask(root, amqRoot, task.id).task.proof, "THE ORIGINAL PROOF",
    "an omitted proof must fall through to the existing value");
});

test("ARM 1: proof:\"\" DOES erase, and that is the defect 25b1753 fixed at the CLI", () => {
  // Pinned DELIBERATELY, as a documented hazard rather than correct behaviour. It documents the
  // exact mechanism of the erasure: "" is NOT nullish, so it beats existingTask.proof. The CLI no
  // longer supplies "" (it omits the key entirely), so this arm describes a path nothing takes.
  //
  // It stays because the hazard is in the TYPE, not in the CLI: any future caller that passes an
  // empty string - a form field, a defaulted object, a parsed flag - reintroduces the erasure
  // without touching actions.mjs at all, and no test of the CLI would notice.
  const { root, amqRoot } = fixture();
  const { task } = addBoardTask(root, amqRoot, { title: "c", owner: "o" });
  updateBoardTask(root, amqRoot, task.id, { status: "done", proof: "THE ORIGINAL PROOF" }, { from: "o", ...quiet });
  updateBoardTask(root, amqRoot, task.id, { status: "in_progress" }, { from: "o", ...quiet });

  updateBoardTask(root, amqRoot, task.id, { status: "done" }, { from: "o", proof: "", ...quiet });
  assert.equal(getBoardTask(root, amqRoot, task.id).task.proof, null,
    "documented hazard: an empty string is not nullish and erases. Do not pass one.");
});

test("a re-done card with a real proof replaces it - replacement stays possible", () => {
  const { root, amqRoot } = fixture();
  const { task } = addBoardTask(root, amqRoot, { title: "c", owner: "o" });
  updateBoardTask(root, amqRoot, task.id, { status: "done", proof: "FIRST" }, { from: "o", ...quiet });
  updateBoardTask(root, amqRoot, task.id, { status: "in_progress" }, { from: "o", ...quiet });
  updateBoardTask(root, amqRoot, task.id, { status: "done" }, { from: "o", proof: "SECOND", ...quiet });
  assert.equal(getBoardTask(root, amqRoot, task.id).task.proof, "SECOND",
    "preserving must not become 'proof can never change'");
});
