import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchFleet } from "../src/fleet.mjs";
import { parseAgentBriefFile } from "../src/briefs.mjs";

/**
 * An agent's KIND is a per-agent property, because "such as I use agy for mkt activities" is a
 * statement about mkt and not about the fleet.
 *
 * The fleet had exactly one `kind`, resolved once at the top of launchFleet and then compared
 * against EVERY pane. Two consequences, both wrong in the same way — the fleet's opinion was
 * applied to each agent individually:
 *   - a brief declaring a different kind could never be recognised as already running, so it was
 *     "replaced" every time, closing and relaunching a correctly-launched agent;
 *   - and the launch args were built from that same single value, so the declared kind was
 *     parsed from the file and then thrown away.
 *
 * The rule shipped is `agent.kind || --kind || "agy"`, three levels, and the middle one keeps
 * `--kind` meaning what it has always meant: the fleet-wide DEFAULT, not an override. A brief
 * with no `kind` has expressed no opinion, which is not the same as having said "agy", so the
 * brief parser records null rather than substituting a default - collapsing those at parse time
 * would make the difference invisible everywhere downstream.
 *
 * Every test injects `getLiveAgents`, `execHerdr` and `sleep`. launchFleet calls `herdr pane
 * close` on the replace path, and a test reaching the real binary would close the operator's
 * panes. That is the standing rule, and this file is where it would be most tempting to break.
 */
