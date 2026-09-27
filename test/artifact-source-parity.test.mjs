import test from "node:test";
import assert from "node:assert/strict";
import { extractClaimedArtifacts, buildWorkAge } from "../src/work-age.mjs";

/**
 * THE EXTRACTOR AND THE CONFIRMATION PASS MUST READ THE SAME PLACES.
 *
 * Coordinator's scope call was to read card titles and bodies, on the argument that a SHA in a
 * title is a citation - which is right, and is 29da63 one layer up: evidence sitting in a field
 * the reader does not read, so a card citing something renders as citing nothing.
 *
 * I implemented the first half of that and it did NOTHING for the tokens that motivated it. An
 * all-numeric sha is only a citation once a repository CONFIRMS it, and the confirmation pass -
 * `collectAllNumericCandidates` - read a different, smaller set (description, proof, notes). So a
 * numeric SHA in a title was extracted by nobody and confirmed by nobody, and the live
 * measurement came back unchanged: 80 more cards cited work, and the two commits the card was
 * about stayed at exactly 6 and 2.
 *
 * Two readers of one card reading two different field sets is the same defect as a projection
 * that has a field and does not carry it, one layer further down. So the arm below is built to
 * fail on a HALF fix, which is the specific mistake that was nearly shipped.
 */

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const KNOWN = new Set(["3975567"]);   // all-numeric, so it REQUIRES confirmation
const confirm = (tok) => KNOWN.has(tok);

test("THE ARM THAT CATCHES A HALF FIX: a numeric SHA in a TITLE is a citation when confirmed", () => {
  // If only the extractor were widened, `isKnownCommit` is never built for this token - the
  // confirmation pass never saw the title - so this returns nothing. That is the exact state I
  // measured as "80 more cards, and the two commits unchanged".
  const a = extractClaimedArtifacts({ title: "review 3975567 and the accessor fix" }, { isKnownCommit: confirm });
  assert.deepEqual(a.shas, ["3975567"], "extracted AND confirmed, not merely extracted");
});

test("and the same for a numeric SHA in a BODY", () => {
  const a = extractClaimedArtifacts({ body: "see 3975567 for the accessor" }, { isKnownCommit: confirm });
  assert.deepEqual(a.shas, ["3975567"]);
});

test("THE CONTROL: a numeric token nobody confirms is still NOT a citation", () => {
  // The boundary coordinator drew: read more PLACES, do not accept more SHAPES. A wider reader
  // that accepts more shapes is a worse scanner - reporting more is not the same as being right.
  const a = extractClaimedArtifacts(
    { title: "measured 95.3052 across 112 samples in 300ms", body: "3975567 was reviewed" },
    { isKnownCommit: confirm },
  );
  assert.deepEqual(a.shas, ["3975567"], "the counts and timestamps stay out; only the confirmed sha is in");
});

test("and an UNCONFIRMED all-numeric token in a title stays out", () => {
  // Reading titles must not promote a bare number that happens to be in one. This is the failure
  // that loosening the SHAPE test would have caused, and it is why the repository is the arbiter.
  const a = extractClaimedArtifacts({ title: "ticket 1234567 is unrelated" }, { isKnownCommit: confirm });
  assert.deepEqual(a.shas, [], "an unconfirmed number in a title is not a citation");
});

test("a shape-valid SHA in a title needs no confirmation, exactly as in a note", () => {
  // The two paths are asymmetric on purpose, and the asymmetry is not an oversight: a token with
  // a letter a-f is already almost certainly a sha, while a bare number is usually a count.
  const a = extractClaimedArtifacts({ title: "review 3408dac" }, { isKnownCommit: confirm });
  assert.deepEqual(a.shas, ["3408dac"]);
});

test("buildWorkAge agrees - the end-to-end path, not just the extractor", () => {
  // buildWorkAge is the entry point every consumer uses, and it builds its own confirmation set.
  // Testing the extractor alone would pass while the end-to-end path still reported "no claims",
  // which is the whole defect.
  //
  // My first version of this arm asserted `dated: 2` with a fake resolver that confirmed only
  // the numeric token, and got 1. The code was right and the fake was wrong - but the correction
  // is worth making rather than quietly loosening, because `dated: 1, undated: 1` is the more
  // interesting state and it is pinned separately below.
  return buildWorkAge(
    { title: "QA review: 3408dac + 3975567" },
    NOW,
    { resolveDate: async (shas) => new Map(shas.map((s) => [s, "2026-09-26T18:51:38-03:00"])) },
  ).then((w) => {
    assert.equal(w.state, "dated", "a title-only citation is dated, not reported as no-claims");
    assert.equal(w.dated, 2);
    assert.equal(w.citationCount, 2, "both tokens came from the title");
  });
});

test("a CITED sha that does not resolve is UNDATED, not ABSENT", () => {
  // 3408dac passes the shape test, so it is a citation; the fake repository does not know it, so
  // it has no date. Collapsing "cited but undated" into "not cited" is the absence-producing
  // error this scanner keeps being pulled out of, one level down from the field it could not see.
  return buildWorkAge(
    { title: "review 3408dac" },
    NOW,
    { resolveDate: async () => new Map() },
  ).then((w) => {
    assert.equal(w.dated, 0);
    assert.equal(w.undated, 1, "cited, and dateless - which is not the same as never cited");
  });
});

test("the citation says WHERE it was found, so a title citation is attributable", () => {
  const a = extractClaimedArtifacts({ title: "3408dac", notes: ["ffc92fd"] }, { isKnownCommit: confirm });
  const byWhere = Object.fromEntries(a.citations.map((c) => [c.value, c.where]));
  assert.equal(byWhere["3408dac"], "title");
  assert.equal(byWhere["ffc92fd"], "note");
});
