import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCoordinatorMetrics } from "../src/metrics.mjs";

process.env.HERDR_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "retry-fp-"));
{ const r = fs.mkdtempSync(path.join(os.tmpdir(), "retry-fp-root-"));
  fs.mkdirSync(path.join(r, "agents"), { recursive: true });
  fs.mkdirSync(path.join(r, "bus"), { recursive: true });
  process.env.AM_ROOT = r; }

/**
 * An alert with no condition fingerprint re-announces itself forever.
 *
 * Observed on the live board: the retry alert fired on 7 retries across 6 items, then fired AGAIN
 * on the same 7 across 6 with only the maximum age moved, then genuinely transitioned to 1/1 and
 * fired, then fired again on 1/1 with only the age moved. One real transition, three
 * re-announcements of a condition that had not changed.
 *
 * The cause is the ABSENCE of a key, not age leaking into one. `coordinatorAlertKey`
 * (bridge.mjs:680) is `id:fingerprint` when a fingerprint exists and a BARE `id` when it does
 * not, and `isCoordinatorAlertPending` then falls through to a cooldown check - so an unchanged
 * condition re-announced itself every time the cooldown expired. Both obvious diagnoses are wrong
 * in different ways: the age was never hashed, because nothing was hashed.
 *
 * THE CLOCK MOVES, THE INCIDENT DOES NOT. An unchanged condition re-announced later is the SAME
 * delivery evidence evaluated at a LATER `now`, so the derived age grows while every stored
 * timestamp stays put. An earlier draft of this file instead moved `firstAttemptAt` to force a
 * larger age, which describes a DIFFERENT incident: the fingerprints then correctly differed and
 * the test was measuring its own construction rather than the bug. Varying the data rather than
 * the clock is how a test for this defect goes green for the wrong reason, and getting it backwards
 * would have hidden the very behaviour under test.
 */
const NOW = Date.UTC(2026, 8, 27, 16, 0, 0);
const alert = (m) => (m.alerts || []).find((a) => a.id === "retry_failure_trend");

/**
 * Build the alert from the delivery evidence it actually reads.
 *
 * The retry set is derived from `deliveredState.delivered` entries with attempts > 1, filtered to
 * those whose last attempt falls inside `retryWindowMs`; the age is `now - firstAttemptAt`.
 * Limits (metrics.mjs:200-202): retryWarningCount 2, retryCriticalCount 3, retryDelayWarnMs 300s.
 */
function build({ retries, at = NOW }) {
  const delivered = {};
  retries.forEach((r, i) => {
    delivered[r?.id ?? `msg${i}`] = {
      // ABSOLUTE and FIXED: the incident is what it is, and only the evaluation clock moves.
      // They are absolute for a reason - making them relative to `at` looks tidier and silently
      // rewrites firstAttemptAt on every pass, so the incident changes and the main arm breaks.
      // They stay inside retryWindowMs because the clock only ever moves a few hundred ms here.
      at: new Date(NOW - 60_000).toISOString(),                            // last attempt, inside the window
      firstAttemptAt: new Date(NOW - (r?.ageMs ?? 300_000)).toISOString(), // when THIS incident started
      attempts: r?.attempts ?? 2,
    };
  });
  return buildCoordinatorMetrics({
    board: { columns: {} },
    now: at,
    deliveredState: { delivered },
    resources: {},
  });
}

const N = (n) => Array.from({ length: n }, () => ({}));

test("THE DEFECT THIS EXISTS FOR: an unchanged condition with a grown age produces the SAME fingerprint", () => {
  const first = alert(build({ retries: N(7) }));
  const later = alert(build({ retries: N(7), at: NOW + 300_000 }));
  assert.ok(first && later, "both passes must produce the alert");
  assert.equal(typeof first.fingerprint, "string",
    "the alert must carry a condition fingerprint AT ALL - its having none was the actual defect");
  assert.equal(first.fingerprint, later.fingerprint,
    "same incidents, later clock: this is the SAME condition, or it re-announces on age growth");
});

