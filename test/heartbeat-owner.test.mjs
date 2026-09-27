import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

process.env.HERDR_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hb-owner-"));

/**
 * A heartbeat is a LEASE, and a lease is a claim about the OWNER's presence. A heartbeat
 * from anyone else is therefore not evidence about the owner, however recent it is.
 *
 * THE DEFECT THIS EXISTS FOR. Two live instances, found by the coordinator on 2026-09-27:
 * 811261 is heartbeated by `range` and owned by `player-rig`; ea055c is heartbeated by the
 * coordinator and owned by `agsuite-dev`. The effect in both is the same, and it is the
 * worst shape an instrument defect can take: nobody is idle, so the card reads healthy, and
 * the one case the instrument exists for -- a genuinely dead lane -- becomes
 * indistinguishable from a working one. `player-rig` could stop entirely and its lease
 * would still be renewed, by `range`, every few minutes. No alert fires, and the absence
 * of an alert is the thing everyone is reading.
 *
 * WHAT IS NOT BEING CLAIMED. The board already RECORDS the author and already projects
 * `heartbeatByNonOwner`, and board.mjs deliberately REJECTS an unattributed heartbeat
 * rather than guessing one. The recording is right and this change does not touch it. The
 * defect is narrower: two readers take the heartbeat TIMESTAMP without reading the AUTHOR,
 * so a correctly-recorded fact is then ignored by exactly the code that acts on it --
 * `cardLivenessState` (a cross-lane beat marks the card live) and the lapsed-lease loop
 * (a cross-lane beat renews a lease the holder cannot move).
 *
 * WHY "IGNORE" AND NOT "REJECT". Rejecting would mean the cross-lane beat never lands, and
 * it must land: a coordinator pinging a lane it does not own is how you discover the lane
 * is stuck. The record is the product. Only its use as the owner's liveness evidence is
 * wrong, so that is the only thing this changes -- and the author is still reported, so a
 * reader can see WHO renewed it.
 */

