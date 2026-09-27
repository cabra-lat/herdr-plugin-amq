import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `where` SHIPPED WITH NO CONSUMER, AND A FIELD NOBODY READS IS A CLAIM ABOUT THE ARTIFACT.
 *
 * `where` is produced in work-age.mjs - it says which field a citation was read from (title,
 * body, proof, note, description) - and until now it was read by exactly two tests and no product
 * code at all. I had already written the rule that a producer test cannot establish delivery, and
 * then shipped a field with a test and no reader, which is the same mistake wearing a lab coat.
 *
 * It is now rendered on the line where a stalled card is ALREADY being reported, because that is
 * the cheapest honest place for it and the place where the question actually gets asked: a
 * stalled card, and is it citing anything? An undated count cannot separate "cites nothing" from
 * "cites something undatable", and those need opposite responses.
 *
 * THE SCOPE CAVEAT TRAVELS WITH THE DATA. workAgeById is built from the stall-eligible set, so
 * this signal covers ACTIVE cards only: a DONE card's evidence is ABSENT from the list, not
 * undated. A limitation that lives only in a commit message is invisible to the person reading
 * the tool, and an unexplained absence reads as a finding about the card.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "src", "bridge.mjs"), "utf8");

test("`where` HAS A CONSUMER: the stalled line renders the source field of each citation", () => {
  assert.ok(SRC.includes("c.where"), "the citation's source field must be read by product code");
  assert.ok(/from \$\{c\.where\}/.test(SRC), "and PRINTED, not merely read");
  // Before: `where` appeared only in work-age.mjs and in tests. A grep for product readers
  // returned two test files and nothing else - which is the measurement that filed this card.
  const workAge = fs.readFileSync(path.join(HERE, "..", "src", "work-age.mjs"), "utf8");
  assert.ok(workAge.includes("where:"), "it is still produced");
});

test("A CARD WITH NO CITATIONS CONTRIBUTES NOTHING, rather than an empty entry", () => {
  // Otherwise the line reads "... : ; ..." for a card that simply cites nothing, which is a
  // different fact from a card whose citations exist and are undated.
  assert.ok(SRC.includes("if (cites.length === 0) return null;"), "no citations, no entry");
  assert.ok(SRC.includes(".filter(Boolean)"), "and the empty entries are dropped");
});

test("THE ACTIVE-ONLY SCOPE IS STATED WHERE THE DATA IS READ", () => {
  // A done card's evidence is absent, not undated. If that is only in a commit message, the person
  // reading the prompt sees a gap and infers a finding about the card that is not there.
  assert.ok(SRC.includes("ACTIVE CARDS ONLY"), "the scope limit is in the rendered text");
  assert.ok(SRC.includes("ABSENT from this list, not undated"), "and says which it is");
});
