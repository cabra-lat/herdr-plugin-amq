import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getPluginVersion() {
  try {
    const pkgPath = path.resolve(__dirname, "../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      return pkg.version || "unknown";
    }
  } catch {}
  return "unknown";
}

export function getHerdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function getStateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) {
    const dir = process.env.HERDR_PLUGIN_STATE_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const legacyDir = path.join(process.env.HOME || "/tmp", ".herdr-amq-state");
  if (fs.existsSync(legacyDir)) {
    return legacyDir;
  }
  const base = process.env.XDG_STATE_HOME || path.join(process.env.HOME || "/tmp", ".local", "state");
  const dir = path.join(base, "herdr-amq");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Report the state directories that exist, so a split state directory is visible
 * instead of silently reading a file nothing is writing.
 *
 * `getStateDir()` resolves to `$HERDR_PLUGIN_STATE_DIR` when that is set (true for a
 * process herdr spawned) and to `~/.herdr-amq-state` otherwise (true for one started
 * from an interactive shell). Two processes started from different contexts can
 * therefore use two different state files, and a comparison of one against the other
 * produces a confident and completely wrong conclusion about delivery history.
 */
export function getStateDirCandidates(env = process.env, home = env.HOME || "/tmp") {
  const dirs = [];
  if (env.HERDR_PLUGIN_STATE_DIR) dirs.push(env.HERDR_PLUGIN_STATE_DIR);
  dirs.push(path.join(home, ".herdr-amq-state"));
  const base = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  dirs.push(path.join(base, "herdr-amq"));
  const herdrPlugins = path.join(base, "herdr", "plugins", "cabra.amq");
  dirs.push(herdrPlugins);
  const seen = new Set();
  return dirs.filter((dir) => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

export function getStateDirDivergence(env = process.env) {
  const home = env.HOME || "/tmp";
  const withState = getStateDirCandidates(env, home).filter((dir) => fs.existsSync(path.join(dir, "bridge-state.json")));
  if (withState.length < 2) return null;
  return { active: getStateDir(), directories: withState };
}

export function getRepoRootFromAmq(amqRoot) {
  if (!amqRoot) return process.cwd();
  return path.basename(amqRoot) === ".agent-mail"
    ? path.resolve(path.dirname(amqRoot))
    : path.resolve(amqRoot);
}

export function getConfigDir() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const legacyDir = path.join(process.env.HOME || "/tmp", ".herdr-amq-config");
  if (fs.existsSync(legacyDir)) {
    return legacyDir;
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "/tmp", ".config");
  const dir = path.join(base, "herdr-amq");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

const COORDINATOR_DOORBELL_FILE = "coordinator-doorbell.json";

export function getCoordinatorDoorbellConfig() {
  const file = path.join(getConfigDir(), COORDINATOR_DOORBELL_FILE);
  // escalationTo and deadlineMs back the alert deadline. BOTH DEFAULT TO OFF, and that is the
  // point: a deadline with no named recipient would escalate to a default audience, and escalating to
  // an audience that cannot act is a re-announcement with a timer on it. Absent, the feature is inert.
  const defaults = { enabled: true, cooldownMs: 300000, escalationTo: null, deadlineMs: 0 };
  if (!fs.existsSync(file)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      enabled: parsed.enabled !== false,
      cooldownMs: Number.isFinite(Number(parsed.cooldownMs)) && Number(parsed.cooldownMs) >= 0 ? Number(parsed.cooldownMs) : defaults.cooldownMs,
      escalationTo: typeof parsed.escalationTo === "string" && parsed.escalationTo.trim() ? parsed.escalationTo.trim() : defaults.escalationTo,
      deadlineMs: Number.isFinite(Number(parsed.deadlineMs)) && Number(parsed.deadlineMs) > 0 ? Number(parsed.deadlineMs) : defaults.deadlineMs,
    };
  } catch {
    return defaults;
  }
}

export function saveCoordinatorDoorbellConfig(patch = {}) {
  const current = getCoordinatorDoorbellConfig();
  const next = {
    enabled: patch.enabled === undefined ? current.enabled : Boolean(patch.enabled),
    cooldownMs: patch.cooldownMs === undefined ? current.cooldownMs : Math.max(0, Number(patch.cooldownMs) || 0),
    escalationTo: patch.escalationTo === undefined ? current.escalationTo : (String(patch.escalationTo).trim() || null),
    deadlineMs: patch.deadlineMs === undefined ? current.deadlineMs : Math.max(0, Number(patch.deadlineMs) || 0),
  };
  const file = path.join(getConfigDir(), COORDINATOR_DOORBELL_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

export function getContext() {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getEventContext() {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve the active AMQ queue root (.agent-mail)
 */
/**
 * True when a candidate mailbox lives INSIDE another mailbox.
 *
 * `<root>/.agent-mail/.agent-mail` is a scaffold, not a second project. It appears whenever
 * something creates a queue relative to a cwd that is already inside a queue - which is exactly
 * what "run the tool from the project directory" invites once a project directory CONTAINS its
 * mailbox. Accepting it is not a partial result: the nested root is empty, so every caller
 * silently sees no agents, no messages and no cards, and reports a healthy empty board.
 *
 * On this machine there is exactly one real mailbox and one such scaffold, and resolving from a
 * cwd inside the mailbox returned the SCAFFOLD. With one mailbox that is a wrong answer; the moment
 * a second project exists, a tool walking up from the wrong directory picks a mailbox by
 * accident and there is nothing in the result that says so.
 */
function isNestedMailbox(dir) {
  return path.basename(path.dirname(dir)) === ".agent-mail";
}

/**
 * The OUTERMOST mailbox at or above `from`.
 *
 * A candidate that is itself nested is skipped rather than returned, so resolution walks
 * past a scaffold and finds the real queue instead of an empty one. Skipping, not erroring: a
 * genuinely nested-only tree has no outer mailbox, and refusing to resolve would be a worse
 * answer than resolving to the only one present.
 */
function outermostMailboxAtOrAbove(from) {
  let curr = path.resolve(from);
  for (;;) {
    const mailDir = path.join(curr, ".agent-mail");
    if (fs.existsSync(mailDir) && !isNestedMailbox(mailDir)) return mailDir;
    if (curr === path.dirname(curr)) return null;
    curr = path.dirname(curr);
  }
}

export function findAmqRoot(cwd = process.cwd()) {
  // 1. Explicit env var
  if (process.env.AM_ROOT && fs.existsSync(process.env.AM_ROOT)) {
    return path.resolve(process.env.AM_ROOT);
  }

  // 2. Context from Herdr workspace / worktree
  const ctx = getContext();
  if (ctx) {
    const candidates = [
      ctx.worktree?.checkout_path,
      ctx.worktree?.repo_root,
      ctx.workspace?.tokens?.cwd,
      ctx.cwd,
    ].filter(Boolean);

    for (const dir of candidates) {
      const mailDir = path.join(dir, ".agent-mail");
      if (fs.existsSync(mailDir) && !isNestedMailbox(mailDir)) return mailDir;
    }
  }

  // 3. Search up from current directory, walking PAST any nested scaffold rather than into it.
  const outermost = outermostMailboxAtOrAbove(cwd);
  if (outermost) return outermost;

  // 4. Fallback in process.cwd()
  const cwdMailDir = path.join(process.cwd(), ".agent-mail");
  if (fs.existsSync(cwdMailDir) && !isNestedMailbox(cwdMailDir)) {
    return cwdMailDir;
  }

  return null;
}

/**
 * Retrieve list of registered agent handles for the given queue root
 */
export function getAgentHandles(amqRoot) {
  if (!amqRoot || !fs.existsSync(amqRoot)) return [];

  // Check config.json locations
  for (const configPath of [
    path.join(amqRoot, "meta", "config.json"),
    path.join(amqRoot, "config.json"),
  ]) {
    if (fs.existsSync(configPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (Array.isArray(parsed.agents)) {
          return parsed.agents
            .map((a) => (typeof a === "string" ? a : a.handle))
            .filter(Boolean);
        }
      } catch {}
    }
  }

  // Fallback: list agent folders
  const agentsDir = path.join(amqRoot, "agents");
  if (fs.existsSync(agentsDir)) {
    try {
      return fs.readdirSync(agentsDir).filter((name) => {
        return fs.statSync(path.join(agentsDir, name)).isDirectory() && !name.startsWith(".");
      });
    } catch {}
  }

  return [];
}

/**
 * Execute command with PATH updated to include ~/.local/bin
 */
export function execCmd(bin, args, options = {}) {
  const env = {
    ...process.env,
    PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ""}`,
    ...(options.env || {}),
  };

  return execFileSync(bin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
    env,
  });
}
