import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extractClaimedArtifacts, buildWorkAge, makeGitDateResolver } from "../src/work-age.mjs";
import { buildCoordinatorMetrics, buildCoordinatorMetricsWithWorkAge } from "../src/metrics.mjs";

const NOW = new Date("2026-09-24T17:00:00.000Z");
const older = (iso) => ({ "e8e9f35": "2026-09-24T10:00:00.000Z", "ab12cd3": "2026-09-24T15:00:00.000Z" }[iso] || iso);

const resolverFor = (map) => async (shas) => new Map(shas.map((s) => [s, map[s]]).filter(([, v]) => v));

// The definition the card commits to: a card's work is the set of commit SHAs and CI run
// ids its evidence CITES. Notes-as-work is explicitly excluded, because an agent that
// writes long reasons while doing nothing would be the loudest worker on the board.
test("a cited commit is work; a long note with no citation is not", () => {
  const verbose = {
    notes: [{
      text: "I spent a long time thinking very hard about this and wrote a great deal about it, "
        + "but I have not actually built anything and there is no commit here.",
    }],
  };
  const built = { notes: [{ text: "Landed in e8e9f35 after rebase." }] };
  assert.equal(extractClaimedArtifacts(verbose).shas.length, 0, "prose is not work");
  assert.equal(extractClaimedArtifacts(built).shas.length, 1);
});

test("note volume cannot game the signal, because volume is not measured at all", () => {
  const loud = { notes: Array.from({ length: 40 }, (_, i) => ({ text: `Reason number ${i}: still thinking, no artifacts.` })) };
  const quiet = { notes: [{ text: "No notes at all." }] };
  return Promise.all([buildWorkAge(loud, NOW), buildWorkAge(quiet, NOW)]).then(([a, b]) => {
    assert.equal(a.citationCount, 0);
    assert.equal(b.citationCount, 0);
    assert.equal(a.state, "no-claims");
    assert.equal(b.state, "no-claims");
  });
});

test("a long decimal is not a SHA, or every run id would read as a commit", () => {
  // 7+ digit decimals are hex-shaped. Without the letter requirement they become SHAs.
  const { shas } = extractClaimedArtifacts({ proof: "job 1790367759 and ticket 1234567 and 99887766" });
  assert.deepEqual(shas, [], "pure digits are not commits");
});

test("hex-only words are not SHAs", () => {
  const { shas } = extractClaimedArtifacts({ notes: [{ text: "the facade and the decade and the added cafe" }] });
  assert.deepEqual(shas, [], "6-letter words made of a-f are prose");
});

test("a short SHA and its full form are one commit, not two", () => {
  const full = "03838fadaf385e02e386301df2ba4dc2048cd339";
  const { shas } = extractClaimedArtifacts({ notes: [{ text: `see 03838fa and ${full}` }] });
  assert.equal(shas.length, 1, "the prefix and the full id are the same commit");
  assert.equal(shas[0], full, "the longer, more precise form is kept");
});

test("work-age is measured from the most recent cited commit", async () => {
  const card = { notes: [{ text: "earlier e8e9f35, then ab12cd3" }] };
  const work = await buildWorkAge(card, NOW, { resolveDate: resolverFor({ e8e9f35: older("e8e9f35"), ab12cd3: older("ab12cd3") }) });
  assert.equal(work.state, "dated");
  assert.equal(work.latestSha, "ab12cd3");
  assert.equal(work.latestAt, "2026-09-24T15:00:00.000Z");
  assert.equal(work.ageMs, 2 * 60 * 60 * 1000);
});

test("no citations is NOT age zero, or it would read as worked-on-right-now", async () => {
  const work = await buildWorkAge({ notes: [{ text: "nothing built" }] }, NOW);
  assert.equal(work.state, "no-claims");
  assert.equal(work.ageMs, null, "an age of 0 would claim work that never happened");
  assert.equal(work.latestAt, null);
});

