/**
 * fleet heal — reconcile what is OPEN against what is WIRED.
 *
 * Why this exists, in one measured example. On the live tree `mkt` was:
 *   • a brief on disk, a worktree, a mailbox, and a profile  → an agent, by every definition
 *     this codebase used
 *   • an open tab labelled `mkt`, with a pane in state `working`
 *   • ABSENT from `.agent-mail/config.json`, whose `agents[]` has 12 entries and is stamped
 *     `created_utc: 2026-09-23T09:10:30Z`
 *   • and its pane title had been overwritten by the foreground program, so the pane read
 *     `agy --dangerously-skip-permissions -c` and no longer named its agent
 *
 * The roster file is the reason. `getAgentHandles` prefers `config.json` over the directory
 * listing, and NOTHING IN THIS REPO EVER WRITES IT — it is a snapshot taken once, by something
 * else, on the day the queue was created. Every agent registered since then is invisible to
 * every consumer that reads the config: the doorbell pass (so their mail is never surfaced to
 * them), `ensureAllWorktrees` (so their worktree is never ensured), and the status roster. The
 * agent exists, is working, and is not in the team.
 *
 * So heal reads the open tabs, and wires up anything open that should be wired. Three gaps, and
 * each is repaired with the smallest action that closes it:
 *
 *   1. tab open, handle missing from the roster  → add it to config.json
 *   2. pane title no longer carries the handle   → rename the pane back
 *   3. persona discovered, no profile.json       → register it
 *
 * Two rules are the whole design, and both exist because the opposite is unrecoverable:
 *
 *   ADDITIVE ONLY. Heal never removes a handle from the roster. `fleet up`'s default
 *   replacement closed working panes and destroyed an operator's context; the roster is the same
 *   class of object, and a "cleanup" that silently un-wires a lane nobody was looking at is not
 *   a cleanup. A stale entry costs a name in a list. A missing one costs a working agent.
 *
 *   NEVER TOUCHES A REAL HERDR IN TESTS. `run` is injected, exactly as in `healAgentName`, and
 *   the unit tests pass a fake. This function renames panes; a test that called the real binary
 *   would rename the operator's actual tabs.
 */
import fs from "node:fs";
import path from "node:path";
import { execCmd } from "./config.mjs";
import { getHerdrBin } from "./config.mjs";
import { discoverFleetPersonas } from "./fleet.mjs";
import { registerAgent } from "./store.mjs";

const ROSTER_CANDIDATES = [
  path.join("meta", "config.json"),
  path.join("config.json"),
];

function defaultRun(args) {
  return execCmd(getHerdrBin(), args);
}

/** Where the roster lives and what it currently says. Null when there is no roster at all. */
export function readRoster(amqRoot) {
  for (const rel of ROSTER_CANDIDATES) {
    const p = path.join(amqRoot, rel);
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      return {
        path: p,
        rel,
        agents: Array.isArray(parsed.agents) ? [...parsed.agents] : [],
        raw: parsed,
      };
    } catch (err) {
      return { path: p, rel, agents: null, error: err.message };
    }
  }
  return null;
}

/**
 * A pane claims a handle when its tab label is exactly that handle and the tab holds one pane.
 *
 * The single-pane condition is inherited from `healAgentName` and is not a nicety: the tab
 * label is the canonical name, but a multi-pane tab has no way to say WHICH pane is the agent.
 * Guessing there means renaming the wrong pane, and renaming the wrong pane destroys whatever
 * that pane was running.
 */
export function resolveTabPanes(panes, tabs) {
  const resolved = [];
  for (const tab of tabs) {
    const handle = (tab.label || "").trim();
    if (!handle) continue;
    const inTab = panes.filter((p) => p.tab_id === tab.tab_id);
    if (inTab.length !== 1) continue;
    resolved.push({ handle, pane: inTab[0], tab });
  }
  return resolved;
}

/** Is this pane's own title still naming its agent? Kept out of the heal path deliberately — see gap 2. */
export function paneTitleNamesHandle(pane, handle) {
  const title = (pane.terminal_title_stripped || pane.terminal_title || "").trim();
  return title === `π - ${handle}` || title.includes(`- ${handle} - `);
}

