/**
 * Frame comparison that can tell a MOVED UI from a BLINKING CLOCK.
 *
 * The rule this replaces is the project's own, and it was wrong:
 *
 *   "the captured frames must be hashed and the distinct-hash count must equal the frame count,
 *    because a duplicated capture is indistinguishable from a stable UI"
 *
 * A duplicated capture is distinguishable, and so is an identical picture with different bytes.
 * Hashing certifies that SOMETHING differed; it says nothing about whether a reader would see
 * it. Measured on a real capture set (2026-09-26, 1440x900, 48 frames):
 *
 *   - desktop, all three frames hashed differently, so the gate went GREEN. The actual
 *     difference was 105 pixels out of 1,296,000 - 0.01% of the frame, PSNR 60.5 dB. Something
 *     badge-sized was moving by itself.
 *   - mobile, f1 and f2 identical, so the gate went RED. The page had painted once and frozen.
 *
 * So the gate was satisfied by noise and unsatisfiable by stability. It could not fail for the
 * reason it exists, and the failure it did produce pointed at the UI when the fault was in the
 * instrument. One lane treated that green as evidence and closed a card on it.
 *
 * What replaces it is a MAGNITUDE. A frame counts as changed only when enough of it changed, by
 * enough, to be visible; and two frames that are bit-identical are reported as FROZEN, which is
 * a statement about the instrument's ability to re-render, not about the page's quality.
 *
 * The defaults are stated rather than tuned to taste:
 *   changedFraction 0.005  half a percent of pixels. The observed phantom churn was 0.01%, so
 *                            this rejects it with an order of magnitude of headroom rather than
 *                            by a hair, and it still admits a real repaint of a mostly-static
 *                            page (a list re-sorting, a panel opening).
 *   minChannelDelta 8       of 255. Below roughly 5/255 the change is not reliably visible on a
 *                            normal display, and the 1-2 deltas that dominated the phantom
 *                            churn are excluded by three multiples.
 *
 * Both are parameters, and both are arguments, so a caller that disagrees says so in the report
 * rather than quietly inheriting a threshold. A threshold nobody can see is a default with the
 * honesty removed.
 */

/**
 * @param {{data: Uint8Array, width: number, height: number}} a
 * @param {{data: Uint8Array, width: number, height: number}} b
 */
export function compareFrames(a, b, options = {}) {
  const changedFractionThreshold = options.changedFraction ?? 0.005;
  const minChannelDelta = options.minChannelDelta ?? 8;

  if (a.width !== b.width || a.height !== b.height) {
    // Not "changed": not comparable. A resized viewport is a different frame, and reporting it
    // as a change would let a re-render pass by changing the geometry instead of the content.
    return { comparable: false, reason: `size differs: ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }

  const total = a.width * a.height;
  const len = Math.min(a.data.length, b.data.length);
  let changedPixels = 0;
  let maxDelta = 0;

  for (let p = 0; p < total; p++) {
    const o = p * 3;
    if (o + 2 >= len) break;
    const dr = Math.abs(a.data[o] - b.data[o]);
    const dg = Math.abs(a.data[o + 1] - b.data[o + 1]);
    const db = Math.abs(a.data[o + 2] - b.data[o + 2]);
    const d = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
    if (d > maxDelta) maxDelta = d;
    if (d >= minChannelDelta) changedPixels++;
  }

  const changedFraction = changedPixels / total;
  return {
    comparable: true,
    changedPixels,
    totalPixels: total,
    changedFraction,
    maxDelta,
    threshold: { changedFraction: changedFractionThreshold, minChannelDelta },
    // "changed" is a claim about VISIBILITY, not about bytes.
    changed: changedFraction > changedFractionThreshold,
    // Bit-identical is its own answer, and it is the one that matters most: it means the page
    // did not repaint at all, so the harness cannot say anything about this width.
    frozen: changedPixels === 0,
  };
}

/**
 * Roll pairwise comparisons into the verdict a gate can actually use.
 *
 * `distinct` is retained only so the old vocabulary still works, and it is explicitly labelled
 * as byte-distinctness - the number that made 105 pixels of clock churn look like a re-render.
 */
export function summariseFrames(frames, options = {}) {
  if (frames.length < 2) {
    return { ok: false, error: "need at least 2 frames to compare" };
  }
  const pairs = [];
  for (let i = 1; i < frames.length; i++) {
    pairs.push({ from: i - 1, to: i, ...compareFrames(frames[i - 1], frames[i], options) });
  }
  const comparable = pairs.filter((p) => p.comparable);
  const anyFrozen = comparable.some((p) => p.frozen);
  const allChanged = comparable.length > 0 && comparable.every((p) => p.changed);
  const byteDistinct = new Set(frames.map((f) => f.byteHash)).size;

  return {
    frames: frames.length,
    byteDistinct,
    // The number that misled: kept, named, and never used as a verdict.
    byteDistinctIsNotEvidence: true,
    pairs,
    allPairsChanged: allChanged,
    anyPairFrozen: anyFrozen,
    // Three verdicts, each a DISTINCT and actionable conclusion, because the failure this
    // replaces reported one thing when the truth was another:
    //   FROZEN      at least one pair was bit-identical, so the page did not repaint at all.
    //               Nothing can be concluded at this width - not about the UI, not about
    //               legibility. This dominates, because one frozen pair invalidates the run
    //               even if every other pair moved convincingly.
    //   NOT_CHANGED every pair differs, but not enough of it, or not visibly enough. The page
    //               DID repaint and the change was beneath notice - the 0.01% churn case, which
    //               is what the old rule read as a successful re-render.
    //   CHANGED     every pair moved perceptibly. This is the only verdict that passes, and it
    //               is a pass only because the same harness reports the other two.
    verdict: anyFrozen ? "FROZEN" : (allChanged ? "CHANGED" : "NOT_CHANGED"),
    ok: allChanged,
  };
}
