import test from "node:test";
import assert from "node:assert/strict";
import {
  clearRuntimeModelCache,
  getOpenCodeSessionModels,
  normalizeRuntimeModel,
  resolveRuntimeModel,
} from "../src/runtime-models.mjs";

test("normalizeRuntimeModel qualifies provider and variant", () => {
  assert.equal(
    normalizeRuntimeModel({ id: "space-bunny-free", providerID: "opencode", variant: "max" }),
    "opencode/space-bunny-free (max)",
  );
  assert.equal(normalizeRuntimeModel("opencode/space-bunny-free"), "opencode/space-bunny-free");
  assert.equal(normalizeRuntimeModel(""), null);
});

test("OpenCode session models are resolved by Herdr session id", () => {
  clearRuntimeModelCache();
  const sessionId = "ses_runtime_model_fixture";
  const agents = [{ agent: "opencode", agent_session: { agent: "opencode", value: sessionId } }];
  const models = getOpenCodeSessionModels(agents, {
    now: 1000,
    queryModels: (ids) => [{ id: ids[0], model: JSON.stringify({ id: "space-bunny-free", providerID: "opencode", variant: "max" }) }],
  });
  assert.deepEqual(resolveRuntimeModel(agents[0], models), {
    model: "opencode/space-bunny-free (max)",
    source: "opencode-session",
    sessionId,
  });
});

test("direct harness model metadata wins over session fallback", () => {
  const agent = {
    agent: "opencode",
    agent_session: { value: "ses_direct_model_fixture" },
    model: { id: "harness-model", provider: "test-provider" },
  };
  assert.deepEqual(resolveRuntimeModel(agent, new Map([["ses_direct_model_fixture", "session-model"]])), {
    model: "test-provider/harness-model",
    source: "herdr-record",
    sessionId: "ses_direct_model_fixture",
  });
});
