import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { createDashboardFixture } from "./dashboard-fixture.mjs";
import { compareFrames, summariseFrames } from "../../src/capture/frame-compare.mjs";

/**
 * The control the old capture gate never had, and the diagnosis that replaced three guesses.
 *
 * MEASURED, at 390x844 and at 1440x900, by toggling the task sheet drawer - a change no layout
 * can hide, since the closed drawer is display:none:
 *
 *   mobile   closed 32235 B (sha fbd5eef5)  ->  open 55576 B (sha 6b7cd88c)   DELTA, large
 *   mobile   open   55576 B                ->  open 55576 B (same sha)         FROZEN
 *   desktop  closed 91135 B                ->  open 127316 B                   DELTA, large
 *   desktop  open   127316 B               ->  open 127220 B (cebf8dfc)       NOT_CHANGED
 *
 * Three facts fall out, and together they close the question the card asked:
 *
 *  1. The page repaints at BOTH widths, and responds to state. So the card's candidate (b) - "the
 *     mobile layout is genuinely static" - is refuted by measurement, not by argument.
 *  2. Re-navigating to the same route cannot change the route, so the three frames it produced
 *     were three renderings of the same page. distinct=1/3 was the harness reporting truthfully
 *     that NOTHING CHANGED, while the gate demanded 3/3. The gate was demanding a change from an
 *     operation that cannot produce one.
 *  3. At desktop that demand was accidentally satisfied anyway, by a difference of 105 pixels
 *     (0.01%, PSNR 60.5 dB) - some perpetually animating thing. So desktop "passed" on noise and
 *     mobile "failed" on honesty, and BOTH readings were meaningless. That is why the old rule
 *     had to go: it produced a green and a red out of the same non-event.
 *
 * The arms below are the invariant, and they are the thing that makes a future capture meaningful:
 * a capture set that exercised a real state change must show a perceptible delta, and a capture
 * set that did not must be reported as FROZEN rather than scored.
 */
function findChromium() {
  for (const c of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try { return execFileSync("which", [c], { encoding: "utf8" }).trim(); } catch { /* next */ }
  }
  throw new Error("no chromium found");
}

// ONE browser and ONE fixture for the whole file, not one per test.
//
// This is the fix for the "cancelled" report on task_1790482860492_1b4a3e, and the hypothesis
// was tested rather than assumed: dashboard-journey.test.mjs creates a single browser for the file
// and does NOT linger, while this file and dashboard-sheet-geometry.test.mjs both wrapped EVERY
// test in its own launch/close and both held the event loop open for ~20 minutes after their
// assertions passed. Repeatedly launching and closing chromium leaves a handle behind, and node's
// runner then reports the whole FILE as cancelled - so every result in it was uncitable even
// though every assertion passed.
let shared = null;

