import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCoordinatorMetrics, projectCardStall } from "../src/metrics.mjs";
import { loadBoard } from "../src/board.mjs";

process.env.HERDR_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hb-names-"));

/**
 * A consumer that cannot distinguish "no heartbeat" from "a heartbeat of zero" IS the defect.
 *
 * The failure that produced the 14062699-minute age was not a wrong field name. It was a fallback:
 * `card.heartbeat || card.heartbeatAt || 0`, which turned an ABSENT key into the number 0, and
 * `Date.parse(0)` is 946692000000. An absent key wearing a zero is worse than a wrong value,
 * because a wrong value is checkable and this is indistinguishable from data.
 *
 * So the arms here are about the two states, not about the export's shape: a card with no
 * heartbeat at all, and a card with a real one. A change that makes the first read as a number
 * fails here even if every other test still passes.
 */
const NOW = Date.now();  // the export subtracts from Date.now(), so a FIXED timestamp here reads as age 0
const MIN = 60_000;

function card(id, over = {}) {
  return {
    id, title: "t", status: "in_progress", stage_dir: "doing",
    owner: "agsuite-dev", next_actor: "agsuite-dev",
    updated: new Date(NOW - 30 * 86_400_000).toISOString(),
    ...over,
  };
}
const allCards = (m) => (m.alerts || []).flatMap((a) => a.cards || []);

/* ---------- 1. THE BOARD EXPORT: unset stays unset, a real one is a real age ---------- */
test("the board export gives null for NO heartbeat, and a real age for a real one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-export-"));
  const amqRoot = path.join(root, ".agent-mail");
  const dir = path.join(amqRoot, "bus", "doing");
  fs.mkdirSync(dir, { recursive: true });
  const withHb = new Date(NOW - 10 * MIN).toISOString();
  fs.writeFileSync(path.join(dir, "task_hb_0001.md"),
    `---\nid: task_hb_0001\ntitle: with\nstatus: in_progress\nstage_dir: doing\nowner: agsuite-dev\nupdated: ${new Date(NOW - 30 * 86_400_000).toISOString()}\nlast_heartbeat_at: ${withHb}\nlast_heartbeat_by: agsuite-dev\n---\n\nb\n`);
  fs.writeFileSync(path.join(dir, "task_hb_0002.md"),
    `---\nid: task_hb_0002\ntitle: without\nstatus: in_progress\nstage_dir: doing\nowner: agsuite-dev\nupdated: ${new Date(NOW - 30 * 86_400_000).toISOString()}\nlast_heartbeat_at: null\nlast_heartbeat_by: null\n---\n\nb\n`);

  const board = loadBoard(process.cwd(), amqRoot);
  const flat = Object.values(board.columns || {}).flat().filter(Boolean);
  const a = flat.find((t) => t.id === "task_hb_0001");
  const b = flat.find((t) => t.id === "task_hb_0002");

  assert.ok(Number.isFinite(a.heartbeatAgeMs) && a.heartbeatAgeMs > 0,
    `a card WITH a heartbeat has a real age, got ${JSON.stringify(a.heartbeatAgeMs)}`);
  assert.ok(a.heartbeatAgeMs >= 10 * MIN - 60_000, "and that age is consistent with the 10-minute-old stamp");

  // The load-bearing arm.
  assert.equal(b.heartbeatAgeMs, null,
    `NO heartbeat must be null, not 0 - a 0 here is what a consumer turns into Date.parse(0) = 946692000000: ${JSON.stringify(b.heartbeatAgeMs)}`);
  assert.notEqual(b.heartbeatAgeMs, 0, "explicitly: not zero, and not undefined-by-accident");
});

/* ---------- 2. THE PROJECTION: the same two states, under the projection's own names ---------- */
test("the ALERT projection reports UNSET, not a number, for a card with no heartbeat", () => {
  // The heartbeat names live in the alert's card projection, not in projectCardStall, which
  // returns only { kind, liveness, stalled }. Reading them off the wrong function is how this
  // test asserted on a key that has never existed there.
  const board = {
    columns: {
      doing: [
        card("task_hb_0003"),
        card("task_hb_0004", { last_heartbeat_at: new Date(NOW - 7 * MIN).toISOString(), last_heartbeat_by: "agsuite-dev" }),
      ],
    },
  };
  const m = buildCoordinatorMetrics({ board, now: NOW, deliveredState: { delivered: {} } });
  const none = allCards(m).find((c) => c.id === "task_hb_0003");
  const real = allCards(m).find((c) => c.id === "task_hb_0004");
  assert.ok(none && real, `both cards must appear in some alert to be observable: ${JSON.stringify(allCards(m).map((c) => c.id))}`);

  assert.equal(none.heartbeatAgeMs, null, `unset must be null, got ${JSON.stringify(none.heartbeatAgeMs)}`);
  assert.equal(none.heartbeatAt, null, `and heartbeatAt too, got ${JSON.stringify(none.heartbeatAt)}`);
  assert.notEqual(none.heartbeatAgeMs, 0, "not zero: zero is a value a consumer will read as a measurement");

  assert.ok(real.heartbeatAgeMs >= 7 * MIN - 60_000, `a real heartbeat gives a real age, got ${real.heartbeatAgeMs}`);
  assert.equal(real.heartbeatBy, "agsuite-dev", "and the actor travels with it");
});

