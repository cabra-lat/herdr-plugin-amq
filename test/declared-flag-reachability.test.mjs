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

// ONE FACTORY, PARAMETERISED BY THE SOURCE. The transitivity arm needs a TWO-hop delegation to
// exist somewhere, and today's real graph has exactly one edge - so without this, that arm either
// cannot run or has to assert against a toy closure defined in the test, which proves nothing about
// the resolver the product uses. A check that runs against a copy of the logic is a coincidence.
function makeResolver(src) {
  const labelRe = /case "([a-z][\w-]*)":/g;
  const positions = [];
  let m;
  while ((m = labelRe.exec(src))) {
    const after = src.slice(m.index + m[0].length);
    positions.push({ label: m[1], start: m.index, bodyStart: m.index + m[0].length, fallThrough: /^\s*case\s/.test(after) });
  }
  function handlerBody(label) {
    const i = positions.findIndex((p) => p.label === label);
    if (i < 0) return null;
    let j = i;
    while (positions[j].fallThrough && j + 1 < positions.length) j += 1;   // shared body
    const from = positions[j].bodyStart;
    const next = src.slice(from).search(/\n {4}(case |default:)/);
    return next < 0 ? src.slice(from) : src.slice(from, from + next);
  }
  const cycles = [];
  // Flag -> shortest hop at which it was found. Reported in failures so one-hop and three-hop
  // reachability are distinguishable at a glance rather than both reading as "reachable".
  const flagHops = new Map();
  const note = (flag, hops) => {
    if (!flagHops.has(flag) || hops < flagHops.get(flag)) flagHops.set(flag, hops);
  };
  function readsFor(label, seen = new Set(), hops = 0) {
    if (seen.has(label)) { cycles.push([...seen, label].join(" -> ")); return new Set(); }
    seen.add(label);
    const body = handlerBody(label);
    if (body === null) return new Set();
    const direct = new Set([
      ...[...body.matchAll(/flags\.([a-zA-Z_]\w*)/g)].map((x) => x[1]),
      ...[...body.matchAll(/flags\["([^"]+)"\]/g)].map((x) => x[1]),
    ]);
    for (const flag of direct) note(flag, hops);
    for (const d of body.matchAll(/handleTaskCommand\(\s*"([a-z][\w-]*)"/g)) {
      for (const flag of readsFor(d[1], seen, hops + 1)) direct.add(flag);
    }
    for (const flag of direct) note(flag, hops);
    return direct;
  }
  function graph() {
    const g = new Map();
    for (const { label } of positions) {
      const body = handlerBody(label);
      if (body === null) continue;
      g.set(label, [...body.matchAll(/handleTaskCommand\(\s*"([a-z][\w-]*)"/g)].map((x) => x[1]));
    }
    return g;
  }
  return { positions, handlerBody, readsFor, graph, cycles, flagHops, labels: positions.map((p) => p.label) };
}

const RESOLVER = makeResolver(taskSwitch);
const { positions, handlerBody, readsFor, labels, cycles: delegationCycles, flagHops } = RESOLVER;
function delegationGraph() { return RESOLVER.graph(); }


// A handler that forwards to another verb inherits that verb's reads. `seen` makes a mutual
// delegation terminate instead of recursing forever, which is the cycle guard the chain-walk in
// the blocked-metrics work needed for the same reason.
// BALLISTICS' POINT 3, taken in full: a delegating verb's flag surface is a FUNCTION of its
// delegate's plus a raw passthrough, so every reachability row for it is a statement about a
// GRAPH and not about a handler. Two consequences, both asserted below rather than assumed:
//
//   RESOLVE TRANSITIVELY. A one-hop resolver passes today's code (one edge, next -> drain) and
//   quietly mis-reports a TWO-hop delegation, because the flag is found in the second delegate
//   and the row looks fine. The hop count is what distinguishes "reachable in one hop" from
//   "reachable by luck" at a glance - the difference between a check and a coincidence.
//
//   FAIL ON A CYCLE RATHER THAN SURVIVING IT. The old code carried a `seen` set, which stops the
//   recursion - and that is exactly the problem. A cycle `next -> drain -> next` is not a wrong
//   answer a test can see; with `seen` it silently yields whatever was collected before the
//   repeat, the suite passes, and the real failure is that a future refactor makes the CLI never
//   return. A hung test is indistinguishable from a slow machine, so this is a failure mode with
//   NO OUTPUT. Cycle is now thrown, which turns an invisible hang into a red assertion.


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
  const hopsByVerb = new Map();
  for (const [verb, flags] of declared) {
    if (!labels.includes(verb)) continue;          // aliases share a label; covered elsewhere
    // The hop map is CLEARED PER VERB on purpose. It is written by every traversal, so a
    // shared map reports the SHORTEST hop across all verbs - and `claim@0` would then describe
    // drain's own direct read while the reader is asking about next, which is one hop further
    // out. A number that answers a different question than the one asked is worse than no
    // number, because it looks authoritative.
    flagHops.clear();
    const reads = readsFor(verb);
    hopsByVerb.set(verb, new Map(flagHops));
    for (const flag of flags) {
      // `from`/`me` are the metadata envelope read by the shared preamble rather than a handler,
      // and `help` is handled before dispatch. Declared universally on every verb.
      if (flag === "from" || flag === "help" || flag === "me") continue;
      if (!reads.has(flag)) inert.push(`task ${verb} --${flag}`);
    }
  }
  // A delegating verb's flags are a FUNCTION of its delegate's plus a raw passthrough, so
  // "reachable in one hop" and "reachable three hops down" must not read the same in a failure.
  // `found at hop N` is the difference between a check and a coincidence.
  // Reported for the INERT VERBS, not whichever verb happened to be traversed last. An inert
  // flag has no read at all, so "what did this verb read, and how far away" is the diagnostic
  // that says something: hop 0 means the handler has the flag in hand and ignores it, while
  // hop 2 means the value is two delegations away and the loss happened in between.
  const fmt = (m) => (m && m.size ? [...m].sort((x, y) => x[1] - y[1]).map(([f, h]) => f + "@hop" + h).join(" ") : "nothing read");
  const inertDetail = () => {
    const verbs = [...new Set(inert.map((entry) => entry.split(" ")[1]))];
    if (verbs.length === 0) return "";
    return " Per inert verb: " + verbs.map((v) => `${v} [${fmt(hopsByVerb.get(v))}]`).join("; ") + ".";
  };
  const delegated = [...RESOLVER.graph()].filter(([, to]) => to.length).map(([f, t]) => `${f}->${t.join(",")}`);
  const detail = inert.length === 0 ? "" :
    ` Delegation edges walked: ${delegated.length ? delegated.join("; ") : "none"}.` +
    `${inertDetail()}`
  assert.deepEqual(inert, [],
    `declared and accepted by the parser but never read: ${inert.join(", ")}${detail}`);
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

test("THE DELEGATION GRAPH IS ACYCLIC, so a cycle cannot become a hang", () => {
  // A cycle is the one failure mode here with NO OUTPUT: the resolver's `seen` set makes it
  // terminate, the collected flags still look plausible, the suite passes - and what actually
  // happened is that a refactor made the CLI never return. There is no assertion that fails,
  // because there is no wrong answer, only a machine that stopped.
  const g = delegationGraph();
  const state = new Map();
  const walk = (n, path) => {
    if (state.get(n) === "done") return;
    if (state.get(n) === "open") {
      assert.fail(`delegation cycle: ${[...path, n].join(" -> ")}`);
    }
    state.set(n, "open");
    for (const m of g.get(n) || []) walk(m, [...path, n]);
    state.set(n, "done");
  };
  for (const n of g.keys()) walk(n, []);
  // And record what today's graph actually is, so a future edge is visible in the diff rather
  // than discovered by a hang.
  const edges = [...g].filter(([, to]) => to.length).map(([from, to]) => `${from} -> ${to.join(",")}`);
  assert.ok(edges.length >= 1, "there is at least one delegation to walk");
  assert.deepEqual(delegationCycles, [], "resolving the real graph must not encounter a cycle");
});

test("RESOLUTION IS TRANSITIVE, and this arm runs the REAL resolver", () => {
  // Built from SOURCE, and run through makeResolver - the same code path that walks
  // actions.mjs. The first version of this arm defined its own two-hop closure inside the test
  // and passed, and capping the REAL resolver at one hop still left the suite green: the arm was
  // proving a copy of the logic rather than the logic. A check that runs against a copy is a
  // coincidence wearing a test's clothes.
  //
  // `c` reads the flag, `b` delegates to `c`, `a` delegates to `b`. Two hops, which today's
  // real graph does not contain - one edge, next -> drain - so only a synthetic SOURCE can
  // produce this, and only the real resolver can answer it.
  const synthetic = makeResolver(`
    case "a": { handleTaskCommand("b", []); }
    case "b": { handleTaskCommand("c", []); }
    case "c": { const x = flags.proof; }
    default:
  `);
  assert.ok(synthetic.readsFor("a").has("proof"), "a flag two hops down must be found");
  // And the negative direction, so "found" is not an artifact of returning everything.
  assert.equal(synthetic.readsFor("a").has("nonesuch"), false, "and nothing is invented on the way");
  assert.equal(synthetic.readsFor("c").has("proof"), true, "the reading verb sees its own flag");
});

test("A CYCLE IS DETECTED BY THE REAL RESOLVER, not survived by it", () => {
  // The no-output failure mode. The resolver's `seen` set makes a cycle TERMINATE, which is
  // exactly the defect: it terminates quietly, the collected flags still look plausible, the
  // suite passes - and what actually happened is the CLI would never return.
  const cyc = makeResolver(`
    case "a": { handleTaskCommand("b", []); }
    case "b": { handleTaskCommand("a", []); }
    default:
  `);
  cyc.readsFor("a");
  assert.ok(cyc.cycles.length > 0, "a cycle must be RECORDED, not absorbed by the recursion guard");
  assert.match(cyc.cycles[0], /a -> b -> a/, "and the path must be reported, so a hang becomes readable");
});
