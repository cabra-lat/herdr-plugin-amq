// ISOLATED STATE DIR, set before the module under test loads - see the note in the sibling
// file. The persisted date cache is process-independent by design, so without this a
// negative assertion can be answered by a positive some earlier test wrote to disk.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildCoordinatorMetricsWithWorkAge } from "../src/metrics.mjs";
import { makeGitDateResolver, __resetWorkAgeCache } from "../src/work-age.mjs";

process.env.HERDR_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-"));

/**
 * A CITATION IN EITHER REPOSITORY MUST DATE, AND A TOKEN IN NEITHER MUST NOT.
 *
 * The limit was named in dcec35 and sized by coordinator: the scan resolved against fps-basegame
 * only, so every card citing a herdr-plugin-amq commit read UNDATED - five cards, and they are
 * the five that record the tooling work itself, so the tool whose job is to say what the board
 * cites could not see the record of its own repairs.
 *
 * THE ACTUAL DEFECT WAS NOT THE ONE DESCRIBED, and finding that is the reason this test is
 * behavioural. The server DID pass two repositories. The second was `path.join(repoRoot, "..",
 * "herdr-plugin-amq")` - a guess about the filesystem that resolves to .../godot/herdr-plugin-amq,
 * which does not exist here, because the plugin repo is a sibling of `godot`, not of the game
 * repo. The failure was SILENT: execFile with a bad cwd simply resolves nothing, so the board
 * reported no tooling citations and no reason. Coordinator hit the same wrong root from the other
 * end tonight, searching for this repository and finding absence.
 *
 * The fix derives the plugin root from this module's own location rather than guessing a sibling
 * a second time, because a second guess is a second thing to be wrong.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const GAME_ROOT = process.env.AGBOARD_GAME_REPO || "/home/cabra.lat/documents/coding/godot/fps-basegame";

const hasGit = (root) => { try { return fs.existsSync(path.join(root, ".git")); } catch { return false; } };
const realCommit = (root, prefix) => {
  try { return execFileSync("git", ["rev-parse", "--verify", `${prefix}^{commit}`], { cwd: root, encoding: "utf8" }).trim().slice(0, 7); }
  catch { return null; }
};

const GAME_SHA = hasGit(GAME_ROOT) ? realCommit(GAME_ROOT, "3975567") : null;   // fix(profiler)
const PLUGIN_SHA = hasGit(PLUGIN_ROOT) ? realCommit(PLUGIN_ROOT, "d317cfd") : null; // reassign wait clock
const NOW = Date.parse("2026-09-27T12:00:00.000Z");
// ACTIVE, not done: workAgeById is populated from activeBoardTasks(stallEligible), so a done
// card is not in the map at all and every arm below would read undefined. That is a property of
// the builder, not something to assert around - the point of the test is resolution, not staging.
const card = (id, extra) => ({
  id, title: id, owner: "lane", status: "doing",
  created: new Date(NOW - 600_000).toISOString(),
  status_at: new Date(NOW - 60_000).toISOString(),
  updated: new Date(NOW - 60_000).toISOString(),
  ...extra,
});

const build = (cards) => buildCoordinatorMetricsWithWorkAge({
  board: { columns: { doing: cards } },
  repos: [GAME_ROOT],
  now: NOW,
  deliveredState: { delivered: {} },
});

test("THE THREE-ARM POSITIVE CONTROL: game / plugin / neither, from DIFFERENT fields", () => {
  // Three arms, because the failure this guards against is a scan that silently stops checking:
  // the first two would both pass if resolution did nothing at all. The third is the one that
  // notices. And the two real tokens come from different fields on purpose, so the arm fails if
  // the artifactSources unification regresses rather than only if the repository list shrinks.
  assert.ok(GAME_SHA, "the game-repo fixture commit resolves");
  assert.ok(PLUGIN_SHA, "the plugin-repo fixture commit resolves");
  assert.notEqual(GAME_SHA, PLUGIN_SHA);

  return build([
    card("from-title", { title: `review ${GAME_SHA}` }),      // game repo, TITLE
    card("from-proof", { proof: `shipped in ${PLUGIN_SHA}` }), // plugin repo, PROOF
    card("from-nowhere", { proof: "commit 0123456789abcdef0123456789abcdef01234567" }), // neither
  ]).then(({ workAgeById }) => {
    assert.equal(workAgeById.get("from-title").dated, 1, "a game-repo SHA in a title is dated");
    assert.equal(workAgeById.get("from-proof").dated, 1, "a PLUGIN-repo SHA in a proof is dated");
    assert.equal(workAgeById.get("from-nowhere").dated, 0, "a SHA in NEITHER repo is not dated");
  });
});

test("THE CONTROL THAT MAKES THE FIRST TWO MEANINGFUL: resolution is not a no-op", () => {
  // If the resolver returned nothing for everything, the arm above would report 0/0/0 and a
  // reader checking only the first two would see them pass. Asserting a positive alongside the
  // negative is what distinguishes "resolved the right ones" from "resolved none".
  return build([card("positive", { proof: GAME_SHA })]).then(({ workAgeById }) => {
    assert.equal(workAgeById.get("positive").dated, 1);
    assert.notEqual(workAgeById.get("positive").state, "no-claims");
  });
});

test("A REPO PATH THAT DOES NOT EXIST IS REPORTED, NOT SILENTLY IGNORED", () => {
  // The original defect was not a missing repository, it was a MISSING repository that said
  // nothing. A wider list that still swallows bad paths would reproduce it exactly.
  const bogus = path.join(PLUGIN_ROOT, "..", "definitely-not-a-repo-xyz");
  return buildCoordinatorMetricsWithWorkAge({
    board: { columns: { doing: [card("x", { proof: PLUGIN_SHA })] } },
    repos: [GAME_ROOT, bogus],
    now: NOW,
    deliveredState: { delivered: {} },
  }).then(({ metrics }) => {
    assert.ok(metrics.workAgeRepos.skipped.includes(bogus), "the unusable path is named in the payload");
    assert.match(metrics.workAgeRepos.note, /do not exist and were NOT searched/);
    assert.ok(!metrics.workAgeRepos.used.includes(bogus), "and it is not in the searched list");
  });
});

test("THE LIMITATION IS IN THE PAYLOAD, so a reader of the metrics sees it", () => {
  // The lesson of this whole class: a limitation that lives only in a commit message or an AMQ
  // note is invisible to the person who needs it. This is the artifact a reader actually opens.
  return build([card("y", { proof: GAME_SHA })]).then(({ metrics }) => {
    assert.ok(Array.isArray(metrics.workAgeRepos.used));
    assert.ok(metrics.workAgeRepos.used.some((r) => fs.existsSync(r)), "every used repo really exists");
  });
});

test("THE POISONING ARM: a NARROW search must not decide a WIDER one in the same process", () => {
  // Found by making a harness error, which is the only reason it is written down. I measured
  // before/after with three resolver probes in ONE process: narrow, wrong-path, correct - and the
  // correct one reported nothing. The cause was not the configuration under test: `dateCache`
  // cached ABSENCES as `null` for the life of the process, so the first narrow search decided
  // every later one, however wide.
  //
  // This is the class in one line - an absence produced by a reader that did not look, made
  // durable and invisible, so that fixing the reader changes nothing. It is why the miss cache is
  // keyed by the repository set that produced it, and why a positive stays global: a resolved
  // commit date is a fact about the commit, an unresolved one is only a fact about the search.
  return (async () => {
    const narrow = makeGitDateResolver({ repos: [GAME_ROOT] });
    const wide = makeGitDateResolver({ repos: [GAME_ROOT, PLUGIN_ROOT] });
    await narrow([PLUGIN_SHA]);                       // cannot see it: game repo only
    const after = await wide([PLUGIN_SHA]);           // can see it, and must be allowed to say so
    assert.ok(after.has(PLUGIN_SHA),
      "a wider search in the same process must not inherit an absence from a narrower one");
  })();
});

test("a path that does not exist resolves nothing, and says so rather than guessing", () => {
  // server.mjs passed `path.join(repoRoot, "..", "herdr-plugin-amq")`, which resolves to
  // .../godot/herdr-plugin-amq - not a repository on this layout. With the miss cache keyed by
  // repo set, that wrong path can no longer poison anything, and it still resolves nothing,
  // which is the honest outcome: a reader pointed at a path that is not there learns nothing.
  //
  // The cache reset is REQUIRED and is not tidiness. A resolved commit date is a fact about the
  // commit and is cached globally forever, so an earlier arm in this file had already resolved
  // PLUGIN_SHA and this one would short-circuit to the cached answer - reporting the SHA as dated
  // regardless of the bogus path. My first version asserted the opposite and failed, and the code
  // was right for a better reason than I had written down: to test the NEGATIVE path this arm has
  // to start from a slate the positive cache cannot answer from.
  __resetWorkAgeCache();
  const bogus = path.join(PLUGIN_ROOT, "..", "godot", "herdr-plugin-amq");
  return (async () => {
    const r = makeGitDateResolver({ repos: [GAME_ROOT, bogus] });
    assert.equal((await r([PLUGIN_SHA])).has(PLUGIN_SHA), false, "nothing is invented from a bad path");
    assert.equal((await r([GAME_SHA])).has(GAME_SHA), true, "and the good path still works alongside it");
  })();
});

test("a caller can still narrow the list explicitly, and the plugin root is additive", () => {
  // `repos` is additive, not authoritative - that is the fix. But a caller who genuinely wants a
  // board resolved against one repository must be able to say so, or "always includes ours" is
  // just a harder-coded guess wearing a configuration flag.
  return buildCoordinatorMetricsWithWorkAge({
    board: { columns: { doing: [card("z", { proof: PLUGIN_SHA })] } },
    repos: [GAME_ROOT],
    now: NOW,
    deliveredState: { delivered: {} },
  }).then(({ metrics }) => {
    assert.ok(metrics.workAgeRepos.used.length >= 2,
      "naming one repository still searches the plugin, because that is the defect being fixed");
  });
});