test("a citation that cannot be dated is reported undated, never dated wrongly", async () => {
  const card = { notes: [{ text: "landed in deadbee" }] };
  const work = await buildWorkAge(card, NOW, { resolveDate: resolverFor({}) });
  assert.equal(work.state, "undated");
  assert.equal(work.ageMs, null);
  assert.deepEqual(work.undatedShas, ["deadbee"]);
  assert.equal(work.undated, 1);
});

test("a resolver that throws degrades to undated rather than taking the board down", async () => {
  const work = await buildWorkAge({ notes: [{ text: "landed in e8e9f35" }] }, NOW, {
    resolveDate: async () => { throw new Error("git exploded"); },
  });
  assert.equal(work.state, "undated");
  assert.equal(work.ageMs, null);
});

test("run ids are counted as claims and reported undated, since no local source dates them", async () => {
  const card = { notes: [{ text: "CI run_id=12345678 passed" }] };
  const work = await buildWorkAge(card, NOW, { resolveDate: resolverFor({}) });
  assert.deepEqual(work.runIds, ["12345678"]);
  assert.equal(work.undatedRunIds.length, 1);
  assert.equal(work.state, "no-claims", "a run id alone is not a dated commit");
});

// ── THE HARD CONSTRAINT ────────────────────────────────────────────────────────
// Report work-age, never alert on it. A finished card waiting on QA or a reviewer has
// no new commits, so any alert here fires on a timer for exactly the healthy cards.
test("work-age NEVER produces an alert: it cannot change the alert set at all", () => {
  // Matching on alert NAMES is the wrong control - "stalled_work" contains "work".
  // The real invariant is stronger and name-independent: supplying work-age, at any age
  // and with any threshold, must leave the alert set byte-identical.
  const ancient = "2000-01-01T00:00:00.000Z";
  const board = {
    columns: {
      // The card the constraint is about: implementation finished, waiting on review,
      // so it has no new commits and would age out on any timer.
      backlog: [{
        id: "finished_waiting", title: "Implementation done, waiting on review", owner: "worker",
        stage: "backlog", created: ancient, updated: ancient,
        notes: [{ text: "landed in e8e9f35" }],
      }],
      in_progress: [], blocked: [], done: [],
    },
  };
  const base = { handles: ["worker"], agentStatuses: { worker: "idle" }, board, now: NOW, thresholds: { stalledWorkMs: 5 * 60 * 1000 } };
  const without = buildCoordinatorMetrics(base);
  const shapes = (m) => JSON.stringify(m.alerts.map((a) => ({ id: a.id, severity: a.severity, cards: (a.cards || []).map((c) => c.id) })));

  for (const ageMs of [0, 60 * 1000, 999 * 24 * 3600 * 1000]) {
    for (const thresholdMs of [null, 0, 1]) {
      const withWork = buildCoordinatorMetrics({
        ...base,
        thresholds: { ...base.thresholds, workAgeWarnMs: thresholdMs ?? undefined },
        workAgeById: new Map([["finished_waiting", { ageMs, state: "dated", latestSha: "e8e9f35", latestAt: ancient, alerts: false }]]),
      });
      assert.equal(shapes(withWork), shapes(without), `work-age of ${ageMs}ms (threshold ${thresholdMs}) changed the alert set`);
      // And the alert ids must not acquire a work-age-shaped member.
      assert.deepEqual(
        withWork.alerts.map((a) => a.id).sort(),
        without.alerts.map((a) => a.id).sort(),
      );
    }
  }
});

test("the payload states report-only explicitly, so a reader is not left guessing", () => {
  const result = buildCoordinatorMetrics({
    handles: [], agentStatuses: {}, board: { columns: {} }, now: NOW,
    workAgeById: new Map(),
  });
  assert.equal(result.workAge.reportOnly, true);
  assert.equal(result.workAge.alerts, false);
  assert.match(result.workAge.note, /Report only/);
  assert.equal(result.workAge.alertingThresholdMs, undefined, "no paging knob is exposed");
});

