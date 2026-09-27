#!/usr/bin/env node
// SCROLL POSITION MUST SURVIVE A LIVE REBUILD. The owner reported that scrolling the side bar
// "triggers the reload", which is not what a reload looks like and was not what it was.
//
// THE DIAGNOSIS, and the reason a plausible first guess was wrong. There is NO scroll listener
// anywhere in the web app - grep returns nothing - so nothing was reacting to the scroll itself.
// The SSE channel opens an EventSource at app.js:2223 and, on every event, calls
// renderPresenceList unconditionally. That function ends in `presenceListEl.innerHTML = html`.
// Assigning innerHTML discards the existing subtree, and a scroll container whose contents are
// discarded starts at scrollTop 0. A live board emits constantly, so a reader who scrolled down
// is thrown back to the top every time anything anywhere changes. The page never reloads; the
// sidebar is rebuilt under their thumb, and it reads as a reload because what they were reading
// vanishes.
//
// The reason this is worth a test rather than a patch: the symptom is a scroll JUMP, which no
// existing gate looks at. The roster still renders, the counts stay right, and nothing throws.
// Only the reader's position is lost, and only they can see it.
//
// Run: node test/sidebar-scroll-preserved.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const appJs = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");

test("the presence list preserves scroll across its rebuild", () => {
  const i = appJs.indexOf("presenceListEl.innerHTML = html;");
  assert.ok(i >= 0, "the rebuild line must exist");

  // The capture must come BEFORE the write, or there is nothing to restore.
  const capture = appJs.lastIndexOf("const presenceScroll = presenceListEl.scrollTop;", i);
  assert.ok(capture >= 0, "the scroll position must be captured before the DOM is replaced");
  assert.ok(capture < i, "capturing after the write would capture zero, which is the bug");

  // And the restore must come AFTER the write.
  const restore = appJs.indexOf("if (presenceScroll > 0) presenceListEl.scrollTop = presenceScroll;", i);
  assert.ok(restore > i, "the scroll position must be restored after the DOM is replaced, or it is a no-op");
});

test("there is still no scroll listener that could have been the real cause", () => {
  // If someone later adds a scroll handler that calls fetchData(), this test fails and points at
  // the actual defect rather than leaving the innerHTML fix in place as the wrong remedy.
  const listeners = appJs.match(/addEventListener\(\s*["']scroll["']/g) || [];
  assert.equal(
    listeners.length,
    0,
    `a scroll listener now exists (${listeners.length}). If it re-renders, THAT is the cause and ` +
    "the innerHTML fix is treating a symptom.",
  );
});

test("the roster is still rebuilt on the event stream - we fixed the position, not the freshness", () => {
  // The tempting wrong fix is to stop re-rendering the roster. That would make the jump stop and
  // the agent list go stale, which is a worse defect and harder to notice. Pin both halves.
  assert.match(
    appJs,
    /renderPresenceList\(state\.agents\)/,
    "the roster must still be refreshed from the event stream",
  );
  assert.match(
    appJs,
    /new EventSource\("\/api\/events"\)/,
    "the live channel must still exist; removing it would fix the symptom by deleting the feature",
  );
});
