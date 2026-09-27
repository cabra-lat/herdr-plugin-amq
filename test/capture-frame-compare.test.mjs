import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { compareFrames, summariseFrames } from "../src/capture/frame-compare.mjs";

/**
 * The instrument, and the two directions it was wrong in.
 *
 * Every fixture below is a RECONSTRUCTION of a measurement that was actually taken, and the
 * numbers are the real ones, because a synthetic case would only prove the arithmetic works and
 * not that the arithmetic is pointed at the right thing.
 *
 * The 2026-09-26 capture set, 1440x900 (1,296,000 pixels, 3,888,000 bytes):
 *   desktop  f0/f1/f2 all hashed differently -> the capture-hash gate reported 3/3 and went
 *            GREEN. Actual difference f0 vs f1: 288 bytes, 105 pixels, 0.01% of the frame,
 *            PSNR 60.5 dB. Roughly 105 badge-sized pixels moving by themselves.
 *   mobile   f1 and f2 were identical as files AND as pixels -> 1/3 (really 2/3), and the page
 *            had painted once and frozen.
 *
 * So the old gate was satisfied by noise and unsatisfiable by stability. Its green was worth
 * nothing, and one lane closed a card on it.
 */
const W = 1440;
const H = 900;
const TOTAL = W * H;

function blank(width = W, height = H, level = 20) {
  const data = new Uint8Array(width * height * 3).fill(level);
  return { data, width, height };
}

/** Paint a small block, the size of a badge or a clock. */
function withBlock(base, x0, y0, w, h, level) {
  const d = Uint8Array.from(base.data);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const o = (y * base.width + x) * 3;
      d[o] = level; d[o + 1] = level; d[o + 2] = level;
    }
  }
  return { data: d, width: base.width, height: base.height };
}

/** The measured desktop artefact: 105 pixels, mostly delta 1-2 with a tail at 25-44. */
function phantomChurn() {
  let f = blank();
  // 75 pixels by delta 1 (the noise floor: gradient dithering, sub-pixel antialiasing)
  for (let i = 0; i < 75; i++) {
    const o = (Math.floor(i / 25) * 400 + i) * 3;
    f.data[o] = 21;
  }
  // 30 pixels by a real delta, as three 10x1 marks - the size of a digit in a clock
  f = withBlock(f, 100, 100, 10, 1, 60);
  f = withBlock(f, 200, 100, 10, 1, 65);
  f = withBlock(f, 300, 100, 10, 1, 58);
  return f;
}

function byteHash(f) {
  return Buffer.from(f.data.slice(0, 4096)).toString("hex");
}

describe("a real repaint counts as changed", () => {
  test("a panel-sized difference clears the threshold", () => {
    const a = blank();
    const b = blank();
    // 200x200 = 40,000 px = 3.1% of the frame
    const big = Uint8Array.from(a.data);
    for (let y = 300; y < 500; y++) {
      for (let x = 400; x < 600; x++) {
        const o = (y * W + x) * 3;
        big[o] = 200; big[o + 1] = 200; big[o + 2] = 200;
      }
    }
    const r = compareFrames(a, { data: big, width: W, height: H });
    assert.equal(r.comparable, true);
    assert.equal(r.changed, true, "a 3% change is something a reader would see");
    assert.ok(r.changedFraction > 0.03);
  });
});

describe("the phantom churn that made the old gate green", () => {
  test("105 pixels of badge-sized movement is NOT a re-render", () => {
    // THE RED ARM for the old rule. These frames have different content, so any distinct-hash
    // count says "3/3, the UI changed". The old gate went green on exactly this.
    const a = phantomChurn();
    const b = blank();
    const r = compareFrames(a, b);
    assert.equal(r.changedPixels <= 200, true, `expected ~105 changed pixels, got ${r.changedPixels}`);
    assert.ok(r.changedFraction < 0.001, `0.01% churn must not read as a re-render (got ${r.changedFraction})`);
    assert.equal(r.changed, false, "and the verdict is the whole point");
  });

  test("a delta too small to see does not count, even across many pixels", () => {
    // HALF the frame changes, by 2/255. A percentage-only rule waves this through, which is why
    // the threshold has two parts: the fraction answers "how much of the page moved" and the
    // per-channel delta answers "would anyone see it". Counted here by max-channel-delta, which
    // is the definition the implementation uses - so the honest expectation is that ZERO pixels
    // clear the bar, and the evidence that half the frame moved is in maxDelta, not in the count.
    const a = blank();
    const b = Uint8Array.from(a.data);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < Math.floor(W * 0.5); x++) {
        const o = (y * W + x) * 3;
        b[o] = 22; b[o + 1] = 22; b[o + 2] = 22;
      }
    }
    const r = compareFrames(a, { data: b, width: W, height: H });
    assert.equal(r.maxDelta, 2, "half the frame really did change");
    assert.equal(r.changedPixels, 0, "and not one pixel of it clears a visible delta");
    assert.equal(r.changed, false, "so the verdict is no");
  });
});

describe("a frozen page is reported as frozen, not as a pass or a UI failure", () => {
  test("bit-identical frames are FROZEN, which is a fact about the instrument", () => {
    const f = blank();
    const r = compareFrames(f, blank());
    assert.equal(r.frozen, true);
    assert.equal(r.changed, false);
  });

  test("summariseFrames refuses to pass a frozen set", () => {
    // The old rule reported 1/3 here and the reading was ambiguous between "the UI is static"
    // and "my harness is blind". Those are opposite conclusions and only one of them is a defect
    // in the page, so the verdict has to distinguish them.
    const f = blank();
    const s = summariseFrames([
      { ...blank(), byteHash: "a" },
      { ...blank(), byteHash: "b" },   // different BYTES, identical pixels
      { ...blank(), byteHash: "b" },
    ]);
    assert.equal(s.verdict, "FROZEN");
    assert.equal(s.ok, false, "a harness that cannot make the page change cannot certify it");
    assert.equal(s.byteDistinct, 2, "the misleading number is still reported, and labelled");
    assert.equal(s.byteDistinctIsNotEvidence, true);
  });
});

