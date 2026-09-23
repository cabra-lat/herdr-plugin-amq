import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { scanAgentBriefs } from "./briefs.mjs";
import { ensureAgentWorktree } from "./worktrees.mjs";
import { registerAgent, formatAgentTitle } from "./store.mjs";
import { getHerdrAgents, isHerdrAvailable } from "./herdr.mjs";

/**
 * Parse agent handles from AGENTS.md, GEMINI.md, or CLAUDE.md
 */
export function parseAgentsMdHandles(repoRoot) {
  if (!repoRoot || !fs.existsSync(repoRoot)) return [];
  const candidateFiles = ["AGENTS.md", "GEMINI.md", "CLAUDE.md"];
  const handles = new Set();

  for (const f of candidateFiles) {
    const fullPath = path.join(repoRoot, f);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const content = fs.readFileSync(fullPath, "utf8");
      // Pattern 1: Handles: `coord`, `worker`, ...
      const handleMatch = content.match(/Handles:\s*([^\n\r]+)/i);
      if (handleMatch) {
        const tokens = handleMatch[1].match(/`([^`]+)`/g) || handleMatch[1].split(/[\s,]+/);
        for (let tok of tokens) {
          tok = tok.replace(/[`'",:]/g, "").trim().toLowerCase();
          if (tok && !["and", "or", "etc", "none"].includes(tok)) {
            handles.add(tok);
          }
        }
      }
    } catch {}
  }

  return Array.from(handles);
}

/**
 * Discover fleet personas across external tool directories (.opencode, .agents, .pi, .claude, AGENTS.md, .worktrees)
 */
export function discoverFleetPersonas(repoRoot) {
  const personas = new Map();
  if (!repoRoot || !fs.existsSync(repoRoot)) return personas;

  // 1. Scan standard briefs (.opencode/agents, .agents, .pi/agents, etc.)
  const briefs = scanAgentBriefs(repoRoot);
  for (const [handle, brief] of briefs.entries()) {
    personas.set(handle, {
      ...brief,
      sourceType: "brief",
    });
  }

  // 2. Parse handles declared in AGENTS.md
  const declaredHandles = parseAgentsMdHandles(repoRoot);
  for (const handle of declaredHandles) {
    if (!personas.has(handle)) {
      personas.set(handle, {
        handle,
        name: formatAgentTitle(handle),
        role: `Declared agent for ${handle}`,
        description: `Agent defined in AGENTS.md`,
        prompt: `You are the ${handle} agent.`,
        source: "AGENTS.md",
        sourceType: "rule",
        model: null,
      });
    }
  }

  // 3. Discover established worktrees (.worktrees/<handle>)
  const worktreeDir = path.join(repoRoot, ".worktrees");
  if (fs.existsSync(worktreeDir)) {
    try {
      const entries = fs.readdirSync(worktreeDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const handle = ent.name;
        if (!personas.has(handle)) {
          personas.set(handle, {
            handle,
            name: formatAgentTitle(handle),
            role: `Specialist agent for ${handle}`,
            description: `Established worktree agent`,
            prompt: `You are the ${handle} agent.`,
            source: path.join(".worktrees", handle),
            sourceType: "worktree",
            model: null,
          });
        }
      }
    } catch {}
  }

  return personas;
}

/**
 * Prepopulate all fleet agents into AMQ maildirs and ensure isolated Git worktrees exist
 */
export function prepopulateFleet(amqRoot, repoRoot) {
  const personas = discoverFleetPersonas(repoRoot);
  const results = [];

  for (const [handle, persona] of personas.entries()) {
    const worktreeResult = ensureAgentWorktree(repoRoot, handle);
    const regResult = registerAgent(amqRoot, {
      handle,
      name: persona.name,
      role: persona.role || persona.description,
      description: persona.description,
      prompt: persona.prompt,
      model: persona.model || "Gemini 3.8 Flash (High)",
      worktree: worktreeResult.ok ? worktreeResult.path : undefined,
    });

    results.push({
      handle,
      name: persona.name,
      source: persona.source,
      sourceType: persona.sourceType,
      worktree: worktreeResult.path,
      worktreeExisted: worktreeResult.existed || false,
      maildirOk: regResult.ok,
    });
  }

  trustFleetWorkspaces(repoRoot);
  return results;
}

/**
 * Pre-authorize worktree directories in Antigravity CLI's settings.json
 * to bypass the interactive TUI trust dialog
 */
