import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

async function preparePage(browser, baseUrl, options, errors) {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: options.deviceScaleFactor || 1,
    isMobile: Boolean(options.isMobile),
    hasTouch: Boolean(options.hasTouch),
    timezoneId: "UTC",
    locale: "en-US",
    colorScheme: "light",
  });
  const page = await context.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.presence-item[data-agent-handle="range"]', { timeout: 15000 });
  return { context, page };
}

async function screenshot(page, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath, fullPage: false });
}

test("AGmail desktop and mobile activity journeys", { timeout: 120000 }, async () => {
  const artifactRoot = path.resolve(process.env.E2E_ARTIFACT_DIR || "artifacts/e2e");
  const fixture = await createDashboardFixture();
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const errors = [];
  const artifacts = [];
  let desktopContext;
  let mobileContext;
  let compactContext;
  let failure = null;
  let sidebarGeometry = null;

  try {
    const agents = await fetch(`${fixture.baseUrl}/api/agents`).then((response) => response.json());
    const range = agents.find((agent) => agent.handle === "range");
    assert.equal(
      range?.herdrStatus,
      "working",
      `Expected range herdrStatus=working; received ${JSON.stringify(range)}`
    );
    assert.equal(
      range?.herdrActivity?.stateLabels?.working,
      "Implementing arena refresh",
      `Unexpected range activity: ${JSON.stringify(range?.herdrActivity)}`
    );
    assert.deepEqual(
      range?.herdrActivity?.tokens,
      ["Gunsmith integration", "Final gate pending"],
      `Unexpected range tokens: ${JSON.stringify(range?.herdrActivity?.tokens)}`
    );
    assert.equal(range.status, "working", `Unexpected range status: ${JSON.stringify(range?.status)}`);
    assert.equal(range.runtimeModel, "opencode/space-bunny-free (max)", `Unexpected range model: ${JSON.stringify(range?.runtimeModel)}`);
    assert.equal(range.modelSource, "herdr-record", `Unexpected range model source: ${JSON.stringify(range?.modelSource)}`);

    const desktopPrepared = await preparePage(browser, fixture.baseUrl, { width: 1440, height: 900, deviceScaleFactor: 1 }, errors);
    desktopContext = desktopPrepared.context;
    const desktop = desktopPrepared.page;
    await desktop.click("#user-profile-btn");
    await desktop.waitForSelector("#account-dropdown:not(.hidden)");
    const hierarchy = await desktop.$eval('.account-item-btn[data-handle="range"]', (button) => {
      const name = button.querySelector(".account-item-name");
      const role = button.querySelector(".account-item-role");
      const address = button.querySelector(".account-item-address");
      const nameStyle = getComputedStyle(name);
      const roleStyle = getComputedStyle(role);
      return {
        nameText: name.textContent,
        roleText: role.textContent,
        addressText: address.textContent,
        nameSize: Number.parseFloat(nameStyle.fontSize),
        roleSize: Number.parseFloat(roleStyle.fontSize),
        nameWeight: Number.parseInt(nameStyle.fontWeight, 10),
        roleWeight: Number.parseInt(roleStyle.fontWeight, 10),
      };
    });
    assert.equal(hierarchy.nameText, "Range Owner");
    assert.equal(hierarchy.roleText, "Shooting range systems engineer");
    assert.equal(hierarchy.addressText, "range@amq");
    assert.ok(hierarchy.nameSize > hierarchy.roleSize);
    assert.ok(hierarchy.nameWeight > hierarchy.roleWeight);
    const accountArtifact = path.join(artifactRoot, "desktop", "account-hierarchy.png");
    await screenshot(desktop, accountArtifact);
    artifacts.push(accountArtifact);

    await desktop.click("#user-profile-btn");
    const initialPresenceOrder = await desktop.$$eval(".presence-item", (items) => items.map((item) => item.dataset.agentHandle));
    assert.deepEqual(initialPresenceOrder, ["user", "qa", "range"]);
    assert.equal(await desktop.locator('.presence-item[data-agent-handle="qa"] .presence-status-pill').textContent(), "Idle");
    assert.equal(await desktop.locator('.presence-item[data-agent-handle="qa"] .presence-status-pill').getAttribute("title"), "Turn ended · ready for input");
    assert.equal(await desktop.locator('.presence-item[data-agent-handle="range"] .presence-status-pill').textContent(), "Working");
    assert.equal(await desktop.locator('.presence-item[data-agent-handle="range"] .presence-status-pill').getAttribute("title"), "Active turn");

    await desktop.click("#user-profile-btn");
    await desktop.click('.account-item-btn[data-handle="qa"]');
    await desktop.locator("#header-account-label", { hasText: "Quality Auditor" }).waitFor({ state: "visible" });
    const activePresenceOrder = await desktop.$$eval(".presence-item", (items) => items.map((item) => item.dataset.agentHandle));
    assert.equal(activePresenceOrder[0], "qa");
    assert.equal(await desktop.locator('.presence-item[data-agent-handle="qa"]').getAttribute("aria-current"), "true");
    assert.equal(await desktop.locator('.presence-item[data-agent-handle="range"]').getAttribute("aria-current"), "false");

    await desktop.click("#user-profile-btn");
    await desktop.click('.account-item-btn[data-handle="range"]');
    await desktop.locator("#header-account-label", { hasText: "Range Owner" }).waitFor({ state: "visible" });

    // Unified Panes view: status + task + latest report + live tail per lane.
    await desktop.click("#nav-view-panes");
    await desktop.waitForSelector("#panes-view-section:not(.hidden)");
    await desktop.locator(".pane-card").first().waitFor({ state: "visible", timeout: 15000 });
    assert.ok((await desktop.locator(".pane-card").count()) >= 3);
    await desktop.waitForFunction(
      () => [...document.querySelectorAll(".pane-card-output")].some((el) => el.textContent && !el.textContent.includes("Reading live pane")),
      { timeout: 20000 }
    );
    const rangeCard = desktop.locator('.pane-card[data-pane-handle="range"]');
    await rangeCard.waitFor({ state: "visible" });
    assert.match(await rangeCard.locator(".presence-status-pill").textContent(), /Working|Idle/);
    assert.ok(((await rangeCard.locator(".pane-card-output").textContent()) || "").length > 0);
    // Terminal-style: no wrapping, type autofits the longest line.
    assert.equal(await rangeCard.locator(".pane-card-output").evaluate((el) => getComputedStyle(el).whiteSpace), "pre");
    const panesArtifact = path.join(artifactRoot, "desktop", "panes-view.png");
    await screenshot(desktop, panesArtifact);
    artifacts.push(panesArtifact);
    await rangeCard.locator('[data-pane-action="message"]').click();
    await desktop.waitForSelector("#compose-modal:not(.hidden)");
    assert.equal(await desktop.locator("#compose-to").inputValue(), "range");
    assert.match(await desktop.locator("#compose-subject").inputValue(), /Status check: Range Owner/);
    await desktop.click("#close-compose-btn");
    await desktop.click("#nav-view-mail");

    // Sidebar click focuses the Panes view on that single lane, fullscreen.
    await desktop.click('.presence-item[data-agent-handle="range"]');
    await desktop.waitForSelector("#panes-view-section:not(.hidden)");
    await desktop.locator(".pane-card").first().waitFor({ state: "visible", timeout: 15000 });
    assert.equal(await desktop.locator(".pane-card").count(), 1);
    assert.ok(await desktop.locator("#panes-focus-banner:not(.hidden)").isVisible());
    assert.match(await desktop.locator("#panes-focus-name").textContent(), /range/);
    const focusArtifact = path.join(artifactRoot, "desktop", "panes-focus.png");
    await screenshot(desktop, focusArtifact);
    artifacts.push(focusArtifact);
    // Lines selector changes the snapshot height (the meaningful "resize").
    await desktop.locator("#panes-lines-select").selectOption("100");
    await desktop.waitForTimeout(1500);

    // Full activity dialog still opens from the focused card.
    await desktop.locator('.pane-card[data-pane-handle="range"] [data-pane-action="activity"]').click();
    await desktop.waitForSelector("#agent-activity-dialog[open]");
    await desktop.locator("#view-agent-task-btn").waitFor({ state: "visible" });
    const activity = await desktop.$eval("#agent-activity-dialog", (dialog) => ({
      status: dialog.querySelector("#agent-activity-status").textContent,
      headline: dialog.querySelector("#agent-activity-headline").textContent,
      task: dialog.querySelector("#agent-activity-task").textContent,
      taskStatus: dialog.querySelector("#agent-activity-task-status").textContent,
      pane: dialog.querySelector("#agent-activity-pane").textContent,
    }));
    assert.deepEqual(activity, {
      status: "Working",
      headline: "Implementing arena refresh",
      task: "Refresh arena v4 with integrated Gunsmith",
      taskStatus: "in progress",
      pane: "pane-range",
    });
    const desktopActivityArtifact = path.join(artifactRoot, "desktop", "agent-activity.png");
    await screenshot(desktop, desktopActivityArtifact);
    artifacts.push(desktopActivityArtifact);

    // Messenger-style detail: live pane tail appended to the activity card.
    await desktop.locator("#agent-activity-pane-output").waitFor({ state: "visible", timeout: 15000 });
    await desktop.waitForFunction(
      () => !document.getElementById("agent-activity-pane-output")?.textContent?.includes("Reading live pane"),
      { timeout: 15000 }
    );
    const paneText = await desktop.$eval("#agent-activity-pane-output", (el) => el.textContent);
    assert.ok(paneText.length > 0, "pane tail resolves to output or an unavailable note, never a stuck loader");
    const paneBox = await desktop.$eval("#agent-activity-pane-output", (el) => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, innerWidth: window.innerWidth };
    });
    assert.ok(paneBox.width <= paneBox.innerWidth);
    const desktopPaneArtifact = path.join(artifactRoot, "desktop", "agent-pane.png");
    await screenshot(desktop, desktopPaneArtifact);
    artifacts.push(desktopPaneArtifact);

    await desktop.click("#view-agent-task-btn");
    await desktop.waitForSelector("#task-sheet-drawer:not(.hidden)");
    const taskTitle = await desktop.$eval("#sheet-task-title", (element) => element.textContent);
    assert.equal(taskTitle, "Refresh arena v4 with integrated Gunsmith");
    const desktopTaskArtifact = path.join(artifactRoot, "desktop", "agent-task.png");
    await screenshot(desktop, desktopTaskArtifact);
    artifacts.push(desktopTaskArtifact);
    await desktop.click("#close-task-sheet-btn");
    await desktop.click("#nav-view-mail");
    await desktop.waitForSelector("#mail-view-section:not(.hidden)");
    await desktop.click("#user-profile-btn");
    await desktop.click('.account-item-btn[data-handle="range"]');
    assert.equal(await desktop.locator("#reply-as-user").textContent(), "range");
    await desktop.click(".mail-row");
    await desktop.waitForSelector("#mail-detail-view:not(.hidden)");
    await desktop.waitForTimeout(150);
    const messagePosition = await desktop.$eval("#mail-detail-view", (detail) => {
      const header = detail.querySelector(".detail-header");
      const latest = detail.querySelector(".thread-card.expanded");
      const detailRect = detail.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const latestRect = latest.getBoundingClientRect();
      return {
        scrollTop: detail.scrollTop,
        headerPosition: getComputedStyle(header).position,
        headerOffset: headerRect.top - detailRect.top,
        latestOffset: latestRect.top - headerRect.bottom,
        latestId: latest.dataset.msgId,
      };
    });
    assert.ok(messagePosition.scrollTop > 0);
    assert.equal(messagePosition.headerPosition, "sticky");
    assert.ok(Math.abs(messagePosition.headerOffset) <= 1);
    assert.ok(messagePosition.latestOffset >= 0 && messagePosition.latestOffset <= 24);
    assert.equal(messagePosition.latestId, "2026-09-24T08-05-00-000Z_fixture-message-3");
    await desktop.$eval("body", () => {
      const dispatchTouch = (type, clientY) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientY }] });
        document.dispatchEvent(event);
      };
      dispatchTouch("touchstart", 100);
      dispatchTouch("touchmove", 220);
      dispatchTouch("touchend", 220);
    });
    await desktop.waitForTimeout(50);
    const pullGuard = await desktop.$eval("#pull-to-refresh", (indicator) => ({
      classes: indicator.className,
      label: indicator.querySelector(".ptr-label")?.textContent,
    }));
    assert.equal(pullGuard.classes.includes("ready"), false);
    assert.equal(pullGuard.classes.includes("refreshing"), false);
    const desktopMessageArtifact = path.join(artifactRoot, "desktop", "latest-message.png");
    await screenshot(desktop, desktopMessageArtifact);
    artifacts.push(desktopMessageArtifact);

    fixture.herdr.setAgents([
      {
        name: "range",
        agent: "opencode",
        model: { id: "space-bunny-free", providerID: "opencode", variant: "max" },
        agent_session: { agent: "opencode", source: "herdr:opencode", value: "ses_e2e_range_fixture" },
        agent_status: "idle",
        pane_id: "pane-range",
        workspace_id: "workspace-range",
        terminal_title_stripped: "QA handoff complete",
        state_labels: { idle: "Waiting for the next gate" },
        tokens: [],
        state_change_seq: 43,
        interactive_ready: true,
      },
      {
        name: "qa",
        agent: "opencode",
        model: { id: "space-bunny-free", providerID: "opencode", variant: "max" },
        agent_session: { agent: "opencode", source: "herdr:opencode", value: "ses_e2e_qa_fixture" },
        agent_status: "idle",
        pane_id: "pane-qa",
        workspace_id: "workspace-qa",
        terminal_title_stripped: "QA console",
        state_labels: { idle: "Reviewing verification evidence" },
        tokens: [],
        state_change_seq: 12,
        interactive_ready: true,
      },
    ]);
    fixture.herdr.emit({
      type: "pane_agent_status_changed",
      name: "range",
      pane_id: "pane-range",
      workspace_id: "workspace-range",
      agent_status: "idle",
      state_labels: { idle: "Waiting for the next gate" },
    });
    await desktop.locator('.presence-item[data-agent-handle="range"] .presence-status-pill', { hasText: "Idle" }).waitFor({ state: "visible", timeout: 10000 });
    const stablePresenceOrder = await desktop.$$eval(".presence-item", (items) => items.map((item) => item.dataset.agentHandle));
    assert.deepEqual(stablePresenceOrder, ["range", "user", "qa"]);

    const mobilePrepared = await preparePage(browser, fixture.baseUrl, { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, errors);
    mobileContext = mobilePrepared.context;
    const mobile = mobilePrepared.page;
    await mobile.tap("#toggle-sidebar");
    await mobile.locator("body.sidebar-open").waitFor({ state: "attached" });
    await mobile.waitForTimeout(350);
    sidebarGeometry = await mobile.$eval("#sidebar", (sidebar) => {
      const rect = sidebar.getBoundingClientRect();
      return {
        width: rect.width,
        left: rect.left,
        right: rect.right,
        innerWidth: window.innerWidth,
        scrollX: window.scrollX,
        devicePixelRatio: window.devicePixelRatio,
      };
    });
    assert.equal(sidebarGeometry.innerWidth, 390);
    assert.equal(sidebarGeometry.scrollX, 0);
    assert.equal(Math.round(sidebarGeometry.width), 280);
    assert.equal(Math.round(sidebarGeometry.left), 0);
    const mobileSidebarArtifact = path.join(artifactRoot, "mobile", "agent-list.png");
    await screenshot(mobile, mobileSidebarArtifact);
    artifacts.push(mobileSidebarArtifact);
    await mobile.tap('.presence-item[data-agent-handle="range"]');
    // Mobile focus: single fullscreen-width pane card, no overflow.
    await mobile.waitForSelector("#panes-view-section:not(.hidden)");
    await mobile.locator(".pane-card").first().waitFor({ state: "visible", timeout: 15000 });
    assert.equal(await mobile.locator(".pane-card").count(), 1);
    const mobileFocusBox = await mobile.$eval(".pane-card", (el) => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, innerWidth: window.innerWidth };
    });
    assert.ok(mobileFocusBox.width <= mobileFocusBox.innerWidth);
    const mobileFocusArtifact = path.join(artifactRoot, "mobile", "panes-focus.png");
    await screenshot(mobile, mobileFocusArtifact);
    artifacts.push(mobileFocusArtifact);
    // Full dialog from the focused card's Activity action.
    await mobile.tap('.pane-card[data-pane-handle="range"] [data-pane-action="activity"]');
    await mobile.waitForSelector("#agent-activity-dialog[open]");
    const mobileDialog = await mobile.$eval("#agent-activity-dialog", (dialog) => {
      const rect = dialog.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
        position: getComputedStyle(dialog).position,
        status: dialog.querySelector("#agent-activity-status").textContent,
      };
    });
    assert.equal(mobileDialog.position, "fixed");
    assert.ok(mobileDialog.width <= 390);
    assert.ok(mobileDialog.height <= 844);
    assert.ok(Math.abs(mobileDialog.bottom - 844) < 2);
    assert.equal(mobileDialog.status, "Idle");
    const mobileActivityArtifact = path.join(artifactRoot, "mobile", "agent-activity.png");
    await screenshot(mobile, mobileActivityArtifact);
    artifacts.push(mobileActivityArtifact);
    // Mobile messenger detail: pane tail fits the narrow dialog, no overflow.
    await mobile.locator("#agent-activity-pane-output").waitFor({ state: "visible", timeout: 15000 });
    await mobile.waitForFunction(
      () => !document.getElementById("agent-activity-pane-output")?.textContent?.includes("Reading live pane"),
      { timeout: 15000 }
    );
    const mobilePaneBox = await mobile.$eval("#agent-activity-pane-output", (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return { width: rect.width, whiteSpace: style.whiteSpace, overflowX: style.overflowX };
    });
    assert.ok(mobilePaneBox.width <= 390);
    // Terminal semantics: never wrap (autofit shrinks type; extremes scroll).
    assert.equal(mobilePaneBox.whiteSpace, "pre");
    assert.ok(["auto", "scroll"].includes(mobilePaneBox.overflowX));
    await mobile.tap("#view-agent-inbox-btn");
    await mobile.locator("#header-account-label", { hasText: "Range Owner" }).waitFor({ state: "attached" });
    assert.equal(await mobile.$eval("body", (body) => body.classList.contains("sidebar-open")), false);
    await mobile.waitForTimeout(350);
    await mobile.waitForSelector(".mail-row", { timeout: 10000 });
    const mobileInboxArtifact = path.join(artifactRoot, "mobile", "range-inbox.png");
    await screenshot(mobile, mobileInboxArtifact);
    artifacts.push(mobileInboxArtifact);
    await mobile.tap(".mail-row");
    await mobile.waitForSelector("#mail-detail-view:not(.hidden)");
    await mobile.waitForTimeout(150);
    const mobileMessage = await mobile.$eval("#mail-detail-view", (detail) => ({
      activeId: document.activeElement?.dataset?.msgId || "",
      activeIsMessage: document.activeElement?.classList.contains("thread-card") || false,
      backDisplay: getComputedStyle(detail.querySelector("#back-to-list-btn")).display,
      headerPosition: getComputedStyle(detail.querySelector(".detail-header")).position,
      scrollTop: detail.scrollTop,
    }));
    assert.equal(mobileMessage.activeIsMessage, true);
    assert.equal(mobileMessage.activeId, "2026-09-24T08-05-00-000Z_fixture-message-3");
    assert.equal(mobileMessage.backDisplay, "flex");
    assert.equal(mobileMessage.headerPosition, "sticky");
    assert.ok(mobileMessage.scrollTop > 0);
    const mobileMessageArtifact = path.join(artifactRoot, "mobile", "latest-message.png");
    await screenshot(mobile, mobileMessageArtifact);
    artifacts.push(mobileMessageArtifact);
    await mobile.tap("#back-to-list-btn");
    await mobile.locator("#mail-detail-view.hidden").waitFor({ state: "attached" });

    const compactPrepared = await preparePage(browser, fixture.baseUrl, { width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, errors);
    compactContext = compactPrepared.context;
    const compact = compactPrepared.page;
    await compact.tap("#toggle-sidebar");
    await compact.locator("body.sidebar-open").waitFor({ state: "attached" });
    await compact.waitForTimeout(350);
    await compact.tap("#nav-view-board");
    await compact.waitForSelector("#board-view-section:not(.hidden)");
    await compact.tap("#open-new-task-btn");
    await compact.waitForSelector("#task-modal-backdrop:not(.hidden)");
    const compactTaskActions = await compact.$eval("#new-task-form", (form) => {
      const actions = form.querySelector(".agent-modal-actions");
      const buttons = [...actions.querySelectorAll("button")];
      return {
        position: getComputedStyle(actions).position,
        formClientWidth: form.clientWidth,
        formScrollWidth: form.scrollWidth,
        actionsRect: actions.getBoundingClientRect().toJSON(),
        buttons: buttons.map((button) => ({
          text: button.textContent.trim(),
          visible: button.getBoundingClientRect().top >= 0 && button.getBoundingClientRect().bottom <= window.innerHeight,
        })),
      };
    });
    assert.equal(compactTaskActions.position, "sticky");
    assert.ok(compactTaskActions.formScrollWidth <= compactTaskActions.formClientWidth);
    assert.ok(compactTaskActions.actionsRect.bottom <= 568);
    assert.equal(compactTaskActions.buttons.every((button) => button.visible), true);
    const compactTaskArtifact = path.join(artifactRoot, "mobile", "new-task-actions.png");
    await screenshot(compact, compactTaskArtifact);
    artifacts.push(compactTaskArtifact);

    assert.deepEqual(errors, [], `Browser console/page errors:\n${errors.join("\n")}`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    const recordCleanupError = (label, error) => {
      cleanupErrors.push(`${label}: ${error?.message || String(error)}`);
    };
    const closeResource = async (label, resource) => {
      if (!resource) return;
      try {
        await resource.close();
      } catch (error) {
        recordCleanupError(label, error);
      }
    };

    let browserVersion = null;
    try {
      browserVersion = browser.version();
    } catch (error) {
      recordCleanupError("browser-version", error);
    }

    await closeResource("compactContext", compactContext);
    await closeResource("mobileContext", mobileContext);
    await closeResource("desktopContext", desktopContext);
    await closeResource("browser", browser);
    await closeResource("fixture", fixture);

    try {
      const report = {
        ok: !failure,
        browser: browserVersion,
        baseUrl: fixture.baseUrl,
        viewports: { desktop: "1440x900", mobile: "390x844", compact: "320x568" },
        sidebarGeometry,
        journeys: ["account-hierarchy", "agent-activity", "agent-task", "latest-message", "pull-refresh-guard", "live-status-refresh", "mobile-agent-list", "mobile-inbox", "mobile-new-task-actions"],
        artifacts,
        errors,
        failure: failure
          ? { name: failure.name, message: failure.message, stack: failure.stack }
          : null,
        cleanupErrors,
      };
      fs.mkdirSync(artifactRoot, { recursive: true });
      fs.writeFileSync(path.join(artifactRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch (error) {
      recordCleanupError("report", error);
    }

    if (failure) {
      failure.cleanupErrors = cleanupErrors;
      throw failure;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "E2E cleanup failed");
    }
  }
});
