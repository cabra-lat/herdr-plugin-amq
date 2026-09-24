import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { createDashboardFixture } from "./dashboard-fixture.mjs";

function findChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  for (const candidate of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      return execFileSync("which", [candidate], { encoding: "utf8" }).trim();
    } catch {}
  }
  throw new Error("Chromium not found. Set CHROMIUM_BIN to a Chrome/Chromium executable.");
}

async function waitForCondition(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for browser condition");
}

async function waitForText(locator, expected, timeout = 10000) {
  await waitForCondition(async () => (await locator.textContent())?.trim() === expected, timeout);
}

test("God Mode sends as user and warns about claimed or blocked owners", { timeout: 120000 }, async () => {
  const fixture = await createDashboardFixture();
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const sentPayloads = [];
  const repliedPayloads = [];
  const readPayloads = [];
  const taskPayloads = [];

  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await page.route("**/api/send", async (route) => {
    sentPayloads.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/reply", async (route) => {
    repliedPayloads.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route(/\/api\/messages\/.*\/read(?:\?|$)/, async (route) => {
    readPayloads.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, alreadyRead: false }) });
  });
  await page.route("**/api/board/tasks", async (route) => {
    taskPayloads.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, task: {} }) });
  });

  try {
    await page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.setItem("agmail_persona", "coordinator"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('.presence-item[data-agent-handle="range"]', { timeout: 15000 });

    assert.equal(await page.locator("#header-account-label").textContent(), "👑 God Mode");
    assert.equal(await page.locator("#reply-as-user").textContent(), "user");
    await page.click("#user-profile-btn");
    await page.click('.account-item-btn[data-handle="user"]');
    await waitForText(page.locator("#header-account-label"), "Human Operator");
    await page.locator(".mail-row").first().click();
    await page.waitForSelector("#mail-detail-view:not(.hidden)");
    await waitForCondition(() => readPayloads.length === 1);
    assert.match(readPayloads[0], /account=user/);
    await page.click("#user-profile-btn");
    await page.click('.account-item-btn[data-handle="all"]');
    await waitForText(page.locator("#reply-as-user"), "user");
    await page.click("#open-compose-btn");
    assert.equal(await page.locator("#compose-from").inputValue(), "user");
    assert.equal(await page.locator("#compose-from").isDisabled(), true);
    await page.fill("#compose-subject", "Identity regression");
    await page.fill("#compose-body", "God Mode must send as the human operator.");
    await page.click("#compose-submit-btn");
    await waitForCondition(() => page.locator("#compose-submit-btn").isEnabled());

    await page.locator(".mail-row").first().click();
    await page.waitForSelector("#mail-detail-view:not(.hidden)");
    await page.fill("#quick-reply-text", "Reply identity regression.");
    await page.click("#send-quick-reply-btn");
    await waitForCondition(() => page.locator("#send-quick-reply-btn").isEnabled());

    assert.equal(sentPayloads.length, 1);
    assert.equal(repliedPayloads.length, 1);
    assert.equal(sentPayloads[0].from, "user");
    assert.equal(repliedPayloads[0].from, "user");

    await page.click("#user-profile-btn");
    await page.click('.account-item-btn[data-handle="range"]');
    await waitForText(page.locator("#reply-as-user"), "range");
    await page.click("#user-profile-btn");
    await page.click('.account-item-btn[data-handle="all"]');
    await waitForText(page.locator("#reply-as-user"), "user");
    await page.click("#open-compose-btn");
    assert.equal(await page.locator("#compose-from").inputValue(), "user");
    await page.click("#close-compose-btn");

    await page.click("#nav-view-board");
    await page.waitForSelector("#board-view-section:not(.hidden)");
    await waitForText(page.locator("#stat-total"), "2");
    await page.click("#open-new-task-btn");
    assert.equal(await page.locator("#task-owner-select").inputValue(), "user");
    assert.match(await page.locator("#task-owner-tip").textContent(), /no claimed or blocked/);
    await page.locator("#task-owner-select").selectOption("range");
    const ownerTip = await page.locator("#task-owner-tip").textContent();
    assert.match(ownerTip, /1 claimed and 1 blocked/);
    assert.match(ownerTip, /Refresh arena v4/);
    assert.equal(await page.locator("#task-owner-tip").evaluate((element) => element.classList.contains("warning")), true);
    await page.locator("#task-owner-select").selectOption("user");
    await page.fill("#task-title-input", "God Mode ownership regression");
    await page.fill("#task-desc-input", "The task must remain owned by the human operator in God Mode.");
    await page.click("#save-task-btn");
    await page.locator("#task-modal-backdrop").waitFor({ state: "hidden" });
    assert.equal(taskPayloads.length, 1);
    assert.deepEqual(taskPayloads[0], {
      title: "God Mode ownership regression",
      owner: "user",
      status: "backlog",
      description: "The task must remain owned by the human operator in God Mode.",
      notify: false,
      from: "user",
    });

    const staticResponse = await fetch(`${fixture.baseUrl}/app.js?v=4`);
    assert.equal(staticResponse.status, 200);
    assert.match(staticResponse.headers.get("cache-control") || "", /no-store/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
    await fixture.close();
  }
});
