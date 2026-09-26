// One fact, three names, and an absent key read as a value.
//
// The defect was not in the export. `last_heartbeat_at` was present and correct on the
// board API the whole time. The reader asked for `card.heartbeat`, which does not exist,
// and wrote `card.heartbeat || card.heartbeatAt || 0` -- so when BOTH keys were absent the
// fallback produced a number. Date.parse(0) is 946692000000, which printed as an age of
// 14062699 minutes and was reported as a measurement.
//
// These tests pin the two states a consumer must be able to tell apart: a card with a real
// heartbeat, and a card with none. A consumer that cannot distinguish them IS the defect.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addBoardTask, heartbeatBoardTask, loadBoard } from "../src/board.mjs";

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hbnaming-"));
  const amqRoot = path.join(repoRoot, "mail");
  fs.mkdirSync(amqRoot, { recursive: true });
  return { repoRoot, amqRoot };
}

test("a card with a heartbeat carries a real heartbeatAgeMs", () => {
  const b = fixture();
  try {
    const t = addBoardTask(b.repoRoot, b.amqRoot, { title: "beat", owner: "qa", status: "in_progress" }).task;
    // The REAL heartbeat path, not a status write. A card created in_progress has not
    // transitioned, so writing its status is not a heartbeat and would prove nothing.
    heartbeatBoardTask(b.repoRoot, b.amqRoot, t.id, { actor: "qa" });
    const card = loadBoard(b.repoRoot, b.amqRoot).columns.in_progress.find((c) => c.id === t.id);
    assert.ok(card, "card is on the board");
    assert.ok(card.last_heartbeat_at, "the timestamp is present");
    assert.equal(typeof card.heartbeatAgeMs, "number", "the age travels with the timestamp");
    assert.ok(card.heartbeatAgeMs >= 0 && card.heartbeatAgeMs < 60_000, "a heartbeat taken now is not ancient");
  } finally { fs.rmSync(b.repoRoot, { recursive: true, force: true }); }
});

test("a card with NO heartbeat reports null, never a number", () => {
  // The arm that just happened. A card that has never heartbeated must be UNSET. It must
  // not become 0, because 0 is a real age and reads as "it was checked and it was fresh".
  const b = fixture();
  try {
    const t = addBoardTask(b.repoRoot, b.amqRoot, { title: "silent", owner: "qa", status: "in_progress" }).task;
    const card = loadBoard(b.repoRoot, b.amqRoot).columns.in_progress.find((c) => c.id === t.id);
    assert.ok(card);
    assert.equal(card.last_heartbeat_at, null, "no timestamp, honestly absent");
    assert.equal(card.heartbeatAgeMs, null, "and therefore no age, rather than an age of 0");

    // The exact arithmetic that produced 14062699 minutes. If heartbeatAgeMs can be 0 for a
    // card that never heartbeated, this consumer reproduces the original wrong number.
    const raw = card.heartbeat ?? card.heartbeatAt ?? 0;
    assert.equal(card.heartbeatAgeMs, null);
    assert.notEqual(card.heartbeatAgeMs, 0, "0 would be indistinguishable from a fresh heartbeat");
  } finally { fs.rmSync(b.repoRoot, { recursive: true, force: true }); }
});

test("the two states are distinguishable by the export alone, with no fallback", () => {
  // The property the card asks for: a consumer that cannot tell these two apart IS the
  // defect. Here they differ by type, not by arithmetic.
  const b = fixture();
  try {
    const beat = addBoardTask(b.repoRoot, b.amqRoot, { title: "a", owner: "qa", status: "in_progress" }).task;
    heartbeatBoardTask(b.repoRoot, b.amqRoot, beat.id, { actor: "qa" });
    const silent = addBoardTask(b.repoRoot, b.amqRoot, { title: "b", owner: "qa", status: "in_progress" }).task;
    const col = loadBoard(b.repoRoot, b.amqRoot).columns.in_progress;
    const withBeat = col.find((c) => c.id === beat.id);
    const without = col.find((c) => c.id === silent.id);
    assert.equal(typeof withBeat.heartbeatAgeMs, "number");
    assert.equal(without.heartbeatAgeMs, null);
  } finally { fs.rmSync(b.repoRoot, { recursive: true, force: true }); }
});
