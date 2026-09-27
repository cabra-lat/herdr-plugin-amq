import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A MESSAGE THAT NAMES A COMMAND MUST NAME A COMMAND THAT WORKS.
 *
 * The done-contradiction guard refused with "Repair it explicitly: `task reopen` clears the stale
 * record". There was no reopen verb. The reader ran it and got Unknown task subcommand "reopen",
 * then came back to the same problem with less information than they started with. Confident,
 * specific and wrong - the worst combination available.
 *
 * The interesting part is that reopen was NOT missing. `case "reopen"` existed, fully
 * implemented, with its own tests, because it had been written against the library. It was
 * unreachable: handleTaskCommand gates every subcommand through TASK_FLAGS at the top, and
 * "reopen" was never added there. So this was a capability that existed in the source and not
 * in the product - which is why reading the code to answer "is there a reopen verb?" gives the
 * wrong answer, and why the earlier report of a missing repair path was itself wrong.
 *
 * Two directions, because either one alone is incomplete:
 *   1. every `task <word>` named in a user-facing string is a real subcommand;
 *   2. every `case "<word>":` in the task switch is registered - an implemented branch that
 *      the gate rejects is dead code that reads as a feature.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "src", "actions.mjs"), "utf8");

// Parsing notes, because the first version of this test produced three confident false
// positives and every one of them was the test's fault rather than the code's:
//
//  - "task reassignment must not restart the clock" is PROSE, and a greedy
//    /\btask ([a-z][\w-]*)/ matched the English word. The codebase already has a convention
//    for this: a literal command goes in BACKTICKS (`task reopen`). Scanning only backtick
//    spans uses the convention instead of guessing at English.
//  - `reassign` IS registered, but two entries share a line
//    (`heartbeat: new Set([...]),  reassign: new Set([...])`), so a line-anchored
//    /^\s{2}(\w+):\s*new Set\(/ silently missed it and reported a working verb as shadowed.
//    The table is parsed as a whole, not line by line.
//  - `send` and `reply` are cases in the MAIL switch, not the task switch. Scanning every
//    `case` in the file attributed another command's branches to this gate.
//
// A guard that cannot tell prose from a command, or one entry from its neighbour, is worse
// than no guard: it trains the reader to dismiss it.