test("A REAL TRANSITION still gets a new fingerprint, so the fix does not silence genuine news", () => {
  // Coordinator's own evidence: 7/6 -> 1/1 WAS a real transition and it did produce a fresh
  // firing. A fix that made every retry alert permanently silent would satisfy the first test and
  // destroy this one, which is why the arm is here rather than assumed.
  const big = alert(build({ retries: N(7) }));
  const small = alert(build({ retries: [{ attempts: 3 }] }));  // 1 item, retryCount 2 -> fires
  const none = alert(build({ retries: N(1) }));                     // 1 item, retryCount 1 -> correctly silent
  assert.ok(big && small, "both must fire");
  assert.equal(none, undefined, "a single retry below the warn count must stay silent - the threshold is real");
  assert.notEqual(big.retryCount, small.retryCount, "the fixture must actually be two different conditions");
  assert.notEqual(big.fingerprint, small.fingerprint, "7 retries and 1 retry must not be collapsed");
});

test("A SEVERITY ESCALATION on age alone still announces", () => {
  // The predicate is `retryCount >= warnCount || retryDelayMaxMs > warnMs`, so an incident that
  // simply keeps ageing can go warning -> critical with no new retries at all. Excluding the age
  // from the key without putting severity in it would swallow that escalation silently - the same
  // class of bug as the one being fixed, wearing the fix's clothes.
  const low = alert(build({ retries: N(2), at: NOW }));
  const high = alert(build({ retries: N(2), at: NOW + 400_000 }));
  assert.ok(low && high, "both must fire - the age disjunct is part of the predicate");
  assert.equal(low.retryCount, high.retryCount, "no NEW retries: the only thing that changed is the clock");
  assert.notEqual(low.severity, high.severity, "an age crossing the critical threshold IS a severity change");
  assert.notEqual(low.fingerprint, high.fingerprint, "and a severity change must produce a new key");
});

test("WHICH incidents are open is in the key, and ORDER is not", () => {
  // An arm I corrected rather than deleted. It originally tagged entries {id:"w1"} and asserted
  // that swapping w2 for w3 changes the fingerprint - but the key is built from each incident's
  // first-attempt time, because `deliveredState.delivered` is a MAP and its Object.values carry no
  // id of their own, so the ids never reached the hash. The real property is the one below.
  const a = alert(build({ retries: [{ ageMs: 100_000 }, { ageMs: 200_000 }] }));
  const b = alert(build({ retries: [{ ageMs: 200_000 }, { ageMs: 100_000 }] }));
  const c = alert(build({ retries: [{ ageMs: 100_000 }, { ageMs: 900_000 }] }));
  assert.ok(a && b && c, "all three must fire");
  assert.equal(a.fingerprint, b.fingerprint, "ordering is not a property of the fault");
  assert.notEqual(a.fingerprint, c.fingerprint, "a different incident IS a different condition");
});

test("RED ARM: every alert the bridge can select needs a condition fingerprint", () => {
  // The guard that would have caught this the first time. It found a SECOND instance of the same
  // defect - `backlog_idle` had no fingerprint either - which is the argument for making it a
  // property of the selection list rather than a one-off assertion about the one alert named in
  // the card. A test that only pins the reported symptom leaves the class open.
  const src = fs.readFileSync(new URL("../src/metrics.mjs", import.meta.url), "utf8");
  const sel = fs.readFileSync(new URL("../src/bridge.mjs", import.meta.url), "utf8");
  const ids = (sel.match(/DOORBELL_ALERT_IDS = \[([^\]]*)\]/) || [, ""])[1]
    .split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean);
  assert.ok(ids.length >= 5, `expected the selection list to be non-trivial, parsed ${ids.length}`);
  const missing = ids.filter((id) => {
    const at = src.indexOf(`id: "${id}"`);
    if (at < 0) return false;
    return !/fingerprint: conditionFingerprint/.test(src.slice(at, at + 2600));
  });
  assert.deepEqual(missing, [],
    `every alert the bridge can select needs a condition fingerprint; missing: ${missing.join(", ")}`);
});
