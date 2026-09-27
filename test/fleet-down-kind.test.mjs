import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopFleet } from "../src/fleet.mjs";

/**
 * `fleet down` was filtering panes on the FLEET-WIDE kind while `fleet up` had already been
 * fixed to launch each agent under its own brief's kind. Those two halves disagree, and the
 * disagreement is not theoretical - it is the shape of the human's actual fleet:
 *
 *   their agents run as `pi`, the default kind is `agy`
 *   => `fleet up` launches each agent as `pi`   (per-agent resolution, since 51e5130)
 *   => `fleet down --kind agy` closed NOTHING  (fleet-wide filter, never updated)
 *
 * An up that creates a pane and a down that refuses to close it is not idempotent in either
 * direction. This is the half of the idempotence card that CAN be proven without a second herdr
 * instance: the pane-matching logic is exercised against an injected registry that mirrors the
 * real one's shape, and every assertion is on PANE IDS, never on the prose of the result.
 *
 * What this file does NOT prove, and must not be read as proving: that the real herdr returns
 * panes in this shape, or that up/down are idempotent against a live server. That needs a second
 * instance and stays blocked on task_1790472002097_3fdb93.
 */

function makeRepo(briefs) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-down-kind-"));
  const dir = path.join(repoDir, ".opencode", "agents");
  fs.mkdirSync(dir, { recursive: true });
  for (const [handle, body] of Object.entries(briefs)) {
    fs.writeFileSync(path.join(dir, `${handle}.md`), body);
  }
  return repoDir;
}

/** A pane as herdr reports it: `agent` is the kind, `name` is the handle. */
function pane(pane_id, name, kind) {
  return { pane_id, name, agent: kind };
}

describe("fleet down resolves kind per agent, the same way fleet up does", () => {
  test("each agent is found under ITS OWN kind, so up and down agree on what it created", async () => {
    // THE ARM, and it is the whole defect. `alpha`'s brief declares `kind: pi` and its pane runs
    // as `pi`, so a down that resolved per agent closes it.
    //
    // The old code compared the FLEET-WIDE `--kind agy` against every pane, so it filtered this
    // pane out and reported `skipped: kind is pi` - meaning the pane `fleet up` had just created
    // (correctly, as pi, since 51e5130) was the one pane `fleet down` refused to close. Red arm:
    // against that implementation this assertion fails with [['pane','close','p2']] only.
    const repoDir = makeRepo({
      alpha: "---\nkind: pi\n---\n\nAlpha brief.",
      bravo: "---\nkind: agy\n---\n\nBravo brief.",
    });
    const closed = [];
    const result = await stopFleet("unused", repoDir, {
      kind: "agy",
      getLiveAgents: async () => [pane("p1", "alpha", "pi"), pane("p2", "bravo", "agy")],
      execHerdr: (args) => { closed.push(args); },
    });

    assert.deepEqual(closed, [["pane", "close", "p1"], ["pane", "close", "p2"]],
      "both panes close, each under the kind its own brief resolved to");
    assert.deepEqual(result.stopped.map((s) => [s.handle, s.paneId, s.kind]), [
      ["alpha", "p1", "pi"],
      ["bravo", "p2", "agy"],
    ]);
    assert.equal(result.skipped.length, 0, "nothing is skipped, because nothing disagrees");
  });

  test("a pane running under a kind its brief does NOT declare is reported, not closed", async () => {
    // The genuine mismatch, and the reason the reporting exists: `alpha`'s brief says `pi`, its
    // pane is actually running as `agy`. Before this change the reason was the bare string
    // "kind is agy", which does not say what was expected or how to proceed - so a teardown
    // quietly became a no-op and nobody noticed for a week.
    const repoDir = makeRepo({ alpha: "---\nkind: pi\n---\n\nAlpha." });
    const closed = [];
    const result = await stopFleet("unused", repoDir, {
      kind: "agy",
      getLiveAgents: async () => [pane("p1", "alpha", "agy")],
      execHerdr: (args) => { closed.push(args); },
    });
    assert.deepEqual(closed, []);
    assert.equal(result.stopped.length, 0);
    const skip = result.skipped[0];
    assert.equal(skip.kind, "agy", "named as found");
    assert.equal(skip.expectedKind, "pi", "and as expected, from its own brief");
    assert.match(skip.reason, /without --kind/, "with the way out stated");
  });

  test("the same fleet is torn down completely when --kind is omitted", async () => {
    // The escape hatch has to exist, or a kind disagreement becomes permanent: there must be a
    // spelling of "down" that means "close this agent's panes, whatever they are running as".
    const repoDir = makeRepo({
      alpha: "---\nkind: pi\n---\n\nAlpha brief.",
      bravo: "---\nkind: agy\n---\n\nBravo brief.",
    });
    const closed = [];
    const result = await stopFleet("unused", repoDir, {
      getLiveAgents: async () => [pane("p1", "alpha", "pi"), pane("p2", "bravo", "agy")],
      execHerdr: (args) => { closed.push(args); },
    });
    assert.deepEqual(closed, [["pane", "close", "p1"], ["pane", "close", "p2"]]);
    assert.equal(result.skipped.length, 0, "no kind filter means no mismatch to report");
  });

  test("a --kind that matches nothing closes nothing and says why, per agent", async () => {
    const repoDir = makeRepo({ alpha: "---\nkind: agy\n---\n\nAlpha." });
    const closed = [];
    const result = await stopFleet("unused", repoDir, {
      kind: "agy",
      getLiveAgents: async () => [pane("p1", "alpha", "opencode")],
      execHerdr: (args) => { closed.push(args); },
    });
    assert.deepEqual(closed, [], "and this is the arm that fails loudly instead of quietly");
    assert.equal(result.stopped.length, 0);
    assert.match(result.skipped[0].reason, /running as opencode, expected agy/);
  });
});

