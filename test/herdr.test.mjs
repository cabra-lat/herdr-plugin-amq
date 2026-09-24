import test from "node:test";
import assert from "node:assert/strict";
import { mapHerdrAgentActivity, normalizeHerdrEvent, normalizeHerdrStatus } from "../src/herdr.mjs";
import {
  findHerdrEventHandle,
  isHerdrRefreshEvent,
  isHerdrStatusEvent,
  mergeHerdrStatusEvent,
} from "../src/server.mjs";

test("normalizeHerdrStatus maps connectivity aliases to actionable states", () => {
  assert.equal(normalizeHerdrStatus("online"), "idle");
  assert.equal(normalizeHerdrStatus("active"), "working");
  assert.equal(normalizeHerdrStatus("working"), "working");
  assert.equal(normalizeHerdrStatus("blocked"), "blocked");
  assert.equal(normalizeHerdrStatus("unexpected"), "unknown");
});

test("normalizes both Herdr event envelope formats", () => {
  assert.deepEqual(normalizeHerdrEvent({ method: "pane.agent_status_changed", params: { pane_id: "pane-range" } }), {
    type: "pane.agent_status_changed",
    pane_id: "pane-range",
  });
  assert.deepEqual(normalizeHerdrEvent({ event: "pane_updated", data: { pane: { name: "range", agent_status: "working" } } }), {
    name: "range",
    agent_status: "working",
    type: "pane.updated",
  });
});

test("status events are separated from output events and merged by pane", () => {
  assert.equal(isHerdrStatusEvent("pane_agent_status_changed"), true);
  assert.equal(isHerdrStatusEvent("pane_output_changed"), false);
  assert.equal(isHerdrRefreshEvent("pane_output_changed"), false);
  assert.equal(isHerdrRefreshEvent("pane.created"), true);

  const cache = new Map([["range", {
    herdrHandle: "range",
    herdrPaneId: "pane-range",
    herdrStatus: "working",
    herdrStateChangeSeq: 4,
    herdrStateLabels: { working: "Implementing" },
  }]]);
  assert.equal(findHerdrEventHandle(cache, { pane_id: "pane-range" }), "range");
  const merged = mergeHerdrStatusEvent(cache, {
    pane_id: "pane-range",
    agent_status: "idle",
    state_change_seq: 5,
    state_labels: { idle: "Waiting" },
  }, "2026-09-24T12:00:00.000Z");
  assert.equal(merged.handle, "range");
  assert.equal(merged.activity.herdrStatus, "idle");
  assert.equal(merged.activity.herdrStateChangeSeq, 5);
  assert.equal(merged.activity.herdrStateLabels.idle, "Waiting");
  assert.equal(merged.activity.herdrObservedAt, "2026-09-24T12:00:00.000Z");
});

test("stale Herdr status events do not overwrite newer state", () => {
  const cache = new Map([["range", {
    herdrHandle: "range",
    herdrPaneId: "pane-range",
    herdrStatus: "working",
    herdrStateChangeSeq: 8,
  }]]);
  const merged = mergeHerdrStatusEvent(cache, {
    pane_id: "pane-range",
    agent_status: "idle",
    state_change_seq: 7,
  });
  assert.equal(merged, null);
  assert.equal(cache.get("range").herdrStatus, "working");
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