const NOW = Date.parse("2026-09-27T20:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// One card, one hour stale, in_progress, with a heartbeat written `beatBy` ago by `beatBy`.
function boardWithHeartbeat({ owner, beatBy, beatAgeMs = 2 * MIN }) {
  return {
    columns: {
      backlog: [],
      in_progress: [
        {
          id: "task-lease",
          title: "Loadout selection screen",
          status: "in_progress",
          stage: "in_progress",
          owner,
          next_actor: owner,
          // The card's own state clock is a day old: this card has NOT moved, which is
          // precisely the situation where the heartbeat is the only evidence of anything.
          updated: new Date(NOW - 1 * DAY).toISOString(),
          created: new Date(NOW - 3 * DAY).toISOString(),
          last_heartbeat_at: new Date(NOW - beatAgeMs).toISOString(),
          last_heartbeat_by: beatBy,
        },
      ],
      blocked: [],
      done: [],
    },
  };
}

// The lapsed-lease block is surfaced through the ALERT, not as a top-level key. Reading
// `result.lapsedLeases` returns undefined and every arm below passes or fails for the wrong
// reason -- which is exactly what my first version of this file did, and the reason the
// first "red" it produced was not evidence of anything.
function leaseEntry(result, id = "task-lease") {
  const alert = result.alerts?.find((a) => a.id === "owner_lease_lapsed");
  return alert?.cards?.find((l) => l.id === id) || null;
}

function livenessEntry(result) {
  return result.livenessLease?.find((l) => l.id === "task-lease") || null;
}

test("a NON-OWNER heartbeat does not renew the owner's lease", () => {
  // `range` heartbeating `player-rig`'s card, 2 minutes ago, while the card itself has
  // not moved in a day. The lease is well past expiry; a non-owner beat must not hide that.
  const fresh = buildCoordinatorMetrics({
    handles: ["player-rig", "range"],
    board: boardWithHeartbeat({ owner: "player-rig", beatBy: "range" }),
    now: NOW,
    thresholds: { stalledWorkMs: 10 * MIN, ownerLeaseMs: 5 * MIN, ownerLeaseReassignMs: 30 * MIN },
  });

  const entry = leaseEntry(fresh);
  assert.ok(entry, "the lease block must still report the card -- ignoring a beat is not hiding a card");
  assert.equal(
    entry.leaseHeartbeatBy,
    "range",
    "the beat is still ATTRIBUTED in the report, so a reader can see who renewed it",
  );
  assert.equal(
    entry.leaseCrossLane,
    true,
    "the payload must say the beat was CROSS-LANE, not the owner's own lease",
  );
  assert.equal(
    entry.leaseAgeMs,
    null,
    "no owner-attributed beat exists to age, and that is reported as null rather than as a number",
  );
  assert.equal(
    entry.reassignmentSuggested,
    true,
    "and a lease no owner has renewed is offered for reassignment, not treated as young",
  );
});

test("the OWNER's own heartbeat DOES renew the lease, so the fix is not 'ignore all beats'", () => {
  const own = buildCoordinatorMetrics({
    handles: ["player-rig"],
    board: boardWithHeartbeat({ owner: "player-rig", beatBy: "player-rig" }),
    now: NOW,
    thresholds: { stalledWorkMs: 10 * MIN, ownerLeaseMs: 5 * MIN, ownerLeaseReassignMs: 30 * MIN },
  });
  assert.equal(
    leaseEntry(own),
    null,
    "the owner's own fresh beat must keep the lease live -- otherwise this fix silences a real liveness signal",
  );
});

test("a NON-OWNER heartbeat does not report the card as live, and says who beat", () => {
  const res = buildCoordinatorMetrics({
    handles: ["player-rig", "range"],
    board: boardWithHeartbeat({ owner: "player-rig", beatBy: "range" }),
    now: NOW,
    thresholds: { stalledWorkMs: 10 * MIN, ownerLeaseMs: 5 * MIN, ownerLeaseReassignMs: 30 * MIN },
  });
  const live = livenessEntry(res);
  assert.ok(live, "the liveness lease payload must still report the card");
  assert.equal(live.by, "range", "the author is reported, not discarded");
  assert.equal(
    live.byIsOwner,
    false,
    "the payload must distinguish a beat that is the owner's from one that is not",
  );
  assert.notEqual(
    live.state,
    "live",
    "a NON-OWNER's fresh beat must not make a day-stale card read as live",
  );
});

test("RED ARM: the reader of last resort -- the two named live cards must not be masked", () => {
  // The two instances from the board, in the shape the coordinator found them.
  const res = buildCoordinatorMetrics({
    handles: ["player-rig", "range", "agsuite-dev", "coordinator"],
    board: {
      columns: {
        backlog: [],
        in_progress: [
          {
            id: "task_1790474839630_811261", title: "camera-distance row", owner: "player-rig", status: "in_progress", stage: "in_progress",
            updated: new Date(NOW - 3 * HOUR).toISOString(),
            last_heartbeat_at: new Date(NOW - 1 * MIN).toISOString(), last_heartbeat_by: "range",
          },
          {
            id: "task_1790536626635_ea055c", title: "merge queue", owner: "agsuite-dev", status: "in_progress", stage: "in_progress",
            updated: new Date(NOW - 3 * HOUR).toISOString(),
            last_heartbeat_at: new Date(NOW - 1 * MIN).toISOString(), last_heartbeat_by: "coordinator",
          },
        ],
        blocked: [],
        done: [],
      },
    },
    now: NOW,
    thresholds: { stalledWorkMs: 10 * MIN, ownerLeaseMs: 5 * MIN, ownerLeaseReassignMs: 30 * MIN },
  });

  for (const id of ["task_1790474839630_811261", "task_1790536626635_ea055c"]) {
    const lease = leaseEntry(res, id);
    assert.ok(
      lease,
      `${id} is heartbeated by a non-owner and has not moved in 3h -- a real stall must still be visible, got ${JSON.stringify(lease)}`,
    );
  }
});
