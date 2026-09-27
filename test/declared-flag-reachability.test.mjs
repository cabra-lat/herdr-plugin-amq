import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A FLAG THAT PARSES AND IS NEVER READ IS A FLAG THAT DOES NOTHING.
 *
 * Ballistics enumerated TASK_FLAGS against the case handlers and found `task reopen --stage`
 * declared, accepted by the parser, and read nowhere - the handler hardcoded
 * `{ status: "doing" }`. So `--stage queued` succeeded, printed a success message, and filed the
 * card in `doing`. Worse, the TASK_FLAGS comment for reopen CLAIMED the capability and cited
 * `unblock` as the verb that has it: a claim in the artifact about what the artifact does.
 *
 * THEIR OTHER FINDING WAS A FALSE POSITIVE, and this test is built so it cannot become one.
 * They reported `task next --claim` as declared-and-inert because the only `flags.claim` read is
 * inside `task drain`. It is not inert: `case "next"` DELEGATES -
 * `handleTaskCommand("drain", [...rawArgs, "--claim"])` - so the read in drain IS the flag's
 * implementation for next. Measured through the CLI: `next` claims, `next --claim` claims, and
 * `drain` alone does NOT claim, which is what makes the flag load-bearing at all.
 *
 * A checker that reads each handler in isolation produces exactly that false positive, which is
 * the same segmentation artifact that produced 19 phantom orphans in their second attempt. So this
 * checker RESOLVES DELEGATION: a handler that forwards to another verb inherits that verb's
 * reads. Reachability has three depths - does the verb exist, does the flag exist, is the flag's
 * VALUE used - and the first two are static. This covers the second, and only the shallow end of
 * the third, and says so rather than implying more.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "src", "actions.mjs"), "utf8");

