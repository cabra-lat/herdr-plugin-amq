// Every rendered message must let a reader open the markdown the sender actually wrote,
// and put those same bytes on the clipboard.
//
// The defect this closes is not theoretical. A 42-byte probe attachment was read as a broken
// deliverable because nothing on the surface let the reader open the file and see that it was
// deliberate: four attachment cards, correct names, correct extensions, and no way to look
// inside any of them. A rendered message and its source are two different things, and a reader
// who cannot see the source cannot tell which one they are looking at.
//
// The arms assert on BYTES, by hash, never by eye:
//   * the source link points at the raw endpoint, is scoped to a concrete mailbox, and opens
//     in a NEW tab rather than replacing the reading view;
//   * the copy action puts exactly the sender's bytes on the clipboard, including the parts a
//     renderer would drop: a body that is a single character, trailing blank lines, and
//     markdown the renderer escapes. A copy that re-renders is a second lossy rendering;
//   * the affordance is ON the message, not behind a menu.
//
// The payload is deliberately hostile: a single character, blank lines the renderer would trim,
// a table pipe and an angle bracket the renderer escapes, and a fenced block. If any of it is
// normalised on the way through, the hash moves and the arm goes red.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { createDashboardFixture } from "./dashboard-fixture.mjs";

const PROBE_THREAD = "agboard/raw-source-probe";
const PROBE_ID = "2026-09-24T09-00-00-000Z_fixture-raw-source-probe";
// Exactly what the sender wrote, including the trailing blank lines. The RAW endpoint returns
// everything after the frontmatter, so this string IS the expected clipboard content.
const PROBE_BODY = "x\n\n\n| a | b |\n|---|---|\n<script>alert(1)</script>\n\n```\nfenced https://not-a-link.example\n```\n\n\n";
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

function findChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  for (const candidate of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      return execFileSync("which", [candidate], { encoding: "utf8" }).trim();
    } catch {}
  }
  throw new Error("Chromium not found. Set CHROMIUM_BIN to a Chrome/Chromium executable.");
}

function seedProbeMessage(amqRoot) {
  const inbox = path.join(amqRoot, "agents", "range", "inbox", "new");
  fs.mkdirSync(inbox, { recursive: true });
  const metadata = {
    schema: 1,
    id: PROBE_ID,
    from: "coordinator",
    to: ["range"],
    subject: "Raw source probe",
    thread: PROBE_THREAD,
    created: "2026-09-24T09:00:00.000Z",
    kind: "status",
  };
  fs.writeFileSync(
    path.join(inbox, `${PROBE_ID}.md`),
    `---json\n${JSON.stringify(metadata, null, 2)}\n---\n${PROBE_BODY}`,
    "utf8",
  );
}

test("a reader can open the source of a message and copy it byte for byte", { timeout: 120000 }, async () => {
  let fixture = null;
  let browser = null;
  const errors = [];
  try {
    fixture = await createDashboardFixture();
    seedProbeMessage(fixture.amqRoot);
    browser = await chromium.launch({
      headless: true,
      executablePath: findChromium(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const origin = new URL(fixture.baseUrl).origin;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    // Read AND write, so the arm can compare what the button put there against what the sender
    // wrote. Without the grant the read throws and the arm would be asserting on a rejection.
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    await page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await page.click("#user-profile-btn");
    await page.click('.account-item-btn[data-handle="range"]');
    await page.locator(`.mail-row[data-thread-id="${PROBE_THREAD}"]`).click();
    await page.waitForSelector("#mail-detail-view:not(.hidden)");
    const card = page.locator(`#mail-detail-view .thread-card[data-msg-id="${PROBE_ID}"]`);
    await card.waitFor({ state: "visible", timeout: 10000 });

    // ARM 1: the affordance is on the message, is scoped to a CONCRETE mailbox, and opens in
    // a new tab. `account=all` is refused by the endpoint, so a link carrying it would be a
    // link that cannot work, and a same-tab link would destroy the reading view.
    const rawHref = await card.locator(".msg-raw-link").getAttribute("href");
    assert.ok(rawHref, "the message exposes a raw link");
    assert.match(rawHref, new RegExp(`/api/messages/${encodeURIComponent(PROBE_ID).replace(/%/g, "%")}/raw\\?`), rawHref);
    assert.match(rawHref, /account=range/, `the link must be scoped to a concrete mailbox, got ${rawHref}`);
    assert.equal(
      await card.locator(".msg-raw-link").getAttribute("target"),
      "_blank",
      "the source opens in a new tab, it does not replace the reading view",
    );

    // ARM 2: the copy action pastes the sender's bytes, asserted by hash. A copy that trimmed
    // the trailing blank lines, escaped the pipe table, or re-rendered the fenced block would
    // all move this hash while still LOOKING right in a screenshot.
    await card.locator(".msg-raw-copy").click();
    await page.waitForFunction(() => document.querySelector(".msg-raw-copy")?.textContent?.trim() !== "copy source", null, { timeout: 10000 });
    const pasted = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(sha(pasted), sha(PROBE_BODY), "the clipboard does not hold the bytes the sender wrote");
    assert.equal(pasted, PROBE_BODY, "a single-character body and its trailing blank lines must survive");

    // ARM 3: the copy reports what it did. A button that silently does nothing is
    // indistinguishable from a message whose source is unavailable, which is the confusion
    // this surface exists to remove.
    assert.equal((await card.locator(".msg-raw-copy").textContent()).trim(), "copied");

    assert.deepEqual(errors, [], "no page errors while reading the source");
  } finally {
    await browser?.close();
    await fixture?.close();
  }
});
