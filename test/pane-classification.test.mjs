// Regression: a dead herdr and a handle with no pane must never look the same.
//
// This exists because they DID look the same. /api/panes reported every failure as
// "herdr-unavailable", so a fleet in perfect health showed two red rows (the `user`
// and `worker` mailboxes have no agent pane) - and a genuine herdr outage later
// rendered as the exact same familiar red, i.e. invisible. The outage is the
// condition that needs a human, and it was the one being suppressed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPaneRead } from "../src/server.mjs";

test("a healthy read is ok with no error", () => {
  assert.deepEqual(classifyPaneRead({ err: null, stdout: "hello from the pane" }), {
    ok: true,
    error: null,
  });
});

test("an empty read with no error is still ok (a quiet agent is not a failure)", () => {
  assert.deepEqual(classifyPaneRead({ err: null, stdout: "" }), { ok: true, error: null });
});

test("a spawn failure is a real herdr outage", () => {
  const r = classifyPaneRead({ err: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), stdout: "" });
  assert.equal(r.error, "herdr-unavailable");
  assert.equal(r.ok, false);
});

test("herdr structured agent_not_found is 'no-pane', NOT an outage", () => {
  // EXACTLY as observed from herdr 0.7.5 for an unknown handle:
  //   exit 1, EMPTY stdout, JSON envelope on STDERR.
  // The first version of this fix read stdout only, passed 8/8, and still reported a
  // live outage - a green test over a payload herdr never emits on this path.
  const stderr = '{"error":{"code":"agent_not_found","message":"agent target user not found"},"id":"cli:agent:read"}';
  const r = classifyPaneRead({ err: new Error("Command failed"), stdout: "", stderr });
  assert.equal(r.error, "no-pane");
  assert.equal(r.ok, false);
});

test("the same envelope on stdout is also honoured (older/other builds)", () => {
  const stdout = '{"error":{"code":"agent_not_found","message":"agent target user not found"}}';
  assert.equal(classifyPaneRead({ err: null, stdout }).error, "no-pane");
});

test("a spawn failure with NO envelope anywhere is a real outage", () => {
  const r = classifyPaneRead({
    err: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    stdout: "",
    stderr: "",
  });
  assert.equal(r.error, "herdr-unavailable");
});

test("agent_not_found still wins even when herdr also exits non-zero", () => {
  // herdr's exit code for this case is not stable across builds; the payload must
  // decide, or a future herdr release silently re-merges the two conditions.
  const stderr = '{"error":{"code":"agent_not_found","message":"agent target worker not found"}}';
  const r = classifyPaneRead({ err: new Error("Command failed"), stderr });
  assert.equal(r.error, "no-pane");
});

test("the two failure modes are genuinely distinguishable (same input shape)", () => {
  const err = new Error("boom");
  const outage = classifyPaneRead({ err, stdout: "" });
  const noPane = classifyPaneRead({ err, stdout: '{"error":{"code":"agent_not_found"}}' });
  assert.notEqual(outage.error, noPane.error);
});

test("a pane that merely prints the words 'not found' is not misread as missing", () => {
  // Guard against a loose substring match: an agent talking about a failing test
  // called "not found" must not be reported as having no pane.
  const r = classifyPaneRead({ err: null, stdout: "FAIL: assertion not found in expected output" });
  assert.equal(r.error, null);
  assert.equal(r.ok, true);
});

test("non-JSON noise on stderr does not become a false no-pane", () => {
  const r = classifyPaneRead({ err: new Error("fail"), stdout: "", stderr: "sh: herdr: command not found" });
  assert.equal(r.error, "herdr-unavailable");
});

test("classifyPaneRead tolerates being called with nothing", () => {
  assert.deepEqual(classifyPaneRead(), { ok: true, error: null });
});
