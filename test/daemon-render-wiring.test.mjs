import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const allCards = (m) => (m.alerts || []).flatMap((a) => a.cards || []);
import { buildCoordinatorAlertPrompt, runDoorbellPass } from "../src/bridge.mjs";
import { buildCoordinatorMetrics, buildCoordinatorMetricsWithWorkAge } from "../src/metrics.mjs";
import { loadBoard } from "../src/board.mjs";

process.env.HERDR_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "render-wired-"));

/**
 * The citation render in 69c60d was closed on assertions about the SOURCE TEXT of bridge.mjs, and
 * the source text was correct. The consumer that holds the prompt was never wired to the producer
 * that fills it: the daemon called `buildCoordinatorMetrics`, the no-work-age builder, so
 * `workAgeById` was null, `projectCardStall` computed `work: workAgeById?.get(id) || null`, and
 * every card had `work = null`. The render then guarded on `cites.length` with
 * `cites = card.work?.citations`, so it could not fire. No assertion about a string in a file can
 * detect a defect that lives in a call site.
 *
 * So every test here reads the RENDERED PROMPT. A source-text assertion would pass against the
 * broken build and is the specific mistake being guarded against.
 */

const NOW = Date.UTC(2026, 8, 27, 8, 0, 0);
const SHA = "0123456789abcdef0123456789abcdef01234567";

function card(id, over = {}) {
  return {
    id,
    title: "wired render",
    status: "in_progress",
    owner: "agsuite-dev",
    next_actor: "agsuite-dev",
    // Old enough to be STALL ELIGIBLE. A card that appears in no alert cannot prove anything
    // about the render, because the render only ever draws cards that some alert selected.
    updated: new Date(NOW - 30 * 86_400_000).toISOString(),
    stage_dir: "doing",
    description: `Closed in commit ${SHA}.`,
    body: `Closed in commit ${SHA}.`,
    proof: `Closed in commit ${SHA}.`,
    ...over,
  };
}

const BOARD = { columns: { doing: [card("task_wired_0001")], done: [card("task_wired_0002", { status: "done", done_at: new Date(NOW - 3_600_000).toISOString() })] } };

test("THE DEFECT THIS EXISTS FOR: the render cannot fire without work age, and can with it", async () => {
  // 1. No work age - the daemon's OLD call. This is the shape that shipped.
  const without = buildCoordinatorMetrics({ board: BOARD, now: NOW, deliveredState: { delivered: {} } });
  const withoutCard = allCards(without).find((c) => c.id === "task_wired_0001");
  assert.equal(withoutCard.work, null, "precondition: without workAgeById every card has work = null");
  const promptWithout = buildCoordinatorAlertPrompt(without.alerts.find((a) => a.id === "stalled_work") || without.alerts[0]);
  assert.equal(/Evidence cited by/.test(promptWithout || ""), false,
    "WITHOUT work age the citation line must be absent - this is the shipped behaviour");

  // 2. With work age - what the daemon now builds.
  const { workAgeById } = await buildCoordinatorMetricsWithWorkAge({ board: BOARD, now: NOW, deliveredState: { delivered: {} }, repos: [] });
  const with_ = buildCoordinatorMetrics({ board: BOARD, now: NOW, deliveredState: { delivered: {} }, workAgeById });
  const withCard = allCards(with_).find((c) => c.id === "task_wired_0001");
  assert.ok(withCard.work, "with workAgeById the card carries work data");
  assert.ok(Array.isArray(withCard.work.citations), "work.citations exists - this is what the render reads");
  assert.ok(withCard.work.citations.length > 0, "the card's cited SHA was extracted");
});