describe("the dry run tells the truth about the mismatch", () => {
  test("wouldStop and skipped are both populated, so a preview cannot promise a teardown it will not do", async () => {
    // The same defect class as the `fleet up` preview: a dry run that only reports the happy
    // path is worse than no preview, because it is the thing you trust right before being
    // destructive.
    const repoDir = makeRepo({
      alpha: "---\nkind: pi\n---\n\nAlpha.",
      bravo: "---\nkind: agy\n---\n\nBravo.",
    });
    const closed = [];
    const result = await stopFleet("unused", repoDir, {
      kind: "agy",
      dryRun: true,
      getLiveAgents: async () => [pane("p1", "alpha", "pi"), pane("p2", "bravo", "agy")],
      execHerdr: (args) => { closed.push(args); },
    });
    assert.deepEqual(closed, [], "a dry run closes nothing, ever");
    assert.deepEqual(result.wouldStop.map((w) => w.paneId), ["p1", "p2"]);
    assert.equal(result.skipped.length, 0);
  });

  test("a dry run reports the mismatch instead of quietly previewing a full teardown", async () => {
    const repoDir = makeRepo({ alpha: "---\nkind: pi\n---\n\nAlpha." });
    const result = await stopFleet("unused", repoDir, {
      kind: "agy",
      dryRun: true,
      getLiveAgents: async () => [pane("p1", "alpha", "agy")],
      execHerdr: () => {},
    });
    assert.deepEqual(result.wouldStop, [], "it will not close it, so it must not preview closing it");
    assert.match(result.skipped[0].reason, /without --kind/);
  });
});

describe("the current pane stays protected", () => {
  test("a pane running under the resolved kind is skipped as the current pane, not closed", async () => {
    const repoDir = makeRepo({ alpha: "---\nkind: pi\n---\n\nAlpha." });
    const closed = [];
    const result = await stopFleet("unused", repoDir, {
      kind: "agy",
      currentPaneId: "p1",
      getLiveAgents: async () => [pane("p1", "alpha", "pi")],
      execHerdr: (args) => { closed.push(args); },
    });
    assert.deepEqual(closed, []);
    assert.match(result.skipped[0].reason, /current pane p1 is protected/);
  });
});
