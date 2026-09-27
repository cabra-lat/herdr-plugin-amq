import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { createDashboardFixture } from "./dashboard-fixture.mjs";

/**
 * The closed task sheet, and what the 856px overflow report actually was.
 *
 * spotter measured, at 00:05Z, and reported as two findings:
 *   1. all three [data-tab] elements outside the viewport AND hidden, at 390x844
 *      (x=409/528/648) and 1440x900 (x=1469/1745/2021), so "a reader cannot get to
 *      two-thirds of the board's own tabs"
 *   2. the task detail sheet overflowing a 1440px viewport by 856px, .task-sheet-card named as
 *      the offender, "a panel about 2296px wide on a 1440px screen"
 *
 * ONE ARTIFACT, AND THE ARITHMETIC NAMES IT. The tab bar (index.html:846) is inside the drawer
 * (index.html:777), which ships `class="hidden"`. The closed drawer was
 *     width: min(880px, 95vw)      -> 880px at 1440, spanning x=560..1440
 *     transform: translateX(100%)  -> +880px, so the box sits at x=1440..2320
 *     visibility: hidden           -> not painted
 * Measured independently here: `aside.task-sheet-drawer hidden` at left=1440 right=2320
 * width=880. x=1469 is 29px into that box. The 856px "overflow" is the same box from the far end.
 *
 * SO THE CORRECTION, and it is the useful half: those are the SHEET's own tabs (all / desc /
 * transmissions), reachable by opening any card, not board navigation — and the painted box was
 * EMPTY both before and after any change. No reader ever saw an 856px overflow. Arm B below
 * asserts that, and it passes against the unfixed CSS, which is the whole point of it.
 *
 * What was NOT an artifact: the closed drawer was still in the box tree, still 880x100vh, and
 * still measurable, so every rect-based audit of this UI read 880px of overflow on every route
 * including routes with no card open. The same class of false reading is what produced the
 * original report, so leaving it in place guarantees the next one. Arm A is the fix and it is
 * red/green; the CSS now uses `display: none` for the closed state, with the slide-in preserved
 * as a keyframe animation because a transition cannot run on an element that is not rendered.
 *
 * The slide-out animation is deliberately given up: there is no way to animate a box out of a
 * layout that must not contain it, and a decorative exit is not worth a permanent false
 * measurement. That is a real, visible trade and it is stated rather than buried.
 *
 * A NOTE ON THE FIRST TWO VERSIONS OF THIS FILE, because they are the same mistake twice:
 *   v1 measured `rect.right > innerWidth` — what spotter measured — and I called the result a
 *      real standing overflow before checking whether anyone could see it.
 *   v2 tried to correct that with a "clipped by an ancestor" test and passed against the
 *      UNFIXED css, because `position: fixed` elements are not clipped by an ancestor's
 *      overflow at all: their containing block is the viewport. The arm was vacuous, and a vacuous
 *      arm is worse than a wrong one because it reads as coverage.
 * Arm A below asserts the structural fact directly instead of inferring it from CSS subtleties.
 */
function findChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  for (const candidate of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      return execFileSync("which", [candidate], { encoding: "utf8" }).trim();
    } catch {}
  }
  throw new Error("Chromium not found. Set CHROMIUM_BIN to a Chrome/Chromium executable.");
}

function seedBoard(amqRoot) {
  const inbox = path.join(amqRoot, "agents", "coordinator", "inbox", "new");
  fs.mkdirSync(inbox, { recursive: true });
  const id = "2026-09-27T00-00-00-000Z_fixture-sheet";
  fs.writeFileSync(
    path.join(inbox, `${id}.md`),
    `---json\n${JSON.stringify({
      schema: 1,
      id,
      from: "coordinator",
      to: ["coordinator"],
      subject: "Sheet geometry probe",
      thread: "agboard/sheet-geometry",
      created: "2026-09-27T00:00:00.000Z",
      kind: "todo",
    }, null, 2)}\n---\nSheet geometry probe.\n`,
    "utf8"
  );
}

/**
 * PAINTED overflow: an element's rect intersected with every ancestor that actually clips.
 * `position: fixed` descendants are exempt from ancestor clipping, because their containing
 * block is the viewport rather than the ancestor — getting that wrong is what made v2 vacuous.
 */
const PAINTED_OVERFLOW_PROBE = `(() => {
  const w = window.innerWidth;
  const out = [];
  const establishesFixedBlock = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.transform !== "none" || cs.filter !== "none" || cs.willChange !== "auto" ||
          (cs.contain && cs.contain !== "none") || cs.perspective !== "none") return p;
    }
    return null;
  };
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (getComputedStyle(el).visibility === "hidden") continue;
    let box = { l: r.left, rt: r.right };
    const fixedBlock = establishesFixedBlock(el);
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p === fixedBlock) break;
      const cs = getComputedStyle(p);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const pr = p.getBoundingClientRect();
        box = { l: Math.max(box.l, pr.left), rt: Math.min(box.rt, pr.right) };
      }
    }
    if (box.rt > w + 1 && box.rt - box.l > 1) {
      out.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 50),
                 paintedLeft: Math.round(box.l), paintedRight: Math.round(box.rt) });
    }
  }
  return { viewport: w, count: out.length, worst: out.sort((a, b) => b.paintedRight - a.paintedRight).slice(0, 5) };
})()`;

