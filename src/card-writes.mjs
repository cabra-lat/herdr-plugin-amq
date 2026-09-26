// Per-card write events - the instrument the stall threshold is missing.
//
// WHY
// A card stores only its LATEST `updated`, so the history of how it moves is destroyed
// on the first write. That means the one quantity `stalled_work` depends on - the
// interval between writes to a specific card - has never been measurable. We have been
// tuning against proxies: per-lane AMQ message cadence (0.9-8.4 min median) measures how
// often lanes TALK, not how often cards MOVE, and those differ by roughly an order of
// magnitude. A threshold read off the wrong quantity is a number that looks measured.
//
// WHAT IT RECORDS
// One line per write: which card, which fields actually changed, when, and who. The
// changed-field list is the point - it separates a transition from bookkeeping, and it
// is exactly what cannot be reconstructed from `updated` after the fact.
//
// BOUNDED
// Append-only JSONL, capped per card and in total, oldest-first eviction. A board that
// runs for a year must not accumulate an unbounded log behind a metric.
import fs from "node:fs";
import path from "node:path";

const MAX_EVENTS_PER_CARD = 200;
const MAX_TOTAL_CARDS = 200;

// Fields whose change means the card MOVED. Mirrors TRANSITION_FIELDS in metrics.mjs;
// duplicated as a literal so the log module keeps no import cycle with the metrics path.
const TRANSITION_FIELDS = new Set(["status", "owner", "next_actor"]);

function logDir(stateDir) {
  return path.join(stateDir, "card-writes");
}

function logFile(stateDir, cardId) {
  return path.join(logDir(stateDir), `${cardId}.jsonl`);
}

function changedFields(previous, next) {
  if (!previous || !next) return [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changed = [];
  for (const key of keys) {
    // `updated` moves on every write by construction, so it can never indicate one.
    if (key === "updated" || key === "filePath" || key === "schema_version") continue;
    const a = previous[key];
    const b = next[key];
    if (a === b) continue;
    if (a == null && b == null) continue;
    if (typeof a === "object" || typeof b === "object") {
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
    }
    changed.push(key);
  }
  return changed.sort();
}

function evictOldCards(stateDir) {
  const dir = logDir(stateDir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  if (names.length <= MAX_TOTAL_CARDS) return;
  const withMtime = names.map((n) => {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, n)).mtimeMs;
    } catch {
      mtime = 0;
    }
    return { n, mtime };
  });
  withMtime.sort((a, b) => a.mtime - b.mtime);
  for (const victim of withMtime.slice(0, withMtime.length - MAX_TOTAL_CARDS)) {
    try {
      fs.unlinkSync(path.join(dir, victim.n));
    } catch {
      // best effort: eviction is housekeeping, never a reason to fail a write
    }
  }
}

export function recordCardWrite(stateDir, cardId, previous, next, { actor = null, at = new Date().toISOString() } = {}) {
  const fields = changedFields(previous, next);
  // A no-op write is not a write. Recording it would inflate the very distribution this
  // log exists to measure.
  if (fields.length === 0) return null;
  const event = {
    at,
    actor,
    fields,
    transitions: fields.filter((f) => TRANSITION_FIELDS.has(f)),
  };
  try {
    const file = logFile(stateDir, cardId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let existing = "";
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      existing = "";
    }
    const lines = existing.split("\n").filter(Boolean);
    lines.push(JSON.stringify(event));
    fs.writeFileSync(file, lines.slice(-MAX_EVENTS_PER_CARD).join("\n") + "\n", "utf8");
    evictOldCards(stateDir);
  } catch {
    // Instrumentation must never be the reason a board write fails.
  }
  return event;
}

export function readCardWrites(stateDir, cardId, { limit = MAX_EVENTS_PER_CARD } = {}) {
  try {
    return fs
      .readFileSync(logFile(stateDir, cardId), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// The measurement a threshold should be read off: intervals between TRANSITION events on
// a single card. Per card, not per lane - a lane working two cards has two clocks.
export function cardTransitionIntervals(stateDir, cardId) {
  const events = readCardWrites(stateDir, cardId).filter((e) => (e.transitions || []).length > 0);
  const out = [];
  for (let i = 1; i < events.length; i++) {
    const delta = Date.parse(events[i].at) - Date.parse(events[i - 1].at);
    if (Number.isFinite(delta) && delta >= 0) out.push(delta);
  }
  return out;
}
