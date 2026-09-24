import test from "node:test";
import assert from "node:assert/strict";
import { healAgentName } from "../src/bridge.mjs";

function runnerFactory({ panes, tabs }) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "list") {
      return JSON.stringify({ result: { panes } });
    }
    if (args[0] === "tab" && args[1] === "list") {
      return JSON.stringify({ result: { tabs } });
    }
    if (args[0] === "agent" && args[1] === "rename") {
      return JSON.stringify({ ok: true });
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  };
  return { run, calls };
}

const OPENCODE_PANE = {
  pane_id: "w4:p1G",
  tab_id: "w4:t1F",
  terminal_title: "OpenCode",
  terminal_title_stripped: "OpenCode",
};

test("heal matches legacy title pattern without touching tabs", () => {
  const panes = [{ ...OPENCODE_PANE, terminal_title_stripped: "fleet - range - opencode" }];
  const { run, calls } = runnerFactory({ panes, tabs: [] });
  assert.equal(healAgentName("range", false, run), true);
  assert.deepEqual(calls.at(-1), ["agent", "rename", "w4:p1G", "range"]);
  assert.ok(!calls.some((c) => c[0] === "tab"), "tab list must not be consulted");
});

test("heal falls back to exact tab label when title is overwritten", () => {
  const panes = [{ ...OPENCODE_PANE }];
  const tabs = [{ tab_id: "w4:t1F", label: "agsuite-dev" }];
  const { run, calls } = runnerFactory({ panes, tabs });
  assert.equal(healAgentName("agsuite-dev", false, run), true);
  assert.deepEqual(calls.at(-1), ["agent", "rename", "w4:p1G", "agsuite-dev"]);
});

test("heal skips multi-pane tabs as ambiguous", () => {
  const panes = [{ ...OPENCODE_PANE }, { ...OPENCODE_PANE, pane_id: "w4:p1H" }];
  const tabs = [{ tab_id: "w4:t1F", label: "agsuite-dev" }];
  const { run, calls } = runnerFactory({ panes, tabs });
  assert.equal(healAgentName("agsuite-dev", false, run), false);
  assert.ok(!calls.some((c) => c[0] === "agent"), "must not rename an ambiguous pane");
});

test("heal returns false when neither title nor tab matches", () => {
  const panes = [{ ...OPENCODE_PANE }];
  const tabs = [{ tab_id: "w4:t1F", label: "something-else" }];
  const { run } = runnerFactory({ panes, tabs });
  assert.equal(healAgentName("missing-lane", false, run), false);
});

test("heal dry-run reports without renaming", () => {
  const panes = [{ ...OPENCODE_PANE }];
  const tabs = [{ tab_id: "w4:t1F", label: "agsuite-dev" }];
  const { run, calls } = runnerFactory({ panes, tabs });
  assert.equal(healAgentName("agsuite-dev", true, run), true);
  assert.ok(!calls.some((c) => c[0] === "agent"), "dry-run must not rename");
});
