import test from "node:test";
import assert from "node:assert/strict";
import { mapHerdrAgentActivity, normalizeHerdrStatus } from "../src/herdr.mjs";

test("normalizeHerdrStatus maps connectivity aliases to actionable states", () => {
  assert.equal(normalizeHerdrStatus("online"), "idle");
  assert.equal(normalizeHerdrStatus("active"), "idle");
  assert.equal(normalizeHerdrStatus("working"), "working");
  assert.equal(normalizeHerdrStatus("blocked"), "blocked");
  assert.equal(normalizeHerdrStatus("unexpected"), "unknown");
});

test("mapHerdrAgentActivity retains status, labels, tokens, and runtime context", () => {
  const activity = mapHerdrAgentActivity({
    name: "range",
    agent: "opencode",
    agent_status: "working",
    pane_id: "pane-range",
    workspace_id: "workspace-range",
    tab_id: "tab-range",
    terminal_id: "terminal-range",
    terminal_title_stripped: "Refreshing arena v4",
    title: { label: "Range implementation" },
    state_labels: { working: "Implementing arena refresh", idle: "Waiting" },
    tokens: ["Gunsmith integration", { text: "Final gate" }],
    state_change_seq: 42,
    interactive_ready: true,
    focused: true,
    launch_pending: false,
  }, "2026-09-24T08:00:00.000Z");

  assert.deepEqual(activity, {
    herdrHandle: "range",
    herdrStatus: "working",
    herdrPaneId: "pane-range",
    herdrWorkspaceId: "workspace-range",
    herdrTabId: "tab-range",
    herdrTerminalId: "terminal-range",
    herdrTitle: "Refreshing arena v4",
    herdrTerminalTitle: "Refreshing arena v4",
    herdrMetadataTitle: "Range implementation",
    herdrStateLabels: { working: "Implementing arena refresh", idle: "Waiting" },
    herdrTokens: ["Gunsmith integration", "Final gate"],
    herdrStateChangeSeq: 42,
    interactiveReady: true,
    herdrFocused: true,
    herdrLaunchPending: false,
     agentType: "opencode",
     herdrSessionId: null,
     herdrModel: null,
     herdrModelSource: null,
     herdrObservedAt: "2026-09-24T08:00:00.000Z",
  });
});

test("mapHerdrAgentActivity rejects unnamed records", () => {
  assert.equal(mapHerdrAgentActivity({ agent_status: "working" }), null);
});
