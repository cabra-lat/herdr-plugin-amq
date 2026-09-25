import test from "node:test";
import assert from "node:assert/strict";
import { createDashboardFixture } from "./dashboard-fixture.mjs";

/**
 * Identity resolution in `getHerdrStatusMap()` reads the registered handles from
 * `getAgentHandles(findAmqRoot())`, NOT from the server's `amqRoot` argument. An
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

test("AM_ROOT is load-bearing for title-resolved identity, not a cosmetic setting", async () => {
  const fixture = await createDashboardFixture({ registerAmqRootEnv: false });
  try {
    const agents = await fetch(`${fixture.baseUrl}/api/agents`).then((response) => response.json());
    const byHandle = new Map(agents.map((agent) => [agent.handle, agent]));

    // A record with a Herdr `name` still resolves: identity is not guessed from the
    // queue root, so this control does not overstate what AM_ROOT does.
    assert.equal(byHandle.get("range")?.herdrStatus, "working", "named agents must not depend on AM_ROOT");

    // The title-only record cannot be resolved, because there is nothing to check
    // its handle against. If this ever passes, the control is not testing the seam.
    assert.equal(
      byHandle.get("spotter")?.herdrStatus,
      undefined,
      "expected a title-only agent to be dropped when its handle is not registered",
    );
  } finally {
    await fixture.close();
  }
});
