import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");

test("persona/account viewing cannot mark a message as read", () => {
  const start = app.indexOf("async function markMessageRead");
  const fn = app.slice(start, app.indexOf("function markThreadRead", start));
  assert.ok(start >= 0);
  assert.match(fn, /state\.activeAccount !== "user"/);
  assert.match(fn, /state\.activeAccount === "all"/);
  assert.match(fn, /return;/);
  assert.doesNotMatch(fn, /fetch\(`\/api\/messages\/\$\{messageId}\/read/);
});

test("Starred is a local read-only view over all fetched folders", () => {
  assert.match(app, /state\.activeFolder === "starred"/);
  assert.match(app, /state\.searchQuery \|\| state\.activeFolder === "starred" \? "all" : state\.activeFolder/);
  assert.match(app, /state\.starredIds\.has\(state\.viewMode === "threads" \? item\.threadId : item\.id\)/);
});

test("Panes and coordinator metrics are separate scrollable sideboard views", () => {
  assert.match(html, /id="nav-view-metrics" data-view="metrics"/);
  assert.match(html, /id="metrics-view-section"/);
  assert.match(app, /metricsViewSection\?\.classList\.toggle\("hidden", viewName !== "metrics"\)/);
  assert.match(app, /navViewMetrics\?\.addEventListener\("click", \(\) => switchView\("metrics"\)\)/);
  assert.match(css, /\.panes-view-section\s*\{[\s\S]*?overflow-y: auto/);
  assert.match(css, /\.metrics-view-scroll\s*\{[\s\S]*?overflow-y: auto/);
  assert.match(app, /renderCoordinatorMetrics\(\)/);
  assert.match(html, /id="coordinator-doorbell-enabled"/);
  assert.match(html, /id="coordinator-doorbell-log"/);
  assert.match(app, /\/api\/coordinator-doorbell/);
  assert.match(css, /\.coordinator-metrics-panel/);
  assert.match(css, /\.coordinator-doorbell-log/);
});

test("mailbox navigation returns to mail view and desktop menu collapses in-flow", () => {
  assert.match(app, /state\.activeFolder = btn\.dataset\.folder;[\s\S]*?switchView\("mail"\)/);
  assert.match(app, /state\.activeCategory = btn\.dataset\.category;[\s\S]*?if \(state\.detailOpen\) hideMessageDetail\(\);[\s\S]*?switchView\("mail"\)/);
  assert.match(app, /state\.activeFolder = btn\.dataset\.folder;[\s\S]*?if \(state\.detailOpen\) hideMessageDetail\(\)/);
  assert.match(app, /document\.body\.classList\.toggle\("sidebar-collapsed"\)/);
  assert.match(app, /window\.innerWidth <= 768/);
  assert.match(css, /body\.sidebar-collapsed \.app-sidebar/);
  assert.doesNotMatch(css, /body\.sidebar-collapsed \.app-sidebar[^}]*sidebar-backdrop/);
});
