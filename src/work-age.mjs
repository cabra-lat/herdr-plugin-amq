// Work-age: how long since a card cited anything that only WORK can produce.
//
// The state clock answers "has anyone moved this card". It cannot answer "has anyone
// built anything", because a card can be moved by a coordinator rewriting a reason for
// clarity - which is bookkeeping, and which moves the state clock. That is the
// distinction the board could not make: a stalled card and a finished-one-waiting-on-QA
// look identical, because both stop moving.
//
// So a card's work is the set of commit SHAs and CI run ids its evidence CITES. Not
// notes: note volume is narration, and an agent that writes long reasons while doing
// nothing would be the loudest worker on the board. Not mtime: it moves when someone
// rewrites a reason. A cited commit is the artifact that is unambiguously produced by
// building something.
//
// REPORT ONLY. There is deliberately no threshold and no alert here. A card whose
// implementation is finished and is waiting on QA or a reviewer has no new commits; any
// alert on work-age would fire on exactly those cards, on a timer, which is the failure
// this whole signal exists to avoid. The two clocks are read together by a human: state
// clock alone cannot tell stalled from waiting, state clock plus work-age can.

// 7-40 hex chars, and at least one a-f. The letter requirement is what separates a SHA
// from a bare number: a 7+ digit decimal run id is hex-shaped, and without it every
// long number in a note would be read as a commit. Real SHAs in this board are always
// mixed hex.
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;