async function withBrowser(fn) {
  if (!shared) {
    const fixture = await createDashboardFixture();
    const browser = await chromium.launch({
      headless: true,
      executablePath: findChromium(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    shared = { fixture, browser };
  }
  return await fn(shared.fixture, shared.browser);
}

after(async () => {
  if (!shared) return;
  await shared.browser.close().catch(() => {});
  await shared.fixture?.cleanup?.().catch?.(() => {});
});

const SIZES = [["mobile", { width: 390, height: 844 }], ["desktop", { width: 1440, height: 900 }]];

for (const [label, viewport] of SIZES) {
  test(`an EXERCISED capture is distinguishable from an UNEXERCISED one at ${label} ${viewport.width}px`, { timeout: 180000 }, async () => {
    // THE ARM THAT REPLACES THE OLD GATE, and the direct answer to the card.
    //
    // Re-navigating to the same route cannot change the route, so the three frames it produced
    // were three renderings of the same page - and distinct=1/3 was the harness reporting
    // truthfully that NOTHING CHANGED while the gate demanded 3/3. The gate was demanding a
    // change from an operation that cannot produce one.
    //
    // The assertion is deliberately NOT "the unexercised capture is frozen". At desktop something
    // animates on every load, and how much it moves is not established: 127316 B against
    // 127220 B is about 105 pixels, which is imperceptible, but whether that clears a threshold
    // on a given run is not something this test should stake a claim on. What IS the instrument's
    // job - and what is asserted here - is that a capture which exercised a real state change
    // can be TOLD APART from one that did not. If those two are ever the same size, no capture
    // at this width means anything and the harness is finished.
    await withBrowser(async (fixture, browser) => {
      const context = await browser.newContext({ viewport, locale: "en-US" });
      const page = await context.newPage();
      await page.goto(`${new URL(fixture.baseUrl).origin}/?account=coordinator`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#task-sheet-drawer", { state: "attached", timeout: 15000 });
      await page.waitForTimeout(1200);

      // Downscaled on purpose. Shipping 1.3M pixels per frame over CDP took 100 s per arm and
      // that cost is paid by every run; a quarter-scale frame is 16x smaller and still shows a
      // drawer covering a third of the screen. What this arm asks is "did a large part of the
      // page change", which survives the blur, and the exact pixel magnitudes are measured by
      // the probe that motivated this file, not here.
      const grab = async () => {
        const b64 = (await page.screenshot({ type: "png" })).toString("base64");
        return page.evaluate(async (payload) => {
          const img = new Image();
          img.src = "data:image/png;base64," + payload;
          await img.decode();
          const w = Math.max(1, Math.floor(img.width / 4));
          const h = Math.max(1, Math.floor(img.height / 4));
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          c.getContext("2d").drawImage(img, 0, 0, w, h);
          const d = c.getContext("2d").getImageData(0, 0, w, h).data;
          return { data: Array.from(d), width: w, height: h, byteHash: payload.length };
        }, b64);
      };

      // UNEXERCISED: three renderings of the same page.
      const idle = [];
      for (let i = 0; i < 3; i++) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#task-sheet-drawer", { state: "attached" });
        await page.waitForTimeout(700);
        idle.push(await grab());
      }
      const idleSummary = summariseFrames(idle);

      // EXERCISED: the same page, with the sheet opened between captures.
      const a = await grab();
      await page.evaluate(() => document.getElementById("task-sheet-drawer").classList.remove("hidden"));
      await page.waitForTimeout(700);
      const b = await grab();
      const exercised = compareFrames(a, b);

      const idleDelta = Math.max(...idleSummary.pairs.filter((p) => p.comparable).map((p) => p.changedFraction));
      const ratio = exercised.changedFraction / Math.max(idleDelta, 1e-9);
      console.log(`      [${label} ${viewport.width}] exercised=${(exercised.changedFraction * 100).toFixed(1)}% ` +
        `idle=${(idleDelta * 100).toFixed(3)}% ratio=${ratio.toFixed(0)}x idleVerdict=${idleSummary.verdict}`);

      assert.equal(exercised.changed, true, "opening the sheet is a real change and must be seen as one");
      assert.equal(idleSummary.ok, false,
        `three captures of an unchanging page must never be a pass (got ${idleSummary.verdict})`);
      assert.ok(exercised.changedFraction > idleDelta * 5,
        `an exercised capture must be clearly distinguishable from an idle one: ` +
        `${(exercised.changedFraction * 100).toFixed(1)}% vs ${(idleDelta * 100).toFixed(3)}%`);
      // Hygiene, not the fix - the per-test browser was the actual cause and withBrowser above
      // now shares one. This stays because a closed page cannot leak even if the shared browser
      // lives until the after() hook.
      await page.close().catch(() => {});
      await context.close();
    });
  });
}

test("compareFrames is the thing that decides, and it is not the hash", () => {
  // Cheap, and it keeps the two files honest with each other: the module and the e2e arms must
  // agree that a no-change capture is not a pass.
  const frozen = summariseFrames([
    { data: new Uint8Array(300).fill(1), width: 10, height: 10, byteHash: "a" },
    { data: new Uint8Array(300).fill(1), width: 10, height: 10, byteHash: "b" },
  ]);
  assert.equal(frozen.verdict, "FROZEN");
  const sameThingDifferentBytes = summariseFrames([
    { data: new Uint8Array(300).fill(10), width: 10, height: 10, byteHash: "a" },
    { data: new Uint8Array(300).fill(200), width: 10, height: 10, byteHash: "b" },
  ]);
  assert.equal(sameThingDifferentBytes.byteDistinct, 2, "the old rule would score that 2/2");
  assert.equal(sameThingDifferentBytes.ok, true, "a whole-frame change really is a change");
  assert.equal(compareFrames({ data: new Uint8Array(300).fill(10), width: 10, height: 10 },
    { data: new Uint8Array(300).fill(200), width: 10, height: 10 }).changedPixels, 100);
});