export function healFleet(options = {}) {
  const {
    amqRoot,
    repoRoot,
    dryRun = false,
    run = defaultRun,
  } = options;

  if (!amqRoot || !fs.existsSync(amqRoot)) {
    return { ok: false, error: "Invalid AMQ root" };
  }

  const actions = { rosterAdded: [], panesRenamed: [], registered: [], skipped: [] };

  // ── What is open ────────────────────────────────────────────────────────────
  // Every failure below is a skip with a reason, never a silent pass: a heal that cannot see
  // the fleet must say so rather than report "nothing to do", which reads as healthy.
  let panes = [];
  let tabs = [];
  try {
    panes = JSON.parse(run(["pane", "list"]))?.result?.panes ?? [];
  } catch (err) {
    return { ok: false, error: `cannot read panes: ${err.message}`, actions };
  }
  try {
    tabs = JSON.parse(run(["tab", "list"]))?.result?.tabs ?? [];
  } catch (err) {
    actions.skipped.push({ what: "tab list", reason: err.message });
  }

  const openHandles = resolveTabPanes(panes, tabs).map((r) => r.handle);
  const personas = repoRoot ? discoverFleetPersonas(repoRoot) : new Map();

  // ── Gap 1: known agent, missing from the roster ──────────────────────────────
  // The set that gets wired is personas ∪ (open handles that are REGISTERED) — and that shape
  // is the result of getting it wrong twice, which is worth writing down:
  //
  //   personas only  — misses an agent that is open and registered but whose brief is gone
  //   union          — promotes whatever a tab is labelled, so a stray tab, a typo'd `--to`,
  //                    or a scratch window becomes a teammate. This is the bug the test below
  //                    pins: `stranger` was promoted, and the comment here claimed otherwise
  //                    while the code did the opposite, which is worse than no comment.
  //   intersection   — leaves an agent unwired the moment it finishes and its tab closes,
  //                    which is the common case rather than an edge case
  //
  // An open tab is evidence something is RUNNING. A persona or a profile is evidence something
  // is an AGENT. Only the second kind belongs in the roster, so that is what the tab can add to.
  const openAndRegistered = openHandles.filter((h) =>
    fs.existsSync(path.join(amqRoot, "agents", h, "profile.json"))
  );
  const roster = readRoster(amqRoot);
  const known = new Set([...personas.keys(), ...openAndRegistered]);
  const missingFromRoster = roster && roster.agents
    ? [...known].filter((h) => !roster.agents.includes(h)).sort()
    : [];

  // ── Gap 2: a tab is labelled, but no agent answers to that name ───────────────
  // My first cut of this was wrong in a way worth recording. It compared the PANE's
  // `terminal_title` against the handle and renamed when they differed - and on the live tree
  // that reported `mkt` as broken forever. `terminal_title` is written by the FOREGROUND
  // PROGRAM (`agy` sets it to its own command line), so a healthy working agent always
  // "drifts", the rename is a no-op, and every subsequent run renames again. A repair that
  // cannot be observed to succeed must not be attempted: an un-healable repair is an infinite
  // loop that reports progress.
  //
  // The real question is whether herdr can RESOLVE the label to an agent, and whether that
  // agent is this pane. `herdr agent get mkt` answered {"name":"mkt","pane_id":"w4:p45"} for a
  // pane whose terminal_title was the clobbered one - correctly named, bad-looking title.
  const unnamed = [];
  for (const { handle, pane } of resolveTabPanes(panes, tabs)) {
    let resolvedPaneId = null;
    try {
      const agent = JSON.parse(run(["agent", "get", handle]))?.result?.agent;
      resolvedPaneId = agent?.pane_id ?? null;
      if (agent?.name === handle) continue; // named, and it is this pane: nothing to do
    } catch {
      resolvedPaneId = null; // no agent by that name at all
    }
    unnamed.push({ handle, paneId: pane.pane_id, resolvedPaneId });
  }

  // ── Gap 3: a persona with no profile ─────────────────────────────────────────
  const unregistered = [...personas.keys()]
    .filter((h) => !fs.existsSync(path.join(amqRoot, "agents", h, "profile.json")))
    .sort();

  if (dryRun) {
    actions.rosterAdded = missingFromRoster;
    actions.panesRenamed = unnamed.map(({ handle, paneId }) => ({ handle, paneId }));
    actions.registered = unregistered;
    return { ok: true, dryRun: true, actions, rosterPath: roster?.path ?? null, observedOpenHandles: openHandles };
  }

  // ── Apply, smallest action first ─────────────────────────────────────────────
  // Roster first: it is the file that hides agents, and it is the only write here.
  if (roster && missingFromRoster.length) {
    const next = [...roster.agents, ...missingFromRoster].sort();
    const updated = { ...roster.raw, agents: next };
    fs.writeFileSync(roster.path, `${JSON.stringify(updated, null, 2)}\n`);
    actions.rosterAdded = missingFromRoster;
  }

  for (const { handle, paneId } of unnamed) {
    try {
      run(["agent", "rename", paneId, handle]);
      actions.panesRenamed.push({ handle, paneId });
    } catch (err) {
      actions.skipped.push({ what: `rename ${handle}`, reason: err.message });
    }
  }

  for (const handle of unregistered) {
    const persona = personas.get(handle) || {};
    const res = registerAgent(amqRoot, {
      handle,
      name: persona.name || undefined,
      role: persona.role || undefined,
      model: persona.model || undefined,
      prompt: persona.prompt || undefined,
    });
    if (res?.ok) actions.registered.push(handle);
    else actions.skipped.push({ what: `register ${handle}`, reason: res?.error || "unknown" });
  }

  return {
    ok: true,
    dryRun: false,
    actions,
    rosterPath: roster?.path ?? null,
    observedOpenHandles: openHandles,
  };
}
