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
