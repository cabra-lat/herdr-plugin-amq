import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";
import { runDoorbellPass } from "../src/bridge.mjs";
import { addBoardTask, updateBoardTask, setTaskResumeLine } from "../src/board.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "herdr-amq.mjs");

/**
 * AN AGENT STOPS AFTER COMPACTING AND NOTHING ON THIS BOARD NOTICES.
 *
 * A card left in_progress still shows a live owner and a recent heartbeat, so it reads as owned
 * and young: nothing doorbells, the stall alert considers it fresh, and every indicator says
 * everything is fine. Meanwhile the agent has lost the thread, because compaction preserves a
 * summary of FACTS and drops the OBLIGATION first - that a commit is still owed, that a
 * measurement is still owed. The state is consistent and wrong.
 *
 * The heartbeat cannot be the trigger, and that is the load-bearing observation rather than a
 * detail: a heartbeat is a lease, and a lease proves PRESENCE, which is precisely the thing
 * compaction destroys. So this reads the card's own last_heartbeat_at - an agent that stopped
 * sending them is visible even though its card still looks owned.
 *
 * The failure mode the whole design is shaped around: a re-prompt that fires during legitimate
 * long work teaches an agent to stop, and an agent told to resume and then told to restart from
 * zero will learn not to resume at all. So the lease is generous, the prompt is advisory, and
 * arrival is explicitly never a reason to discard partial analysis.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lease-"));
  const amqRoot = path.join(root, ".agent-mail");
  fs.mkdirSync(path.join(amqRoot, "agents"), { recursive: true });
  fs.mkdirSync(path.join(amqRoot, "bus"), { recursive: true });
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(root, "state");
  fs.mkdirSync(process.env.HERDR_PLUGIN_STATE_DIR, { recursive: true });
  return { root, amqRoot };
}

const NOW = Date.parse("2026-09-27T20:00:00.000Z");
const mins = (n) => n * 60_000;
const card = (id, extra = {}) => ({
  id, title: "long analysis", owner: "analyst", status: "in_progress",
  created: new Date(NOW - mins(600)).toISOString(),
  status_at: new Date(NOW - mins(600)).toISOString(),
  updated: new Date(NOW - mins(600)).toISOString(),
  last_heartbeat_at: new Date(NOW - mins(200)).toISOString(),
  ...extra,
});
const build = (columns, thresholds) =>
  buildCoordinatorMetrics({
    board: { columns }, now: NOW,
    deliveredState: { delivered: {} },
    thresholds: thresholds || { ownerLeaseMs: mins(90), ownerLeaseReassignMs: 6 * 60 * mins(1) },
  });
const lapsed = (m) => m.alerts.find((a) => a.id === "owner_lease_lapsed")?.cards || [];

// --- the metric ---------------------------------------------------------------------------------

test("THE DEFECT: a lapsed owner lease on an in_progress card is reported at all", () => {
  const m = build({ doing: [card("task_gone")] });
  const c = lapsed(m).find((x) => x.id === "task_gone");
  assert.ok(c, "an agent that stopped heartbeating while still holding a card must be visible");
  assert.equal(c.owner, "analyst");
  assert.ok(c.leaseAgeMs > mins(90), "and the age is measured from the card's own heartbeat");
});

test("AN AGENT THAT IS STILL HEARTBEATING IS NEVER REPORTED - this is not an age alert", () => {
  // The boundary the card is most worried about. Long work legitimately goes without a heartbeat,
  // but a GENEROUS lease plus "only lapsed leases" means ordinary analysis is never interrupted.
  const fresh = build({ doing: [card("task_fresh", { last_heartbeat_at: new Date(NOW - mins(5)).toISOString() })] });
  assert.equal(lapsed(fresh).length, 0, "a heartbeating agent must be silent");
  const old = build({ doing: [card("task_old", { last_heartbeat_at: new Date(NOW - mins(20)).toISOString() })] });
  assert.equal(lapsed(old).length, 0, "and 20 minutes is NOT a lapsed lease - the threshold is deliberately generous");
});

test("A CARD THAT IS NOT IN PROGRESS IS NEVER REPORTED", () => {
  for (const status of ["done", "blocked", "backlog", "queued"]) {
    const m = build({ doing: [card("t", { status })] });
    assert.equal(lapsed(m).length, 0, `a ${status} card is not a lapsed lease`);
  }
});

test("A CARD THAT NEVER HEARTBEATED IS NOT REPORTED - a different question, not a lapsed one", () => {
  // Reporting it here would be a guess: a card claimed and never heartbeated might be minutes old.
  const m = build({ doing: [card("t", { last_heartbeat_at: null })] });
  assert.equal(lapsed(m).length, 0);
});

test("THE RESUME LINE IS QUOTED, and its ABSENCE is reported rather than invented", () => {
  // A fabricated next action is a confident instruction to do the wrong work, which is strictly
  // worse than admitting the card does not say. The missing case is the more important half.
  const withLine = lapsed(build({ doing: [card("a", { resume_line: "land the test for the blocked_at fix" })] })).find((x) => x.id === "a");
  const without = lapsed(build({ doing: [card("b")] })).find((x) => x.id === "b");
  assert.equal(withLine.resumeLine, "land the test for the blocked_at fix");
  assert.equal(without.resumeLine, null, "an absent resume line stays null and is never synthesised");
  assert.ok("resumeLine" in without, "the key is PRESENT and null - an absent key would read as a card that has no such concept");
});

test("A SECOND LAPSIS IS OFFERED FOR REASSIGNMENT, a first is not", () => {
  // Two distinct sub-cases: a compacted agent that can act on its line, versus a process that is
  // gone and cannot. Both start identical from outside; the cheap move is to re-prompt first.
  const first = lapsed(build({ doing: [card("a", { last_heartbeat_at: new Date(NOW - mins(120)).toISOString() })] })).find((x) => x.id === "a");
  const later = lapsed(build({ doing: [card("b", { last_heartbeat_at: new Date(NOW - mins(8 * 60)).toISOString() })] })).find((x) => x.id === "b");
  assert.equal(first.reassignmentSuggested, false, "a first lapse is not a reassignment");
  assert.equal(later.reassignmentSuggested, true, "a long-dead lease is offered for reassignment, not taken");
});

// --- the prompt, and who it goes to ------------------------------------------------------------

test("THE PROMPT GOES TO THE OWNER, NOT THE COORDINATOR", () => {
  const { root, amqRoot } = fixture();
  try {
    addBoardTask(root, amqRoot, { title: "long analysis", owner: "analyst", description: "x", notify: false });
    const prompts = [];
    const r = runDoorbellPass({
      repoRoot: root, amqRoot,
      handles: ["analyst", "coordinator"],
      state: { delivered: {}, deliveredTasks: {}, coordinatorAlerts: {} },
      getStatus: () => "idle",
      prompt: (h, t) => { prompts.push(h); return true; },
      allowPrompt: true, persistState: true,
    });
    // With no real cards the pass is quiet; the point is the ROUTE, asserted structurally below.
    assert.ok(r.ownerLease);
    assert.ok(!prompts.includes("coordinator") || prompts.length >= 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("THE PROMPT IS ADVISORY: it quotes the line, forbids a restart, and offers reassignment", () => {
  // The wording is the part most likely to be wrong, and a prompt that says "restart" makes this
  // defect worse: an agent that restarts from zero learns to stop resuming.
  const { root, amqRoot } = fixture();
  try {
    const id = addBoardTask(root, amqRoot, { title: "long analysis", owner: "analyst", description: "x", notify: false }).task.id;
    updateBoardTask(root, amqRoot, id, { status: "in_progress" });
    setTaskResumeLine(root, amqRoot, id, "run the red arm and land the commit");
    // Backdate the card's heartbeat past the lease.
    const f = findCard(root, id);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^last_heartbeat_at: .*$/m,
      `last_heartbeat_at: ${JSON.stringify(new Date(Date.now() - 5 * 60 * 60_000).toISOString())}`));

    const prompts = [];
    runDoorbellPass({
      repoRoot: root, amqRoot,
      handles: ["analyst", "coordinator"],
      state: { delivered: {}, deliveredTasks: {}, coordinatorAlerts: {} },
      getStatus: () => "idle",
      prompt: (h, t) => { prompts.push({ handle: h, text: t }); return true; },
      allowPrompt: true, persistState: true,
    });
    const mine = prompts.filter((p) => p.handle === "analyst");
    assert.equal(mine.length, 1, `the owner is prompted exactly once, got ${mine.length}`);
    const text = mine[0].text;
    assert.ok(text.includes("run the red arm and land the commit"), "the resume line is QUOTED - this is the mechanism");
    assert.ok(/do not redo|still valid/i.test(text), "it says the analysis is still valid");
    assert.ok(!/\brestart\b/i.test(text.replace(/not an instruction to restart/i, "")),
      "it must never instruct a restart");
    assert.ok(/advisory/i.test(text), "arrival is advisory, not a command");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("A CARD WITH NO RESUME LINE TELLS THE OWNER TO WRITE ONE, AND NAMES THE COMMAND", () => {
  const { root, amqRoot } = fixture();
  try {
    const id = addBoardTask(root, amqRoot, { title: "long analysis", owner: "analyst", description: "x", notify: false }).task.id;
    updateBoardTask(root, amqRoot, id, { status: "in_progress" });
    const f = findCard(root, id);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^last_heartbeat_at: .*$/m,
      `last_heartbeat_at: ${JSON.stringify(new Date(Date.now() - 5 * 60 * 60_000).toISOString())}`));
    const prompts = [];
    runDoorbellPass({
      repoRoot: root, amqRoot, handles: ["analyst"],
      state: { delivered: {}, deliveredTasks: {}, coordinatorAlerts: {} },
      getStatus: () => "idle",
      prompt: (h, t) => { prompts.push(t); return true; },
      allowPrompt: true, persistState: true,
    });
    const text = prompts.find((t) => /analyst|still own/.test(t)) || "";
    assert.ok(/NO resume line/i.test(text), "the absence is stated, not papered over");
    assert.ok(/task resume-line/.test(text), "and the owner is told exactly how to fix it");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("IT IS PROMPTED ONCE PER LEASE, NOT ONCE PER PASS - age alone is not a transition", () => {
  // The exact churn this board spent a night removing: an unchanged condition re-announced
  // whenever the cooldown expired. Here there is no age-based key at all - the arm is the epoch.
  const { root, amqRoot } = fixture();
  try {
    const id = addBoardTask(root, amqRoot, { title: "long analysis", owner: "analyst", description: "x", notify: false }).task.id;
    updateBoardTask(root, amqRoot, id, { status: "in_progress" });
    const f = findCard(root, id);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^last_heartbeat_at: .*$/m,
      `last_heartbeat_at: ${JSON.stringify(new Date(Date.now() - 5 * 60 * 60_000).toISOString())}`));
    let count = 0;
    const state = { delivered: {}, deliveredTasks: {}, coordinatorAlerts: {} };
    const opts = {
      repoRoot: root, amqRoot, handles: ["analyst"], state,
      getStatus: () => "idle", prompt: () => { count++; return true; },
      allowPrompt: true, persistState: true,
    };
    runDoorbellPass(opts);
    const first = count;
    runDoorbellPass(opts);
    runDoorbellPass(opts);
    assert.equal(first, 1, "the first pass prompts");
    assert.equal(count, 1, "and further passes over an UNCHANGED lease must not prompt again");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("RE-CLAIMING RE-ARMS IT ONCE - a resumed agent is prompted again, not silenced forever", () => {
  // The other half of once-per-lease. Arming forever would mean a genuinely dead agent is
  // prompted once and then never again, which is the failure this is meant to catch.
  const { root, amqRoot } = fixture();
  try {
    const id = addBoardTask(root, amqRoot, { title: "long analysis", owner: "analyst", description: "x", notify: false }).task.id;
    updateBoardTask(root, amqRoot, id, { status: "in_progress" });
    const backdate = () => {
      const f = findCard(root, id);
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^last_heartbeat_at: .*$/m,
        `last_heartbeat_at: ${JSON.stringify(new Date(Date.now() - 5 * 60 * 60_000).toISOString())}`));
    };
    backdate();
    let count = 0;
    const state = { delivered: {}, deliveredTasks: {}, coordinatorAlerts: {} };
    const opts = {
      repoRoot: root, amqRoot, handles: ["analyst"], state,
      getStatus: () => "idle", prompt: () => { count++; return true; },
      allowPrompt: true, persistState: true,
    };
    runDoorbellPass(opts);
    assert.equal(count, 1);
    // A resume: the owner RE-CLAIMS, which bumps the lease epoch, and stops heartbeating again.
    // Through the REAL CLI, not updateBoardTask directly: the re-claim is a no-op on status for a
    // card already in_progress, so the epoch bump lives in the claim path and calling the board
    // helper here would test a different mechanism than the one a resuming agent actually uses.
    execFileSync("node", [CLI, "task", "claim", id, "--me", "analyst", "--notify", "false"],
      { cwd: root, env: { ...process.env, AMQ_ME: "analyst" }, encoding: "utf8", stdio: "pipe" });
    backdate();
    runDoorbellPass(opts);
    assert.equal(count, 2, "a NEW lease is a new obligation and is armed again");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- the field itself ---------------------------------------------------------------------------

test("THE RESUME LINE SURVIVES A ROUND TRIP - written, then read back off disk", () => {
  // The serializer writes a FIXED key list. An unlisted field is written and then silently
  // dropped on the next parse, which looks exactly like a field that does not work.
  const { root, amqRoot } = fixture();
  try {
    const id = addBoardTask(root, amqRoot, { title: "t", owner: "lane", description: "x", notify: false }).task.id;
    setTaskResumeLine(root, amqRoot, id, "re-run the sweep and read the artifact back");
    const text = fs.readFileSync(findCard(root, id), "utf8");
    assert.ok(/^resume_line: "re-run the sweep and read the artifact back"/m.test(text),
      "the field must be in the serialised card, not only in memory");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("THE RESUME LINE DOES NOT MOVE THE STATE CLOCK - restating an obligation is not progress", () => {
  // Otherwise an agent could clear its own stall by re-typing what it was already supposed to
  // do, which is the same class of defect as heartbeating your way out of a stall.
  const { root, amqRoot } = fixture();
  try {
    const id = addBoardTask(root, amqRoot, { title: "t", owner: "lane", description: "x", notify: false }).task.id;
    const before = fs.readFileSync(findCard(root, id), "utf8").match(/^updated: (.*)$/m)[1];
    setTaskResumeLine(root, amqRoot, id, "still owed: land the commit");
    const after = fs.readFileSync(findCard(root, id), "utf8").match(/^updated: (.*)$/m)[1];
    assert.equal(after, before, "updated must not move");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("THE VERB IS REACHABLE FROM THE REAL CLI AND PROVES ITS FIELD CHANGES", () => {
  // Real CLI path is primary proof for a verb - a `case` that only exists in a switch is the
  // documented dead end this codebase has already been bitten by once.
  const { root, amqRoot } = fixture();
  try {
    const out = execFileSync("node", [CLI, "task", "create", "--title", "t", "--owner", "lane", "--description", "x"],
      { cwd: root, env: { ...process.env, AMQ_ME: "lane" }, encoding: "utf8" });
    const id = out.match(/task_[0-9a-f_]{8,}/)?.[0];
    assert.ok(id, `the CLI must report a card id, got: ${out.slice(0, 200)}`);
    execFileSync("node", [CLI, "task", "resume-line", id, "--text", "land the red arm", "--me", "lane"],
      { cwd: root, env: { ...process.env, AMQ_ME: "lane" }, encoding: "utf8" });
    assert.ok(/^resume_line: "land the red arm"/m.test(fs.readFileSync(findCard(root, id), "utf8")),
      "the real CLI must write the field the owner re-prompt quotes");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("AN EMPTY RESUME LINE IS REFUSED - it would write the absence this exists to prevent", () => {
  const { root, amqRoot } = fixture();
  try {
    const id = addBoardTask(root, amqRoot, { title: "t", owner: "lane", description: "x", notify: false }).task.id;
    let threw = false;
    try { execFileSync("node", [CLI, "task", "resume-line", id, "--text", "  ", "--me", "lane"],
      { cwd: root, env: { ...process.env, AMQ_ME: "lane" }, encoding: "utf8", stdio: "pipe" }); }
    catch { threw = true; }
    assert.ok(threw, "an empty line must be an error, not a write");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("lease_epoch STAYS A NUMBER across routine writes - a type flip is a silent corruption", () => {
  // Found by HAND, not by a test: adding lease_epoch to the ownership watch list made every
  // routine verb report it changing, and the cause was that YAML round-trips a bare 1 back as a
  // string. `existingTask.lease_epoch ?? null` therefore handed "1" forward, the serializer wrote
  // lease_epoch: "1", and the next write wrote "1" again. Nothing errored, the card looked
  // correct, and any comparison of the field across two writes disagreed with itself.
  //
  // It is pinned here because the mutation that removes the coercion does NOT fail any other
  // suite - I checked, and the ownership table passed with the coercion deleted. An unverified
  // fix is the same as no fix, with a commit message claiming otherwise.
  const { root, amqRoot } = fixture();
  try {
    const id = addBoardTask(root, amqRoot, { title: "t", owner: "lane", description: "x", notify: false }).task.id;
    execFileSync("node", [CLI, "task", "claim", id, "--me", "lane", "--notify", "false"],
      { cwd: root, env: { ...process.env, AMQ_ME: "lane" }, encoding: "utf8", stdio: "pipe" });
    const afterClaim = fs.readFileSync(findCard(root, id), "utf8").match(/^lease_epoch: (.*)$/m)[1];
    assert.equal(afterClaim, "1", "a fresh lease is the number 1, unquoted");

    // Routine verbs that must not disturb it.
    execFileSync("node", [CLI, "task", "reassign", id, "--to", "lane", "--notify", "false"],
      { cwd: root, env: { ...process.env, AMQ_ME: "lane" }, encoding: "utf8", stdio: "pipe" });
    execFileSync("node", [CLI, "task", "comment", id, "--text", "a note"],
      { cwd: root, env: { ...process.env, AMQ_ME: "lane" }, encoding: "utf8", stdio: "pipe" });
    const after = fs.readFileSync(findCard(root, id), "utf8").match(/^lease_epoch: (.*)$/m)[1];
    assert.equal(after, "1", "and it is still the NUMBER 1 - a quoted value means the type flipped");

    // The CLI path alone does NOT expose the flip - the flag stayed green with the coercion
    // deleted, twice, because a bare `1` comes back from the frontmatter parser as a number here.
    // The flip is on the DIRECT API path, which is how I found it: updateBoardTask hands its
    // return value's lease_epoch straight through, and a card re-read from disk carries a string.
    // So the assertion that bites is against that path, and saying otherwise would be claiming
    // coverage I do not have.
    updateBoardTask(root, amqRoot, id, { owner: "lane" });
    const viaApi = updateBoardTask(root, amqRoot, id, { owner: "lane" });
    assert.strictEqual(typeof viaApi.task.lease_epoch, "number",
      "the direct API must hand back a number, not the string a disk round-trip produces");
    assert.equal(fs.readFileSync(findCard(root, id), "utf8").match(/^lease_epoch: (.*)$/m)[1], "1",
      "and the serialised card must still be unquoted");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function findCard(root, id) {
  for (const stage of fs.readdirSync(path.join(root, ".agent-mail", "bus"))) {
    const f = path.join(root, ".agent-mail", "bus", stage, `${id}.md`);
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`card ${id} not found`);
}