test("a stalled card carries its work beside its state clock, so the two can be read together", () => {
  const board = {
    columns: {
      backlog: [], blocked: [], done: [],
      in_progress: [{
        id: "c1", title: "Stalled but has work", owner: "worker", stage: "in_progress",
        created: "2026-09-24T10:00:00.000Z", updated: "2026-09-24T10:00:00.000Z",
        notes: [{ text: "landed in e8e9f35" }],
      }],
    },
  };
  const work = { state: "dated", latestSha: "e8e9f35", latestAt: "2026-09-24T10:00:00.000Z", ageMs: 7 * 3600 * 1000, alerts: false };
  const result = buildCoordinatorMetrics({
    handles: ["worker"], agentStatuses: { worker: "idle" }, board, now: NOW,
    thresholds: { stalledWorkMs: 5 * 60 * 1000 },
    workAgeById: new Map([["c1", work]]),
  });
  const card = result.stalledWork.find((c) => c.id === "c1");
  assert.ok(card, "the card is stalled by the state clock");
  assert.equal(card.work.latestSha, "e8e9f35");
  assert.deepEqual(result.workAge.cards.c1, work);
});

test("the async wrapper resolves dates and covers exactly the active cards", async () => {
  const board = {
    columns: {
      backlog: [{ id: "b1", title: "a", owner: "w", stage: "backlog", created: "2026-09-24T10:00:00.000Z", updated: "2026-09-24T10:00:00.000Z", notes: [{ text: "e8e9f35" }] }],
      in_progress: [{ id: "d1", title: "b", owner: "w", stage: "in_progress", created: "2026-09-24T10:00:00.000Z", updated: "2026-09-24T10:00:00.000Z", notes: [{ text: "no work here" }] }],
      blocked: [{ id: "x1", title: "c", owner: "w", stage: "blocked", created: "2026-09-24T10:00:00.000Z", updated: "2026-09-24T10:00:00.000Z" }],
      done: [],
    },
  };
  const { metrics, workAgeById } = await buildCoordinatorMetricsWithWorkAge({
    handles: ["w"], agentStatuses: { w: "idle" }, board, now: NOW,
    thresholds: { stalledWorkMs: 5 * 60 * 1000 },
    repos: [],
  });
  // Active scope is backlog/doing/review: the blocked card is not covered, because the
  // state and queue signals do not cover it either.
  assert.deepEqual([...workAgeById.keys()].sort(), ["b1", "d1"]);
  assert.equal(workAgeById.get("b1").state, "undated", "no repo configured, so nothing can be dated");
  assert.equal(workAgeById.get("d1").state, "no-claims");
  assert.equal(metrics.workAge.reportOnly, true);
});

// ── The git resolver, against REAL repositories ────────────────────────────────
// Both of these were found by running against live data, not by a fixture: a fixture
// with a single synthetic repo cannot express a SHA that lives in the other one.
const REPO_A = process.cwd();
const REPO_B = path.join(REPO_A, "..", "godot", "fps-basegame");

test("a citation from ANOTHER repository does not poison the ones that do resolve", async () => {
  // Both repositories must be real: a scratch copy has no .git, and a guard on only one
  // of them turns an environmental skip into a false failure that has nothing to do with
  // the break under test.
  if (!fs.existsSync(path.join(REPO_A, ".git"))) return;
  if (!fs.existsSync(path.join(REPO_B, ".git"))) return; // sibling checkout absent
  const { execFileSync } = await import("node:child_process");
  const headA = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_A }).toString().trim();
  const headB = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_B }).toString().trim();
  // One SHA from each repository, plus something that is not a commit at all. The old
  // implementation passed all three to a single `git log --no-walk`, which aborts with
  // "fatal: ambiguous argument" on the unknown one and discards BOTH resolvable dates.
  const resolve = makeGitDateResolver({ repos: [REPO_A, REPO_B] });
  const work = await buildWorkAge(
    { notes: [{ text: `A is ${headA}, B is ${headB}, and 1234567 is neither` }] },
    new Date(),
    { resolveDate: resolve },
  );
  assert.equal(work.state, "dated", "both repositories' commits must resolve");
  assert.equal(work.dated, 2);
  assert.equal(work.undated, 0);
  assert.ok(work.ageMs >= 0);
});

