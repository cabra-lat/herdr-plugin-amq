// The metrics history was bounded by COUNT only (last 500), so the time span it covered
// depended on how busy the system happened to be - ~20h quiet, well under an hour busy.
// A viewer could not tell which, and 500 x ~235 B was ~117 KB on every /api/board poll.
//
// The rule this file exists to enforce: a window that silently drops old samples is
// indistinguishable from a history that never had them. So dropping must be REPORTED,
// and undated samples must never be treated as old.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHistoryWindow, DEFAULT_HISTORY_WINDOW_MS } from "../src/metrics-history.mjs";

const NOW = Date.parse("2026-09-26T15:00:00.000Z");
const H = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(NOW - hoursAgo * H).toISOString();

// Oldest-first, matching recordMetricsSample's append order.
const hist = (...hoursAgo) => ({
  schemaVersion: 1,
  samples: [...hoursAgo].sort((a, b) => b - a).map((h) => ({ at: at(h) })),
});

test("samples inside the window are kept and older ones dropped", () => {
  const r = applyHistoryWindow(hist(0.5, 2, 5, 7, 20), { windowMs: 6 * H, now: NOW });
  assert.equal(r.samples.length, 3, "0.5h, 2h and 5h are inside 6h");
  assert.equal(r.retention.droppedOld, 2, "7h and 20h are outside");
});

test("the window REPORTS what it dropped - it is never silent", () => {
  const r = applyHistoryWindow(hist(0.5, 2, 5, 7, 20), { windowMs: 6 * H, now: NOW });
  assert.equal(r.retention.total, 5, "total must be the pre-window count");
  assert.equal(r.retention.retained, 3);
  assert.equal(r.retention.droppedOld, 2);
  assert.equal(r.retention.mode, "window");
  assert.equal(r.retention.windowMs, 6 * H);
});

test("the reported span describes the WINDOW, not the whole file", () => {
  // Regression: the span was computed over every dated sample INCLUDING the dropped
  // ones, so a 6h window reported a 19.2h span. Every earlier fixture had all its
  // samples inside the window, so this could not fail until the real file had history
  // older than the window in it. Caught by measuring the live payload.
  const r = applyHistoryWindow(hist(30, 20, 5, 2, 0.5), { windowMs: 6 * H, now: NOW });
  assert.equal(r.samples.length, 3);
  assert.equal(r.retention.droppedOld, 2);
  const spanH = (Date.parse(r.retention.newestAt) - Date.parse(r.retention.oldestKeptAt)) / H;
  assert.ok(spanH <= 6, `reported span ${spanH}h must not exceed the 6h window`);
  assert.equal(r.retention.oldestKeptAt, at(5), "oldest KEPT, not oldest present");
});

test("oldestKeptAt and newestAt let the UI state the actual span", () => {
  const r = applyHistoryWindow(hist(5, 2, 0.5), { windowMs: 6 * H, now: NOW });
  assert.equal(r.retention.oldestKeptAt, at(5));
  assert.equal(r.retention.newestAt, at(0.5));
});

test("the reported span does not depend on the order samples arrive in", () => {
  // A restored or merged file could be out of order; reporting a window from
  // positional assumptions would then state the wrong span.
  const ordered = hist(5, 2, 0.5);
  const shuffled = { samples: [...ordered.samples].reverse() };
  const a = applyHistoryWindow(ordered, { windowMs: 6 * H, now: NOW }).retention;
  const b = applyHistoryWindow(shuffled, { windowMs: 6 * H, now: NOW }).retention;
  assert.equal(a.oldestKeptAt, b.oldestKeptAt);
  assert.equal(a.newestAt, b.newestAt);
  assert.equal(a.droppedOld, b.droppedOld);
});

test("undated samples are RETAINED and counted, never dropped as if old", () => {
  // A sample we cannot place in time is not evidence that it is stale. Dropping it
  // would quietly destroy data on the basis of a parse failure.
  const h = { schemaVersion: 1, samples: [{ at: "not-a-date" }, { at: at(1) }] };
  const r = applyHistoryWindow(h, { windowMs: H, now: NOW });
  assert.equal(r.retention.undated, 1);
  assert.equal(r.samples.length, 2, "the undated sample survives");
});

test("windowMs=Infinity keeps everything and says so", () => {
  const r = applyHistoryWindow(hist(0.5, 20, 100), { windowMs: Infinity, now: NOW });
  assert.equal(r.samples.length, 3);
  assert.equal(r.retention.droppedOld, 0);
  assert.equal(r.retention.mode, "all");
  assert.equal(r.retention.windowMs, null);
});

test("a nonsense window does not empty the history", () => {
  // NaN/0/negative would otherwise read as "keep nothing" - i.e. an empty chart that
  // looks like a system with no history.
  for (const bad of [0, -1, NaN, "banana"]) {
    const r = applyHistoryWindow(hist(1, 20), { windowMs: bad, now: NOW });
    assert.equal(r.samples.length, 2, `windowMs=${bad} must not drop samples`);
  }
});

test("an empty or malformed history does not throw", () => {
  for (const bad of [{}, { samples: null }, { samples: [] }]) {
    assert.doesNotThrow(() => applyHistoryWindow(bad, { windowMs: H, now: NOW }));
  }
  const r = applyHistoryWindow({ samples: [] }, { windowMs: H, now: NOW });
  assert.equal(r.samples.length, 0);
  assert.equal(r.retention.total, 0);
  assert.equal(r.retention.oldestKeptAt, null);
});

test("the default window is longer than any alert window in use", () => {
  // The longest windowed alert is retry_failure_trend at 900s. If the history window
  // were shorter, an alert could lose the evidence it is judged on.
  assert.ok(DEFAULT_HISTORY_WINDOW_MS > 900 * 1000, "history must outlast the 900s alert window");
});

test("the payload actually shrinks - the point of the change", () => {
  const many = { samples: Array.from({ length: 500 }, (_, i) => ({ at: at(i * 0.05), agents: { a: 1, b: 2 } })) };
  const before = JSON.stringify(many).length;
  const after = JSON.stringify(applyHistoryWindow(many, { now: NOW })).length;
  assert.ok(after < before / 2, `expected a large reduction, got ${before} -> ${after}`);
});