/* ---------- 3. THE NAMES, so a reader is not left inferring which surface uses which ---------- */
test("the mapping between the two surfaces is RECORDED, not left to inference", () => {
  // Three names existed for one fact: last_heartbeat_at/last_heartbeat_by on the files and the
  // export, heartbeatAt/heartbeatBy on the projection, and an analysis asking for `card.heartbeat`.
  // A reader who has to discover that by trying is how the 14062699-minute age happened.
  const src = fs.readFileSync(new URL("../src/metrics.mjs", import.meta.url), "utf8");
  assert.ok(/last_heartbeat_at/.test(src) && /heartbeatAt/.test(src),
    "the projection still reads the file names and still emits the projection names");
  assert.ok(/heartbeatAgeMs/.test(src), "and the derived age has one name");
  // The file names are the ones parsed and written; that is a fact worth pinning because if it
  // ever inverts, every stored card silently stops carrying a heartbeat.
  const boardSrc = fs.readFileSync(new URL("../src/board.mjs", import.meta.url), "utf8");
  assert.ok(/`last_heartbeat_at:/.test(boardSrc) && /last_heartbeat_at: meta\.last_heartbeat_at/.test(boardSrc),
    "the card format still writes and parses last_heartbeat_at / last_heartbeat_by");
});

/* ---------- 4. THE LIMIT IS IN THE ARTIFACT ---------- */
test("the lease-not-progress limit ships in the METRICS, not only in a mail thread", () => {
  const m = buildCoordinatorMetrics({ board: { columns: {} }, now: NOW, deliveredState: { delivered: {} } });
  const limit = m.instrumentLimits?.heartbeat;
  assert.equal(typeof limit, "string", "the limit must be in the payload a reader opens");
  assert.ok(/LEASE/i.test(limit) && /progress/i.test(limit), "and it must say a heartbeat is a lease, not progress");
  assert.ok(/never be paged|indefinitely/i.test(limit),
    "including the consequence: a lane that heartbeats while doing nothing is never paged by liveness keying");
});

/* ---------- 5. THE THRESHOLD AND PREDICATE ARE UNTOUCHED ---------- */
test("this card changed NAMES and unset-ness only: a heartbeat does not move the stall verdict", () => {
  // The card forbids touching the threshold, the predicate, or the liveness keying, because a
  // naming fix that also moves the predicate is indistinguishable from a behaviour change and the
  // false-positive rate has not been measured. Behavioural proof, not a source-text claim: two
  // cards identical except for their heartbeat must be judged IDENTICALLY. If a fresh heartbeat
  // could rescue a stalled card, this naming work would have quietly changed the predicate.
  //
  // My first version of this arm asserted there was no `stalledWorkMs: <number>` in the file,
  // which is false by construction - the threshold is declared, that is the point of a named
  // threshold - so it could only ever fail. Asserting a value's absence is not the same as
  // asserting its behaviour is unchanged.
  const stale = new Date(NOW - 30 * 86_400_000).toISOString();
  const board = {
    columns: {
      doing: [
        card("task_hb_0005", { updated: stale }),
        card("task_hb_0006", { updated: stale, last_heartbeat_at: new Date(NOW - MIN).toISOString(), last_heartbeat_by: "agsuite-dev" }),
      ],
    },
  };
  const m = buildCoordinatorMetrics({ board, now: NOW, deliveredState: { delivered: {} } });
  const a = allCards(m).find((c) => c.id === "task_hb_0005");
  const b = allCards(m).find((c) => c.id === "task_hb_0006");
  assert.equal(a.stalled, b.stalled, "a fresh heartbeat must not rescue a stale card: the stall verdict is the progress clock's, not the lease's");
  assert.equal(a.liveness.via, b.liveness.via, "and the liveness keying is unchanged between the two");
  assert.notEqual(a.heartbeatAgeMs, b.heartbeatAgeMs, "while the heartbeat fields DO differ, or this test proves nothing");
});