export function trustFleetWorkspaces(repoRoot) {
  try {
    const home = os.homedir();
    const settingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const set = new Set(settings.trustedWorkspaces || []);
    set.add(repoRoot);
    const wtDir = path.join(repoRoot, ".worktrees");
    if (fs.existsSync(wtDir)) {
      for (const f of fs.readdirSync(wtDir)) {
        set.add(path.join(wtDir, f));
      }
    }
    settings.trustedWorkspaces = Array.from(set);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {}
}

/**
 * Resolve a robust PATH that guarantees local binaries (~/.local/bin, ~/.gemini/antigravity-cli/bin, nix profiles)
 */
export function buildFleetEnvPath() {
  const home = os.homedir();
  const userName = os.userInfo().username;
  const paths = [
    path.join(home, ".local", "bin"),
    path.join(home, ".gemini", "antigravity-cli", "bin"),
    path.join(home, ".nix-profile", "bin"),
    path.join(home, ".cargo", "bin"),
    "/run/wrappers/bin",
    `/etc/profiles/per-user/${userName}/bin`,
    "/nix/profile/bin",
    "/run/current-system/sw/bin",
    process.env.PATH || "",
  ];

  return Array.from(new Set(paths.filter(Boolean))).join(":");
}

/**
 * Launch or recover the agent fleet inside Herdr
 */
export async function launchFleet(amqRoot, repoRoot, options = {}) {
  const kind = options.kind || "agy";
  const dryRun = Boolean(options.dryRun);
  const timeoutMs = options.timeout || 25000;
  const customArgs = options.args || (kind === "agy" ? ["--dangerously-skip-permissions"] : []);
  const filterList = options.agents
    ? (Array.isArray(options.agents) ? options.agents : options.agents.split(",")).map((s) => s.trim().toLowerCase())
    : null;

  // 1. Prepopulate maildirs and worktrees
  const fleet = prepopulateFleet(amqRoot, repoRoot);
  const targetFleet = filterList ? fleet.filter((f) => filterList.includes(f.handle)) : fleet;

  const result = {
    total: targetFleet.length,
    prepopulated: targetFleet.map((t) => t.handle),
    alreadyRunning: [],
    wouldLaunch: [],
    launched: [],
    failed: [],
    dryRun,
  };

  // 2. Check Herdr connectivity and live agents
  let activeHandles = new Set();
  try {
    const liveAgents = await getHerdrAgents();
    activeHandles = new Set(liveAgents.map((a) => a.name).filter(Boolean));
  } catch {}

  for (const agent of targetFleet) {
    if (activeHandles.has(agent.handle)) {
      result.alreadyRunning.push(agent.handle);
    } else {
      result.wouldLaunch.push(agent.handle);
    }
  }

  if (dryRun) {
    return result;
  }

  // Determine Herdr workspace
  let workspaceId = process.env.HERDR_WORKSPACE_ID || null;
  if (!workspaceId) {
    try {
      const wsRaw = execFileSync("herdr", ["workspace", "list"], { encoding: "utf8" });
      const wsJson = JSON.parse(wsRaw);
      const workspaces = wsJson?.result?.workspaces || [];
      const matched = workspaces.find((w) => w.cwd === repoRoot || w.label === path.basename(repoRoot));
      workspaceId = matched ? matched.workspace_id : (workspaces[0]?.workspace_id || null);
    } catch {}
  }

  const safePath = buildFleetEnvPath();

  // 4. Launch each non-active agent into a tab
  for (const agent of targetFleet) {
    const handle = agent.handle;
    if (activeHandles.has(handle)) {
      result.alreadyRunning.push(handle);
      continue;
    }

    try {
      // Create tab in Herdr targeting worktree
      const tabArgs = [
        "tab",
        "create",
        "--cwd",
        agent.worktree,
        "--label",
        handle,
        "--env",
        `PATH=${safePath}`,
        "--no-focus",
      ];
      if (workspaceId) {
        tabArgs.push("--workspace", workspaceId);
      }

      const tabOut = execFileSync("herdr", tabArgs, { encoding: "utf8" });
      const tabJson = JSON.parse(tabOut);
      const paneId = tabJson?.result?.root_pane?.pane_id;

      if (!paneId) {
        throw new Error(`Failed to acquire pane_id from herdr tab create: ${tabOut}`);
      }

      // Start the agent in the new pane with retry if the shell is still booting
      const startArgs = [
        "agent",
        "start",
        handle,
        "--kind",
        kind,
        "--pane",
        paneId,
        "--timeout",
        String(timeoutMs),
      ];

      if (customArgs.length > 0) {
        startArgs.push("--", ...customArgs);
      }

      let started = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 800));
          } else {
            await new Promise((r) => setTimeout(r, 1200));
          }
          execFileSync("herdr", startArgs, { encoding: "utf8" });
          started = true;
          result.launched.push({ handle, paneId, kind });
          break;
        } catch (err) {
          lastErr = err;
          if (err.message && err.message.includes("agent_pane_busy")) {
            continue;
          }
          break;
        }
      }

      if (!started) {
        result.failed.push({ handle, error: lastErr?.message || "Failed to start agent" });
      }
    } catch (err) {
      result.failed.push({ handle, error: err.message });
    }
  }

  return result;
}
