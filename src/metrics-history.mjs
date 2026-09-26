import fs from "node:fs";
import path from "node:path";

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

// The sample history was bounded by COUNT only (last 500), which means the time span it
// covers depends entirely on how busy the system was: 500 samples was ~20 hours on a
// quiet night and would be well under an hour on a busy one. A viewer cannot tell which,
// so "the chart starts here" was ambiguous, and 500 x ~235 B was ~117 KB on every
// /api/board poll.
//
// This bounds it by TIME as well, and - the part that matters - it reports what it
// dropped. A window that silently discards old samples is indistinguishable from a
// history that never had them, which is the same class of bug as reporting a returned
// count as a total.
export const DEFAULT_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h

export function applyHistoryWindow(history, { windowMs = DEFAULT_HISTORY_WINDOW_MS, now = Date.now() } = {}) {
  const samples = Array.isArray(history?.samples) ? history.samples : [];
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    // A non-positive/NaN window must not read as "keep nothing".
    return {
      ...history,
      retention: {
        ...(history?.retention || {}),
        mode: "all",
        windowMs: null,
        total: samples.length,
        retained: samples.length,
        droppedOld: 0,
        undated: 0,
        oldestKeptAt: samples[0]?.at ?? null,
        newestAt: samples[samples.length - 1]?.at ?? null,
      },
    };
  }

  const cutoff = now - windowMs;
  const kept = [];
  const keptDated = [];
  let droppedOld = 0;
  let undated = 0;
  for (const sample of samples) {
    const t = Date.parse(sample?.at ?? "");
    if (!Number.isFinite(t)) {
      // Undated samples are RETAINED and counted, never dropped: a sample we cannot
      // place in time is not evidence that it is old.
      undated++;
      kept.push(sample);
      continue;
    }
    if (t >= cutoff) {
      kept.push(sample);
      keptDated.push(t);
    } else {
      droppedOld++;
    }
  }

  // min/max over the KEPT samples only. This was originally computed over every dated
  // sample including the dropped ones, so the reported span described the whole file
  // rather than the window - it claimed 19.2h of history while serving a 6h window, and
  // the unit tests missed it because every fixture had all its samples inside the
  // window. Caught by measuring the live payload, not by reading the assertions.
  const oldestKeptAt = keptDated.length ? new Date(Math.min(...keptDated)).toISOString() : null;
  const newestAt = keptDated.length ? new Date(Math.max(...keptDated)).toISOString() : null;

  return {
    ...history,
    samples: kept,
    retention: {
      ...(history?.retention || {}),
      mode: "window",
      windowMs,
      total: samples.length,
      retained: kept.length,
      droppedOld,
      undated,
      oldestKeptAt,
      newestAt,
    },
  };
}

export function loadMetricsHistory(file, limit = 500) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      schemaVersion: Number(parsed.schemaVersion) || 1,
      samples: Array.isArray(parsed.samples) ? parsed.samples.slice(-limit) : [],
      retention: { limit },
    };
  } catch {
    return { schemaVersion: 1, samples: [], retention: { limit } };
  }
}

export function recordMetricsSample(file, metrics, { limit = 500, at = new Date().toISOString() } = {}) {
  const history = loadMetricsHistory(file, limit);
  history.samples.push({
    at,
    agents: metrics?.agents?.byStatus || {},
    queueDepth: metrics?.queue?.activeCards ?? 0,
    jobQueueDepth: metrics?.jobs?.queueDepth ?? 0,
    outcomes: metrics?.jobs?.outcomes || {},
    concurrency: metrics?.jobs?.concurrency?.current ?? 0,
  });
  history.samples = history.samples.slice(-limit);
  writeAtomic(file, history);
  return history;
}
