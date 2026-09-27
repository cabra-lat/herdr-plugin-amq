import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { launchFleet } from "../src/fleet.mjs";

/**
 * `fleet up` does not close a running agent unless you say `--replace`.
 *
 * The user reported, on their own fleet, that `fleet up` "closed agents and started over
 * probably they lost some context too" - and the command reported success while it did it. A
 * fleet is where people's in-flight work lives; a plain `fleet up` closing thirteen working
 * panes is the most destructive thing in this tool, and it used to be what you got by typing
 * the ordinary command.
 *
 * The user chose this on 2026-09-27 ("(a) is good no scripts rely on it"), so the change breaks
 * nothing and the destructive direction is never reached by omission. `heal` (0b32008) and
 * `task claim` (896e806) went the same way for the same reason, which is a pattern rather than
 * three coincidences: in a coordination tool, an action that destroys another lane's state is
 * never the default.
 *
 * The arm that matters most is the PREVIEW one. `dryRun` used to be checked before the refusal,
 * so `fleet up --dry-run` reported `wouldReplace` for an agent the real command would refuse to
 * touch. A preview is the instrument a person trusts right before being destructive; one that
 * says "this will replace three agents" about a run that replaces nothing is worse than no
 * preview, because it is believed precisely when it is most expensive to be wrong.
 *
 * All herdr access is injected. launchFleet calls `pane close` on the replace path, and a test
 * reaching the real binary would close the operator's panes.
 */
const fleet = [{ handle: "mkt", kind: null }];

const live = [{ name: "mkt", agent: "opencode", pane_id: "p-mkt" }];

function fakeHerdr(record = []) {
  return (args) => {
    record.push(args);
    if (args[0] === "tab" && args[1] === "create") {
      const label = args[args.indexOf("--label") + 1];
      return JSON.stringify({ result: { tab_id: `t-${label}`, root_pane: { pane_id: `p-${label}` } } });
    }
    return JSON.stringify({ result: {} });
  };
}

const base = {
  prepopulate: () => fleet,
  getLiveAgents: async () => live,
  sleep: async () => {},
  currentPaneId: null,
  envPath: "",
};

function closedPanes(calls) {
  return calls.filter((c) => c[0] === "pane" && c[1] === "close").map((c) => c[2]);
}

describe("the default is safe", () => {
  test("a mismatched agent is left alone and reported, not closed", async () => {
    const calls = [];
    const res = await launchFleet("/tmp/u", "/tmp/u", { ...base, execHerdr: fakeHerdr(calls) });

    assert.deepEqual(closedPanes(calls), [], "the default must not close a pane");
    assert.deepEqual(res.replaced, []);
    assert.deepEqual(res.blocked.map((b) => b.handle), ["mkt"]);
    assert.match(res.blocked[0].reason, /nothing was closed/i);
    assert.match(res.blocked[0].reason, /--replace/, "and it says how to actually ask for it");
    assert.match(res.blocked[0].reason, /opencode/, "naming what it is running as, which is the fact you need to decide");
  });

  test("replace: false behaves identically, because it is now the default", async () => {
    // `--no-replace` used to be the flag that made this safe. It is still accepted and still
    // means this, so an old invocation does not become an unknown-flag failure - but the safe
    // behaviour no longer depends on anyone remembering it.
    const explicit = await launchFleet("/tmp/u", "/tmp/u", { ...base, execHerdr: fakeHerdr(), replace: false });
    const byDefault = await launchFleet("/tmp/u", "/tmp/u", { ...base, execHerdr: fakeHerdr() });
    assert.deepEqual(explicit.blocked, byDefault.blocked);
    assert.deepEqual(explicit.replaced, byDefault.replaced);
  });
});

describe("the preview tells the truth", () => {
  test("a dry run reports the REFUSAL, not a replacement it will not perform", async () => {
    // THE RED ARM. Before the ordering fix this returned wouldReplace: ["mkt"], which described a
    // destructive action the command was not going to take.
    const calls = [];
    const res = await launchFleet("/tmp/u", "/tmp/u", { ...base, execHerdr: fakeHerdr(calls), dryRun: true });

    assert.deepEqual(res.wouldReplace, [], "a preview must not promise a replacement that is refused");
    assert.deepEqual(res.blocked.map((b) => b.handle), ["mkt"], "it reports what will actually happen");
    assert.deepEqual(closedPanes(calls), [], "and a dry run closes nothing either way");
  });

  test("with --replace, the dry run reports the replacement it WOULD perform", async () => {
    // The control: the preview is not just always conservative. If it always said "blocked" it
    // would be as useless as the lie it replaced.
    const res = await launchFleet("/tmp/u", "/tmp/u", {
      ...base, execHerdr: fakeHerdr(), dryRun: true, replace: true,
    });
    assert.deepEqual(res.wouldReplace, ["mkt"]);
    assert.deepEqual(res.blocked, []);
  });
});

describe("replacement is opt-in and still works when asked for", () => {
  test("--replace closes the mismatched pane and relaunches as the resolved kind", async () => {
    const calls = [];
    const res = await launchFleet("/tmp/u", "/tmp/u", { ...base, execHerdr: fakeHerdr(calls), replace: true });

    assert.deepEqual(closedPanes(calls), ["p-mkt"]);
    assert.deepEqual(res.replaced.map((r) => r.handle), ["mkt"]);
    assert.deepEqual(res.replaced[0].fromKinds, ["opencode"], "recorded, so the replacement is auditable after the fact");
    assert.ok(
      calls.some((c) => c[0] === "agent" && c[1] === "start" && c[c.indexOf("--kind") + 1] === "agy"),
      "and the relaunch uses the agent's resolved kind, not the one it was running as"
    );
  });

  test("an agent already running as its resolved kind is untouched, replace or not", async () => {
    // A guard against over-correcting: "never close anything" must not become "never recognise a
    // healthy agent", which would relaunch a correct fleet on every invocation.
    const calls = [];
    const res = await launchFleet("/tmp/u", "/tmp/u", {
      ...base,
      getLiveAgents: async () => [{ name: "mkt", agent: "agy", pane_id: "p-mkt" }],
      execHerdr: fakeHerdr(calls),
      replace: true,
    });
    assert.deepEqual(res.alreadyRunning, ["mkt"]);
    assert.deepEqual(closedPanes(calls), []);
    assert.deepEqual(res.replaced, []);
  });
});
