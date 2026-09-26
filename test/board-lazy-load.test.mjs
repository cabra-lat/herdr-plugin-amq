// The done column is an archive that only ever grows, and nothing bounded it: at 325
// cards /api/board shipped 853 KB of completed work on every poll, every SSE re-render
// and every open tab. These tests pin the bounding AND the honesty of it - a lazy load
// that hides cards without reporting the total would be a performance win bought with
// a silent lie.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyColumnLimits } from "../src/server.mjs";

const mkBoard = (doneCount, other = {}) => ({
  backlog: [{ id: "b1" }],
  in_progress: [{ id: "i1" }, { id: "i2" }],
  blocked: [{ id: "x1" }],
  done: Array.from({ length: doneCount }, (_, i) => ({
    id: `d${i}`,
    // Newest last, so "most recent N" is distinguishable from "first N".
    created: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    updated: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
  })),
  ...other,
});

const q = (s) => ({ get: (k) => (s && s[k] !== undefined ? s[k] : null) });

test("default bounds the archive and reports the true total", () => {
  const { columns, columnsMeta } = applyColumnLimits(mkBoard(325), q(null));
  assert.equal(columns.done.length, 25);
  assert.equal(columnsMeta.done.total, 325);
  assert.equal(columnsMeta.done.returned, 25);
  assert.equal(columnsMeta.done.truncated, true);
});

test("active columns are NEVER trimmed - a card you can act on must not be the hidden one", () => {
  const { columns } = applyColumnLimits(mkBoard(325), q({ doneLimit: "0" }));
  assert.equal(columns.backlog.length, 1);
  assert.equal(columns.in_progress.length, 2);
  assert.equal(columns.blocked.length, 1);
});

test("doneLimit=0 returns no archive cards but still reports the total", () => {
  const { columns, columnsMeta } = applyColumnLimits(mkBoard(325), q({ doneLimit: "0" }));
  assert.equal(columns.done.length, 0);
  assert.equal(columnsMeta.done.total, 325);
  assert.equal(columnsMeta.done.truncated, true);
});

test("doneLimit=n returns the n most RECENT, not the first n", () => {
  const { columns } = applyColumnLimits(mkBoard(30), q({ doneLimit: "3" }));
  assert.equal(columns.done.length, 3);
  const dates = columns.done.map((c) => c.updated).sort();
  // The three newest available days must be present, oldest days absent.
  assert.deepEqual(dates, ["2026-01-26T00:00:00.000Z", "2026-01-27T00:00:00.000Z", "2026-01-28T00:00:00.000Z"]);
});

test("doneLimit=-1 and 'all' are escape hatches back to full history", () => {
  for (const v of ["-1", "all"]) {
    const { columns, columnsMeta } = applyColumnLimits(mkBoard(325), q({ doneLimit: v }));
    assert.equal(columns.done.length, 325, `doneLimit=${v}`);
    assert.equal(columnsMeta.done.truncated, false);
    assert.equal(columnsMeta.done.limit, "all");
  }
});

test("a junk doneLimit falls back to the default instead of emptying the column", () => {
  // NaN would render as "0 done" and read as an empty board rather than a typo.
  const { columns, columnsMeta } = applyColumnLimits(mkBoard(325), q({ doneLimit: "banana" }));
  assert.equal(columns.done.length, 25);
  assert.equal(columnsMeta.done.total, 325);
});

test("an empty done column is reported as not truncated", () => {
  const { columns, columnsMeta } = applyColumnLimits(mkBoard(0), q(null));
  assert.equal(columns.done.length, 0);
  assert.equal(columnsMeta.done.truncated, false);
  assert.equal(columnsMeta.done.total, 0);
});

test("a board with no done key at all does not throw", () => {
  const { columns, columnsMeta } = applyColumnLimits({ backlog: [] }, q(null));
  assert.deepEqual(columns.done, []);
  assert.equal(columnsMeta.done.total, 0);
});

test("the payload actually shrinks - the point of the change", () => {
  const board = mkBoard(325);
  const before = JSON.stringify(board).length;
  const { columns } = applyColumnLimits(board, q(null));
  const after = JSON.stringify(columns).length;
  assert.ok(after < before / 3, `expected a large reduction, got ${before} -> ${after}`);
});