const taskFlagsBlock = SRC.slice(SRC.indexOf("const TASK_FLAGS = {"), SRC.indexOf("\n};", SRC.indexOf("const TASK_FLAGS = {")));
// A Map, not a Set, so a test can ask WHICH FLAGS a verb accepts - help text that advertises a
// flag the gate rejects sends the reader back where they started, one step later and with more
// confidence than they had before.
// The key may be QUOTED. It has to be, for any verb with a hyphen: `resume-line: new Set(...)` is
// a syntax error, so a hyphenated verb can only be registered as `"resume-line":`. The original
// pattern required an unquoted key, which meant this gate could not express ANY hyphenated verb -
// a real limitation, latent until today because no verb needed one. It failed by reporting a
// correctly-registered `resume-line` as shadowed, which is the failure mode that trains a reader
// to dismiss a guard: a gate that reports working code as broken is worse than no gate.
//
// Loosening a guard to accept your own code is exactly the move that needs a red arm, so the arm
// below proves the widened pattern still catches a quoted verb that is NOT registered.
const registered = new Map(
  [...taskFlagsBlock.matchAll(/["']?([a-z][\w-]*)["']?:\s*new Set\(\[([^\]]*)\]\)/g)]
    .map((m) => [m[1], new Set([...m[2].matchAll(/"([^"]+)"/g)].map((f) => f[1]))]),
);

// The TASK switch only: from its `switch (` to the matching close, so the mail switch's
// branches are not attributed to the task gate.
const taskSwitchStart = SRC.indexOf("switch (subcommand", SRC.indexOf("function handleTaskCommand"));
const taskSwitchEnd = SRC.indexOf("\n  }", taskSwitchStart);
const switchCases = new Set(
  [...SRC.slice(taskSwitchStart, taskSwitchEnd).matchAll(/case "([a-z][\w-]*)":/g)].map((m) => m[1]),
);

test("the gate is not empty, so the assertions below are not vacuous", () => {
  assert.ok(registered.size > 10, `expected a populated TASK_FLAGS, saw ${registered.size}`);
  assert.ok(switchCases.size > 10, `expected a populated task switch, saw ${switchCases.size}`);
});

test("every subcommand named in a user-facing string is a real, reachable one", () => {
  // Backtick spans only - that is where a literal command goes in this codebase, and it is
  // what keeps "task reassignment" (prose) out of the results. The `(?![\w:])` lookahead is
  // the second half: "Failed to write task completion:" and "Failed to write task reassignment:"
  // are noun phrases in error text, not commands, and they are inside backticks like everything
  // else, so backticks alone were not enough to exclude them.
  const spans = [...SRC.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  const named = new Set();
  for (const s of spans) {
    for (const m of s.matchAll(/\btask ([a-z][\w-]*)(?![\w:])/g)) named.add(m[1]);
  }
  const placeholders = new Set(["id", "subcommand", "help", "and", "or", "not", "is", "the", "to", "a", "in"]);
  const real = [...named].filter((n) => !placeholders.has(n));
  assert.ok(real.includes("reopen"), "the guard that produced the dead-end advice must still be named");
  const unknown = real.filter((n) => !registered.has(n));
  assert.deepEqual(unknown, [],
    `these are named in backticked user-facing text but are not real subcommands: ${unknown.join(", ")}`);
});

test("and it can still go RED: a backticked command that does not exist fails this", () => {
  // If the assertion above could not fail, it would be the same false green as the bug.
  const probe = SRC + "\nconst x = `task frobnicate the widget`;\n";
  const named = new Set([...probe.matchAll(/\btask ([a-z][\w-]*)\b/g)].map((m) => m[1]));
  assert.ok(named.has("frobnicate") && !registered.has("frobnicate"),
    "the probe really is a command that is not registered");
});

test("THE WIDENED PATTERN IS NOT A LOOSENING: a quoted, unregistered verb is still caught", () => {
  // `resume-line` widened the key pattern to accept quotes. Without this arm the change is
  // indistinguishable from deleting the check, and the honest question about any guard change -
  // does it still bite? - would have no answer.
  // A SYNTHETIC table, not SRC plus a suffix: appending to SRC put the probe AFTER the real
  // table's closing brace, so the block slice excluded it and the arm failed on its own fixture.
  // That is the failure mode of a red arm that never exercised the thing it claims to.
  const block = "const TASK_FLAGS = {\n  \"quoted-ghost\": new Set([\"id\"]),\n};";
  const found = new Set([...block.matchAll(/["']?([a-z][\w-]*)["']?:\s*new Set\(\[([^\]]*)\]\)/g)].map((m) => m[1]));
  assert.ok(found.has("quoted-ghost"), "the probe really is a registered quoted verb");
  assert.ok(!registered.has("quoted-ghost"), "and it really is not in the real table");
});

test("NO IMPLEMENTED BRANCH IS SHADOWED BY THE GATE", () => {
  // The defect in one assertion. A `case` that TASK_FLAGS does not register is code that
  // cannot run, while the source reads as though the feature shipped.
  const shadowed = [...switchCases].filter((c) => !registered.has(c));
  assert.deepEqual(shadowed, [],
    `implemented but unreachable from the CLI: ${shadowed.join(", ")}`);
});

test("`task reopen` is registered AND documented - both halves of the dead end", () => {
  // Registering it without documenting it leaves the same reader stuck, one step earlier:
  // the verb works but nothing lists it. Coordinator's help output is the evidence that the
  // help text is a load-bearing surface, not a courtesy.
  assert.ok(registered.has("reopen"), "the verb is gated in");
  const helpStart = SRC.indexOf("function taskUsage");
  const help = SRC.slice(helpStart, SRC.indexOf("\n}", helpStart));
  // The help entries are string literals, so each line starts with a quote - hence `"?`.
  assert.match(help, /^\s*"?\s*reopen <id>/m, "`task --help` lists reopen");
  assert.match(help, /--reason/, "and says the reason is required");
  // And the arms a reader would try: if the help text names a flag the gate rejects, the
  // reader is back where they started, one step later and with more confidence.
  const reopenFlags = [...help.matchAll(/reopen <id>[^\n]*/g)].join(" ");
  for (const flag of [...reopenFlags.matchAll(/--([a-z-]+)/g)].map((m) => m[1])) {
    assert.ok(registered.get("reopen").has(flag),
      `help advertises --${flag} for reopen, but the gate rejects it`);
  }
});