async function withBrowser(fn) {
  let fixture = null;
  let browser = null;
  try {
    fixture = await createDashboardFixture();
    seedBoard(fixture.amqRoot);
    browser = await chromium.launch({
      headless: true,
      executablePath: findChromium(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    return await fn(fixture, browser);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fixture?.cleanup) await fixture.cleanup().catch(() => {});
  }
}

const SIZES = [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]];

for (const [label, viewport] of SIZES) {
  test(`the CLOSED sheet occupies no box at ${label} ${viewport.width}px`, { timeout: 120000 }, async () => {
    // THE RED/GREEN ARM. Not an inference about clipping: the closed drawer must simply have no
    // box. Under the old `translateX(100%) + visibility:hidden` it measured 880x100vh at
    // x=1440..2320, and its three tab buttons measured x=1469/1745/2021 — which is where the
    // original report's numbers came from.
    await withBrowser(async (fixture, browser) => {
      const context = await browser.newContext({ viewport, locale: "en-US" });
      const page = await context.newPage();
      await page.goto(`${new URL(fixture.baseUrl).origin}/?account=coordinator`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#task-sheet-drawer", { state: "attached", timeout: 15000 });

      const closed = await page.evaluate(() => {
        const drawer = document.getElementById("task-sheet-drawer");
        const r = drawer.getBoundingClientRect();
        return {
          hasHiddenClass: drawer.classList.contains("hidden"),
          display: getComputedStyle(drawer).display,
          width: Math.round(r.width),
          left: Math.round(r.left),
          tabWidths: [...document.querySelectorAll(".sheet-tab-btn")].map((t) =>
            Math.round(t.getBoundingClientRect().width)
          ),
          sheetCardWidth: Math.round(
            (document.querySelector(".task-sheet-card") || { getBoundingClientRect: () => ({ width: 0 }) })
              .getBoundingClientRect().width
          ),
        };
      });

      assert.ok(closed.hasHiddenClass, "the sheet starts closed");
      assert.equal(closed.width, 0, `a closed sheet must occupy no width (measured ${closed.width}px at x=${closed.left})`);
      assert.equal(closed.sheetCardWidth, 0, "and neither must the card inside it");
      assert.deepEqual(closed.tabWidths, [0, 0, 0], "nor its three tab buttons, which is where x=1469/1745/2021 came from");
      await context.close();
    });
  });

  test(`nothing PAINTED overflows the viewport at ${label} ${viewport.width}px`, { timeout: 120000 }, async () => {
    // THE CORRECTION, asserted. This passes against the UNFIXED css too, and that is the point:
    // the 856px was never painted, so no reader ever saw a broken panel. This arm is the standing
    // reader-facing bar, and it is the one that would catch a real clipping bug.
    await withBrowser(async (fixture, browser) => {
      const context = await browser.newContext({ viewport, locale: "en-US" });
      const page = await context.newPage();
      await page.goto(`${new URL(fixture.baseUrl).origin}/?account=coordinator`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#task-sheet-drawer", { state: "attached", timeout: 15000 });

      const probe = await page.evaluate(PAINTED_OVERFLOW_PROBE);
      assert.equal(probe.count, 0, `painted overflow: ${JSON.stringify(probe.worst, null, 1)}`);
      await context.close();
    });
  });
}

test("the sheet's three tabs are inside the viewport once the sheet is OPEN", { timeout: 120000 }, async () => {
  // The actual answer to the question that was asked. The tabs are the SHEET's tabs, so the
  // assertion is about the open sheet — and it is the arm that catches a regression from making
  // the closed drawer `display: none`.
  await withBrowser(async (fixture, browser) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    const page = await context.newPage();
    await page.goto(`${new URL(fixture.baseUrl).origin}/?account=coordinator`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#task-sheet-drawer", { state: "attached", timeout: 15000 });

    const opened = await page.evaluate(async () => {
      const btn = document.getElementById("task-sheet-open") || document.querySelector("[data-task-id]");
      if (btn) btn.click();
      const drawer = document.getElementById("task-sheet-drawer");
      if (drawer) drawer.classList.remove("hidden");
      // Measuring at t=0 measures the first animation frame, where the panel is still off-screen
      // at translateX(100%). True of a transient frame, false of the panel; a human does not
      // measure at t=0 either.
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
      const w = window.innerWidth;
      return [...document.querySelectorAll(".sheet-tab-btn")].map((t) => {
        const r = t.getBoundingClientRect();
        return {
          tab: t.dataset.tab,
          left: Math.round(r.left),
          right: Math.round(r.right),
          insideViewport: r.left >= 0 && r.right <= w,
          visible: getComputedStyle(t).visibility !== "hidden" && r.width > 0,
        };
      });
    });

    assert.equal(opened.length, 3, `expected 3 sheet tabs, saw ${opened.length}`);
    for (const t of opened) {
      assert.ok(t.visible, `tab ${t.tab} is not visible when the sheet is open`);
      assert.ok(t.insideViewport, `tab ${t.tab} at ${t.left}..${t.right} is outside the 1440px viewport`);
    }
    await context.close();
  });
});