function brief(dir, handle, extra = "") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${handle}.md`),
    `---\nhandle: ${handle}\ndescription: ${handle} agent\nmode: subagent\n${extra}---\n\nYou are ${handle}.\n`
  );
}

function noopPrepopulate() {
  return [
    { handle: "mkt", kind: null },
    { handle: "range", kind: null },
  ];
}

/**
 * A fake herdr that records calls and answers with the JSON shapes launchFleet parses.
 * Returning "" is not a neutral stub: `tab create` output is JSON.parse'd, so an empty stub
 * fails the launch before `agent start` is ever reached and the arm ends up asserting about a
 * parse error instead of about kinds. That is a check that cannot fail for the right reason.
 */
function fakeHerdr(record = []) {
  return (args) => {
    record.push(args);
    if (args[0] === "tab" && args[1] === "create") {
      const label = args[args.indexOf("--label") + 1];
      return JSON.stringify({ result: { tab_id: `t-${label}`, root_pane: { pane_id: `p-${label}` } } });
    }
    if (args[0] === "pane") return JSON.stringify({ result: { pane_id: args[2] } });
    if (args[0] === "agent" && args[1] === "start") return JSON.stringify({ result: { pane_id: "p-new" } });
    return JSON.stringify({ result: {} });
  };
}

const baseOpts = {
  prepopulate: noopPrepopulate,
  getLiveAgents: async () => [],
  execHerdr: () => "",
  sleep: async () => {},
  currentPaneId: null,
  env: {},
  envPath: "",
};

describe("per-agent kind", () => {
  test("a brief may declare its own kind, and the parser does not invent one when it does not", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amq-kind-"));
    brief(dir, "mkt", "kind: pi\n");
    brief(dir, "range");
    const withKind = parseAgentBriefFile(path.join(dir, "mkt.md"));
    const without = parseAgentBriefFile(path.join(dir, "range.md"));
    assert.equal(withKind.kind, "pi");
    // null, not "agy": absence of an opinion has to stay distinguishable from a stated one.
    assert.equal(without.kind, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the declared kind is used to launch that agent and not the fleet default", async () => {
    const fleet = [
      { handle: "mkt", kind: "pi" },
      { handle: "range", kind: null },
    ];
    const calls = [];
    const res = await launchFleet("/tmp/unused", "/tmp/unused", {
      ...baseOpts,
      prepopulate: () => fleet,
      execHerdr: fakeHerdr(calls),
      getLiveAgents: async () => [],
    });

    // The resolution is reported, so `fleet up` can be read rather than trusted.
    assert.deepEqual(res.kinds, { mkt: "pi", range: "agy" });
    const launchOf = (handle) => calls.find((c) => c[0] === "agent" && c[1] === "start" && c[2] === handle);
    const mktLaunch = launchOf("mkt");
    const rangeLaunch = launchOf("range");
    assert.ok(mktLaunch && rangeLaunch, "both agents launched");
    const kindOf = (a) => a[a.indexOf("--kind") + 1];
    const argsOf = (a) => a[a.indexOf("--") + 1];
    assert.equal(kindOf(mktLaunch), "pi", "mkt is started as the kind its own brief declared");
    assert.equal(kindOf(rangeLaunch), "agy", "and the rest of the fleet keeps the default");
    assert.notDeepEqual(
      argsOf(mktLaunch),
      argsOf(rangeLaunch),
      "the per-kind launch args are built per agent, not once for the fleet"
    );
  });

  test("--kind stays a fleet-wide DEFAULT, not an override of a brief that spoke", async () => {
    const res = await launchFleet("/tmp/unused", "/tmp/unused", {
      ...baseOpts,
      prepopulate: () => [{ handle: "mkt", kind: "pi" }, { handle: "range", kind: null }],
      kind: "opencode",
    });
    // The brief wins for the agent that has an opinion; the flag supplies the rest. Reading it
    // as an override instead would make per-agent kind unexpressible from the command line.
    assert.deepEqual(res.kinds, { mkt: "pi", range: "opencode" });
  });

  test("an agent already running as its DECLARED kind is recognised, not replaced", async () => {
    // The bug this fixes, stated as an arm. With one fleet-wide kind, a `kind: pi` agent running
    // as pi did not match the fleet's kind, so every `fleet up` closed a healthy agent and
    // relaunched it.
    const closed = [];
    const res = await launchFleet("/tmp/unused", "/tmp/unused", {
      ...baseOpts,
      prepopulate: () => [{ handle: "mkt", kind: "pi" }, { handle: "range", kind: null }],
      getLiveAgents: async () => [
        { name: "mkt", agent: "pi", pane_id: "p-mkt" },
        { name: "range", agent: "agy", pane_id: "p-range" },
      ],
      execHerdr: (args) => { closed.push(args); return ""; },
    });

    assert.deepEqual(res.alreadyRunning.sort(), ["mkt", "range"]);
    assert.deepEqual(res.replaced, [], "a correctly-launched agent is not closed and relaunched");
    assert.equal(closed.filter((c) => c[0] === "pane" && c[1] === "close").length, 0);
  });

  test("an agent running as a DIFFERENT kind than it declares is still a mismatch", async () => {
    // The control for the arm above: matching must be because the kinds agree, not because
    // matching stopped happening. Not a dry run, so the mismatch is acted on - through the
    // INJECTED execHerdr, which records instead of closing anything.
    const calls = [];
    const res = await launchFleet("/tmp/unused", "/tmp/unused", {
      ...baseOpts,
      prepopulate: () => [{ handle: "mkt", kind: "pi" }],
      getLiveAgents: async () => [{ name: "mkt", agent: "agy", pane_id: "p-mkt" }],
      execHerdr: fakeHerdr(calls),
    });
    assert.deepEqual(res.alreadyRunning, [], "agy is not pi");
    assert.deepEqual(res.replaced.map((r) => r.handle), ["mkt"], "and the mismatch is acted on");
    assert.deepEqual(res.replaced[0].fromKinds, ["agy"], "recording what it was, so the replacement is auditable");
    assert.ok(
      calls.some((c) => c[0] === "pane" && c[1] === "close" && c[2] === "p-mkt"),
      "the mismatched pane is the one closed"
    );
    assert.ok(
      calls.some((c) => c[0] === "agent" && c[1] === "start" && c[c.indexOf("--kind") + 1] === "pi"),
      "and the relaunch uses the DECLARED kind, not the one it was running as"
    );
  });

  test("no brief anywhere means every agent is the historical default", async () => {
    const res = await launchFleet("/tmp/unused", "/tmp/unused", {
      ...baseOpts,
      prepopulate: () => [{ handle: "a" }, { handle: "b" }],
    });
    assert.deepEqual(res.kinds, { a: "agy", b: "agy" });
  });
});