// Run ids are cited in a handful of shapes and none of them appear in the current
// board, so these patterns are exercised by fixtures rather than by live data. Guessing
// a looser shape ("#1234") would read issue numbers as CI runs.
const RUN_PATTERNS = [
  /\brun[_\s-]?id\s*[:=#]?\s*(\d{3,})\b/gi,
  /\bactions\/runs\/(\d{3,})\b/gi,
  /\bruns?\/(\d{3,})\b/gi,
];

function isShaLike(token) {
  return /[a-f]/.test(token);
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

/**
 * Pull the work artifacts a card claims, from the fields where evidence actually lands.
 * The source of each citation is kept, because "cited in a proof" and "cited in a note"
 * are not the same claim and a reader should be able to tell them apart.
 */
export function extractClaimedArtifacts(task = {}) {
  const notes = Array.isArray(task.notes) ? task.notes : [];
  const sources = [];
  for (const note of notes) {
    const text = typeof note === "string" ? note : note?.text;
    if (text) sources.push({ where: "note", text });
  }
  if (task.proof) sources.push({ where: "proof", text: String(task.proof) });
  if (task.block_reason) sources.push({ where: "block_reason", text: String(task.block_reason) });
  if (task.reason) sources.push({ where: "reason", text: String(task.reason) });
  // `description` is where the real evidence lives: on the live board, cards carried 6, 2
  // and 1 cited commits in their description and zero in their notes, so a scanner that
  // read only notes reported "no claims" on precisely the cards doing the most work.
  if (task.description) sources.push({ where: "description", text: String(task.description) });

  const shas = [];
  const runIds = [];
  const citations = [];
  for (const { where, text } of sources) {
    for (const token of text.match(SHA_RE) || []) {
      if (!isShaLike(token)) continue;
      shas.push(token);
      citations.push({ kind: "sha", value: token, where });
    }
    for (const pattern of RUN_PATTERNS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(text);
      while (match) {
        runIds.push(match[1]);
        citations.push({ kind: "run", value: match[1], where });
        match = pattern.exec(text);
      }
    }
  }

  // Collapse a short SHA to its unambiguous 7-char prefix so it is not counted twice
  // alongside the full form of the same commit.
  const shasOut = uniq(shas).sort((a, b) => b.length - a.length || a.localeCompare(b));
  const seen = [];
  for (const sha of shasOut) {
    if (seen.some((kept) => kept.startsWith(sha))) continue;
    seen.push(sha);
  }

  return { shas: seen, runIds: uniq(runIds), citations };
}

// Commit dates are immutable, so a resolved SHA is cached for the life of the process.
// There is no TTL here on purpose: re-asking git about a commit that cannot change is
// pure cost, and the cardinality is bounded by the SHAs a board has ever cited.
const dateCache = new Map();

/**
 * Default resolver: one `git log --no-walk` per repository for the whole batch.
 * Returns a Map of sha -> ISO date, containing only SHAs that actually resolve, so a
 * SHA that is not in this repository is absent rather than dated wrongly.
 */
export function makeGitDateResolver({ repos = [] } = {}) {
  return async (shas) => {
    const wanted = uniq(shas).filter((sha) => !dateCache.has(sha));
    if (wanted.length > 0) {
      const { execFile } = await import("node:child_process");
      await Promise.all(repos.filter(Boolean).map(async (repo) => {
        const run = (args, stdin) => new Promise((resolve) => {
          const child = execFile("git", args, { cwd: repo, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            resolve(error ? null : String(stdout));
          });
          if (stdin !== undefined && child.stdin) child.stdin.end(stdin);
        });

        // `git log --no-walk a b c` ABORTS with "fatal: ambiguous argument" if any single
        // rev is unknown, discarding the ones that DID resolve. A card routinely cites a
        // commit that lives in the other repository, so that made the whole batch fail
        // and left every card undated - found on live data, not by a fixture.
        // `cat-file --batch-check` answers per object instead, so a miss costs only that
        // SHA.
        const check = await run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${wanted.join("\n")}\n`);
        const present = [];
        if (check) {
          for (const line of check.split("\n")) {
            const [hash, type] = line.trim().split(/\s+/);
            if (hash && type === "commit") present.push(hash);
          }
        }
        if (present.length > 0) {
          const log = await run(["log", "--no-walk", "--format=%H %cI", ...present]);
          if (log) {
            // cat-file answers with FULL hashes while the caller asked with the
            // abbreviations the notes actually cite, so the resolved date has to be
            // filed under every requested prefix - keying it by the full hash alone
            // leaves every abbreviated citation permanently "missing".
            const byFull = new Map();
            for (const line of log.split("\n")) {
              const [hash, date] = line.trim().split(/\s+/);
              if (hash && date) byFull.set(hash.toLowerCase(), date);
            }
            for (const full of present) {
              const date = byFull.get(full.toLowerCase());
              if (!date) continue;
              for (const requested of wanted) {
                if (full.toLowerCase().startsWith(requested.toLowerCase())) dateCache.set(requested, date);
              }
            }
          }
        }
      }));
      // A SHA nobody could resolve is remembered as unknown, so a card citing a commit
      // from another repository is not re-queried on every board render.
      for (const sha of wanted) if (!dateCache.has(sha)) dateCache.set(sha, null);
    }
    const out = new Map();
    for (const sha of uniq(shas)) {
      const hit = dateCache.get(sha);
      if (hit) out.set(sha, hit);
    }
    return out;
  };
}

// A resolver that knows nothing: the default when no repository is configured. It makes
// every citation undated rather than guessing a date, so the signal degrades to "this
// card cites N things" instead of to a fabricated age.
export const nullDateResolver = async () => new Map();

/**
 * Work-age for one card. Never throws and never invents a date: a card with no
 * citations, or whose citations cannot be dated, reports an explicit undated count
 * rather than an age of zero, which would read as "worked on right now".
 */
export async function buildWorkAge(task, now, { resolveDate = nullDateResolver, thresholdMs = null } = {}) {
  const { shas, runIds, citations } = extractClaimedArtifacts(task);
  // `buildCoordinatorMetrics` defaults `now` to Date.now(), a NUMBER. Only a Date and a
  // string were handled, so Date.parse(number) returned NaN and every ageMs became NaN,
  // which serialises as null - a live payload showing `latestAt` correctly and `ageMs: null`
  // beside it. The fixtures all passed a Date, which is exactly how it stayed hidden.
  const nowMs = now instanceof Date
    ? now.getTime()
    : (typeof now === "number" ? now : Date.parse(now));
  const nowValid = Number.isFinite(nowMs);
  const base = {
    shas,
    runIds,
    citationCount: citations.length,
    citations,
    // `thresholdMs` is accepted and deliberately unused for alerting. It is here so a
    // future reader looking for the paging knob finds it explicitly null rather than
    // having to infer its absence.
    alertingThresholdMs: thresholdMs,
    alerts: false,
  };

  if (shas.length === 0) {
    return {
      ...base,
      dated: 0,
      undated: runIds.length,
      undatedShas: [],
      undatedRunIds: runIds,
      latestSha: null,
      latestAt: null,
      ageMs: null,
      // Explicitly not 0: "never cited work" and "cited work just now" must not look alike.
      state: "no-claims",
    };
  }

  let dates = new Map();
  try {
    dates = (await resolveDate(shas)) || new Map();
  } catch {
    dates = new Map();
  }

  let latestSha = null;
  let latestMs = -Infinity;
  for (const [sha, date] of dates) {
    const ms = Date.parse(date);
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latestSha = sha;
    }
  }

  const datedShas = [...dates.keys()];
  const undatedShas = shas.filter((sha) => !dates.has(sha));
  if (latestSha === null) {
    return {
      ...base,
      dated: 0,
      undated: undatedShas.length + runIds.length,
      undatedShas,
      undatedRunIds: runIds,
      latestSha: null,
      latestAt: null,
      ageMs: null,
      state: "undated",
    };
  }

  const latestAt = new Date(latestMs).toISOString();
  return {
    ...base,
    dated: datedShas.length,
    undated: undatedShas.length + runIds.length,
    undatedShas,
    undatedRunIds: runIds,
    latestSha,
    latestAt,
    // Never NaN: a null age means "not computable" and is distinguishable from 0.
    ageMs: nowValid ? Math.max(0, nowMs - latestMs) : null,
    state: "dated",
  };
}

export function __resetWorkAgeCache() {
  dateCache.clear();
}

// ── Two-clock classification ───────────────────────────────────────────────────
//
// The state clock says whether the card was moved; work-age says whether anything was
// built. Read together they separate situations one clock cannot.
//
// THE LABELS NAME CLOCKS, NOT PEOPLE. A verdict-shaped label is read as a judgement
// about whoever owns the card, and the moment a human can see a verdict next to a
// colleague's name the metric becomes a performance signal: owners learn to move the
// clock instead of finishing the work. That is not hypothetical - the strongest argument
// for excluding notes and mtime as work signals was an agent writing substantial reasons
// purely to move a clock. A label that reads as a verdict rebuilds the exact incentive
// the two-clock design removes. So: say what the clocks say, and let the reader draw
// the conclusion, which is the only way the reading stays honest.

export const CLOCK_OBSERVATIONS = Object.freeze({
  BOTH_RECENT: "both-recent",
  WORK_RECENT_STATE_STALE: "work-recent-state-stale",
  STATE_RECENT_WORK_STALE: "state-recent-work-stale",
  BOTH_STALE: "both-stale",
  WORK_UNKNOWN: "work-unknown",
});

// What each observation is ALSO consistent with. A label that reads as a conclusion
// without its alternatives is the failure mode, so the alternatives travel with it.
// The important one: WORK_RECENT_STATE_STALE is equally what an implemented-but-forgotten
// card looks like, and equally what work that does not address this card looks like. The
// two clocks cannot separate those, and a reader who assumes fresh work means finished
// work will be wrong sometimes.
const OBSERVATION_NOTES = Object.freeze({
  [CLOCK_OBSERVATIONS.BOTH_RECENT]: {
    describes: "the card was moved and something was built, both recently",
    alsoConsistentWith: [
      "an owner who is actively working and keeping the card current",
      "work that was committed and the card updated in the same pass",
    ],
  },
  [CLOCK_OBSERVATIONS.WORK_RECENT_STATE_STALE]: {
    describes: "something was built recently; the card itself has not moved",
    alsoConsistentWith: [
      "an implemented-but-forgotten card: the work landed and nobody closed or moved the card",
      "work that does not actually address this card, committed near it in time",
      "a reviewer or QA dependency that has not reported back yet",
    ],
  },
  [CLOCK_OBSERVATIONS.STATE_RECENT_WORK_STALE]: {
    describes: "the card was moved recently; nothing has been built against it",
    alsoConsistentWith: [
      "bookkeeping activity, such as rewriting a reason or a note for clarity",
      "a card being re-scoped, reassigned or re-prioritised before any code exists",
      "an agent whose real work is elsewhere and who is keeping this card tidy",
    ],
  },
  [CLOCK_OBSERVATIONS.BOTH_STALE]: {
    describes: "neither the card nor the cited work has moved recently",
    alsoConsistentWith: [
      "work that exists only as uncommitted local changes, which this signal cannot see",
      "a card whose work was landed under a different card or with no citation at all",
      "a genuinely abandoned card",
    ],
  },
  [CLOCK_OBSERVATIONS.WORK_UNKNOWN]: {
    describes: "the card cites no dated work, so the work axis cannot be read at all",
    alsoConsistentWith: [
      "work that exists but cites no commit, which is indistinguishable from no work",
    ],
  },
});

/**
 * Classify one card by the pair of clocks. Pure, and deliberately total: any input
 * produces a label, because a card that cannot be classified must SAY so rather than
 * defaulting to the stale reading - defaulting would invent evidence of inactivity.
 */
export function classifyTwoClocks({ stateAgeMs, work = null, staleAfterMs }) {
  const base = {
    thresholdMs: staleAfterMs,
    stateAgeMs: Number.isFinite(stateAgeMs) ? stateAgeMs : null,
    workAgeMs: work && Number.isFinite(work.ageMs) ? work.ageMs : null,
    workState: work?.state || "no-claims",
    latestSha: work?.latestSha || null,
    // Report-only, exactly like the signal it is derived from. If this ever needs to
    // page someone, that is a separate decision taken deliberately, not a threshold
    // added here.
    reportOnly: true,
    alerts: false,
    thresholdPages: false,
  };

  const dated = work && work.state === "dated" && Number.isFinite(work.ageMs);
  if (!dated) {
    return { ...base, label: CLOCK_OBSERVATIONS.WORK_UNKNOWN, ...OBSERVATION_NOTES[CLOCK_OBSERVATIONS.WORK_UNKNOWN] };
  }
  if (!Number.isFinite(stateAgeMs)) {
    // Same principle from the other side: no state clock means the card cannot be placed
    // on the state axis, so the pair is unreadable rather than stale.
    return { ...base, label: CLOCK_OBSERVATIONS.WORK_UNKNOWN, ...OBSERVATION_NOTES[CLOCK_OBSERVATIONS.WORK_UNKNOWN] };
  }

  const stateStale = stateAgeMs > staleAfterMs;
  const workStale = work.ageMs > staleAfterMs;
  const label = stateStale && workStale
    ? CLOCK_OBSERVATIONS.BOTH_STALE
    : (workStale ? CLOCK_OBSERVATIONS.STATE_RECENT_WORK_STALE : CLOCK_OBSERVATIONS.WORK_RECENT_STATE_STALE);
  // BOTH_RECENT is the only label not reachable above, because either axis being stale
  // routes to one of the others first.
  if (!stateStale && !workStale) {
    return { ...base, label: CLOCK_OBSERVATIONS.BOTH_RECENT, ...OBSERVATION_NOTES[CLOCK_OBSERVATIONS.BOTH_RECENT] };
  }
  return { ...base, label, ...OBSERVATION_NOTES[label] };
}

export const CLOCK_LABEL_VALUES = Object.freeze(Object.values(CLOCK_OBSERVATIONS));
