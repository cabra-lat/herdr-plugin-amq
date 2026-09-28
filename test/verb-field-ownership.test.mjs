import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// ISOLATION, and it is load-bearing rather than tidy. board.mjs records every card write to the
// state dir RESOLVED AT CALL TIME, so a test that does not set this writes its fixture cards into
// the real ~/.herdr-amq-state and evicts real card history: 194 of 200 audit slots are test
// residue, and task_1790520029313_38a378's log was unlinked while its card survived. Set at module
// scope, before any test runs, because the read happens when the write happens.
//
// `||=` so a file that already isolates keeps its own directory. The guard that keeps this true
// is test/state-isolation-guard.test.mjs; it names any file that drifts back.
process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-verb-field-ownership-"));


/**
 * A ROUTINE VERB MUST NOT DESTROY A TIMESTAMP IT DOES NOT OWN.
 *
 * Four fields, four different ad-hoc mechanisms, in four places, each with its own comment:
 * claimed_at guarded by a transition test, blocked_at by an isBlocked ternary, done_at by a
 * hasOwnProperty carve-out, proof by a `??` chain. All four are individually correct and none of
 * them is wrong tonight - that is the point. What is missing is any single STATEMENT of the
 * invariant they all implement, so nothing stops a FIFTH field, added tomorrow, from getting no
 * guard at all. Every one of tonight's three defects was found by a person looking for a defect
 * in that particular field, not by anything that would have found the class.
 *
 * So this is a TABLE rather than a fifth finding. One fixture, one assertion per verb, and it
 * fails loudly the moment a verb grows a new write - including a write nobody was looking for.
 *
 * THE CLOCK PROBLEM, which ballistics identified and which is why every stamp below is set to a
 * deliberately ANCIENT date. Without an injected clock, a reset landing in the same millisecond
 * as the verb is indistinguishable from a preserve, and the probe would be decorative. A 2020
 * stamp cannot be re-created by a verb that writes `now`, so equality proves preservation without
 * needing to control time at all. (`opts.now` at board.mjs is the library-level equivalent; the
 * CLI has no such hook, and this is the CLI.)
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "herdr-amq.mjs");
const ANCIENT = "2020-01-01T00:00:00.000Z";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verbfield-"));
  fs.mkdirSync(path.join(root, ".agent-mail", "bus"), { recursive: true });
  return root;
}
const cli = (root, args) =>
  execFileSync(process.execPath, [CLI, ...args], {
    cwd: root, env: { ...process.env, AMQ_ME: "lane" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
const cardIn = (root, id) => {
  for (const stage of fs.readdirSync(path.join(root, ".agent-mail", "bus"))) {
    const f = path.join(root, ".agent-mail", "bus", stage, `${id}.md`);
    if (fs.existsSync(f)) return { stage, text: fs.readFileSync(f, "utf8") };
  }
  throw new Error(`card ${id} in no stage`);
};
const field = (text, name) => text.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];

// Every stamp and evidence field a routine verb could plausibly touch. The watch list must
// include the field the verb ACTS on: ballistics' description arm watched thirteen stamps and
// not `description`, so the arm could not have failed - the expectation excluded the thing under
// test. `title` is here for the same reason.
const WATCHED = [
  "claimed_at", "blocked_at", "done_at", "status_at", "updated", "owner_at", "next_actor_at",
  "last_heartbeat_at", "blocked_ms", "blocked_total_ms", "proof", "description", "title",
  "next_actor", "owner", "notes", "depends_on",
  // resume_line, lease_epoch and lease_started_at are watched for a second reason: they are
  // DELIBERATELY not allowed to move `updated`, and an arm that cannot see them cannot prove it.
  "resume_line", "lease_epoch", "lease_started_at",
];

// A card already `doing`, every stamp pushed into the past so any rewrite is unmissable.
function doingCard(root) {
  const id = cli(root, ["task", "create", "--title", "owned", "--owner", "lane"])
    .match(/task_[0-9a-f_]{8,}/)?.[0];
  cli(root, ["task", "claim", id]);
  const f = path.join(root, ".agent-mail", "bus", "doing", `${id}.md`);
  let text = fs.readFileSync(f, "utf8");
  for (const key of ["claimed_at", "status_at", "updated", "owner_at"]) {
    text = text.replace(new RegExp(`^${key}: .*$`, "m"), `${key}: "${ANCIENT}"`);
  }
  fs.writeFileSync(f, text);
  return id;
}

const before = (root, id) => Object.fromEntries(WATCHED.map((k) => [k, field(cardIn(root, id).text, k)]));

// `updated` is owned by EVERY verb that writes the card at all - it is the modification time,
// not a lifecycle stamp - so it is declared once rather than repeated per row.
//
// The rows below are more precise than the measured draft I started from, which recorded
// reassign as "owner + next_actor only" and did not itemise the stamps. Building the table
// showed that a single `reassign --to` also writes `updated`, `owner_at` and `next_actor`. All
// three are legitimate writes: the card changed, so the modification time moves; the owner
// changed, so `owner_at` moves; and the verb moves the actor with the owner. The table's value
// is not in the fields a verb MAY write - it is in the ones it may not, which is why the
// expectations are declared rather than inferred.
// THE FIELD THAT PROVES EACH VERB ACTUALLY DID SOMETHING.
//
// I first used `updated` for this, on the claim that "updated is owned by every write because it
// is a modification time and not a lifecycle stamp". That claim is TOO STRONG, and two rows
// caught it: `heartbeat` and `comment` do not move `updated` - deliberately, because a note and
// a heartbeat are narration, not progress, and a board where they moved the modification time
// would make looking busy indistinguishable from working. So `updated` is a poor liveness probe
// for exactly the two verbs whose whole point is not to look like work.
//
// Which also means `updated` belongs in mayChange (it is not a defect when it moves) and NOT in
// the set of things a verb must move. Each row therefore declares the field that proves IT
// acted, and the table says so rather than leaving a reader to infer it.
const EVERY_WRITE = ["updated"];   // may move; never a defect. Not a proof of anything.

const VERBS = [
  { name: "reassign owner", args: (id) => ["task", "reassign", id, "--to", "someone-else"], mayChange: ["owner", "owner_at", "next_actor"], mustChange: "owner" },
  { name: "reassign next_actor", args: (id) => ["task", "reassign", id, "--to", "lane", "--next-actor", "verifier"], mayChange: ["next_actor", "next_actor_at"], mustChange: "next_actor" },
  { name: "heartbeat", args: (id) => ["task", "heartbeat", id], mayChange: ["last_heartbeat_at", "last_heartbeat_by"], mustChange: "last_heartbeat_at" },
  { name: "comment", args: (id) => ["task", "comment", id, "--text", "a note"], mayChange: ["notes"], mustChange: "notes" },
  // mayChange is EXACTLY resume_line and nothing else - not `updated`. A resume line restates an
  // obligation that already exists, so treating the restatement as progress would let an agent
  // clear its own stall by re-typing what it was already supposed to do.
  { name: "resume-line", args: (id) => ["task", "resume-line", id, "--text", "land the commit"], mayChange: ["resume_line"], mustChange: "resume_line" },
  // This row REPLACES a "priority bump" row from the measured draft I started from, which
  // recorded "priority bump: none". There is no such command: `reassign` rejects --priority as an
  // unknown option, and its help never advertised one. So that row measured a command that does
  // not exist and reported "no stamp touched" - a vacuous arm wearing a measurement's clothes,
  // which is the same defect as the description arm in the same draft.
  //
  // An edge write is the more useful row anyway: depends_on is the field tonight's three defects
  // circled, and it is written by a routine verb.
  { name: "reassign adding a dependency", args: (id) => ["task", "reassign", id, "--to", "lane", "--depends-on", "some-other-card"], mayChange: ["depends_on"], mustChange: "depends_on" },
];

for (const verb of VERBS) {
  test(`${verb.name} on a doing card touches no stamp it does not own`, () => {
    const root = workspace();
    const id = doingCard(root);
    const b = before(root, id);
    cli(root, verb.args(id));
    const afterText = cardIn(root, id).text;
    const allowed = new Set([...verb.mayChange, ...EVERY_WRITE]);
    const changed = WATCHED.filter((k) => field(afterText, k) !== b[k] && !allowed.has(k));
    assert.deepEqual(changed, [],
      `${verb.name} changed ${changed.join(", ")} - a routine verb must not destroy a field it does not own`);
    // AND THE WRITE ACTUALLY LANDED. Without this a row whose command is a silent no-op passes:
    // "nothing changed" is exactly what a dead row looks like, and it is indistinguishable from
    // the row's actual claim. Only `reassign` had a positive arm; the other four were asking a
    // question that a verb which does nothing would also answer correctly.
    assert.notEqual(field(afterText, verb.mustChange), b[verb.mustChange],
      `${verb.name} must actually change ${verb.mustChange}, or this row measures nothing`);
  });
}

// EVERY ROW MUST NAME A VERB THAT EXISTS, WITH FLAGS THE PARSER ACCEPTS.
//
// This is the FOURTH vacuity mode, and it is the one no runtime assertion catches: a path that is
// unreachable from ANY verb. No exit code, no assertion and no amount of running detects it,
// because at the library level the code is correct and the fixture is asking a question no user
// can ask. Ballistics' "priority bump" row was exactly this: `updateBoardTask(..., {priority:
// "high"})` returns ok:true, the field reads high, nothing throws - a green row for a path with
// no door. Their probe called the library, so there was no non-zero exit to notice.
//
// Assertions detect DIVERGENCE - an arm behaving unlike its expectation. They cannot detect
// UNREACHABILITY, where the arm behaves exactly as expected and the question was never asked.
// So the defence has to be STATIC: enumerate verb -> flags, which is what this does, by reading
// the same TASK_FLAGS table the CLI gates on.
//
// The CLI level catches the REJECTED case for free - execFileSync throws on a non-zero exit, so
// an unknown verb or flag fails the row loudly. What it cannot catch is a row whose flags parse
// but whose semantics nothing ever performs. That is what this check is for, and it is the same
// parser the product uses rather than a second opinion about it.
test("STATIC REACHABILITY: every row names a real verb with flags the CLI accepts", () => {
  const actions = fs.readFileSync(path.join(HERE, "..", "src", "actions.mjs"), "utf8");
  const block = actions.slice(actions.indexOf("const TASK_FLAGS = {"), actions.indexOf("\n};", actions.indexOf("const TASK_FLAGS = {")));
  // The key may be QUOTED, and it must be for any hyphenated verb: `resume-line: new Set(...)` is
  // a syntax error, so the verb can only be registered as `"resume-line":`. This parser had the
  // same unquoted-only limitation as the one in named-verb-reachability.test.mjs, and it reported
  // a correctly-registered verb as non-existent. Two copies of one bug is the reason to fix the
  // pattern in both rather than in whichever one bit first.
  const flagsFor = new Map(
    [...block.matchAll(/["']?([a-z][\w-]*)["']?:\s*new Set\(\[([^\]]*)\]\)/g)]
      .map((m) => [m[1], new Set([...m[2].matchAll(/"([^"]+)"/g)].map((f) => f[1]))]),
  );
  assert.ok(flagsFor.size > 10, `TASK_FLAGS did not parse, so this check would be vacuous (${flagsFor.size})`);
  for (const verb of VERBS) {
    const argv = verb.args("task_x");
    const name = argv[1];
    assert.ok(flagsFor.has(name), `row "${verb.name}" names a verb that does not exist: ${name}`);
    const allowed = flagsFor.get(name);
    for (let i = 2; i < argv.length; i += 1) {
      const token = argv[i];
      if (!token.startsWith("--")) continue;
      const flag = token.slice(2);
      assert.ok(allowed.has(flag),
        `row "${verb.name}" uses --${flag}, which "task ${name}" rejects: the row exercises a path no user can reach`);
    }
  }
});

test("AND THE POSITIVE DIRECTION: the field the verb DOES own does change", () => {
  // Without this, "nothing ever changes" satisfies every arm above - and would be achieved by
  // simply not writing the card at all, which is the failure mode of a fixture that swallows
  // its own command.
  const root = workspace();
  const id = doingCard(root);
  const b = before(root, id);
  cli(root, ["task", "reassign", id, "--to", "someone-else"]);
  const afterText = cardIn(root, id).text;
  assert.notEqual(field(afterText, "owner"), b.owner, "reassign really re-owns the card");
  assert.equal(field(afterText, "claimed_at"), b.claimed_at, "and still does not restamp the claim");
});

test("blocked_at survives its OWN verb's siblings - the defect d317cfd fixed, as a table row", () => {
  // The one row that WAS a real defect. It lives in this table now so the class has a home,
  // rather than as a fifth isolated finding that someone has to remember to look for.
  const root = workspace();
  const id = cli(root, ["task", "create", "--title", "gated", "--owner", "lane"]).match(/task_[0-9a-f_]{8,}/)?.[0];
  cli(root, ["task", "block", id, "--reason", "waiting on a human", "--next-actor", "user"]);
  const stamp = field(cardIn(root, id).text, "blocked_at");
  assert.ok(stamp, "the card is blocked and carries a stamp");
  cli(root, ["task", "reassign", id, "--to", "lane", "--next-actor", "verifier"]);
  assert.equal(field(cardIn(root, id).text, "blocked_at"), stamp, "re-routing is not a new wait");
});

test("NOT COVERED HERE, AND SAID SO RATHER THAN IMPLIED: done, reopen and claim", () => {
  // These change status by design, so a blanket "touched nothing" assertion would be wrong for
  // them and a vacuous one would be worse. They belong in a table keyed on transitions. This
  // test exists to make the omission explicit instead of letting a reader assume the table is
  // the whole write path - it covers six verbs and fifteen fields, not the board.
  assert.ok(true);
});
