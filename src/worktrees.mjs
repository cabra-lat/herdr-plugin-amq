import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * List all git worktrees in the target repository
 */
export function listWorktrees(repoRoot) {
  if (!repoRoot || !fs.existsSync(repoRoot)) return [];

  try {
    const raw = execSync("git worktree list --porcelain", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const worktrees = [];
    let current = {};

    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        if (current.path) {
          worktrees.push(current);
          current = {};
        }
        continue;
      }

      if (line.startsWith("worktree ")) {
        current.path = line.slice(9).trim();
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5).trim();
      } else if (line.startsWith("branch ")) {
        const fullBranch = line.slice(7).trim();
        current.branch = fullBranch.replace(/^refs\/heads\//, "");
      } else if (line.startsWith("bare")) {
        current.isBare = true;
      } else if (line.startsWith("detached")) {
        current.isDetached = true;
      }
    }

    if (current.path) {
      worktrees.push(current);
    }

    // Associate worktree with agent handle if located in .worktrees/<handle>
    return worktrees.map((wt) => {
      const isMain = path.resolve(wt.path) === path.resolve(repoRoot);
      let agent = null;
      if (wt.path.includes(".worktrees")) {
        agent = path.basename(wt.path);
      }
      return {
        ...wt,
        isMain,
        agent,
      };
    });
  } catch (err) {
    return [];
  }
}

/**
 * Create a new git worktree for an agent
 */
export function createWorktree(repoRoot, { handle, branch, baseBranch = "main" }) {
  if (!repoRoot || !fs.existsSync(repoRoot)) {
    return { ok: false, error: "Invalid repository root" };
  }

  const safeHandle = (handle || "agent").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const branchName = branch ? branch.trim() : `agent/${safeHandle}`;
  const targetDir = path.join(repoRoot, ".worktrees", safeHandle);

  if (fs.existsSync(targetDir)) {
    return { ok: false, error: `Worktree directory already exists: ${targetDir}` };
  }

  // Ensure parent .worktrees dir exists
  const worktreesParent = path.join(repoRoot, ".worktrees");
  if (!fs.existsSync(worktreesParent)) {
    fs.mkdirSync(worktreesParent, { recursive: true });
  }

  try {
    // Check if branch already exists
    let branchExists = false;
    try {
      execSync(`git show-ref --verify --quiet refs/heads/${branchName}`, {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"],
      });
      branchExists = true;
    } catch {}

    const cmd = branchExists
      ? `git worktree add "${targetDir}" "${branchName}"`
      : `git worktree add -b "${branchName}" "${targetDir}" "${baseBranch}"`;

    execSync(cmd, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return {
      ok: true,
      path: targetDir,
      branch: branchName,
      handle: safeHandle,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Remove an existing git worktree
 */
export function removeWorktree(repoRoot, { targetPath, force = false }) {
  if (!repoRoot || !fs.existsSync(repoRoot)) {
    return { ok: false, error: "Invalid repository root" };
  }

  if (!targetPath) {
    return { ok: false, error: "Missing target worktree path" };
  }

  const resolved = path.resolve(targetPath);
  const mainRepo = path.resolve(repoRoot);

  if (resolved === mainRepo) {
    return { ok: false, error: "Cannot remove the primary worktree" };
  }

  try {
    const flag = force ? "--force" : "";
    execSync(`git worktree remove ${flag} "${resolved}"`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Prune stale worktree references
    try {
      execSync("git worktree prune", {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {}

    return { ok: true, removed: resolved };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Ensure an agent has a dedicated git worktree for safe concurrent execution.
 * If the worktree already exists, returns its information.
 * If not, creates it at .worktrees/<handle>.
 */
export function ensureAgentWorktree(repoRoot, handle, branch) {
  if (!repoRoot || !fs.existsSync(repoRoot)) {
    return { ok: false, error: "Invalid repository root" };
  }

  const safeHandle = (handle || "agent").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const targetDir = path.join(repoRoot, ".worktrees", safeHandle);

  // Check existing worktrees
  const existing = listWorktrees(repoRoot);
  const found = existing.find(
    (wt) => path.resolve(wt.path) === path.resolve(targetDir) || wt.agent === safeHandle
  );
  if (found) {
    return {
      ok: true,
      path: found.path,
      branch: found.branch || `agent/${safeHandle}`,
      handle: safeHandle,
      existed: true,
    };
  }

  // If directory exists on disk, treat as established
  if (fs.existsSync(targetDir)) {
    return {
      ok: true,
      path: targetDir,
      branch: branch || `agent/${safeHandle}`,
      handle: safeHandle,
      existed: true,
    };
  }

  // Create new worktree
  return createWorktree(repoRoot, {
    handle: safeHandle,
    branch: branch || `agent/${safeHandle}`,
  });
}

/**
 * Ensure worktrees for an array of agent handles
 */
export function ensureAllWorktrees(repoRoot, handles = []) {
  const results = [];
  for (const h of handles) {
    results.push(ensureAgentWorktree(repoRoot, h));
  }
  return results;
}
