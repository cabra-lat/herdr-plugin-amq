import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../src/web/i18n.js", import.meta.url), "utf8");

test("dashboard provides persisted English and Brazilian Portuguese translations", () => {
  assert.match(html, /id="language-select"/);
  assert.match(html, /<option value="pt-BR">Português \(Brasil\)<\/option>/);
  assert.match(html, /i18n\.js\?v=1/);
  assert.match(app, /const t = i18n\?\.t/);
  assert.match(app, /setLocale\(languageSelect\.value\)/);
  assert.match(app, /agmail-locale-changed/);
  assert.match(app, /renderCoordinatorMetrics\(\)/);
  assert.match(app, /renderPaneCards\(\)/);
  assert.match(app, /renderList\(\)/);
  assert.match(app, /fetchStatus\(\)/);
  assert.match(app, /AMQ_MD_LINK_/);
  assert.ok(app.includes("(?<![\\p{L}\\p{N}_\"'=])((?:https?:\\/\\/)[^\\s<]+)"));
  assert.match(i18n, /"pt-BR"/);
  assert.match(i18n, /agmail_locale/);
  assert.match(i18n, /translations\[DEFAULT_LOCALE\]/);
  assert.match(i18n, /document\.documentElement\.lang = locale/);
});

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
  assert.match(html, /id="coordinator-doorbell-cooldown"/);
  assert.match(html, /id="coordinator-doorbell-manual"/);
  assert.match(app, /coordinatorDoorbellManual\?\.addEventListener\("click"/);
  assert.match(app, /\/api\/coordinator-doorbell\/ping/);
  assert.match(app, /coordinatorDoorbellCooldown\.textContent = `\$\{t\("metrics\.cooldown"\)\}: \$\{cooldown\}`/);
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

// The source of a message must be reachable FROM THE MESSAGE, on every surface that renders
// one, and every attachment must state its size.
//
// Both are here as source assertions because the failure is a duplication failure: there are
// three places that render a message and a fourth that lists attachments, and a reader who
// finds the affordance in the thread view but not in the sheet has been told the feature does
// not exist. The rendered output is asserted for real in
// test/e2e/dashboard-raw-source.test.mjs, which drives a browser; these arms exist to catch a
// NEW render site added without the affordance, which no browser arm would notice until
// somebody opened that view and complained.
test("every surface that renders a message also offers the raw source and a copy", () => {
  const renderSites = app.match(/renderAttachmentsSection\((?:m|msg)\.attachments\)/g) || [];
  assert.equal(renderSites.length, 3, `expected 3 message render sites, found ${renderSites.length}`);
  // One source-tools template, one delegated wiring, and both next to every render site.
  assert.equal((app.match(/\$\{sourceToolsHtml\}/g) || []).length, 3, "every render site must place the source tools");
  assert.equal((app.match(/wireMessageSourceTools\(/g) || []).length, 4, "one definition plus one call per rendered container");
  assert.match(app, /href="\$\{url\}" target="_blank" rel="noopener"/);
  assert.match(app, /\/api\/messages\/\$\{id\}\/raw\?account=\$\{account\}/);
  // Scoped to a CONCRETE mailbox. The endpoint refuses `all`, so a link that carried it would
  // be a link that cannot work, and it would fail only when clicked.
  assert.match(app, /const account = encodeURIComponent\(getActiveSender\(\)\)/);
  // The copy reads the JSON envelope rather than scraping the rendered tab, because a copy
  // taken from the DOM is a second lossy rendering wearing the first one's name.
  assert.match(app, /raw\?account=\$\{account\}&format=json/);
  assert.match(app, /navigator\.clipboard\.writeText\(data\.raw \?\? ""\)/);
  // And it says so when it fails, rather than silently doing nothing.
  assert.match(app, /mail\.rawFailed/);
  for (const key of ["mail.seeRaw", "mail.copyRaw", "mail.copiedRaw", "mail.rawFailed"]) {
    assert.ok(i18n.includes(`"${key}"`), `${key} is missing from the translations`);
  }
  assert.match(css, /\.message-source-tools/);
});

test("every attachment row states its byte size, not only the file rows", () => {
  // A 42-byte deliberate probe and an upload that arrived nearly empty look identical without
  // a number next to them, and that confusion is what made a fixture read as a broken
  // deliverable. The size was already computed and already on the wire; it was rendered for
  // files and dropped for images and video.
  assert.match(app, /const sizeTag = \(a\) =>/);
  for (const name of ["img.name", "vid.name"]) {
    assert.match(app, new RegExp(`attachment-filename">\\$\\{escapeHtml\\(${name.replace(".", "\\.")}\\)} \\$\\{sizeTag\\(`),
      `${name} does not carry its size`);
  }
  // The file row kept its own class and gained the same tag, so all three row kinds go
  // through one helper. A second, near-identical size renderer is how the two drifted apart
  // in the first place.
  assert.match(app, /class="file-name">\$\{escapeHtml\(f\.name\)\}<\/span>\s*\$\{sizeTag\(f\)\}/);
  assert.match(css, /\.attachment-size/);
});
