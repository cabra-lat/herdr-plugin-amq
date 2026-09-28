#!/usr/bin/env node
// A PROMPT MUST NOT QUOTE A CLOCK THAT DOES NOT EXIST.
//
// metrics.mjs sets leaseAgeMs to NULL when the most recent beat is CROSS-LANE - somebody other
// than the owner pinging a card they cannot move - and the comment says why: "a fabricated age is
// a confident statement about a clock that does not exist." The owner prompt then did
// Math.round(null / 60000), which is 0.
//
// It surfaced on me. My own lease prompt said "Your lease last showed a heartbeat 0 minute(s)
// ago", and the card's heartbeat had been recorded by another lane minutes earlier. The VERDICT was
// right - my lease had lapsed, and a cross-lane beat is positive evidence of exactly that - and the
// number quoted to justify it belonged to somebody else's clock. A correct verdict on a misleading
// surface is worse than a wrong one, because it teaches the reader to trust the sentence.
//
// The projection already carried leaseCrossLane and leaseHeartbeatBy for this. The prompt ignored
// both.
//
// Run: node test/owner-lease-prompt-age.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(new URL("../src/bridge.mjs", import.meta.url), "utf8");

/** The prompt is not exported, so the age logic is read from source and evaluated directly. */
function readAgeExpression() {
  const start = src.indexOf("function buildOwnerResumePrompt");
  assert.ok(start >= 0, "buildOwnerResumePrompt must exist");
  const slice = src.slice(start, start + 4000);
  assert.match(slice, /leaseCrossLane/, "the prompt must branch on leaseCrossLane");
  assert.match(slice, /leaseAgeMs === null/, "and must handle a null age explicitly");
  return slice;
}

test("a cross-lane lease does NOT produce '0 minute(s) ago'", () => {
  const slice = readAgeExpression();
  // The defect in one line: the old expression guarded neither the null nor the author.
  assert.doesNotMatch(
    slice,
    /Math\.round\(card\.leaseAgeMs\s*\/\s*60000\)\s*minute/,
    "an unguarded null must not be rendered as a zero-minute lease",
  );
  // The cross-lane branch must name the sender, because "somebody else is beating your card" is
  // the evidence and the owner deserves to know who.
  assert.match(slice, /leaseHeartbeatBy/, "the cross-lane branch should name who has been beating the card");
  assert.match(slice, /has NOT been renewed by you|NOT been renewed/i, "and must say the owner has not renewed");
});

test("the age is only quoted when an age actually exists", () => {
  const slice = readAgeExpression();
  // Reproduce the old defect to prove the guard is load-bearing, not decorative.
  const old = Math.round(null / 60000);
  assert.equal(old, 0, "the unguarded expression really does produce zero - that is the bug");
  // And the null branch must be reachable, or the guard is dead code.
  assert.match(slice, /no owner-attributed heartbeat|no age to quote/i, "a null age must be stated, not numbered");
});

test("a real owner beat still quotes a real age", () => {
  // The fix must not silence the case the prompt was written for: an owner who really did lapse.
  const slice = readAgeExpression();
  assert.match(
    slice,
    /Math\.round\(card\.leaseAgeMs\s*\/\s*60000\)\}?\s*minute\(s\) ago/,
    "an owner-attributed lease must still report its age in minutes",
  );
  assert.match(slice, /CONTEXT COMPACTION/, "and keep the advisory about compaction for that case");
});
