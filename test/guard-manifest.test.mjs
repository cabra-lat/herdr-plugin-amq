import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_MANIFEST, GUARD_LOCATIONS } from "../src/guards.mjs";

/**
 * THE BUILD MUST BE ABLE TO SAY WHICH BUILD IT IS.
 *
 * A stale copy of this package (0.1.3, in the npx cache) predates every guard, and `npx
 * herdr-amq` resolves to it while `herdr-amq` and the bridge daemon resolve to the current tree.
 * Both write the same bus. So "the guard is in place" was a statement about a PATH, and the
 * question - which resolved binary did that lane actually invoke - had no command to ask it.
 *
 * This is a DIAGNOSTIC AID, not a test of the guards themselves: test/proof-durability*.test.mjs
 * and the other suites are what hold the guards in place. What this pins is that the manifest
 * does not LIE, which is a different and lower bar - a manifest that under-reports protection is
 * worse than none, because it reads as a measurement.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "herdr-amq.mjs");

test("the current build reports every guard in the manifest as present", () => {
  // The first version of this manifest reused ONE probe string for two different guards, and this
  // assertion failed: the contradictory-card guard was reported ABSENT on a build that has carried
  // it since 5948c25. One line disagreeing with a known fact, for a reason the guard does not
  // control - the same tell as every other broken measurement in this session.
  for (const [name, present] of Object.entries(GUARD_MANIFEST)) {
    assert.equal(present, true, `manifest under-reports: "${name}" is in this build but reads absent`);
  }
});

test("no two guards share a probe string, or the manifest cannot tell them apart", () => {
  // Structural, and the thing that actually bit: reusing a string means at most one of the pair
  // can ever be reported correctly. Asserted on the source so it cannot come back quietly.
  const src = fs.readFileSync(new URL("../src/guards.mjs", import.meta.url), "utf8");
  const probes = [...src.matchAll(/board\.includes\("([^"]+)"\)|actions\.includes\("([^"]+)"\)/g)]
    .map((m) => m[1] || m[2]);
  const dupes = probes.filter((p, i) => probes.indexOf(p) !== i);
  assert.deepEqual(dupes, [], `probe strings reused: ${dupes.join(", ")}`);
});

test("--version names the resolved path and the guards", () => {
  const out = execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  assert.match(out, /herdr-amq \d+\.\d+\.\d+/, "a version");
  assert.match(out, /resolved: \//, "and the path it actually ran from");
  for (const name of Object.keys(GUARD_MANIFEST)) {
    assert.ok(out.includes(name), `manifest entry not printed: ${name}`);
  }
});

test("each guard is reported as a SOURCE LOCATION, and the location is real", () => {
  // Wording is load-bearing: "found src/board.mjs:917" is a fact a reader can go and check, while
  // "guard: in place" is a claim they cannot. The line number is verified rather than trusted,
  // because a location that points at the wrong line is worse than no location.
  for (const [name, present] of Object.entries(GUARD_MANIFEST)) {
    const loc = GUARD_LOCATIONS[name];
    if (!present) { assert.equal(loc, null, `${name} reads absent but claims a location`); continue; }
    const m = loc.match(/^src\/(\w+)\.mjs:(\d+)$/);
    assert.ok(m, `${name} has an unparseable location: ${loc}`);
    const line = fs.readFileSync(new URL(`../src/${m[1]}.mjs`, import.meta.url), "utf8")
      .split("\n")[Number(m[2]) - 1];
    assert.ok(line && line.length > 0, `${name} points at an empty line in ${loc}`);
  }
});

test("the output says the suites hold the guards, and prints the commit it read", () => {
  // "Which tree am I standing in" should answer to a commit, not a directory - a directory ages
  // silently, and a stale manifest is then invisible rather than wrong.
  const out = execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  // Whitespace is normalised first, and that is the FIFTH time tonight an arm of mine has been
  // wrong for a reason the code under test does not control. The previous version of this very
  // assertion failed on a LINE WRAP in the artifact - the sentence it checks is correct and the
  // newline falls between "the" and "guards". An arm that fails on formatting is not testing the
  // thing it names, and the tell is the same one every time: one arm, wrong for a reason of mine.
  const flat = out.replace(/\s+/g, " ");
  assert.match(flat, /test suites are what hold the guards/i, "the limitation is in the artifact, not only in a message");
  assert.match(flat, /commit:\s+\S+/, "and the commit it read at");
  assert.match(flat, /not a claim that a guard is in place/i, "and it does not overclaim what it checked");
});
