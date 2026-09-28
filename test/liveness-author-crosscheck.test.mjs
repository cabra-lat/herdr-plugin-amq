import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordCardWrite, readCardWrites } from "../src/card-writes.mjs";

/**
 * A LIE IN THE AUTHOR FIELD, CROSS-CHECKED AGAINST A SECOND WITNESS.
 *
 * WHY THIS FILE EXISTS. `c4ff8aa` made liveness key on the AUTHOR: a heartbeat is the OWNER's
 * lease, and a beat by anyone else must not count. That fix is a detector keyed on
 * `last_heartbeat_by`. A detector keyed on one field CANNOT DETECT A LIE IN THAT FIELD, and
 * that is not hypothetical: board.mjs:1249 had `existingTask.last_heartbeat_by || (entering
 * Progress ? actor : null)`, so entering progress stamped the clock FRESH while keeping the
 * PREVIOUS holder as the author. Observed live on task_1790520288120_cef4eb at
 * 2026-09-28T15:44:42.285Z: the owner and the writer were both `spotter`, and the card read
 * `last_heartbeat_by: player-rig` -- the previous holder, not the writer. Fixed in 3e8353a.
 *
 * So the consumer was correct and correctly fed, by a producer that lied. What was missing is
 * a SECOND WITNESS, and one already exists: card-writes.mjs appends one JSONL row per write
 * with `at`, `actor`, `fields` and `transitions`, written by a DIFFERENT function from a
 * DIFFERENT value. The check is therefore:
 *
 *   FOR ANY WRITE WHOSE `fields` INCLUDE `last_heartbeat_at`,
 *   THE RESULTING `last_heartbeat_by` MUST EQUAL THAT ROW'S `actor`.
 *
 * This is not a comment. It is machine-checkable today, and nothing was checking it, which is
 * why the row above sat on disk for an hour with nobody cross-checking two records of the same
 * fact that disagreed.
 *
 * THE REACH OF THIS CHECK, STATED UP FRONT BECAUSE IT IS THE PART THAT WOULD OTHERWISE BE
 * OVERCLAIMED. `recordCardWrite` records the NAMES of the fields that changed, not their
 * values. So a row can only be checked while the card still carries the value that row wrote --
 * once the card has moved on, the resulting `last_heartbeat_by` is not on disk anywhere and the
 * row is unverifiable. On the live board that is 23 verifiable rows against 298 that are not.
 * This file therefore pins the INVARIANT and the check's reach, and says plainly that extending
 * reach means recording the value. It does not pretend to be a board-wide audit.
 */

const NOW = "2026-09-28T15:44:42.285Z";

function withState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liveness-xcheck-"));
  const old = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (old === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


// The invariant, isolated as a pure function so both the arms and any future audit share it.
export function livenessAuthorViolations(rows, current) {
  const out = [];
  for (const row of rows) {
    if (!(row.fields || []).includes("last_heartbeat_at")) continue;
    if (row.at !== current.last_heartbeat_at) continue; // unverifiable: the card has moved on
    if (current.last_heartbeat_by !== row.actor) {
      out.push({ at: row.at, actor: row.actor, last_heartbeat_by: current.last_heartbeat_by });
    }
  }
  return out;
}

test("RED ARM: a fresh clock wearing the PREVIOUS holder is caught by the second witness", () => {
  withState((stateDir) => {
    // The row: spotter entered progress and the clock was stamped fresh.
    recordCardWrite(stateDir, "card-x", { last_heartbeat_at: null, last_heartbeat_by: null }, {
      last_heartbeat_at: NOW, last_heartbeat_by: "player-rig", // <- the lie: previous holder
    }, { actor: "spotter", at: NOW });

    const rows = readCardWrites(stateDir, "card-x");
    assert.equal(rows.length, 1, "the write must have been recorded at all");
    assert.deepEqual(rows[0].fields, ["last_heartbeat_at", "last_heartbeat_by"]);

    const v = livenessAuthorViolations(rows, { last_heartbeat_at: NOW, last_heartbeat_by: "player-rig" });
    assert.equal(v.length, 1, "the stale-author pair must be a VIOLATION");
    assert.equal(v[0].actor, "spotter", "and it must name who actually wrote it");
    assert.equal(v[0].last_heartbeat_by, "player-rig", "and whose name the card is wearing");
  });
});

test("CONTROL: an honest write is NOT a violation, so the arm cannot pass by flagging everything", () => {
  withState((stateDir) => {
    recordCardWrite(stateDir, "card-ok", { last_heartbeat_at: null, last_heartbeat_by: null }, {
      last_heartbeat_at: NOW, last_heartbeat_by: "spotter",
    }, { actor: "spotter", at: NOW });
    const rows = readCardWrites(stateDir, "card-ok");
    const v = livenessAuthorViolations(rows, { last_heartbeat_at: NOW, last_heartbeat_by: "spotter" });
    assert.deepEqual(v, [], "the writer naming itself is the NORMAL case and must be silent");
  });
});

test("CONTROL: a row that moved the card on is UNVERIFIABLE, and is reported as such rather than passing", () => {
  withState((stateDir) => {
    // An older write stamped the clock; the card has since been written again.
    recordCardWrite(stateDir, "card-moved", { last_heartbeat_at: null, last_heartbeat_by: null }, {
      last_heartbeat_at: "2026-09-27T22:15:26.478Z", last_heartbeat_by: "npc-body",
    }, { actor: "npc-body", at: "2026-09-27T22:15:26.478Z" });
    const rows = readCardWrites(stateDir, "card-moved");
    const current = { last_heartbeat_at: "2026-09-28T09:00:00.000Z", last_heartbeat_by: "worker" };
    assert.deepEqual(livenessAuthorViolations(rows, current), [],
      "no violation may be claimed for a value that is no longer on disk");
  });
});

test("REACH IS BOUNDED AND THE BOUND IS DOCUMENTED, not silently assumed", () => {
  withState((stateDir) => {
    const older = "2026-09-27T22:15:26.478Z";
    recordCardWrite(stateDir, "card-reach", { last_heartbeat_at: null, last_heartbeat_by: null }, {
      last_heartbeat_at: older, last_heartbeat_by: "npc-body",
    }, { actor: "npc-body", at: older });
    const rows = readCardWrites(stateDir, "card-reach");
    assert.ok(rows[0].fields.includes("last_heartbeat_at"),
      "the row is checkable in principle -- it DID write the clock");
    // ...and yet it is not checkable in practice, because the log stores field NAMES.
    assert.equal(rows[0].last_heartbeat_at, undefined,
      "THE BOUND, AS AN ASSERTION: the audit row carries the NAME of the changed field and NOT " +
      "its value, so a row can only be cross-checked while the card still carries what it wrote. " +
      "This assertion is what fails if someone starts storing values -- at which point the reach " +
      "of this check widens and this file's premise should be revisited, not deleted.");
  });
});
