import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// ─── Standard MIME Types Dictionary ──────────────────────────────────────────

export const MIME_TYPES = {
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",

  // Text / Logs / Source
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".gd": "text/plain; charset=utf-8",
  ".tscn": "text/plain; charset=utf-8",
  ".tres": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",

  // Documents / Data
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",

  // Video (pilot: inline <video> playback, same-origin blob stream)
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
};

export function getMimeType(ext) {
  const normalized = (ext || "").toLowerCase();
  return MIME_TYPES[normalized] || "application/octet-stream";
}

// ─── Option A: Content-Addressed Storage (CAS) Blobstore ──────────────────────

export function getBlobsDir(amqRoot) {
  const dir = path.join(amqRoot, "blobs");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function computeSha256(bufferOrString) {
  return crypto.createHash("sha256").update(bufferOrString).digest("hex");
}

export function computeFileSha256(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return computeSha256(fileBuffer);
}

/**
 * Store a file or buffer into the content-addressed blobstore.
 * Storage structure: <amqRoot>/blobs/<prefix-2-chars>/<sha256><ext>
 */
export function storeBlob(input, amqRoot, originalName = "") {
  if (!amqRoot) throw new Error("amqRoot is required to store blobs");

  let contentBuffer;
  let filename = originalName;

  if (Buffer.isBuffer(input)) {
    contentBuffer = input;
  } else if (typeof input === "string") {
    if (fs.existsSync(input)) {
      contentBuffer = fs.readFileSync(input);
      if (!filename) filename = path.basename(input);
    } else {
      contentBuffer = Buffer.from(input, "utf8");
    }
  } else {
    throw new Error("Invalid input: expected Buffer, filePath string, or content string");
  }

  const sha256 = computeSha256(contentBuffer);
  const ext = filename ? path.extname(filename).toLowerCase() : "";
  const baseDir = getBlobsDir(amqRoot);
  const shardDir = path.join(baseDir, sha256.slice(0, 2));

  if (!fs.existsSync(shardDir)) {
    fs.mkdirSync(shardDir, { recursive: true });
  }

  const targetName = `${sha256}${ext}`;
  const targetPath = path.join(shardDir, targetName);

  // Write blob atomically if not already stored
  if (!fs.existsSync(targetPath)) {
    const tmpPath = `${targetPath}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, contentBuffer);
    fs.renameSync(tmpPath, targetPath);
  }

  const sizeBytes = contentBuffer.length;
  const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(ext);
  const isVideo = [".mp4", ".m4v", ".webm"].includes(ext);
  const isLog = [".log", ".txt", ".csv", ".json", ".out", ".diff", ".patch"].includes(ext);

  return {
    type: "blob",
    sha256,
    name: filename || `${sha256.slice(0, 10)}${ext}`,
    ext,
    mime: getMimeType(ext),
    sizeBytes,
    isImage,
    isVideo,
    isLog,
    exists: true,
    url: `/api/blob/${sha256}${ext ? `?ext=${encodeURIComponent(ext)}` : ""}`,
  };
}

/**
 * Locate an existing blob by its 64-char SHA256 hex string.
 * Strictly verifies hash syntax to prevent path traversal.
 */
export function getBlob(sha256, amqRoot) {
  if (!sha256 || !amqRoot) return null;
  const cleanHash = sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleanHash)) {
    return null;
  }

  const shardDir = path.join(getBlobsDir(amqRoot), cleanHash.slice(0, 2));
  if (!fs.existsSync(shardDir)) return null;

  try {
    const entries = fs.readdirSync(shardDir);
    const match = entries.find((file) => file.startsWith(cleanHash));
    if (!match) return null;

    const fullPath = path.join(shardDir, match);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return null;

    const ext = path.extname(match).toLowerCase();
    return {
      filePath: fullPath,
      sha256: cleanHash,
      name: match,
      ext,
      mime: getMimeType(ext),
      sizeBytes: stat.size,
    };
  } catch {
    return null;
  }
}

// ─── Option B: Git Commit & Object Pinning ────────────────────────────────────

const gitRefCache = new Map();
const headCommitCache = new Map();
const timestampCommitCache = new Map();

export function clearGitRefCache() {
  gitRefCache.clear();
  headCommitCache.clear();
  timestampCommitCache.clear();
}

/**
 * Resolve the git commit active before or at a given ISO timestamp.
 */
export function getCommitAtTimestamp(repoRoot, timestamp) {
  if (!repoRoot || !timestamp) return null;
  const iso = typeof timestamp === "string" ? timestamp.trim() : new Date(timestamp).toISOString();
  const cacheKey = `${repoRoot}:${iso}`;
  if (timestampCommitCache.has(cacheKey)) {
    return timestampCommitCache.get(cacheKey);
  }

  try {
    const commit = execFileSync("git", ["rev-list", "-n", "1", `--before=${iso}`, "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const result = commit && /^[a-f0-9]{7,40}$/i.test(commit) ? commit : null;
    timestampCommitCache.set(cacheKey, result);
    return result;
  } catch {
    timestampCommitCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Extract commit hashes explicitly mentioned in message text.
 */
export function extractMentionedCommits(text = "") {
  if (!text || typeof text !== "string") return [];
  const commits = [];
  const regex = /\b(?:commit|commitado|commitada|fixado|merge|sha|rev)?[:\s*`"'(]*([0-9a-f]{7,40})\b/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const hex = match[1].toLowerCase();
    if (/^[0-9]+$/.test(hex) && hex.length < 40) continue;
    if (!commits.includes(hex)) {
      commits.push(hex);
    }
  }
  return commits;
}

/**
 * Pin a repository file to a specific commit or HEAD.
 * Returns immutable git ref descriptor.
 */
export function pinGitRef(repoRoot, relativePath, commit = "HEAD") {
  if (!repoRoot || !relativePath) return null;

  const cleanRel = relativePath.replace(/^[/\\]+/, "");
  const cacheKey = `${repoRoot}:${commit}:${cleanRel}`;
  if (gitRefCache.has(cacheKey)) {
    return gitRefCache.get(cacheKey);
  }

  try {
    let commitSha;
    if (commit === "HEAD") {
      const cachedHead = headCommitCache.get(repoRoot);
      const now = Date.now();
      if (cachedHead && now - cachedHead.at < 5000) {
        commitSha = cachedHead.sha;
      } else {
        commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        headCommitCache.set(repoRoot, { sha: commitSha, at: now });
      }
    } else if (/^[a-f0-9]{40}$/i.test(commit)) {
      commitSha = commit;
    } else {
      commitSha = execFileSync("git", ["rev-parse", commit], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    }

    // Resolve git blob hash
    const blobSha = execFileSync("git", ["rev-parse", `${commitSha}:${cleanRel}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    // Get blob size
    const sizeStr = execFileSync("git", ["cat-file", "-s", blobSha], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const sizeBytes = parseInt(sizeStr, 10) || 0;

    const ext = path.extname(cleanRel).toLowerCase();
    const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(ext);
    const isVideo = [".mp4", ".m4v", ".webm"].includes(ext);
    const isLog = [".log", ".txt", ".csv", ".json", ".out", ".diff", ".patch"].includes(ext);

    const ref = {
      type: "git",
      commit: commitSha,
      shortCommit: commitSha.slice(0, 10),
      blob: blobSha,
      path: cleanRel,
      name: path.basename(cleanRel),
      ext,
      mime: getMimeType(ext),
      sizeBytes,
      isImage,
      isVideo,
      isLog,
      exists: true,
      url: `/api/git-file?commit=${commitSha}&path=${encodeURIComponent(cleanRel)}`,
    };
    gitRefCache.set(cacheKey, ref);
    return ref;
  } catch {
    gitRefCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Read file content strictly from git object database.
 */
export function readGitRef(repoRoot, commitSha, relativePath) {
  if (!repoRoot || !commitSha || !relativePath) return null;

  // Validate commit SHA syntax
  if (!/^[a-f0-9]{7,40}$/i.test(commitSha.trim())) {
    return null;
  }

  // Reject path traversal tokens
  const cleanRel = relativePath.replace(/^[/\\]+/, "");
  if (cleanRel.includes("..") || path.isAbsolute(cleanRel)) {
    return null;
  }

  try {
    const buffer = execFileSync("git", ["show", `${commitSha}:${cleanRel}`], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 50 * 1024 * 1024, // 50MB limit
    });

    const ext = path.extname(cleanRel).toLowerCase();
    return {
      buffer,
      sizeBytes: buffer.length,
      mime: getMimeType(ext),
      ext,
      name: path.basename(cleanRel),
    };
  } catch {
    return null;
  }
}

// ─── Unified Attachment Ingestion (Hybrid Option A + B) ───────────────────────

/**
 * Ingest or resolve an attachment candidate safely.
 * - Ephemeral files (like /tmp/*) are automatically copied into the CAS blobstore.
 * - Committed files in repoRoot can be pinned to git HEAD.
 * - Already pinned/stored items retain their immutable URLs.
 */
export function ingestAttachment(candidate, amqRoot, repoRoot, { timestamp = null, text = "" } = {}) {
  if (!candidate) return null;

  // Already a structured descriptor
  if (typeof candidate === "object") {
    if (candidate.type === "blob" && candidate.sha256) {
      const stored = getBlob(candidate.sha256, amqRoot);
      if (stored) {
        return {
          ...candidate,
          exists: true,
          sizeBytes: stored.sizeBytes,
          url: `/api/blob/${candidate.sha256}${candidate.ext ? `?ext=${encodeURIComponent(candidate.ext)}` : ""}`,
        };
      }
    }

    if (candidate.type === "git" && candidate.commit && candidate.path) {
      return {
        ...candidate,
        exists: true,
        url: `/api/git-file?commit=${candidate.commit}&path=${encodeURIComponent(candidate.path)}`,
      };
    }

    if (candidate.path) {
      return ingestAttachment(candidate.path, amqRoot, repoRoot, { timestamp, text });
    }
  }

  // String path or reference
  if (typeof candidate === "string") {
    const raw = candidate.trim();
    if (!raw) return null;

    // Check if it's already a blob hash reference: blob:<sha256> or <sha256>
    const hashMatch = raw.match(/^(?:blob:)?([a-f0-9]{64})$/i);
    if (hashMatch) {
      const stored = getBlob(hashMatch[1], amqRoot);
      if (stored) {
        return {
          type: "blob",
          sha256: stored.sha256,
          name: stored.name,
          ext: stored.ext,
          mime: stored.mime,
          sizeBytes: stored.sizeBytes,
          exists: true,
          url: `/api/blob/${stored.sha256}${stored.ext ? `?ext=${encodeURIComponent(stored.ext)}` : ""}`,
        };
      }
    }

    // Check if file exists on disk
    let diskPath = null;
    if (fs.existsSync(raw) && fs.statSync(raw).isFile()) {
      diskPath = path.resolve(raw);
    } else if (repoRoot) {
      const candidateInRepo = path.resolve(repoRoot, raw);
      if (fs.existsSync(candidateInRepo) && fs.statSync(candidateInRepo).isFile()) {
        diskPath = candidateInRepo;
      }
    }

    if (diskPath && amqRoot) {
      // Is it an ephemeral file (e.g. in /tmp, /var/tmp, or scratch)?
      const isEphemeral = diskPath.startsWith("/tmp") || diskPath.includes("/scratch/");

      if (isEphemeral) {
        // Freeze it forever into the AMQ blobstore!
        return storeBlob(diskPath, amqRoot, path.basename(diskPath));
      }

      // If it's inside repoRoot and git is present, pin to commit at timestamp (or HEAD)
      if (repoRoot && diskPath.startsWith(repoRoot)) {
        const rel = path.relative(repoRoot, diskPath);
        const commit = (timestamp ? getCommitAtTimestamp(repoRoot, timestamp) : null) || "HEAD";
        const gitRef = pinGitRef(repoRoot, rel, commit);
        if (gitRef) return gitRef;
      }

      // Default fallback for existing files: store into blobstore for guarantee
      return storeBlob(diskPath, amqRoot, path.basename(diskPath));
    }

    // ─── Historical Git Pinning Fallback ───
    // If the file does not exist on disk right now (e.g. deleted or renamed in subsequent commits),
    // check if it existed in Git at the time the message was created or at a commit mentioned in the message!
    if (!diskPath && repoRoot) {
      const cleanRel = raw.startsWith(repoRoot) ? path.relative(repoRoot, raw) : raw.replace(/^[/\\]+/, "");
      if (!cleanRel.includes("..") && !path.isAbsolute(cleanRel)) {
        const candidateCommits = [];
        if (text) {
          candidateCommits.push(...extractMentionedCommits(text));
        }
        if (timestamp) {
          const atTime = getCommitAtTimestamp(repoRoot, timestamp);
          if (atTime && !candidateCommits.includes(atTime)) {
            candidateCommits.push(atTime);
          }
        }
        candidateCommits.push("HEAD");

        for (const commitSha of candidateCommits) {
          const gitRef = pinGitRef(repoRoot, cleanRel, commitSha);
          if (gitRef && gitRef.exists) {
            return {
              ...gitRef,
              pinnedAt: timestamp || null,
            };
          }
        }
      }
    }
  }

  return null;
}
