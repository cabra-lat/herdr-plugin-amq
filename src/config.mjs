import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function getHerdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function getStateDir() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR || path.join(process.env.HOME || "/tmp", ".herdr-amq-state");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getRepoRootFromAmq(amqRoot) {
  if (!amqRoot) return process.cwd();
  return path.basename(amqRoot) === ".agent-mail"
    ? path.resolve(path.dirname(amqRoot))
    : path.resolve(amqRoot);
}

export function getConfigDir() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(process.env.HOME || "/tmp", ".herdr-amq-config");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
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
      if (fs.existsSync(mailDir)) return mailDir;
    }
  }

  // 3. Search up from current directory
  let curr = path.resolve(cwd);
  while (curr !== path.dirname(curr)) {
    const mailDir = path.join(curr, ".agent-mail");
    if (fs.existsSync(mailDir)) return mailDir;
    curr = path.dirname(curr);
  }

  // 4. Fallback in process.cwd()
  const cwdMailDir = path.join(process.cwd(), ".agent-mail");
  if (fs.existsSync(cwdMailDir)) {
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