const flagsBlock = SRC.slice(SRC.indexOf("const TASK_FLAGS = {"), SRC.indexOf("\n};", SRC.indexOf("const TASK_FLAGS = {")));
const declared = new Map(
  [...flagsBlock.matchAll(/([a-z][\w-]*):\s*new Set\(\[([^\]]*)\]\)/g)]
    .map((m) => [m[1], new Set([...m[2].matchAll(/"([^"]+)"/g)].map((f) => f[1]))]),
);

// The TASK switch only, so the mail switch's handlers are not attributed to the task gate. The
// file-wide version of this produced a phantom on `drain`, which exists in both switches - the
// artifact was only visible because each hit was checked by hand before it was reported.
const switchStart = SRC.indexOf("switch (subcommand", SRC.indexOf("function handleTaskCommand"));
const switchEnd = SRC.indexOf("\n  }", switchStart);
const taskSwitch = SRC.slice(switchStart, switchEnd);

// FALL-THROUGH IS REAL AND IT IS WHAT PRODUCED BALLISTICS' 19 PHANTOM ORPHANS.
// `case "create":` / `case "assign":` and `done` / `complete` share one body, so a per-label slice
// ends at the next label and returns an empty string - and every flag in a shared handler then
// looks unread. A 19-hit finding that is entirely segmentation artifact is the most dangerous
// output shape there is, because it is specific. So a label whose next non-blank token is another
// `case` is a FALL-THROUGH LABEL: it has no body of its own and must take the next body's.
function labelPositions() {
  const out = [];
  const re = /case "([a-z][\w-]*)":/g;
  let m;
  while ((m = re.exec(taskSwitch))) {
    const after = taskSwitch.slice(m.index + m[0].length);
    const isFallThrough = /^\s*case\s/.test(after);
    out.push({ label: m[1], start: m.index, bodyStart: m.index + m[0].length, fallThrough: isFallThrough });
  }
  return out;
}
const positions = labelPositions();

function handlerBody(label) {
  const i = positions.findIndex((p) => p.label === label);
  if (i < 0) return null;
  let j = i;
  while (positions[j].fallThrough && j + 1 < positions.length) j += 1;  // follow the shared body
  const from = positions[j].bodyStart;
  const next = taskSwitch.slice(from).search(/\n {4}(case |default:)/);
  return next < 0 ? taskSwitch.slice(from) : taskSwitch.slice(from, from + next);
}

const labels = positions.map((p) => p.label);

// A handler that forwards to another verb inherits that verb's reads. `seen` makes a mutual
// delegation terminate instead of recursing forever, which is the cycle guard the chain-walk in
// the blocked-metrics work needed for the same reason.
function readsFor(label, seen = new Set()) {
  if (seen.has(label)) return new Set();
  seen.add(label);
  const body = handlerBody(label);
  if (body === null) return new Set();
  // Both access forms. A dashed flag name cannot be written `flags.next-actor`, so every edge
  // flag is read as `flags["next-actor"]` - and a dot-only regex reports all nine of them as
  // declared-and-inert. That is a third false positive of exactly the kind this file exists to
  // stop shipping, and I hit it myself in the first run: 32 findings, of which 9 were this.
  const direct = new Set([
    ...[...body.matchAll(/flags\.([a-zA-Z_]\w*)/g)].map((m) => m[1]),
    ...[...body.matchAll(/flags\["([^"]+)"\]/g)].map((m) => m[1]),
  ]);
  for (const m of body.matchAll(/handleTaskCommand\(\s*"([a-z][\w-]*)"/g)) {
    for (const flag of readsFor(m[1], seen)) direct.add(flag);
  }
  return direct;
}

test("the checker parsed something, so a clean result is not vacuous", () => {
  // Ballistics' first attempt reported "0 flags parsed" and "(none) dead flags" - a vacuous arm
  // that compared against an empty set and called it a result. The 0 was implausible because 26
  // flag names are read in the file. Assert the SHAPE first, so an empty parse fails here
  // instead of turning every inert-flag check below into a pass.
  assert.ok(declared.size > 10, `TASK_FLAGS did not parse (${declared.size} verbs)`);
  assert.ok(labels.length > 8, `the task switch did not parse (${labels.length} labels)`);
});

test("FALL-THROUGH IS HANDLED, not mistaken for an inert flag", () => {
  // `create` shares a body with `assign` and reads eleven flags. If the segmenter sliced per
  // label, every one of those would be reported as declared-and-inert - which is exactly the
  // 19-orphan artifact. Assert a known shared-body verb reads its flags, so a regression in the
  // segmenter fails as "the checker is wrong" rather than as 32 real findings.
  const reads = readsFor("create");
  for (const f of ["title", "owner", "desc", "status", "priority"]) {
    assert.ok(reads.has(f), `create must be seen reading --${f} (shared body with assign)`);
  }
});

test("NO DECLARED FLAG IS INERT IN ITS OWN VERB, and delegation is resolved", () => {
  const inert = [];
  for (const [verb, flags] of declared) {
    if (!labels.includes(verb)) continue;          // aliases share a label; covered elsewhere
    const reads = readsFor(verb);
    for (const flag of flags) {
      // `from`/`me` are the metadata envelope read by the shared preamble rather than a handler,
      // and `help` is handled before dispatch. Declared universally on every verb.
      if (flag === "from" || flag === "help" || flag === "me") continue;
      if (!reads.has(flag)) inert.push(`task ${verb} --${flag}`);
    }
  }
  assert.deepEqual(inert, [],
    `declared and accepted by the parser but never read: ${inert.join(", ")}`);
});

test("THE CONTROL: `next --claim` is reachable BY DELEGATION, not by its own read", () => {
  // If delegation were not resolved this would be reported as inert - the false positive this
  // file exists to avoid. Asserting it explicitly means a refactor that breaks the delegation
  // fails HERE with an accurate message, rather than being quietly excused as "aliases share a
  // handler" the way it would be if this assertion were left to the loop above.
  const reads = readsFor("next");
  assert.ok(reads.has("claim"), "`next` reaches --claim by delegating to drain with it appended");
  assert.ok(readsFor("drain").has("claim"), "and drain is where the read actually happens");
});

test("DASHED FLAGS ARE READ, and a dot-only regex would have called all nine inert", () => {
  // The nine edge flags (`--next-actor`, `--depends-on`, `--clear-depends-on` across five verbs)
  // cannot be accessed with dot notation, so they appear only as `flags["next-actor"]`. This
  // asserts one of them directly, so the failure reads as "the checker lost the access form"
  // rather than as nine confident findings that would send someone to fix working code.
  assert.ok(readsFor("reassign").has("next-actor"),
    "reassign reads --next-actor via bracket notation; a dot-only regex misses it");
  assert.ok(readsFor("block").has("depends-on"), "block reads --depends-on the same way");
});
test("`reopen --stage` is READ now - the defect ballistics actually found", () => {
  // The counterpart to the control above. If someone "fixes" a failure by deleting the flag from
  // TASK_FLAGS, the loop test still passes and this one fails - the flag must work, not vanish.
  assert.ok(handlerBody("reopen") !== null, "the reopen handler exists");
  assert.ok(readsFor("reopen").has("stage"),
    "reopen must READ --stage, not merely accept it; a removed flag is not a fixed flag");
});
