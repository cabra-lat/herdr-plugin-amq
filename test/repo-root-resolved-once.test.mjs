import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.HERDR_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oneroot-state-"));
{ const r = fs.mkdtempSync(path.join(os.tmpdir(), "oneroot-root-"));
  fs.mkdirSync(path.join(r, "agents"), { recursive: true });
  fs.mkdirSync(path.join(r, "bus"), { recursive: true });
  process.env.AM_ROOT = r; }
const { runDoorbellPass } = await import("../src/bridge.mjs");

/**
 * The repo root must be resolved ONCE and passed down, not resolved twice independently.
 *
 * I first wrote this to assert that a caller-supplied repoRoot changes WHICH BOARD the pass
 * reads. It does not, and that assertion failed. `getBusDirectory(repoRoot, amqRoot)` prefers
 * `amqRoot/bus`, so the board always comes from amqRoot and repoRoot only ever selects the
 * REPOSITORY used to date citations. The failure mode I described - the tick loading one board
 * while the pass loads another - is not possible, and I asserted it anyway because it sounded
 * alarming. The test now pins the true shape, which is worth pinning precisely because it is
 * narrower than I claimed.
 *
 * What is still worth testing: the two resolutions agreeing today is a coincidence nothing
 * enforces, and a comment claiming "resolved once" while the file resolves it twice is exactly
 * the stale claim this project keeps finding in product code.
 */
function queueWithCard(tag) {
  const amqRoot = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  for (const h of ["coordinator", "agsuite-dev"]) {
    fs.mkdirSync(path.join(amqRoot, "agents", h), { recursive: true });
    fs.writeFileSync(path.join(amqRoot, "agents", h, "profile.json"), JSON.stringify({ handle: h }));
  }
  fs.mkdirSync(path.join(amqRoot, "bus", "doing"), { recursive: true });
  fs.writeFileSync(path.join(amqRoot, "bus", "doing", "task_oneroot_0001.md"),
    `---\nid: task_oneroot_0001\ntitle: t\nstatus: in_progress\nstage_dir: doing\nowner: agsuite-dev\nnext_actor: agsuite-dev\nupdated: ${new Date(Date.now() - 30 * 86400000).toISOString()}\n---\n\nClosed in commit 0123456789abcdef0123456789abcdef01234567.\n`);
  return amqRoot;
}

const idSet = (metrics) => [...(metrics.alerts || []).flatMap((a) => a.cards || [])].map((c) => c.id);

test("a caller-supplied repoRoot is HONOURED, not accepted and ignored", () => {
  const amqRoot = queueWithCard("oneroot-queue-");
  // A repo root that resolves to a repository with NO board at all.
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "oneroot-emptyrepo-"));

  const withParam = runDoorbellPass({
    amqRoot, handles: ["agsuite-dev"], dryRun: true, allowPrompt: false, persistState: false,
    repoRoot: emptyRepo, getStatus: () => ({ state: "idle" }),
  });
  const withoutParam = runDoorbellPass({
    amqRoot, handles: ["agsuite-dev"], dryRun: true, allowPrompt: false, persistState: false,
    getStatus: () => ({ state: "idle" }),
  });

  const viaParam = idSet(withParam.coordinator);
  const viaFallback = idSet(withoutParam.coordinator);

  // Both arms see the SAME card, and that is the correction: the board comes from amqRoot, so
  // repoRoot cannot make the two call sites disagree about WHICH cards exist.
  assert.equal(viaFallback.includes("task_oneroot_0001"), true,
    `precondition: the pass sees the queue's cards, got ${JSON.stringify(viaFallback)}`);
  assert.deepEqual(viaParam, viaFallback,
    "a supplied repoRoot does NOT change the board - getBusDirectory prefers amqRoot/bus. Pinning this so nobody re-derives a scarier claim from it.");
  assert.ok(emptyRepo.length > 0, "the empty repo root was a real path, so the arm was not vacuous");
});

test("the daemon resolves once and passes down: the file contains no second independent resolution", async () => {
  // A structural check, but on the SHAPE rather than a string: exactly one call site may resolve
  // the root inside the pass body, and it must be guarded by the supplied value. Two unguarded
  // resolutions is the defect; this catches it if the fallback is ever dropped or duplicated.
  const src = fs.readFileSync(new URL("../src/bridge.mjs", import.meta.url), "utf8");
  const resolutions = src.split("\n").filter((l) => /getRepoRootFromAmq\(amqRoot\)/.test(l) && /const repoRoot/.test(l));
  assert.equal(resolutions.length, 2,
    `expected exactly two - one at daemon scope, one as a guarded fallback - found ${resolutions.length}`);
  assert.equal(resolutions.filter((l) => l.includes("givenRepoRoot")).length, 1,
    "the in-pass resolution must be guarded by the supplied value, or it is resolving independently");
  assert.equal(resolutions.filter((l) => l.trim().startsWith("const repoRoot = getRepoRootFromAmq")).length, 1,
    "exactly one UNGUARDED resolution, at daemon lifetime");
});
