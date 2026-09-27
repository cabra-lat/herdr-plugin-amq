import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * CLOSING A CARD MUST NOT ERASE ITS EVIDENCE.
 *
 * Found by ballistics reading the source, confirmed here through the REAL CLI rather than by
 * reading the code - because reading this code is what misled them once tonight, and because a
 * positive path has to be exercised through the actual command rather than a library import.
 *
 * THE DEFECT. `task done` computed `proofArg = ... || ""` unconditionally and always passed
 * `proof` in OPTS. board.mjs resolves `updates.proof ?? opts.proof ?? existingTask.proof`, and ""
 * is NOT nullish, so the empty default beat the existing proof and an ordinary re-close with no
 * --flag silently deleted the card's evidence. Observed before the fix, on this CLI:
 *
 *     after first done           : proof: "THE ORIGINAL PROOF: measured 45/0 ..."
 *     after re-close, NO --proof : proof: null
 *
 * WHY IT IS WORSE THAN THE done_at OVERWRITE THIS BOARD HAS ALREADY BEEN BITTEN BY. A replaced
 * proof is indistinguishable from a first proof: there is nothing left to compare it against, so
 * the loss is invisible by construction and no later reading of the card can recover it. The
 * timestamp was the cheap field and it survived; the proof is the expensive one and it did not.
 *
 * The fix is at the ROOT, not at the symptom: an absent --proof now omits the key from OPTS
 * entirely, so the ?? chain falls through to the existing value. There is also no --clear-proof
 * flag, and arm 3 pins that down.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "herdr-amq.mjs");

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-durability-"));
  fs.mkdirSync(path.join(root, ".agent-mail", "bus"), { recursive: true });
  return root;
}

function cli(root, args) {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { ...process.env, AMQ_ME: "lane" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // A refusal exits non-zero and that is a RESULT here, not a crash: arm 3 depends on it.
    return `${error.stdout || ""}${error.stderr || ""}`;
  }
}

const newCard = (root, title) => {
  const out = cli(root, ["task", "create", "--title", title, "--owner", "lane"]);
  return out.match(/task_[0-9a-f_]{8,}/)?.[0];
};

// Returns the RAW frontmatter token as a string, or null when the line is absent entirely.
// "null" and absent are deliberately DIFFERENT: one is a field the writer set to nothing, the
// other is a field nobody wrote, and conflating them is how a missing proof passes for a cleared
// one. My first version of this helper returned the string "null" for a written null, so the
// control arm below failed while the card was in fact correct - a broken harness, not a defect.
const proofOf = (root, id) => {
  const file = path.join(root, ".agent-mail", "bus", "done", `${id}.md`);
  const raw = fs.readFileSync(file, "utf8").match(/^proof: (.*)$/m)?.[1];
  if (raw === undefined) return undefined;
  return raw === "null" ? null : raw;
};

test("THE DEFECT: a re-close with no --proof must NOT erase the evidence", () => {
  const root = workspace();
  const id = newCard(root, "card with real evidence");
  cli(root, ["task", "done", id, "--proof", "THE ORIGINAL PROOF: measured 45/0"]);
  assert.match(proofOf(root, id), /ORIGINAL PROOF/);

  cli(root, ["task", "reopen", id, "--reason", "simulating an ordinary re-close"]);
  const out = cli(root, ["task", "done", id]);

  assert.match(proofOf(root, id), /ORIGINAL PROOF/,
    "the evidence must survive an ordinary re-close - this is the arm that was null");
  assert.match(out, /preserved/i, "and the preservation is said out loud, not silent");
});

test("replacing the proof is still possible, and only when asked for", () => {
  const root = workspace();
  const id = newCard(root, "card");
  cli(root, ["task", "done", id, "--proof", "THE ORIGINAL PROOF: measured 45/0"]);
  cli(root, ["task", "reopen", id, "--reason", "re-close"]);
  cli(root, ["task", "done", id, "--proof", "THE SECOND PROOF: re-closed"]);
  assert.match(proofOf(root, id), /SECOND PROOF/, "a deliberate replacement still works");
});

test("there is NO flag that erases the evidence", () => {
  // Pinned because the absence is the design. An undocumented erasure cannot be told apart from a
  // card that was never evidenced, so the destructive path is not expressible.
  const root = workspace();
  const id = newCard(root, "card");
  cli(root, ["task", "done", id, "--proof", "THE ORIGINAL PROOF: measured 45/0"]);
  cli(root, ["task", "reopen", id, "--reason", "x"]);
  const out = cli(root, ["task", "done", id, "--clear-proof"]);
  assert.match(proofOf(root, id), /ORIGINAL PROOF/, "the evidence is untouched");
  assert.match(out, /unknown option|clear-proof/i, "and the attempt is refused by name");
});

test("THE CONTROL: a card with no prior proof still closes with null", () => {
  // Without this arm, "preserve the proof" and "never write a proof" are indistinguishable.
  const root = workspace();
  const id = newCard(root, "fresh");
  cli(root, ["task", "done", id]);
  assert.equal(proofOf(root, id), null);
});

test("THE OTHER CONTROL: a first close WITH --proof is unaffected", () => {
  const root = workspace();
  const id = newCard(root, "card");
  cli(root, ["task", "done", id, "--proof", "measured 45/0 on validate_movement_states.gd"]);
  assert.match(proofOf(root, id), /measured 45\/0/);
});
