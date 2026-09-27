import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  "last_heartbeat_at", "blocked_ms", "blocked_total_ms", "proof", "description", "title", "next_actor", "owner",
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
const EVERY_WRITE = ["updated"];

const VERBS = [
  { name: "reassign owner", args: (id) => ["task", "reassign", id, "--to", "someone-else"], mayChange: ["owner", "owner_at", "next_actor"] },
  { name: "reassign next_actor", args: (id) => ["task", "reassign", id, "--to", "lane", "--next-actor", "verifier"], mayChange: ["next_actor", "next_actor_at"] },
  { name: "heartbeat", args: (id) => ["task", "heartbeat", id], mayChange: ["last_heartbeat_at", "last_heartbeat_by"] },
  { name: "comment", args: (id) => ["task", "comment", id, "--text", "a note"], mayChange: [] },
  // This row REPLACES a "priority bump" row from the measured draft I started from, which
  // recorded "priority bump: none". There is no such command: `reassign` rejects --priority as an
  // unknown option, and its help never advertised one. So that row measured a command that does
  // not exist and reported "no stamp touched" - a vacuous arm wearing a measurement's clothes,
  // which is the same defect as the description arm in the same draft.
  //
  // An edge write is the more useful row anyway: depends_on is the field tonight's three defects
  // circled, and it is written by a routine verb.
  { name: "reassign adding a dependency", args: (id) => ["task", "reassign", id, "--to", "lane", "--depends-on", "some-other-card"], mayChange: [] },
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
  });
}

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
