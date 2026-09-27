import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WHAT GUARDS DOES THIS BUILD ACTUALLY CARRY?
 *
 * The guards are a property of a FILE TREE. There is a second, older copy of this package in the
 * npx cache - 0.1.3, predating every one of them - and `npx herdr-amq ...` resolves to that copy
 * while `herdr-amq` and the bridge daemon resolve to the current source tree. Both write to the
 * same bus. So a claim like "the done-card guard is in place" is a statement about a PATH unless
 * somebody can ask which path was used.
 *
 * This manifest makes the question answerable, and - the part that matters more - makes it
 * SELF-DESCRIBING rather than requiring anyone to remember a list. `herdr-amq --version` prints
 * the resolved path and this table, so a claim about a guard can be paired with the evidence for
 * which guards that build had. A guard nobody can enumerate is a guard nobody can verify.
 *
 * The checks are DELIBERATELY grep-shaped: they look for the distinctive string each guard leaves
 * in the source. That is the opposite of what coordinator ruled for the stage-path check, where a
 * grep on a prohibition was rejected because a grep passes on a comment. The difference is that
 * these are POSITIVE assertions - the string is the guard's own code, and a comment quoting the
 * guard would have to reproduce it verbatim inside this file. This is a diagnostic aid, not a
 * test; test/proof-durability*.test.mjs and friends are what actually hold the guards in place.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(HERE, rel), "utf8");
  } catch {
    return "";
  }
};

const board = read("board.mjs");
const actions = read("actions.mjs");

/** name -> does this build's source actually contain it. */
export const GUARD_MANIFEST = {
  "a claim cannot revive a done card (01aad98)":
    board.includes("existingTask.status === \"done\" && updates.status"),
  // A DISTINCT probe string, not the one above. My first version used `carries done_at` for both
  // guards, and the manifest then reported the contradictory-card guard as ABSENT on a build that
  // has had it since 5948c25. The tell was identical to every other broken measurement tonight:
  // ONE line disagreeing with a thing I knew to be true, for a reason the guard does not control.
  // A manifest that reuses one probe for two guards cannot tell them apart, so it will lie about
  // at least one of them - silently, and in the direction of under-reporting protection.
  "an already-contradictory card refuses further transitions (5948c25)":
    board.includes("existingTask.done_at && existingTask.status !== \"done\""),
  "an edge to a finished card is refused (4b6ad21)":
    board.includes("already-completed"),
  "a closed card keeps its evidence when no --proof is given (25b1753)":
    actions.includes("proofGiven"),
  "an unreadable @file body is refused (0fe53db)":
    actions.includes("expandAtFile"),
  "per-card write events are recorded (card-writes)":
    board.includes("recordCardWrite"),
  "stage directories resolve through STAGE_DIRS, never bus/${status} (5948c25)":
    board.includes("STAGE_DIRS"),
};