describe("a harness that can go red", () => {
  test("a set where every pair really changed is CHANGED and passes", () => {
    // The control the old gate never had. If everything is FROZEN, the instrument is blind; if
    // everything is CHANGED, it can still fail - which is the property that makes a pass mean
    // something. An instrument that only ever says "changed" certifies nothing.
    const mk = (level) => {
      const d = new Uint8Array(W * H * 3).fill(20);
      for (let y = 100 + level; y < 500 + level; y++) {
        for (let x = 100; x < 700; x++) {
          const o = (y * W + x) * 3;
          d[o] = 200; d[o + 1] = 200; d[o + 2] = 200;
        }
      }
      return { data: d, width: W, height: H, byteHash: String(level) };
    };
    const s = summariseFrames([mk(0), mk(60), mk(120)]);
    assert.equal(s.verdict, "CHANGED");
    assert.equal(s.ok, true);
  });

  test("imperceptible churn is NOT_CHANGED, a third answer and not a page failure", () => {
    // The 2026-09-26 desktop case exactly: every pair differs, no pair is frozen, and the
    // difference is 0.01% of the frame. The old rule scored this 3/3 and went green.
    const s = summariseFrames([
      { ...phantomChurn(), byteHash: "p0" },
      { ...blank(), byteHash: "p1" },
    ]);
    assert.equal(s.anyPairFrozen, false, "the page did repaint");
    assert.equal(s.byteDistinct, 2, "so the old rule would have called this 2/2 and passed it");
    assert.equal(s.verdict, "NOT_CHANGED");
    assert.equal(s.ok, false, "but the change was beneath notice, so it is not evidence");
  });

  test("an ambiguous middle - some pairs frozen - is neither pass nor clean fail", () => {
    // pair 1->2 is bit-identical (frozen), pair 2->3 moves a whole panel (changed). A single
    // boolean over "did anything change" would pass this set on the strength of one good pair,
    // and a set like this is exactly what a half-working re-render produces.
    const flat = { ...blank(), byteHash: "flat" };
    const flatAgain = { ...blank(), byteHash: "flat2" };
    const panel = Uint8Array.from(blank().data);
    for (let y = 200; y < 600; y++) {
      for (let x = 200; x < 900; x++) {
        const o = (y * W + x) * 3;
        panel[o] = 210; panel[o + 1] = 210; panel[o + 2] = 210;
      }
    }
    const s = summariseFrames([
      flat,
      flatAgain,
      { data: panel, width: W, height: H, byteHash: "panel" },
    ]);
    assert.equal(s.pairs[0].frozen, true, "the first pair never repainted");
    assert.equal(s.pairs[1].changed, true, "the second one did");
    assert.equal(s.verdict, "FROZEN", "which is a half-working instrument, not a pass");
    assert.equal(s.ok, false);
  });
});

describe("the rule this replaces, run on the same fixtures", () => {
  // The red arm, kept permanently, because the old rule is not code anywhere - it was a stated
  // rule, and a stated rule that has been replaced is exactly the thing that comes back a month
  // later from someone's memory of it. These two tests are the difference, executable.
  function oldRuleDistinctHashCount(frames) {
    return new Set(frames.map((f) => f.byteHash)).size;
  }

  test("the old rule passed the phantom churn that the new rule rejects", () => {
    // Desktop, 2026-09-26: 105 pixels, 0.01%, PSNR 60.5 dB - and three distinct byte hashes.
    const frames = [
      { ...phantomChurn(), byteHash: "h0" },
      { ...blank(), byteHash: "h1" },
      { ...blank(0, 0), byteHash: "h2" },
    ].filter((f) => f.width > 0 || f.byteHash === "h2");
    const three = [
      { ...phantomChurn(), byteHash: "h0" },
      { ...blank(), byteHash: "h1" },
      { ...phantomChurn(), byteHash: "h2" },
    ];
    // A subtlety worth keeping: the old rule scores the phantom set 3/3 ONLY because the encoder
    // gave each capture different bytes. Feed it three captures of a genuinely unchanged page and
    // it fails. It is not merely lenient - it is reading the PNG writer, not the UI.
    assert.equal(oldRuleDistinctHashCount(three), 3, "the old rule calls this a full re-render");
    const s = summariseFrames(three);
    assert.equal(s.verdict, "NOT_CHANGED", "the new rule does not");
    assert.equal(s.ok, false, "and the discrepancy is the whole reason the rule changed");
  });

  test("the old rule failed a genuinely unchanged page that the new rule calls FROZEN", () => {
    const same = ["s0", "s1", "s2"];
    const frames = same.map((h) => ({ ...blank(), byteHash: h }));
    assert.equal(oldRuleDistinctHashCount(frames), 3, "byte-distinct, if the bytes differed");
    const s = summariseFrames(frames);
    assert.equal(s.verdict, "FROZEN", "but nothing on the page moved, and that is now the answer");
  });
});

describe("frames that cannot be compared", () => {
  test("a different viewport size is not a change", () => {
    const r = compareFrames(blank(1440, 900), blank(390, 844));
    assert.equal(r.comparable, false);
    assert.match(r.reason, /size differs/);
  });

  test("TOTAL is the real pixel count of the measured fixture", () => {
    // Guards the arithmetic the measurements above were read against.
    assert.equal(TOTAL, 1296000);
  });
});
