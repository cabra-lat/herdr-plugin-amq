import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healFleet, readRoster, resolveTabPanes } from "../src/fleet-heal.mjs";

/**
 * Every test here injects `run`. That is not a style preference: healFleet calls
 * `herdr agent rename`, and a test that reached the real binary would rename the operator's
 * actual tabs — the same class of accident as the tests that must not close real panes.
 */
function fakeHerdr({ panes = [], tabs = [], agents = {}, failPanes = false } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (failPanes) throw new Error("herdr not reachable");
    if (args[0] === "pane" && args[1] === "list") {
      return JSON.stringify({ result: { panes } });
    }
    if (args[0] === "tab" && args[1] === "list") {
      return JSON.stringify({ result: { tabs } });
    }
    if (args[0] === "agent" && args[1] === "get") {
      const name = args[2];
      if (!agents[name]) throw new Error(`no agent named ${name}`);
      return JSON.stringify({ result: { agent: { name, pane_id: agents[name] } } });
    }
    if (args[0] === "agent" && args[1] === "rename") {
      agents[args[3]] = args[2];
      return JSON.stringify({ result: { ok: true } });
    }
    return JSON.stringify({ result: { ok: true } });
  };
  return { run, calls, agents };
}

let root;
let repo;

function writeRoster(agents) {
  fs.mkdirSync(path.join(root, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "meta", "config.json"),
    `${JSON.stringify({ agents, created_utc: "2026-09-23T09:10:30Z", version: 1 }, null, 2)}\n`
  );
}

