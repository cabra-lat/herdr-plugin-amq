import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDashboardFixture } from "./dashboard-fixture.mjs";

/**
 * Identity resolution in `getHerdrStatusMap()` reads the registered handles from
 * the root the caller injects, falling back to AM_ROOT only when none is given. An
 * agent with no Herdr `name` can only be resolved from its canonical pane title, and
 * only when that handle is registered in the queue root that `findAmqRoot()` finds.
 *
 * Both directions are asserted on purpose: a positive assertion alone would still
 * pass if identity resolution were removed entirely, which is exactly the kind of
 * vacuous green this file exists to prevent.
 */
test("fixture resolves registered agents by name and by title, and drops unregistered ones", async () => {
  const fixture = await createDashboardFixture();
  try {
    const agents = await fetch(`${fixture.baseUrl}/api/agents`).then((response) => response.json());
    const byHandle = new Map(agents.map((agent) => [agent.handle, agent]));

    // Positive, by name.
    assert.equal(byHandle.get("range")?.herdrStatus, "working", `unexpected range row: ${JSON.stringify(byHandle.get("range"))}`);
    assert.equal(byHandle.get("range")?.status, "working");
    assert.equal(byHandle.get("qa")?.herdrStatus, "idle", `unexpected qa row: ${JSON.stringify(byHandle.get("qa"))}`);

    // Positive, by canonical pane title only (no Herdr `name` in the record).
    assert.equal(
      byHandle.get("spotter")?.herdrStatus,
      "idle",
      `title-resolved agent missing: ${JSON.stringify(byHandle.get("spotter"))}`,
    );
    assert.equal(byHandle.get("spotter")?.herdrPaneId, "pane-spotter");

    // Negative control: reported by Herdr, absent from the AMQ root, so it must not
    // become an agent and must not hijack a registered handle.
    assert.equal(
      byHandle.has(fixture.unregisteredHandle),
      false,
      `unregistered handle leaked into the agent list: ${agents.map((a) => a.handle).join(",")}`,
    );
    assert.notEqual(byHandle.get("range")?.herdrPaneId, "pane-intruder");
    for (const handle of fixture.registeredHandles) {
      assert.equal(byHandle.has(handle), true, `registered handle missing: ${handle}`);
    }
  } finally {
    await fixture.close();
  }
});

test("the injected root wins over AM_ROOT, and AM_ROOT is not required", async () => {
  // A decoy root: a real, existing, EMPTY .agent-mail that registers no handles.
  // If identity resolution read the env, the title-only agent would drop out.
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "amq-decoy-"));
  const decoyRoot = path.join(decoy, ".agent-mail");
  fs.mkdirSync(path.join(decoyRoot, "agents"), { recursive: true });

  const fixture = await createDashboardFixture({ amqRootEnvPath: decoyRoot });
  try {
    const agents = await fetch(`${fixture.baseUrl}/api/agents`).then((response) => response.json());
    const byHandle = new Map(agents.map((agent) => [agent.handle, agent]));

    // Positive: the title-only record resolves from the INJECTED root even though
    // AM_ROOT points at an empty one. Fails if the code regressed to the env.
    assert.equal(
      byHandle.get("spotter")?.herdrStatus,
      "idle",
      `injected root must win over AM_ROOT: ${JSON.stringify(byHandle.get("spotter"))}`,
    );
    // A named record is unaffected either way, so this does not overclaim.
    assert.equal(byHandle.get("range")?.herdrStatus, "working");
    // Registration is still enforced against the injected root, not skipped.
    assert.equal(byHandle.has(fixture.unregisteredHandle), false, "unregistered handle leaked");
  } finally {
    await fixture.close();
    fs.rmSync(decoy, { recursive: true, force: true });
  }
});

test("title-resolved identity resolves with AM_ROOT absent entirely", async () => {
  const fixture = await createDashboardFixture();
  try {
    const agents = await fetch(`${fixture.baseUrl}/api/agents`).then((response) => response.json());
    const byHandle = new Map(agents.map((agent) => [agent.handle, agent]));
    assert.equal(byHandle.get("spotter")?.herdrStatus, "idle", "title-only agent must resolve without AM_ROOT");
    assert.equal(byHandle.get("range")?.herdrStatus, "working");
    assert.equal(byHandle.has(fixture.unregisteredHandle), false, "unregistered handle leaked");
  } finally {
    await fixture.close();
  }
});
