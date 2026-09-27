#!/usr/bin/env node
// A BURST OF LIVE EVENTS MUST COST ONE SCAN, NOT ONE PER EVENT.
//
// The owner reported that scrolling the sidebar "triggers the reload. This is not good at all,
// really annoying." I fixed a real scroll-jump defect first and it was SECONDARY. The measured
// cost is this: /api/threads?account=all takes 27-34 SECONDS on the live dashboard, because
// loadThreads -> loadAllMessages scans every agent maildir and groups every message in JS with
// paginate disabled. One concrete account is 3.8-4.1s. There are 16,392 message files under
// agents/.
//
// The SSE channel calls fetchData on every event with no debounce and no in-flight guard, so
// while one 30-second scan runs, every arriving event starts another. Several concurrent
// 30-second requests is what a reader experiences as the page hanging or reloading.
//
// This does not make the scan cheaper - that is server-side and a different piece of work. It
// bounds the client to ONE scan in flight and remembers that one more is owed, so a burst costs
// a second scan instead of N. The unbounded part is the bug; the constant is the server's.
//
// Run: node test/live-refetch-coalesced.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const appJs = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");

// fetchData grew a long explanatory comment when the in-flight guard was added, so the fixed
// 3000-character slice this test originally used no longer reaches the body and the guard
// assertions were reading past the end of the function. Take it from the signature to its close.
function fetchDataSource() {
  const start = appJs.indexOf("async function fetchData()");
  const rest = appJs.slice(start);
  const end = rest.indexOf("\n  }\n", rest.indexOf("finally {"));
  return rest.slice(0, end + 4);
}

test("fetchData refuses to start while a scan is already running", () => {
  const fn = fetchDataSource();

  // The flag is declared immediately ABOVE fetchData, not inside it, so it must be asserted
  // against the surrounding region rather than the function slice. Asserting it inside the
  // function would be a test that can only pass if the flag were declared in the wrong place.
  const decl = appJs.slice(appJs.indexOf("let fetchInFlight"), appJs.indexOf("async function fetchData()"));
  assert.match(decl, /let fetchInFlight = false;/, "an in-flight flag must exist, initialised false");
  assert.match(decl, /let fetchTrailing = false;/, "a trailing flag must exist, initialised false");
  assert.match(
    fn,
    /if \(fetchInFlight\) \{[\s\S]*?fetchTrailing = true;[\s\S]*?return;/,
    "a call arriving during a scan must record that one more is owed and return early - " +
    "returning is the whole mechanism, because joining the request is what creates the pile-up",
  );
  assert.match(fn, /fetchInFlight = true;/, "the flag must be set before the fetch starts");
});

test("the flag is cleared on BOTH success and failure, or one error wedges the dashboard forever", () => {
  const fn = fetchDataSource();
  assert.match(fn, /\} catch \(e\) \{[\s\S]*?\} finally \{[\s\S]*?fetchInFlight = false;/,
    "the reset must be in a finally. Clearing it only on the success path would mean a single " +
    "network error - which the owner already hit once, the transmissions NetworkError - left the " +
    "dashboard permanently unable to refresh again.");
});

test("exactly one trailing refresh is owed, not one per skipped event", () => {
  const fn = fetchDataSource();
  // The trailing flag is set, never counted and never queued, so N events during a scan produce
  // one follow-up rather than N. Asserting the SET and the single reset, because a counter here
  // would be the regression: 30 events must not become 30 queued scans.
  assert.match(fn, /fetchTrailing = true;/, "skipped events set the flag");
  assert.match(
    fn,
    /finally \{[\s\S]*?fetchInFlight = false;[\s\S]*?if \(fetchTrailing\) \{[\s\S]*?fetchTrailing = false;[\s\S]*?fetchData\(\);/,
    "the flag is cleared BEFORE the follow-up call, or a burst would re-enter in a loop",
  );
  assert.doesNotMatch(fn, /fetchTrailing\s*\+=/, "the flag must not be a counter; that would restore the pile-up");
});

test("the event stream still calls fetchData - we bounded the pile-up, we did not disable live updates", () => {
  // The tempting wrong fix is to stop refetching on events. That makes the dashboard feel fast
  // and leaves it silently stale, which is the trade this board keeps refusing.
  const sse = appJs.slice(appJs.indexOf("evtSource.onmessage"), appJs.indexOf("evtSource.onmessage") + 2500);
  assert.match(sse, /fetchData\(\)/, "live events must still trigger a refresh");
  assert.doesNotMatch(sse, /removeEventListener\(\s*["']message["']/, "the event stream must stay connected");
});