function makePersona(handle, name) {
  const dir = path.join(repo, ".opencode", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${handle}.md`),
    `---\ndescription: ${name}\nmode: subagent\n---\n\nYou are ${handle}.\n`
  );
}

function makeAgent(handle) {
  const dir = path.join(root, "agents", handle);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ handle, name: handle }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "amq-heal-root-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "amq-heal-repo-"));
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("healFleet — the mkt case", () => {
  test("an open, working, fully-provisioned agent missing from the roster gets wired", () => {
    // Exactly the live situation: brief on disk, worktree, mailbox, profile, an open tab —
    // and absent from config.json, so the doorbell pass never surfaced its mail.
    writeRoster(["coordinator", "qa"]);
    makePersona("mkt", "Marketing");
    makeAgent("mkt");
    fs.mkdirSync(path.join(repo, ".worktrees", "mkt"), { recursive: true });

    const { run, calls, agents } = fakeHerdr({
      panes: [{ pane_id: "w4:p45", tab_id: "w4:t44", terminal_title_stripped: "agy --dangerously-skip-permissions -c" }],
      tabs: [{ tab_id: "w4:t44", label: "mkt" }],
      // Exactly what the live tree answered: the agent is NAMED and it is this pane, even
      // though the foreground program has overwritten the terminal title.
      agents: { mkt: "w4:p45" },
    });

    const res = healFleet({ amqRoot: root, repoRoot: repo, run });
    assert.equal(res.ok, true);
    assert.deepEqual(res.actions.rosterAdded, ["mkt"]);
    assert.deepEqual(res.actions.panesRenamed, [], "a named agent is not renamed");
    assert.equal(calls.some((c) => c[1] === "rename"), false);

    const roster = readRoster(root);
    assert.ok(roster.agents.includes("mkt"));
    assert.ok(roster.agents.includes("coordinator"), "existing entries survive");
  });

  test("a clobbered terminal title is NOT a wiring gap (the infinite-rename regression)", () => {
    // The arm I needed and did not have. My first implementation compared the pane's
    // terminal_title against the handle, so this healthy agent looked broken, the rename it
    // issued was a no-op (terminal_title is written by the foreground program, not by the
    // registry), and every later run renamed again — a repair that can never succeed while
    // reporting progress each time. On the live tree this fired against `mkt` every run.
    writeRoster(["coordinator", "mkt"]);
    makePersona("mkt", "Marketing");
    makeAgent("mkt");
    const { run, calls } = fakeHerdr({
      panes: [{ pane_id: "p1", tab_id: "t1", terminal_title_stripped: "agy --dangerously-skip-permissions -c" }],
      tabs: [{ tab_id: "t1", label: "mkt" }],
      agents: { mkt: "p1" },
    });

    for (let i = 0; i < 3; i++) healFleet({ amqRoot: root, repoRoot: repo, run });
    assert.equal(calls.filter((c) => c[1] === "rename").length, 0, "three runs, zero renames");
  });

  test("a tab whose label no agent answers to IS renamed, and then stops", () => {
    // The genuine version of gap 2: the tab says `mkt`, herdr has no agent by that name, so the
    // pane is unnamed. After the rename the fake registry resolves it, so run two is clean —
    // the property the terminal_title version could never have had.
    writeRoster(["coordinator", "mkt"]);
    makePersona("mkt", "Marketing");
    makeAgent("mkt");
    const fake = fakeHerdr({
      panes: [{ pane_id: "p1", tab_id: "t1", terminal_title_stripped: "agy -c" }],
      tabs: [{ tab_id: "t1", label: "mkt" }],
    });

    const first = healFleet({ amqRoot: root, repoRoot: repo, run: fake.run });
    assert.deepEqual(first.actions.panesRenamed.map((p) => p.handle), ["mkt"]);
    const second = healFleet({ amqRoot: root, repoRoot: repo, run: fake.run });
    assert.deepEqual(second.actions.panesRenamed, [], "the repair is observable, so it stops");
  });

  test("a persona on disk with no tab open is still wired (an idle agent is still an agent)", () => {
    // The roster gap does not care whether the pane happens to be open right now. Requiring an
    // open tab would leave every agent unwired the moment it finished and exited.
    writeRoster(["coordinator"]);
    makePersona("mkt", "Marketing");
    makeAgent("mkt");
    const { run } = fakeHerdr({ panes: [], tabs: [] });

    const res = healFleet({ amqRoot: root, repoRoot: repo, run });
    assert.deepEqual(res.actions.rosterAdded, ["mkt"]);
    assert.ok(readRoster(root).agents.includes("mkt"));
  });
});

describe("healFleet — it only ever adds", () => {
  test("a stale roster entry is left alone, and never removed", () => {
    // `board` and `worker` are exactly this: in the agents/ tree, not in config.json. Under the
    // "reconcile both ways" reading they would be deletions. Deleting a roster entry un-wires a
    // lane, and a cleanup that does that to an agent nobody was watching is not a cleanup.
    writeRoster(["coordinator", "retired-lane"]);
    makePersona("mkt", "Marketing");
    makeAgent("mkt");
    const { run } = fakeHerdr({ panes: [], tabs: [] });

    healFleet({ amqRoot: root, repoRoot: repo, run });
    const roster = readRoster(root);
    assert.ok(roster.agents.includes("retired-lane"), "heal is additive: nothing is removed");
    assert.ok(roster.agents.includes("mkt"), "and the real gap is still closed");
  });

  test("dry-run changes nothing on disk and renames nothing", () => {
    writeRoster(["coordinator"]);
    makePersona("mkt", "Marketing");
    makeAgent("mkt");
    const before = fs.readFileSync(path.join(root, "meta", "config.json"), "utf8");
    const { run, calls } = fakeHerdr({
      panes: [{ pane_id: "p1", tab_id: "t1", terminal_title_stripped: "agy -c" }],
      tabs: [{ tab_id: "t1", label: "mkt" }],
    });

    const res = healFleet({ amqRoot: root, repoRoot: repo, run, dryRun: true });
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.actions.rosterAdded, ["mkt"], "it reports what it would do");
    assert.equal(fs.readFileSync(path.join(root, "meta", "config.json"), "utf8"), before, "…and writes nothing");
    assert.equal(calls.some((c) => c[0] === "agent" && c[1] === "rename"), false, "and renames nothing");
  });

  test("is idempotent: a second run reports no changes", () => {
    writeRoster(["coordinator"]);
    makePersona("mkt", "Marketing");
    makeAgent("mkt");
    const panes = [{ pane_id: "p1", tab_id: "t1", terminal_title_stripped: "π - mkt" }];
    const tabs = [{ tab_id: "t1", label: "mkt" }];
    const fake = fakeHerdr({ panes, tabs, agents: { mkt: "p1" } });

    healFleet({ amqRoot: root, repoRoot: repo, run: fake.run });
    const second = healFleet({ amqRoot: root, repoRoot: repo, run: fake.run });
    assert.deepEqual(second.actions.rosterAdded, []);
    assert.deepEqual(second.actions.panesRenamed, []);
  });

  test("a healthy fleet is left completely alone", () => {
    writeRoster(["coordinator", "mkt"]);
    makePersona("mkt", "Marketing");
    makeAgent("mkt");
    const { run, calls } = fakeHerdr({
      panes: [{ pane_id: "p1", tab_id: "t1", terminal_title_stripped: "agy -c" }],
      tabs: [{ tab_id: "t1", label: "mkt" }],
      agents: { mkt: "p1" },
    });

    const res = healFleet({ amqRoot: root, repoRoot: repo, run });
    assert.deepEqual(res.actions, { rosterAdded: [], panesRenamed: [], registered: [], skipped: [] });
    assert.equal(calls.filter((c) => c[1] === "rename").length, 0, "zero writes");
  });
});

describe("healFleet — it refuses to guess", () => {
  test("a multi-pane tab is skipped rather than renamed", () => {
    // The tab label names the agent, but a two-pane tab cannot say which pane is the agent.
    // Renaming the wrong one kills whatever was running in it.
    writeRoster(["coordinator"]);
    const { run, calls } = fakeHerdr({
      panes: [
        { pane_id: "p1", tab_id: "t1", terminal_title_stripped: "agy -c" },
        { pane_id: "p2", tab_id: "t1", terminal_title_stripped: "vim" },
      ],
      tabs: [{ tab_id: "t1", label: "mkt" }],
    });

    const res = healFleet({ amqRoot: root, repoRoot: repo, run });
    assert.deepEqual(res.actions.panesRenamed, []);
    assert.equal(calls.some((c) => c[1] === "rename"), false);
  });

  test("an unreachable herdr is an error, not a silent 'nothing to do'", () => {
    // A heal that cannot see the fleet must say so. Returning "no changes" would be read as
    // healthy, which is the failure mode this whole exercise is about.
    writeRoster(["coordinator"]);
    const { run } = fakeHerdr({ failPanes: true });
    const res = healFleet({ amqRoot: root, repoRoot: repo, run });
    assert.equal(res.ok, false);
    assert.match(res.error, /herdr not reachable/);
  });

  test("an unknown tab handle is not promoted into the team", () => {
    // Either source alone would be wrong: an open tab alone would promote a typo'd `--to`, and a
    // persona alone would ignore a live agent. Only a handle both sources agree on is wired.
    writeRoster(["coordinator"]);
    makePersona("mkt", "Marketing");
    makeAgent("mkt");
    const { run } = fakeHerdr({
      panes: [{ pane_id: "p9", tab_id: "t9", terminal_title_stripped: "π - stranger" }],
      tabs: [{ tab_id: "t9", label: "stranger" }],
    });

    const res = healFleet({ amqRoot: root, repoRoot: repo, run });
    assert.equal(res.actions.rosterAdded.includes("stranger"), false);
  });
});

describe("resolveTabPanes", () => {
  test("only single-pane tabs with a label resolve", () => {
    const panes = [
      { pane_id: "p1", tab_id: "t1" },
      { pane_id: "p2", tab_id: "t2" },
      { pane_id: "p3", tab_id: "t2" },
      { pane_id: "p4", tab_id: "t3" },
    ];
    const tabs = [
      { tab_id: "t1", label: "mkt" },
      { tab_id: "t2", label: "crowded" },
      { tab_id: "t3", label: "  " },
    ];
    assert.deepEqual(resolveTabPanes(panes, tabs).map((r) => r.handle), ["mkt"]);
  });
});
