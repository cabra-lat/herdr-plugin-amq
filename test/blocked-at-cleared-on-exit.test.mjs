import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.HERDR_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "blocked-at-state-"));
{ const r = fs.mkdtempSync(path.join(os.tmpdir(), "blocked-at-root-"));
  fs.mkdirSync(path.join(r, "agents"), { recursive: true });
  fs.mkdirSync(path.join(r, "bus"), { recursive: true });
  process.env.AM_ROOT = r; }

// DYNAMIC, not static: ESM evaluates every static import BEFORE any top-level statement, so an
// env assignment written under the imports runs too late for the import-time root check and the
// whole file dies with "No active .agent-mail directory found", which reads like a syntax error.
const { updateBoardTask } = await import("../src/board.mjs");

/**
 * A card must not carry a timestamp for a state it is not in.
 *
 * The measurement: 88 of 448 non-blocked cards carried a `blocked_at` from a block they are no
 * longer in - 83 done, 4 queued, 1 in_progress. The worst was the OLDEST queued user decision on
 * the board: status queued, next_actor user, carrying blocked_at and ~50 minutes of block time. A
 * reader that checks whether `blocked_at` is SET concludes the most load-bearing decision on this
 * board is blocked. It is queued and waiting on a person, which has a different remedy.
 *
 * Every assertion here reads the CARD BACK OFF DISK. `updateBoardTask` returning a tidy object
 * proves nothing when the defect is a field that survives serialisation.
 */
function seedCard(fields) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ba-case-"));
  const amqRoot = path.join(root, ".agent-mail");
  const dir = path.join(amqRoot, "bus", fields.stage_dir);
  fs.mkdirSync(dir, { recursive: true });
  const head = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
  fs.writeFileSync(path.join(dir, `${fields.id}.md`), `---\n${head}\n---\n\nbody\n`);
  return { root, amqRoot };
}

function readBack(amqRoot, id) {
  const bus = path.join(amqRoot, "bus");
  for (const col of fs.readdirSync(bus)) {
    const f = path.join(bus, col, `${id}.md`);
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    const out = { col };
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([a-z_]+):\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (v === "null") v = null;
      out[kv[1]] = v;
    }
    return out;
  }
  return null;
}

const MIN = 60_000;

test("LEAVING blocked clears blocked_at AND blocked_ms, and banks the spell into blocked_total_ms", () => {
  const now = new Date();
  const blockedAt = new Date(now.getTime() - 50 * MIN).toISOString();
  const { root, amqRoot } = seedCard({
    id: "task_clear_0001", title: "t", status: "blocked", stage_dir: "blocked",
    owner: "agsuite-dev", next_actor: "user", updated: blockedAt,
    blocked_at: blockedAt, blocked_ms: String(50 * MIN), blocked_total_ms: "0",
  });

  const res = updateBoardTask(root, amqRoot, "task_clear_0001", { status: "queued", reason: "the person decided" }, { now });
  assert.equal(res.ok, true, `update failed: ${res.error || ""}`);

  const t = readBack(amqRoot, "task_clear_0001");
  assert.equal(t.status, "queued");
  assert.equal(t.blocked_at, null, "blocked_at must not describe a state the card has left");
  assert.equal(Number(t.blocked_ms), 0, "blocked_ms agrees: not blocked for zero ms, not blocked NOW");
  assert.equal(Number(t.blocked_total_ms), 50 * MIN, "and the spell is NOT lost - banked as cumulative time");
});

test("A RE-ROUTE still preserves blocked_at, because staying blocked is not a new spell", () => {
  const now = new Date();
  const blockedAt = new Date(now.getTime() - 30 * MIN).toISOString();
  const { root, amqRoot } = seedCard({
    id: "task_clear_0002", title: "t", status: "blocked", stage_dir: "blocked",
    owner: "agsuite-dev", next_actor: "user", updated: blockedAt,
    blocked_at: blockedAt, blocked_ms: String(30 * MIN), blocked_total_ms: "0",
  });

  const res = updateBoardTask(root, amqRoot, "task_clear_0002", { next_actor: "verifier", owner: "ballistics" }, { now });
  assert.equal(res.ok, true, `update failed: ${res.error || ""}`);

  const t = readBack(amqRoot, "task_clear_0002");
  assert.equal(t.status, "blocked");
  assert.equal(t.blocked_at, blockedAt, "a re-route must not restart the clock - d317cfd's invariant survives");
});

test("ENTERING blocked starts a fresh spell even when a previous one was banked", () => {
  const now = new Date();
  const { root, amqRoot } = seedCard({
    id: "task_clear_0004", title: "t", status: "queued", stage_dir: "queued",
    owner: "agsuite-dev", next_actor: "user", updated: now.toISOString(),
    blocked_at: "null", blocked_ms: "0", blocked_total_ms: String(90 * MIN),
  });
  const res = updateBoardTask(root, amqRoot, "task_clear_0004", { status: "blocked", reason: "waiting on a person" }, { now });
  assert.equal(res.ok, true, `update failed: ${res.error || ""}`);
  const t = readBack(amqRoot, "task_clear_0004");
  assert.ok(t.blocked_at, "entering blocked sets blocked_at");
  assert.equal(Number(t.blocked_ms), 0, "a new spell starts at zero");
  assert.equal(Number(t.blocked_total_ms), 90 * MIN, "and the earlier cumulative time is untouched, not reset");
});

test("RED ARM: a done card that never carried blocked_at still cannot acquire one", () => {
  // Guards the shape of the fix rather than its timing: the CLEAR is the whole assertion, and a
  // regression that re-preserves blocked_at on exit shows up here as a non-null stamp.
  const now = new Date();
  const { root, amqRoot } = seedCard({
    id: "task_clear_0005", title: "t", status: "blocked", stage_dir: "blocked",
    owner: "agsuite-dev", next_actor: "user", updated: now.toISOString(),
    blocked_at: now.toISOString(), blocked_ms: "0", blocked_total_ms: "0",
  });
  updateBoardTask(root, amqRoot, "task_clear_0005", { status: "done", reason: "finished" }, { now });
  const t = readBack(amqRoot, "task_clear_0005");
  assert.equal(t.status, "done");
  assert.equal(t.blocked_at, null, "a done card must not carry a blocked_at - this is the 83-card residue class");
});
