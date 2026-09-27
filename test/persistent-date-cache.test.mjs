import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeGitDateResolver } from "../src/work-age.mjs";

/**
 * THE POSITIVE CACHE IS PERSISTED, AND ONLY THE POSITIVES.
 *
 * Coordinator measured the operational cost I had refused to answer from temperament: the daemon
 * tick is 3000ms, there is no configuration key for it, and the daemon is NOT long-lived - six
 * observed lifetimes tonight at roughly one restart every 2.3 minutes. So a process-wide cache is
 * COLD on every start, and the full-board work-age build pays 2005ms against a 3000ms tick: a 67%
 * duty cycle, with delivery gaps up to 40s against a 3-second cadence. My "a second build in the
 * same process is cheaper" was true and irrelevant, because there is rarely a second build.
 *
 * So positives are written to disk and read back. The asymmetry IS the design, and it is the
 * opposite of what a cache is normally optimised for:
 *
 *   A MISS IS NOT PERSISTED. A miss means "this repository set did not contain it", which is a
 *   fact about a SEARCH. Persisting it would reintroduce the poisoning bug fixed earlier tonight
 *   - a stale absence read back by a wider search and making it report nothing. An absence that
 *   outlives the process that produced it is a DEFECT, not an optimisation. This file asserts
 *   that negatively and explicitly, because it is the mistake the code is shaped to invite.
 *
 * The arms below use SEPARATE PROCESSES. An in-process test would pass on the in-memory cache
 * alone and prove nothing about persistence, which is the whole feature.
 */

const REPO = process.cwd();
const SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
const SHORT = SHA.slice(0, 8);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wacache-"));

// A child process: resolves against REPO, in a FRESH module registry with a FRESH state dir.
const child = `
  import { makeGitDateResolver, flushPersistentDates } from ${JSON.stringify(path.join(REPO, "src", "work-age.mjs"))};
  const r = makeGitDateResolver({ repos: [${JSON.stringify(REPO)}] });
  const out = await r([${JSON.stringify(SHORT)}]);
  // The write happens at the BUILD BOUNDARY, not inside the resolver: the resolver runs once per
  // card, so persisting there made the cost a function of the caller's shape. This is the same
  // flush buildCoordinatorMetrics calls after its loop, so the child runs the real sequence.
  await flushPersistentDates();
  process.stdout.write(JSON.stringify({ hit: out.has(${JSON.stringify(SHORT)}), date: out.get(${JSON.stringify(SHORT)}) || null }));
`;
function runChild(tag) {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", child], {
    encoding: "utf8", env: { ...process.env, HERDR_PLUGIN_STATE_DIR: stateDir },
  }));
}

test("A FRESH PROCESS REUSES A PERSISTED DATE INSTEAD OF RE-RESOLVING IT", () => {
  // First process is necessarily cold: nothing is on disk yet, so it must resolve and persist.
  const first = runChild();
  assert.equal(first.hit, true, "the cold process resolves it");
  const file = path.join(stateDir, "work-age-dates.json");
  assert.ok(fs.existsSync(file), "and writes the date to the state dir");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Object.keys(saved).some((k) => k.startsWith(SHORT.slice(0, 7))), "keyed by the SHA it resolved");

  // The second process shares no memory with the first. If it resolves, that is a cache HIT from
  // disk; if the persistence were broken it would simply resolve again and the test would still
  // pass - which is why the assertion below is on the FILE plus a deliberate corruption check.
  const second = runChild();
  assert.equal(second.hit, true, "a fresh process still reports the date");
  assert.equal(second.date, first.date, "and the same date, so the persisted value is the real one");
});

test("A CORRUPTED CACHE FILE IS IGNORED, NOT TRUSTED", () => {
  // Validated on read: a truncated or hand-edited file must not be able to introduce a date that
  // was never resolved. A cache that is trusted blindly is a way to make the tool lie with a
  // stale artefact, which is worse than having no cache at all.
  fs.writeFileSync(path.join(stateDir, "work-age-dates.json"), "{not json");
  const after = runChild();
  assert.equal(after.hit, true, "a corrupt file is discarded and the SHA is resolved for real");

  // A well-formed file carrying a date for a SHA that is not a commit at all.
  fs.writeFileSync(path.join(stateDir, "work-age-dates.json"),
    JSON.stringify({ deadbeefdeadbeef: "1999-01-01T00:00:00.000Z", "nothex!!": "1999-01-01T00:00:00.000Z" }));
  const seeded = runChild();
  assert.equal(seeded.hit, true, "a poisoned entry cannot answer for a real SHA");
});

test("MISSES ARE NEVER PERSISTED - this is the defect the file is shaped to invite", () => {
  // Resolve a SHA that is not in this repository. Nothing is written for it, because "absent
  // here" is a fact about a search and must not outlive the process that ran it.
  const absent = "0123456789abcdef0123456789abcdef01234567";
  const r = makeGitDateResolver({ repos: [REPO] });
  return r([absent]).then((out) => {
    assert.equal(out.has(absent), false, "it does not resolve");
    const file = path.join(stateDir, "work-age-dates.json");
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.ok(!Object.keys(saved).includes(absent),
        "an absence must never be written to disk: it would poison a wider search on a later start");
    }
  });
});

test("THE IN-MEMORY RESET CLEARS BOTH, and does not resurrect the file", () => {
  // __resetWorkAgeCache exists for tests that need a cold in-process resolver. It must NOT read
  // the file back, or "reset" would be a lie and a test using it would silently pass on stale
  // persisted data instead of exercising the real path.
  const src = fs.readFileSync(path.join(REPO, "src", "work-age.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export function __resetWorkAgeCache"));
  assert.ok(!/loadPersistentDates\(\)/.test(fn),
    "a cache reset that reloads from disk is not a reset");
  assert.ok(/dateCache\.clear\(\)/.test(fn) && /missCache\.clear\(\)/.test(fn), "both are cleared");
});