test("an abbreviated SHA is dated, not reported missing", async () => {
  if (!fs.existsSync(path.join(REPO_A, ".git"))) return;
  const { execFileSync } = await import("node:child_process");
  const short = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_A }).toString().trim();
  // cat-file answers with the FULL hash; the notes cite the abbreviation. Filing the
  // resolved date under the full hash alone leaves every real citation undated forever.
  const resolve = makeGitDateResolver({ repos: [REPO_A] });
  const work = await buildWorkAge({ proof: `landed in ${short}` }, new Date(), { resolveDate: resolve });
  assert.equal(work.state, "dated", "an abbreviated SHA must resolve");
  assert.equal(work.latestSha, short);
});

test("a repository that is not a repository yields no dates and no throw", async () => {
  const resolve = makeGitDateResolver({ repos: ["/nonexistent/repo/path", REPO_A] });
  const work = await buildWorkAge({ proof: "landed in 22d476d" }, new Date(), { resolveDate: resolve });
  assert.ok(["dated", "undated"].includes(work.state));
});

// ── Two more found on the LIVE payload, not by a fixture ───────────────────────
test("a numeric `now` (Date.now(), which is what the metrics builder passes) yields a real age", async () => {
  // buildCoordinatorMetrics defaults now to Date.now() - a number. Only Date and string
  // were handled, so Date.parse(number) was NaN and every ageMs serialised as null:
  // a live payload showed `latestAt` correctly with `ageMs: null` beside it. Every
  // earlier fixture passed a Date, which is precisely how it stayed invisible.
  // `proof` rather than `description`: each break must move exactly one thing, and
  // reusing the description field would couple this test to the field-scanning change.
  const work = await buildWorkAge(
    { proof: "landed in e8e9f35" },
    Date.parse("2026-09-24T17:00:00.000Z"),
    { resolveDate: resolverFor({ e8e9f35: older("e8e9f35") }) },
  );
  assert.equal(work.latestAt, "2026-09-24T10:00:00.000Z");
  assert.equal(work.ageMs, 7 * 60 * 60 * 1000, "a numeric timestamp must give a real age, not null");
  assert.ok(Number.isFinite(work.ageMs), "ageMs must never be NaN, which serialises as null");
});

test("citations in the description are found, which is where the live board keeps them", async () => {
  // Live measurement: cards carried 6, 2 and 1 cited commits in their description and
  // ZERO in their notes. A notes-only scanner reported "no claims" on precisely the cards
  // doing the most work - the worst possible direction for this signal to fail in.
  const work = await buildWorkAge(
    { description: "blocked on e8e9f35 and ab12cd3", notes: [] },
    Date.parse("2026-09-24T17:00:00.000Z"),
    { resolveDate: resolverFor({ e8e9f35: older("e8e9f35"), ab12cd3: older("ab12cd3") }) },
  );
  assert.equal(work.citationCount, 2);
  assert.equal(work.latestSha, "ab12cd3");
  assert.ok(work.citations.every((c) => c.where === "description"), "the source is reported");
});

test("an uncomputable age is null and never NaN", async () => {
  const work = await buildWorkAge({ proof: "landed in e8e9f35" }, NaN, { resolveDate: resolverFor({ e8e9f35: older("e8e9f35") }) });
  assert.equal(work.ageMs, null);
  assert.ok(!Number.isNaN(work.ageMs));
});