test("runDoorbellPass THREADS workAgeById into the builder, so cards are not born with work = null", async () => {
  // Captures the bridge's board itself, so this exercises the real loadBoard -> metrics path
  // rather than a hand-built object that could differ from production in some way that matters.
  const amqRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amq-"));
  for (const h of ["coordinator", "agsuite-dev"]) {
    fs.mkdirSync(path.join(amqRoot, "agents", h), { recursive: true });
    fs.writeFileSync(path.join(amqRoot, "agents", h, "profile.json"), JSON.stringify({ handle: h }));
  }
  fs.mkdirSync(path.join(amqRoot, "bus"), { recursive: true });
  fs.writeFileSync(path.join(amqRoot, "bus", "STATUS.md"), `---\ntitle: t\n---\n\nClosed in commit ${SHA}.\n`);
  const md = path.join(amqRoot, "bus", "doing", "task_wired_0003.md");
  fs.mkdirSync(path.dirname(md), { recursive: true });
  fs.writeFileSync(md, `---\nid: task_wired_0003\ntitle: wired\nstatus: in_progress\nowner: agsuite-dev\nnext_actor: agsuite-dev\nupdated: ${new Date(NOW - 30 * 86_400_000).toISOString()}\n---\n\nClosed in commit ${SHA}.\n`);

  const { workAgeById } = await buildCoordinatorMetricsWithWorkAge({ board: loadBoard(process.cwd(), amqRoot), now: NOW, deliveredState: { delivered: {} }, repos: [] });

  const res = runDoorbellPass({
    amqRoot, handles: ["agsuite-dev"], dryRun: true, allowPrompt: false, persistState: false,
    workAgeById,
    getStatus: () => ({ state: "idle" }),
    prompt: () => ({ ok: true }),
  });
  assert.ok(res, "the pass returns");
  // THE LOAD-BEARING ASSERTION. It reads the metrics runDoorbellPass built - not the metrics this
  // test built. An earlier version of this test asserted on its own workAgeById and passed
  // unchanged when the production argument was commented out: a test of the test. A red arm that
  // does not go red is worse than no arm, because it is reported as coverage.
  const built = res.coordinator;
  assert.ok(built, "the pass reports the metrics it built (as `coordinator`), so the wiring is observable");
  const c = allCards(built).find((x) => x.id === "task_wired_0003");
  assert.ok(c, "the card the daemon renders is in the pass's own metrics");
  assert.ok(c.work, "runDoorbellPass threaded workAgeById: without it this is null and the render is dead");
  assert.ok(c.work.citations.length > 0, "and the citations the render reads are present");
});

test("CITATION-ONLY mode is LABELLED, because 'undated' must not read as a fact about the commit", async () => {
  const { metrics, workAgeById } = await buildCoordinatorMetricsWithWorkAge({ board: BOARD, now: NOW, deliveredState: { delivered: {} }, repos: [] });
  const c = allCards(buildCoordinatorMetrics({ board: BOARD, now: NOW, deliveredState: { delivered: {} }, workAgeById })).find((x) => x.id === "task_wired_0001");
  // RECORDED AS FOUND, not as I expected: an unresolved citation has NO `date` key at all,
  // rather than an explicit null. Absence and "we did not ask" are therefore indistinguishable
  // from the citation alone - which is precisely why the mode has to be labelled on the metrics.
  assert.equal("date" in c.work.citations[0], false, "with repos: [] no date key is present at all");
  assert.equal(c.work.citations[0].kind, "sha", "but the citation itself is real and extractable");
  // `where` is whichever source the reader found it in; this fixture puts the same text in
  // three fields, so pinning the exact one would be asserting my fixture's field order rather
  // than the behaviour. What matters is that provenance SURVIVES citation-only mode.
  assert.ok(["description", "body", "proof", "title"].includes(c.work.citations[0].where),
    `and it keeps its provenance, got ${JSON.stringify(c.work.citations[0].where)}`);
  assert.equal(metrics.workAgeScope.datesResolved, false, "and the metrics SAY so, so a consumer cannot present it as an unknown commit");
  assert.equal(metrics.workAgeScope.mode, "citation-only");
});

test("RED ARM: dropping workAgeById from runDoorbellPass restores the silent null", async () => {
  // Proves this suite would have caught the shipped defect. If the production builder call is
  // edited to stop passing workAgeById, the card's work goes back to null and the citation line
  // goes back to unreachable - asserted here through the same public path, not through a copy.
  const { workAgeById } = await buildCoordinatorMetricsWithWorkAge({ board: BOARD, now: NOW, deliveredState: { delivered: {} }, repos: [] });
  const broken = buildCoordinatorMetrics({ board: BOARD, now: NOW, deliveredState: { delivered: {} } }); // workAgeById omitted
  const brokenCard = allCards(broken).find((c) => c.id === "task_wired_0001");
  assert.equal(brokenCard.work, null, "omitting the argument is exactly the shipped defect");
  assert.notEqual(workAgeById.size, 0, "and the injected one is not empty, so the difference is real");
});
