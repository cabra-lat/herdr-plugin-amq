import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateBoardTask } from "../src/board.mjs";

process.env.HERDR_PLUGIN_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "herdr-iso-liveness-clock-author-"));

/**
 * A FRESH CLOCK WITH A STALE AUTHOR IS A FALSE PRESENCE RECORD, AND IT IS THE WORST SHAPE
 * THE CLOCK CAN TAKE.
 *
 * The invariant board.mjs states four lines above the write is: "A liveness clock is only ever
 * written together with the actor that produced it. A clock with no author is a liveness claim no
 * reader can discount, and the stall detector still honours it." Commit f2370d7 added that
 * sentence and the write beside it.
 *
 * Observed on a real card at 2026-09-28T16:34:47.885Z, `task_1790603680046_4742aa`, owner
 * agsuite-dev: the coordinator ran `task unblock --me coordinator --stage doing`, and the card
 * came back with `last_heartbeat_at: 16:34:47.885Z` and `last_heartbeat_by: "meta"`. Neither the
 * caller nor the owner. meta had been idle for an hour (its own agent_status=idle at seq 19388,
 * which is why the coordinator unblocked the card in the first place).
 *
 * The pair is the defect, not the author: `last_heartbeat_at` is reset to now on entry into
 * progress while `last_heartbeat_by` keeps `existingTask.last_heartbeat_by`, the PREVIOUS lease
 * holder. So the card claims a beat that is fresh in time and false in authorship - and every
 * consumer of the liveness dimension, including the one that fixed `stalled_work` and the one the
 * deadline decision was justified from, reads it as presence. `heartbeatByNonOwner` in
 * metrics.mjs:139 cannot discount it either: a non-owner beat and a stale-author-fresh-clock are
 * the same field.
 *
 * The fix is that on entry into progress the author is ALWAYS the actor who entered, and if no
 * actor can be named the clock stays unset rather than being stamped anonymously.
 */
function seedCard({ id, stage, status, owner, hbBy, hbAt }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clock-author-"));
  const amqRoot = path.join(root, ".agent-mail");
  const dir = path.join(amqRoot, "bus", stage);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`),
    `---\nid: ${id}\ntitle: clock author\nstatus: ${status}\nstage_dir: ${stage}\nowner: ${owner}\n` +
    `updated: 2026-09-25T00:00:00.000Z\nlast_heartbeat_at: ${hbAt}\nlast_heartbeat_by: ${hbBy}\n---\n\nb\n`);
  return { root, amqRoot };
}

const ANCIENT = "2026-09-25T00:00:00.000Z";

test("entering progress names the actor who entered, not the previous lease holder", () => {
  const { root, amqRoot } = seedCard({
    id: "task_clock_0001", stage: "blocked", status: "blocked",
    owner: "agsuite-dev", hbBy: '"meta"', hbAt: ANCIENT,
  });

  const res = updateBoardTask(root, amqRoot, "task_clock_0001", { status: "in_progress", reason: "r" }, { from: "coordinator" });
  assert.ok(res.ok, `the write should succeed: ${JSON.stringify(res.error || res)}`);

  const t = res.task;
  // The clock DID move - so this is not a preserve that would pass vacuously.
  assert.notEqual(t.last_heartbeat_at, ANCIENT,
    "control: entering progress must reset the clock, otherwise this test proves nothing");
  assert.equal(t.last_heartbeat_by, "coordinator",
    `the author of a fresh clock must be the actor that wrote it; got ${JSON.stringify(t.last_heartbeat_by)} (the PREVIOUS holder, ${"meta"}, is exactly the defect)`);
});

test("the invariant itself: a changed clock always carries the actor that changed it", () => {
  const { root, amqRoot } = seedCard({
    id: "task_clock_0002", stage: "blocked", status: "blocked",
    owner: "agsuite-dev", hbBy: '"player-rig"', hbAt: ANCIENT,
  });

  const res = updateBoardTask(root, amqRoot, "task_clock_0002", { status: "in_progress", reason: "r" }, { from: "coordinator" });
  assert.ok(res.ok, `the write should succeed: ${JSON.stringify(res.error || res)}`);

  const clockMoved = res.task.last_heartbeat_at !== ANCIENT;
  const author = res.task.last_heartbeat_by;
  assert.ok(!(clockMoved && author !== "coordinator"),
    `clock moved (${clockMoved}) with author ${JSON.stringify(author)} - a fresh clock wearing a stale author`);
  assert.ok(!(!clockMoved && author),
    "a preserved clock must not gain an author it did not have");
});

test("CONTROL: a card with no prior heartbeat gets a named one, so the fix cannot pass by never writing", () => {
  const { root, amqRoot } = seedCard({
    id: "task_clock_0003", stage: "blocked", status: "blocked",
    owner: "agsuite-dev", hbBy: "null", hbAt: "null",
  });

  const res = updateBoardTask(root, amqRoot, "task_clock_0003", { status: "in_progress", reason: "r" }, { from: "coordinator" });
  assert.ok(res.ok, `the write should succeed: ${JSON.stringify(res.error || res)}`);
  assert.ok(res.task.last_heartbeat_at, "entering progress with no prior beat must still stamp a clock");
  assert.equal(res.task.last_heartbeat_by, "coordinator",
    "and it must be named - an anonymous fresh clock is the other half of the same defect");
});
