import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { mapHerdrAgentActivity } from "../src/herdr.mjs";

/**
 * A FAKE MORE PERMISSIVE THAN REALITY CANNOT FAIL.
 *
 * The e2e fixture emitted `name: ""` for a title-only agent, where the real server omits the
 * key entirely. The two behave identically for any truthiness test, and differently for any
 * test of PRESENCE - `if ("name" in agent)`, `agent.name !== undefined`,
 * `Object.keys(agent).includes("name")`. So the fixture was exercising code paths the real socket
 * never produces, and the pane tests were green against a shape that cannot occur.
 *
 * Making the fixture stricter did NOT turn anything red, which is the finding: nothing in the
 * production path branches on the key's presence, so the permissiveness was hiding nothing
 * today. It was one refactor away from hiding something, and the fixture would have been the
 * last place that showed it - because the fake, not the code, defined the input.
 *
 * So the arm that makes the strictness worth having is HERE: these cases are pinned directly,
 * against the real consumer, so the guarantee no longer depends on a fixture happening to be
 * honest.
 */

const base = {
  agent: "pi",
  model: { id: "space-bunny-free", providerID: "opencode", variant: "max" },
  agent_session: { agent: "pi", source: "herdr:pi", value: "ses_x" },
  agent_status: "idle",
  pane_id: "pane-1",
  workspace_id: "ws-1",
  tab_id: "tab-1",
  terminal_id: "term-1",
  terminal_title_stripped: "pi - spotter",
};

const KNOWN = ["spotter", "qa", "range"];

test("an ABSENT name falls through to the terminal title", () => {
  const a = mapHerdrAgentActivity({ ...base }, new Date().toISOString(), null, new Set(KNOWN));
  assert.equal(a?.herdrHandle, "spotter", "identity comes from the title, which is the point");
});

test("an EMPTY name behaves identically to an absent one", () => {
  // The fake used to send "" here. If these ever diverge, a consumer has started testing
  // presence rather than truthiness, and the fixture's permissiveness would be masking it.
  const absent = mapHerdrAgentActivity({ ...base }, new Date().toISOString(), null, new Set(KNOWN));
  const empty = mapHerdrAgentActivity({ ...base, name: "" }, new Date().toISOString(), null, new Set(KNOWN));
  const blank = mapHerdrAgentActivity({ ...base, name: "   " }, new Date().toISOString(), null, new Set(KNOWN));
  assert.equal(empty?.herdrHandle, absent?.herdrHandle, '"" must resolve exactly like absent');
  assert.equal(blank?.herdrHandle, absent?.herdrHandle, "whitespace must resolve exactly like absent");
});

test("a REAL name wins over the title", () => {
  // The one case where a title-only agent is NOT the answer, so a regression that always
  // preferred the title would pass every other arm in this file.
  const a = mapHerdrAgentActivity({ ...base, name: "qa" }, new Date().toISOString(), null, new Set(KNOWN));
  assert.equal(a?.herdrHandle, "qa", "an explicit name outranks the pane title");
});

test("the fixture no longer sends the field the real server omits", () => {
  // Guards the fake itself, so it cannot drift back to being more permissive. Reading the source
  // is deliberate: a unit test of the fixture's exports would pass against a shape the real
  // server does not produce, which is the whole problem restated.
  const src = readFileSync(
    path.join(import.meta.dirname, "..", "test", "e2e", "dashboard-fixture.mjs"), "utf8");
  const titleOnly = src.slice(src.indexOf("const titleOnlyAgent"));
  assert.ok(!/^\s*name:\s*"",?\s*$/m.test(titleOnly),
    "the title-only agent must omit `name`, exactly as the real server does");
});
