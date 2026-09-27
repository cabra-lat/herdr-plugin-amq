import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

process.env.HERDR_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "depshape-"));
{ const r = fs.mkdtempSync(path.join(os.tmpdir(), "depshape-root-"));
  fs.mkdirSync(path.join(r, "agents"), { recursive: true });
  fs.mkdirSync(path.join(r, "bus"), { recursive: true });
  process.env.AM_ROOT = r; }

/**
 * A string-valued `depends_on` made a card render as though it waited on nothing.
 *
 * A bare string is a LEGAL depends_on, and the stalled projection has always accepted one - it
 * falls back to a scalar on purpose. The blocked projection read the same field as
 * `(task.depends_on || task.dependency || []).map?.(...)`. `.map?.()` on a string returns
 * undefined, so the `?? []` guard converted that into an EMPTY dependencyStates rather than a
 * crash, and the renderer took its "no edges" branch:
 *
 *     deps=none (this card waits on nothing, which is not the same as its deps being met)
 *
 * for a card that was waiting on one edge. The guard prevented a crash and left a lie.
 *
 * The root cause is two projections reading one field under two different notions of what it may
 * be. The fix is ONE reader, not a third normalisation - a second inline normaliser is how the two
 * readers came to disagree.
 *
 * Latent, not a regression: every live card sampled uses arrays, so this has not fired. The point
 * of pinning it is that the codebase's own stalled reader PROMISES to accept a scalar, so the
 * divergence is a broken promise, not a hypothetical input.
 */
const NOW = Date.UTC(2026, 8, 27, 18, 0, 0);

const card = (id, over) => ({
  id, title: "Work", owner: "worker", status: "blocked",
  created: new Date(NOW - 10 * 3600_000).toISOString(),
  updated: new Date(NOW - 10 * 3600_000).toISOString(),
  claimed_at: new Date(NOW - 9 * 3600_000).toISOString(),
  status_at: new Date(NOW - 9 * 3600_000).toISOString(),
  ...over,
});

function build(cards) {
  return buildCoordinatorMetrics({
    board: { columns: { blocked: cards } },
    now: NOW, deliveredState: { delivered: {} }, resources: {},
  });
}

// The projections live on the metrics OBJECT (blockedWork / blockedOldest / stalledWork), not on
// the alerts - my first version searched only m.alerts and found nothing, so every arm failed on a
// card that was projected correctly all along. An empty result here is a lookup bug, not a
// behaviour bug, and the two are indistinguishable unless you check where the data lives.
const byId = (m, id) => {
  for (const group of [m.blockedWork, m.blockedOldest, m.stalledWork])
    for (const c of group || []) if (c.id === id) return c;
  for (const a of m.alerts || []) for (const c of a.cards || []) if (c.id === id) return c;
  return null;
};

test("THE DEFECT: a string-valued depends_on does not read as 'waits on nothing'", () => {
  // The dependency is OPEN, so this card is genuinely gated. If the shape were lost the renderer
  // would report it as ungated - the opposite of the truth - and that is what must not happen.
  const m = build([card("task_scalar", { depends_on: "task_open" })]);
  const c = byId(m, "task_scalar");
  assert.ok(c, "the blocked card must be projected");
  assert.deepEqual(c.dependencyStates.map((d) => d.id), ["task_open"],
    "a bare string must read as a one-element dependency list, not as an empty one");
  assert.equal(c.dependencyStates[0].status, "unknown",
    "a dependency id absent from the table is UNKNOWN, never assumed done");
  assert.equal(c.dependencyStates.length, 1,
    "one scalar edge is one edge; reading it as none is the defect");
});

test("THE SAME CARD WITH AN ARRAY IS IDENTICAL - the shape is a presentation detail, not semantics", () => {
  // If these two differ, then which shape a card happens to be stored in changes its MEANING,
  // which is the actual defect rather than a rendering preference.
  const scalar = byId(build([card("task_x", { depends_on: "task_open" })]), "task_x");
  const array = byId(build([card("task_x", { depends_on: ["task_open"] })]), "task_x");
  assert.deepEqual(scalar.dependencyStates, array.dependencyStates,
    "scalar and array must produce the SAME dependency states");
  assert.equal(scalar.dependency.length, array.dependency.length, "and the same reported edge list");
});

test("A CARD WITH NO DEPENDENCIES STILL READS AS NONE - the fix is not 'never say none'", () => {
  // The guard against over-correcting. A reader that turned every card into a one-element list
  // would make this pass trivially and would be wrong in the other direction.
  const c = byId(build([card("task_none", { depends_on: [] })]), "task_none");
  assert.ok(c);
  assert.deepEqual(c.dependencyStates, [], "no dependencies really is an empty list");
  assert.equal(c.dependency, null, "and the card carries no edge to report");
});

test("RED ARM: the two projections now read the field through ONE reader", () => {
  // The structural guard. The defect was two readers disagreeing about one field, so asserting
  // behaviour alone would not catch a third copy being added later. This pins the single reader.
  const src = fs.readFileSync(new URL("../src/metrics.mjs", import.meta.url), "utf8");
  const reader = src.match(/function dependencyList\(task\) \{[\s\S]*?\n\}/);
  assert.ok(reader, "a shared dependency reader must exist");
  // No projection may normalise the field itself any more.
  const inline = src.match(/\(task\.depends_on \|\| task\.dependency \|\| \[\]\)\.map\?/g) || [];
  assert.deepEqual(inline, [],
    `no projection may re-implement the read; found ${inline.length} inline normalisation(s)`);
  // And the reader must handle the scalar case, which is the whole point.
  assert.ok(/if \(raw === null \|\| raw === undefined \|\| raw === ""\) return \[\];/.test(reader[0])
    && /return \[raw\];/.test(reader[0]),
    "the reader must turn a bare scalar into a one-element list");
});
