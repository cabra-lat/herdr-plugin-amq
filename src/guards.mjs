import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WHERE IS EACH GUARD'S SOURCE TEXT, IN THIS TREE?
 *
 * The guards are a property of a FILE TREE. There is a second, older copy of this package in the
 * npx cache - 0.1.3, predating every one of them - and `npx herdr-amq ...` resolves to that copy
 * while `herdr-amq` and the bridge daemon resolve to the current source tree. Both write to the
 * same bus. So a claim like "the done-card guard is in place" is a statement about a PATH unless
 * somebody can ask which path was used.
 *
 * WHAT THIS IS, precisely - the wording is load-bearing and ballistics is right that it matters.
 * This reports TEXTUAL PRESENCE OF A STRING IN A FILE TREE. It does NOT report that a guard is
 * in place, and the output says so, because a tired person at 06:00 reads the artifact and not
 * the message that explains it. Three residual risks a string manifest cannot see, and none is
 * hypothetical in a codebase this new:
 *   - a refactor extracts the literal into a variable: the guard is healthy, this says ABSENT.
 *   - a guard is present but disabled by a flag or config: this says PRESENT, the guard does
 *     nothing.
 *   - the probe string is shared between two entries: the first run DID this, and reported a
 *     guard as absent on a build that had carried it for hours. A false NEGATIVE on a positive
 *     assertion, which is worse than a comment grep - a comment grep errs toward optimism, this
 *     errs toward alarm. There is now a test forbidding shared probe strings.
 * So each entry reports file:line, the output names the commit it read, and the output says
 * plainly that the SUITES hold the guards and this only tells you which tree you are standing in.
 *
 * This is a DIAGNOSTIC AID, not a test. test/proof-durability*.test.mjs, test/done-card-revival
 * .test.mjs and the rest are what actually hold the guards in place.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(HERE, rel), "utf8");
  } catch {
    return "";
  }
};

const SOURCES = { board: read("board.mjs"), actions: read("actions.mjs") };

/** Locate a probe string so the output can say WHERE, not just whether. */
function locate(file, needle) {
  const lines = SOURCES[file].split("\n");
  const at = lines.findIndex((l) => l.includes(needle));
  return at === -1 ? null : { file, line: at + 1 };
}

/**
 * name -> probe. A DISTINCT probe string per guard: reusing one means the manifest cannot tell
 * two guards apart, so at most one of the pair can ever be reported correctly.
 */
const PROBES = {
  "a claim cannot revive a done card (01aad98)":
    locate("board", 'existingTask.status === "done" && updates.status'),
  "an already-contradictory card refuses further transitions (5948c25)":
    locate("board", 'existingTask.done_at && existingTask.status !== "done"'),
  "an edge to a finished card is refused (4b6ad21)":
    locate("board", "already-completed"),
  "a closed card keeps its evidence when no --proof is given (25b1753)":
    locate("actions", "proofGiven"),
  "an unreadable @file body is refused (0fe53db)":
    locate("actions", "expandAtFile"),
  "per-card write events are recorded (card-writes)":
    locate("board", "recordCardWrite"),
  "stage directories resolve through STAGE_DIRS, never bus/${status} (5948c25)":
    locate("board", "STAGE_DIRS"),
};

/** name -> true when the guard's source text is present in this tree. */
export const GUARD_MANIFEST = Object.fromEntries(
  Object.entries(PROBES).map(([name, at]) => [name, at !== null]),
);

/** name -> "src/board.mjs:938" or null. Reported so a reader can go and look. */
export const GUARD_LOCATIONS = Object.fromEntries(
  Object.entries(PROBES).map(([name, at]) => [name, at && `src/${at.file}.mjs:${at.line}`]),
);
