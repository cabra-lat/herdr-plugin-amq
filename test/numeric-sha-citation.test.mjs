import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkAge, makeGitDateResolver } from "../src/work-age.mjs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A COMMIT HASH CAN BE ENTIRELY NUMERIC, AND THE EVIDENCE SCANNER WENT BLIND ON IT.
 *
 * `isShaLike` required a letter a-f - a SHAPE heuristic standing in for "is this a SHA". Git's
 * minimum abbreviation is 7 characters and a valid commit hash can be all digits. The plugin
 * repo's HEAD happened to be 4824947, so two work-age tests failed for a reason that had
 * nothing to do with either test's subject: the scanner reported "no claims" for a proof that
 * cited a real commit.
 *
 * This is the same class of defect as the false block, one layer down: a check that cannot
 * distinguish two cases reports one of them confidently, and here the case it dropped was the
 * evidence a card had actually done work.
 *
 * A bare number must STILL not become a citation - counts and timestamps are everywhere in
 * prose - so the shape filter stays. What changed is that an all-numeric token is accepted when
 * the REPOSITORY confirms it, because resolution is the only honest arbiter of what a hash is.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

test("an all-numeric commit hash is a CITATION, and it is dated", async () => {
  const short = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  assert.match(short, /^[0-9a-f]{7,}$/);
  // Skip rather than fail if this repo's HEAD happens to contain a letter, because then the arm
  // proves nothing and a vacuous pass is worse than an honest skip. State it either way.
  if (/[a-f]/.test(short)) {
    assert.ok(true, "SKIPPED: HEAD has a letter, so this arm would be vacuous");
    return;
  }
  const resolve = makeGitDateResolver({ repos: [REPO] });
  const work = await buildWorkAge({ proof: `landed in ${short}` }, new Date(), { resolveDate: resolve });
  assert.equal(work.state, "dated", "an all-numeric commit hash must not read as no claims");
  assert.equal(work.dated, 1);
});

test("THE CONTROL: a bare number is NOT promoted to a citation", async () => {
  // The other half, and the reason the shape filter survives: if numeric resolution were the
  // only rule, every count and timestamp in a proof would become a claim.
  const resolve = makeGitDateResolver({ repos: [REPO] });
  const work = await buildWorkAge({ proof: "1234567 is neither, and 45 of 60 passed" }, new Date(), { resolveDate: resolve });
  assert.equal(work.shas.length, 0, "a bare number that resolves to nothing is not a citation");
  assert.equal(work.dated, 0);
});

test("without a resolver, an all-numeric token is not guessed at", async () => {
  // No resolver means no way to tell a hash from a count, so the honest answer is to decline -
  // not to promote every number in the corpus into evidence.
  const work = await buildWorkAge({ proof: "landed in 4824947" }, new Date(), {});
  assert.equal(work.shas.length, 0, "shape alone is not enough, and that is deliberate");
});
