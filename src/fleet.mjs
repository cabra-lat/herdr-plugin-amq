import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
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
      model: persona.model || null,
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

  return Array.from(new Set(paths.filter(Boolean))).join(path.delimiter);
}

function filterPersonas(fleet, filter) {
  if (!filter) return fleet;
  const selected = new Set(
    (Array.isArray(filter) ? filter : filter.split(","))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return fleet.filter((agent) => selected.has(agent.handle.toLowerCase()));
}

function pathsMatch(left, right) {
  if (!left || !right) return false;
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function matchingFleetPanes(agent, liveAgents) {
  return liveAgents.filter((live) => (
    live.name === agent.handle && pathsMatch(live.cwd, agent.worktree)
  ));
}

function runHerdr(args, execHerdr) {
  if (execHerdr) return execHerdr(args);
  return execFileSync("herdr", args, { encoding: "utf8" });
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function defaultLaunchArgs(kind, handle) {
  if (kind === "agy") return ["--dangerously-skip-permissions"];
  if (kind === "opencode") return ["--agent", handle, "--auto"];
  return [];
}

export function resolveExecutable(name, envPath = buildFleetEnvPath()) {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {}
  }
  return null;
}

function validModel(model) {
  return typeof model === "string" && /^[^\s/]+\/[^\s/]+/.test(model) ? model : null;
}

export function readOpencodeModel(worktree) {
  for (const relativePath of ["opencode.json", path.join(".opencode", "opencode.json")]) {
    const configPath = path.join(worktree, relativePath);
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const model = validModel(config.model);
      if (model) return model;
    } catch {}
  }
  return null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

export function createOpencodeLauncher(handle, model, executable) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-amq-opencode-"));
  const binDir = path.join(root, handle.replace(/[^a-zA-Z0-9._-]/g, "_"));
  fs.mkdirSync(binDir, { recursive: true });
  const agentConfig = { mode: "all" };
  const selectedModel = validModel(model);
  if (selectedModel) agentConfig.model = selectedModel;
  const config = JSON.stringify({ agent: { [handle]: agentConfig } });
  const launcher = path.join(binDir, "opencode");
  fs.writeFileSync(
    launcher,
    `#!/bin/sh\nexport OPENCODE_CONFIG_CONTENT=${shellQuote(config)}\nexec ${shellQuote(executable)} "$@"\n`,
    { mode: 0o700 },
  );
  return { root, binDir, launcher, config };
}

export async function stopFleet(amqRoot, repoRoot, options = {}) {
  const personas = discoverFleetPersonas(repoRoot);
  const fleet = [...personas.values()].map((agent) => ({
    ...agent,
    worktree: path.join(repoRoot, ".worktrees", agent.handle),
  }));
  const targetFleet = filterPersonas(fleet, options.agents);
  const kind = options.kind || null;
  const dryRun = Boolean(options.dryRun);
  const getLiveAgents = options.getLiveAgents || getHerdrAgents;
  const execHerdr = options.execHerdr || null;
  const liveAgents = await getLiveAgents();
  const result = {
    total: targetFleet.length,
    stopped: [],
    wouldStop: [],
    skipped: [],
    failed: [],
    dryRun,
  };

  for (const agent of targetFleet) {
    const panes = matchingFleetPanes(agent, liveAgents);
    const selected = kind ? panes.filter((pane) => pane.agent === kind) : panes;
    if (selected.length === 0) {
      if (panes.length > 0) {
        result.skipped.push({ handle: agent.handle, reason: `kind is ${panes.map((pane) => pane.agent).join(", ")}` });
      }
      continue;
    }
    if (dryRun) {
      result.wouldStop.push(...selected.map((pane) => ({ handle: agent.handle, paneId: pane.pane_id, kind: pane.agent })));
      continue;
    }
    for (const pane of selected) {
      try {
        runHerdr(["pane", "close", pane.pane_id], execHerdr);
        result.stopped.push({ handle: agent.handle, paneId: pane.pane_id, kind: pane.agent });
      } catch (error) {
        result.failed.push({ handle: agent.handle, paneId: pane.pane_id, error: error.message });
      }
    }
  }

  return result;
}

/**
 * Launch or recover the agent fleet inside Herdr
 */
export async function launchFleet(amqRoot, repoRoot, options = {}) {
  const kind = options.kind || "agy";
  const dryRun = Boolean(options.dryRun);
  const timeoutMs = options.timeout || 25000;
  const replace = options.replace !== false;
  const prepopulate = options.prepopulate || prepopulateFleet;
  const getLiveAgents = options.getLiveAgents || getHerdrAgents;
  const execHerdr = options.execHerdr || null;
  const sleep = options.sleep || waitFor;
  const safePath = options.envPath || buildFleetEnvPath();
  const configuredArgs = options.args == null
    ? defaultLaunchArgs(kind, "")
    : Array.isArray(options.args) ? options.args : [String(options.args)];
  const fleet = prepopulate(amqRoot, repoRoot);
  const targetFleet = filterPersonas(fleet, options.agents);
  const result = {
    total: targetFleet.length,
    prepopulated: targetFleet.map((agent) => agent.handle),
    alreadyRunning: [],
    replaced: [],
    wouldReplace: [],
    wouldLaunch: [],
    blocked: [],
    launched: [],
    failed: [],
    dryRun,
  };
  const liveAgents = await getLiveAgents();
  const launcherRoots = new Set();
  // A fleet command can be issued from inside an agent pane. Never launch a
  // second copy of the agent that is running the command; the existing pane
  // is already the canonical one for that handle.
  const currentHandle = process.env.HERDR_AGENT_HANDLE || process.env.AMQ_AGENT_HANDLE || "";
  let workspaceId = process.env.HERDR_WORKSPACE_ID || null;
  let workspaceLookupAttempted = Boolean(workspaceId);

  try {
    for (const agent of targetFleet) {
      const handle = agent.handle;
      if (currentHandle && currentHandle === handle) {
        result.alreadyRunning.push(handle);
        continue;
      }
      const panes = matchingFleetPanes(agent, liveAgents);
      const matchingKind = panes.filter((pane) => pane.agent === kind);

      if (matchingKind.length > 0) {
        result.alreadyRunning.push(handle);
        for (const duplicate of matchingKind.slice(1)) {
          try {
            runHerdr(["pane", "close", duplicate.pane_id], execHerdr);
          } catch (error) {
            result.failed.push({ handle, error: error.message });
          }
        }
        continue;
      }

      if (panes.length > 0) {
        if (dryRun) {
          result.wouldReplace.push(handle);
          continue;
        }
        if (!replace) {
          result.blocked.push({ handle, reason: `already running as ${panes.map((pane) => pane.agent).join(", ")}` });
          continue;
        }
        try {
          for (const pane of panes) {
            runHerdr(["pane", "close", pane.pane_id], execHerdr);
          }
          await sleep(300);
          result.replaced.push({
            handle,
            fromKinds: panes.map((pane) => pane.agent),
            paneIds: panes.map((pane) => pane.pane_id),
          });
        } catch (error) {
          result.failed.push({ handle, error: error.message });
          continue;
        }
      }

      if (dryRun) {
        result.wouldLaunch.push(handle);
        continue;
      }

      if (!workspaceLookupAttempted) {
        workspaceLookupAttempted = true;
        try {
          const workspaceOutput = runHerdr(["workspace", "list"], execHerdr);
          const workspaceJson = JSON.parse(workspaceOutput);
          const workspaces = workspaceJson?.result?.workspaces || [];
          const matched = workspaces.find((workspace) => workspace.cwd === repoRoot || workspace.label === path.basename(repoRoot));
          workspaceId = matched ? matched.workspace_id : (workspaces[0]?.workspace_id || null);
        } catch {}
      }

      let paneId;
      try {
        let launchPath = safePath;
        if (kind === "opencode") {
          const executable = options.opencodeExecutable || resolveExecutable("opencode", safePath);
          if (!executable) throw new Error("OpenCode executable not found in fleet PATH");
          const createLauncher = options.createOpencodeLauncher || createOpencodeLauncher;
          const launcher = createLauncher(handle, readOpencodeModel(agent.worktree), executable);
          launcherRoots.add(launcher.root);
          launchPath = `${launcher.binDir}${path.delimiter}${safePath}`;
        }

        const tabArgs = [
          "tab",
          "create",
          "--cwd",
          agent.worktree,
          "--label",
          handle,
          "--env",
          `PATH=${launchPath}`,
          // Make the identity available inside the launched process as well as
          // in Herdr's pane record. Without this, Pi/OpenCode agents cannot
          // tell which AMQ mailbox they own and may drain the wrong inbox.
          "--env",
          `HERDR_AGENT_HANDLE=${handle}`,
          "--env",
          `AMQ_AGENT_HANDLE=${handle}`,
          "--no-focus",
        ];
        if (workspaceId) tabArgs.push("--workspace", workspaceId);
        const tabOutput = runHerdr(tabArgs, execHerdr);
        const tabJson = JSON.parse(tabOutput);
        paneId = tabJson?.result?.root_pane?.pane_id;
        if (!paneId) throw new Error(`Failed to acquire pane_id from herdr tab create: ${tabOutput}`);

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
        const launchArgs = kind === "opencode" && options.args == null
          ? defaultLaunchArgs(kind, handle)
          : configuredArgs;
        if (launchArgs.length > 0) startArgs.push("--", ...launchArgs);

        let started = false;
        let lastError = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await sleep(attempt === 0 ? 800 : 1200);
            runHerdr(startArgs, execHerdr);
            started = true;
            result.launched.push({ handle, paneId, kind });
            break;
          } catch (error) {
            lastError = error;
            if (error.message && error.message.includes("agent_pane_busy")) continue;
            break;
          }
        }
        if (!started) {
          throw lastError || new Error("Failed to start agent");
        }
      } catch (error) {
        result.failed.push({ handle, error: error.message || String(error) });
        if (paneId) {
          try {
            runHerdr(["pane", "close", paneId], execHerdr);
          } catch {}
        }
      }
    }
  } finally {
    for (const root of launcherRoots) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    }
  }

  return result;
}
