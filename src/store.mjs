import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execCmd, getHerdrBin, getAgentHandles, getRepoRootFromAmq } from "./config.mjs";
import { scanAgentBriefs, getAgentBrief, saveAgentBrief } from "./briefs.mjs";
import { ingestAttachment } from "./blobs.mjs";
import { sendMaildirMessage, replyMaildirMessage, drainMaildir, ensureAgentMailbox, findMessageForRecipient, isSafeMailIdentifier, readMaildirMessageFile, writeBoundedFileAtomic } from "./protocol.mjs";
import { renderLocalTemplate } from "./templates.mjs";

const PALETTE = [
  "#1a73e8", "#ea4335", "#fbbc05", "#34a853", "#ff6d00",
  "#9c27b0", "#009688", "#e91e63", "#3f51b5", "#00bcd4",
  "#795548", "#607d8b", "#673ab7", "#2e7d32", "#c2185b"
];
const LEGACY_PLACEHOLDER_MODEL = "gemini 3.8 flash (high)";

export function getAgentColor(handle = "") {
  let hash = 0;
  for (let i = 0; i < handle.length; i++) {
    hash = (hash << 5) - hash + handle.charCodeAt(i);
    hash |= 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function formatAgentTitle(handle = "") {
  if (!handle) return "Agent";
  if (handle.toLowerCase() === "user") return "User";
  return handle
    .split(/[-_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const filePathCache = new Map();
let cacheTimestamp = 0;

export function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isPathSafe(filePath, repoRoot, amqRoot) {
  if (!filePath || typeof filePath !== "string") return false;
  const normalized = path.resolve(filePath);
  const lower = normalized.toLowerCase();

  const forbidden = [
    "/.ssh",
    "/.env",
    "/.git",
    "/etc/",
    "/proc/",
    "/sys/",
    "/root",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "credentials",
    ".pem",
    ".key",
    ".bash_history",
  ];
  for (const f of forbidden) {
    if (lower.includes(f)) return false;
  }

  const base = path.basename(normalized);
  if (base.startsWith(".") && base !== ".agent-mail") return false;

  const allowedRoots = [
    path.resolve(os.tmpdir()),
    "/tmp",
    "/private/tmp",
    path.resolve(repoRoot || process.cwd()),
    path.resolve(amqRoot || process.cwd()),
  ];

  return allowedRoots.some((allowed) => {
    return normalized === allowed || normalized.startsWith(allowed + path.sep);
  });
}

/**
 * Resolve relative or bare file references to actual files on disk
 */
export function resolveAttachmentPath(ref, amqRoot) {
  if (!ref || typeof ref !== "string") return null;
  const clean = ref.trim().replace(/^["'<(\[]+|[>"')\],;:]+$/g, "");
  if (!clean) return null;

  const repoRoot = getRepoRootFromAmq(amqRoot);
  const now = Date.now();
  if (now - cacheTimestamp > 30000) {
    filePathCache.clear();
    cacheTimestamp = now;
  }

  const cacheKey = `${repoRoot}::${clean}`;
  if (filePathCache.has(cacheKey)) {
    return filePathCache.get(cacheKey);
  }

  function testFile(p) {
    try {
      if (!isPathSafe(p, repoRoot, amqRoot)) return null;
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const resolved = path.resolve(p);
        filePathCache.set(cacheKey, resolved);
        return resolved;
      }
    } catch {}
    return null;
  }

  // 1. Direct path check (if absolute or starts with /)
  if (clean.startsWith("/")) {
    const res = testFile(clean);
    if (res) return res;
  }

  // 2. Relative to repoRoot
  const fromRepo = testFile(path.join(repoRoot, clean));
  if (fromRepo) return fromRepo;

  // 3. In os.tmpdir() or os.tmpdir()/shooter
  const base = path.basename(clean);
  const fromTmpSub = testFile(path.join(os.tmpdir(), "shooter", base));
  if (fromTmpSub) return fromTmpSub;

  const fromTmp = testFile(path.join(os.tmpdir(), base));
  if (fromTmp) return fromTmp;

  // 4. In amqRoot/attachments
  if (amqRoot) {
    const fromAmqAtt = testFile(path.join(amqRoot, "attachments", base));
    if (fromAmqAtt) return fromAmqAtt;
  }

  // 5. Common subdirectories in repo
  const subdirs = [
    "src",
    "test",
    "docs",
    "tools",
    "scripts",
    "resources",
    "scenes",
    "assets",
  ];
  for (const sub of subdirs) {
    const candidate = testFile(path.join(repoRoot, sub, base));
    if (candidate) return candidate;
  }

  // 6. Not found in standard locations: cache null
  filePathCache.set(cacheKey, null);
  return null;
}

/**
 * Extract attachments and referenced images/logs from body or frontmatter,
 * verifying presence on disk and providing existence flags.
 */
export function extractAttachments(body = "", metaAttachments = [], amqRoot = null, meta = {}) {
  // If attachments are already structured and resolved (e.g. via migration or sendMaildirMessage), return directly
  if (Array.isArray(metaAttachments) && metaAttachments.length > 0) {
    const isStructured = metaAttachments.every(
      (a) => typeof a === "object" && a !== null && (a.type === "blob" || a.type === "git" || a.exists !== undefined)
    );
    if (isStructured) {
      return metaAttachments.map((a) => ({
        ...a,
        originalRef: a.originalRef || a.path || a.name,
        sizeDisplay: a.sizeDisplay || (a.exists ? formatFileSize(a.sizeBytes || 0) : "Missing on disk"),
      }));
    }
  }

  const attachments = [];
  const seen = new Set();
  const repoRoot = getRepoRootFromAmq(amqRoot);

  function addCandidate(rawRef) {
    if (!rawRef) return;
    let clean = typeof rawRef === "string" ? rawRef.trim().replace(/^["'<(\[]+|[>"')\],;:]+$/g, "") : "";
    if (typeof rawRef === "object" && rawRef !== null) {
      if (rawRef.type === "git" || rawRef.type === "blob") {
        attachments.push(rawRef);
        return;
      }
      clean = rawRef.path || rawRef.sha256 || rawRef.name || "";
    }
    if (!clean || seen.has(clean) || clean.startsWith("http://") || clean.startsWith("https://")) {
      return;
    }
    seen.add(clean);

    const base = path.basename(clean);
    if (["config.json", "package.json", "pyproject.toml", "Cargo.toml", "flake.lock"].includes(base)) {
      return;
    }

    const ext = path.extname(clean).toLowerCase();
    const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(ext);
    const isLog = [".log", ".txt", ".csv", ".json", ".out", ".diff", ".patch"].includes(ext);

    // 1. Check disk resolution first (sub-millisecond)
    const resolved = resolveAttachmentPath(clean, amqRoot);
    if (resolved) {
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(resolved).size;
      } catch {}

      attachments.push({
        path: resolved,
        originalRef: clean,
        name: base,
        ext,
        isImage,
        isLog,
        exists: true,
        sizeBytes,
        sizeDisplay: formatFileSize(sizeBytes),
        url: `/api/file?path=${encodeURIComponent(resolved)}`,
      });
      return;
    }

    // 2. Check CAS Blobstore if hash
    if (amqRoot) {
      const hashMatch = clean.match(/^(?:blob:)?([a-f0-9]{64})$/i);
      if (hashMatch) {
        const stored = getBlob(hashMatch[1], amqRoot);
        if (stored) {
          attachments.push({
            type: "blob",
            sha256: stored.sha256,
            name: stored.name,
            ext: stored.ext,
            mime: stored.mime,
            sizeBytes: stored.sizeBytes,
            isImage,
            isLog,
            exists: true,
            sizeDisplay: formatFileSize(stored.sizeBytes),
            url: `/api/blob/${stored.sha256}${stored.ext ? `?ext=${encodeURIComponent(stored.ext)}` : ""}`,
          });
          return;
        }
      }
    }

    // 3. Fallback: missing on disk (unmigrated legacy reference)
    attachments.push({
      path: clean,
      originalRef: clean,
      name: base,
      ext,
      isImage,
      isLog,
      exists: false,
      sizeBytes: 0,
      sizeDisplay: "Missing on disk",
      url: null,
    });
  }

  if (Array.isArray(metaAttachments)) {
    for (const a of metaAttachments) {
      addCandidate(a);
    }
  }

  // Auto-scan body for referenced media/logs (strictly excludes code files like .gd/.tscn)
  const regex = /(?:(?:(?:\/|\.\/|[a-zA-Z0-9_.-]+\/)[a-zA-Z0-9_./-]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|log|txt|csv|json|diff|patch|out))|(?:\b[a-zA-Z0-9_.-]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|log|diff|patch|out)\b))/gi;
  const matches = body.match(regex) || [];

  for (const m of matches) {
    addCandidate(m);
  }

  return attachments;
}

/**
 * Levenshtein distance for fuzzy matching
 */
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Fuzzy term matcher across target text
 */
function matchFuzzyTerm(targetText, term) {
  if (!targetText || !term) return false;
  const text = targetText.toLowerCase();
  const t = term.toLowerCase();

  // Direct substring match
  if (text.includes(t)) return true;

  // Word-level fuzzy match
  if (t.length >= 4) {
    const words = text.split(/[\s,./_:-]+/);
    for (const w of words) {
      if (Math.abs(w.length - t.length) <= 2) {
        if (levenshtein(w, t) <= (t.length <= 5 ? 1 : 2)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Parse advanced search queries:
 * from:coordinator, to:me, recipient:user, has:image, has:attachment, is:unread, is:starred, free text
 */
export function parseQuery(queryStr = "", currentAccount = "user", persona = "") {
  let meHandle = persona || currentAccount;
  if (!meHandle || meHandle === "all") {
    meHandle = "user";
  }
  const me = meHandle.toLowerCase();
  const filters = {
    from: [],
    to: [],
    hasImage: false,
    hasAttachment: false,
    isUnread: false,
    isStarred: false,
    terms: [],
  };

  const tokens = queryStr.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "has:image" || lower === "has:images") {
      filters.hasImage = true;
    } else if (lower === "has:attachment" || lower === "has:attachments") {
      filters.hasAttachment = true;
    } else if (lower === "is:unread" || lower === "is:new") {
      filters.isUnread = true;
    } else if (lower === "is:starred") {
      filters.isStarred = true;
    } else if (lower.startsWith("from:")) {
      let val = token.slice(5).replace(/^"|"$/g, "");
      if (val.toLowerCase() === "me") val = me;
      filters.from.push(val.toLowerCase());
    } else if (lower.startsWith("to:") || lower.startsWith("recipient:")) {
      const prefixLen = lower.startsWith("to:") ? 3 : 10;
      let val = token.slice(prefixLen).replace(/^"|"$/g, "");
      if (val.toLowerCase() === "me") val = me;
      filters.to.push(val.toLowerCase());
    } else {
      const clean = token.replace(/^"|"$/g, "").trim();
      if (clean) filters.terms.push(clean);
    }
  }

  return filters;
}

/**
 * Match a single message against parsed query filters
 */
export function matchesFilter(msg, parsedQuery) {
  if (parsedQuery.hasImage && !msg.hasImage) return false;
  if (parsedQuery.hasAttachment && !msg.hasAttachment) return false;
  if (parsedQuery.isUnread && !msg.isNew) return false;

  if (parsedQuery.from.length > 0) {
    const fromLower = (msg.from || "").toLowerCase();
    const matchFrom = parsedQuery.from.some((f) => fromLower.includes(f));
    if (!matchFrom) return false;
  }

  if (parsedQuery.to.length > 0) {
    const toList = Array.isArray(msg.to)
      ? msg.to.map((t) => t.toLowerCase())
      : [(msg.to || "").toLowerCase()];
    const matchTo = parsedQuery.to.some((t) => toList.some((recipient) => recipient.includes(t)));
    if (!matchTo) return false;
  }

  if (parsedQuery.terms.length > 0) {
    const combined = `${msg.subject || ""} ${msg.snippet || ""} ${msg.from || ""} ${msg.body || ""} ${msg.thread || ""}`;
    for (const term of parsedQuery.terms) {
      if (!matchFuzzyTerm(combined, term)) return false;
    }
  }

  return true;
}

/**
 * Parse a markdown AMQ message file containing ---json frontmatter
 */
export function parseMessageFile(filePath, amqRoot = null) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const match = raw.match(/^---(?:json)?\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) return null;

    const meta = JSON.parse(match[1]);
    const body = match[2] || "";

    const isNew = filePath.includes("/inbox/new/");
    const isCur = filePath.includes("/inbox/cur/");
    const isOutbox = filePath.includes("/outbox/");

    let folder = "inbox";
    if (isOutbox) folder = "sent";

    const root = amqRoot || (filePath.includes("/agents/") ? filePath.split(path.sep + "agents" + path.sep)[0] : null);
    const attachments = extractAttachments(body, meta.attachments, root, meta);
    const hasImage = attachments.some((a) => a.isImage);
    const hasAttachment = attachments.length > 0;

    return {
      ...meta,
      body,
      filePath,
      isNew,
      isCur,
      folder,
      snippet: body.replace(/\n+/g, " ").slice(0, 140),
      attachments,
      hasImage,
      hasAttachment,
    };
  } catch {
    return null;
  }
}

/**
 * In-memory mtime cache for parsed messages (reduces 10s cold scans to sub-10ms)
 */
const messageParseCache = new Map(); // fullPath -> { mtimeMs, size, parsed }

export function invalidateMessageCache() {
  messageParseCache.clear();
}

export function getCachedMessage(fullPath, amqRoot) {
  try {
    const stat = fs.statSync(fullPath);
    const cached = messageParseCache.get(fullPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.parsed;
    }
    const parsed = parseMessageFile(fullPath, amqRoot);
    if (parsed) {
      messageParseCache.set(fullPath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        parsed,
      });
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Recursively collect message files (.md, .json) from a directory and its subdirectories
 */
function collectMessageFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "tmp") continue;
        try {
          const subEntries = fs.readdirSync(full, { withFileTypes: true });
          for (const sub of subEntries) {
            if (!sub.isDirectory() && (sub.name.endsWith(".md") || sub.name.endsWith(".json"))) {
              results.push(path.join(full, sub.name));
            }
          }
        } catch {}
      } else if (ent.name.endsWith(".md") || ent.name.endsWith(".json")) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

/**
 * Scan all messages across mailboxes in an AMQ root with caching & pagination
 */
export function loadAllMessages(
  amqRoot,
  {
    account = "all",
    folder = "inbox",
    query = "",
    persona = "",
    page = 1,
    pageSize = 50,
    paginate = false,
  } = {}
) {
  if (!amqRoot || !fs.existsSync(amqRoot)) return paginate ? { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 } : [];

  const agentsDir = path.join(amqRoot, "agents");
  if (!fs.existsSync(agentsDir)) return paginate ? { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 } : [];

  const handles = fs.readdirSync(agentsDir).filter((h) => {
    return !h.startsWith(".") && fs.statSync(path.join(agentsDir, h)).isDirectory();
  });

  const targetHandles = account === "all" ? handles : [account];
  const messageMap = new Map(); // id -> message

  // Freeform search queries search across all folders
  const isSearch = Boolean(query && query.trim());
  const effectiveFolder = isSearch ? "all" : folder;

  for (const h of targetHandles) {
    const handleDir = path.join(agentsDir, h);
    const targetDirs = [];

    if (effectiveFolder === "inbox" || effectiveFolder === "all" || effectiveFolder === "starred" || effectiveFolder === "threads") {
      targetDirs.push(path.join(handleDir, "inbox"));
    }
    if (effectiveFolder === "sent" || effectiveFolder === "all") {
      targetDirs.push(path.join(handleDir, "outbox"));
    }

    for (const d of targetDirs) {
      const filePaths = collectMessageFiles(d);
      for (const fullPath of filePaths) {
        const msg = getCachedMessage(fullPath, amqRoot);
        if (!msg) continue;

        if (fullPath.includes("/outbox/")) {
          msg.folder = "sent";
        }

        const existing = messageMap.get(msg.id);
        if (!existing) {
          messageMap.set(msg.id, {
            ...msg,
            targetAccount: h,
          });
        } else {
          if (msg.isNew || (effectiveFolder === "sent" && msg.folder === "sent")) {
            messageMap.set(msg.id, {
              ...msg,
              targetAccount: h,
            });
          }
        }
      }
    }
  }

  let list = Array.from(messageMap.values());

  // Filter by query if provided
  if (query && query.trim()) {
    const parsedQuery = parseQuery(query, account, persona);
    list = list.filter((m) => matchesFilter(m, parsedQuery));
  }

  // Sort descending by created date
  list.sort((a, b) => {
    const timeA = a.created ? new Date(a.created).getTime() : 0;
    const timeB = b.created ? new Date(b.created).getTime() : 0;
    return timeB - timeA;
  });

  const total = list.length;
  if (paginate) {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const limit = Math.max(1, parseInt(pageSize, 10) || 50);
    const start = (p - 1) * limit;
    const items = list.slice(start, start + limit);
    return {
      items,
      total,
      page: p,
      pageSize: limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  return list;
}

/**
 * Group messages into conversation threads (Gmail Conversation View) with caching & pagination
 */
export function loadThreads(
  amqRoot,
  {
    account = "all",
    folder = "inbox",
    query = "",
    persona = "",
    page = 1,
    pageSize = 50,
    paginate = false,
  } = {}
) {
  const msgs = loadAllMessages(amqRoot, { account, folder: "all", query: "", persona, paginate: false });
  const threadMap = new Map();

  for (const m of msgs) {
    const threadId = m.thread || m.id;
    if (!threadMap.has(threadId)) {
      threadMap.set(threadId, {
        threadId,
        subject: m.subject || "(no subject)",
        participants: new Set(),
        messages: [],
        hasUnread: false,
        latestCreated: m.created,
        latestSnippet: m.snippet,
        latestFrom: m.from,
      });
    }

    const t = threadMap.get(threadId);
    if (m.from) t.participants.add(m.from);
    if (m.isNew) t.hasUnread = true;
    t.messages.push(m);

    const msgTime = m.created ? new Date(m.created).getTime() : 0;
    const latestTime = t.latestCreated ? new Date(t.latestCreated).getTime() : 0;
    if (msgTime >= latestTime) {
      t.latestCreated = m.created;
      t.latestSnippet = m.snippet;
      t.latestFrom = m.from;
      if (m.subject) t.subject = m.subject;
    }
  }

  let threads = Array.from(threadMap.values()).map((t) => {
    t.messages.sort((a, b) => {
      const timeA = a.created ? new Date(a.created).getTime() : 0;
      const timeB = b.created ? new Date(b.created).getTime() : 0;
      return timeA - timeB;
    });

    const hasImage = t.messages.some((m) => m.hasImage);
    const hasAttachment = t.messages.some((m) => m.hasAttachment);

    return {
      threadId: t.threadId,
      subject: t.subject,
      participants: Array.from(t.participants),
      messageCount: t.messages.length,
      hasUnread: t.hasUnread,
      hasImage,
      hasAttachment,
      latestCreated: t.latestCreated,
      latestSnippet: t.latestSnippet,
      latestFrom: t.latestFrom,
      messages: t.messages,
    };
  });

  if (account !== "all") {
    threads = threads.filter((t) => {
      return (
        t.participants.includes(account) ||
        t.messages.some((m) => m.targetAccount === account || (m.to && m.to.includes(account)))
      );
    });
  }

  // When freeform search query is absent, filter by the active folder
  if (!query || !query.trim()) {
    if (folder === "inbox") {
      threads = threads.filter((t) => t.messages.some((m) => m.folder === "inbox"));
    } else if (folder === "sent") {
      threads = threads.filter((t) => {
        if (account !== "all") {
          return t.messages.some((m) => (m.from && m.from.toLowerCase() === account.toLowerCase()) || (m.folder === "sent" && m.targetAccount === account));
        }
        return t.messages.some((m) => m.folder === "sent" || m.from);
      });
    }
  }

  if (query && query.trim()) {
    const parsedQuery = parseQuery(query, account, persona);
    threads = threads.filter((t) => {
      if (t.messages.some((m) => matchesFilter(m, parsedQuery))) return true;
      if (parsedQuery.terms.length > 0) {
        const combined = `${t.subject} ${t.threadId} ${t.participants.join(" ")}`;
        return parsedQuery.terms.every((term) => matchFuzzyTerm(combined, term));
      }
      return false;
    });
  }

  threads.sort((a, b) => {
    const timeA = a.latestCreated ? new Date(a.latestCreated).getTime() : 0;
    const timeB = b.latestCreated ? new Date(b.latestCreated).getTime() : 0;
    return timeB - timeA;
  });

  const total = threads.length;
  if (paginate) {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const limit = Math.max(1, parseInt(pageSize, 10) || 50);
    const start = (p - 1) * limit;
    const items = threads.slice(start, start + limit);
    return {
      items,
      total,
      page: p,
      pageSize: limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  return threads;
}

export function loadAgentDirectory(amqRoot) {
  if (!amqRoot || !fs.existsSync(amqRoot)) return [];

  const agentsDir = path.join(amqRoot, "agents");
  if (!fs.existsSync(agentsDir)) return [];

  const handles = fs.readdirSync(agentsDir).filter((h) => {
    return !h.startsWith(".") && fs.statSync(path.join(agentsDir, h)).isDirectory();
  });

  // Query herdr agents if possible
  const herdrAgents = new Map();
  try {
    const bin = getHerdrBin();
    const out = execCmd(bin, ["pane", "list"]);
    const panes = JSON.parse(out)?.result?.panes || [];
    for (const p of panes) {
      if (p.agent_status) {
        const title = p.terminal_title_stripped || p.terminal_title || "";
        for (const h of handles) {
          if (title.includes(`- ${h} -`)) {
            herdrAgents.set(h, {
              status: p.agent_status,
              paneId: p.pane_id,
            });
          }
        }
      }
    }
  } catch {}

  const repoRoot = getRepoRootFromAmq(amqRoot);
  const briefs = scanAgentBriefs(repoRoot);

  // Merge discovered brief handles into the list so agents defined on disk are discoverable
  for (const briefHandle of briefs.keys()) {
    if (!handles.includes(briefHandle)) {
      handles.push(briefHandle);
    }
  }

  const list = [];
  for (const h of handles) {
    const presencePath = path.join(agentsDir, h, "presence.json");
    let presence = null;
    if (fs.existsSync(presencePath)) {
      try {
        presence = JSON.parse(fs.readFileSync(presencePath, "utf8"));
      } catch {}
    }

    const profilePath = path.join(agentsDir, h, "profile.json");
    let customProfile = null;
    if (fs.existsSync(profilePath)) {
      try {
        customProfile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      } catch {}
    }

    const herdrInfo = herdrAgents.get(h);
    const status = herdrInfo?.status || presence?.status || "offline";

    // Count unread messages
    const newDir = path.join(agentsDir, h, "inbox", "new");
    let unreadCount = 0;
    if (fs.existsSync(newDir)) {
      unreadCount = fs.readdirSync(newDir).filter((f) => f.endsWith(".md") || f.endsWith(".json")).length;
    }

    const brief = briefs.get(h) || null;
    const name = customProfile?.name || presence?.name || brief?.name || formatAgentTitle(h);
    const role = customProfile?.role || (presence?.role && presence.role !== "Swarm Agent" ? presence.role : null) || brief?.role || brief?.description || (h === "user" ? "Human Operator" : "Swarm Agent");
    const model = normalizeModel(customProfile?.model) || normalizeModel(brief?.model);
    const emoji = customProfile?.emoji || presence?.emoji || (h === "user" ? "👤" : h.slice(0, 1).toUpperCase());
    const color = customProfile?.color || presence?.color || getAgentColor(h);
    const worktree = customProfile?.worktree || null;
    const prompt = customProfile?.prompt || brief?.prompt || "";
    const briefSource = customProfile?.briefSource || brief?.source || null;

    list.push({
      handle: h,
      status,
      lastSeen: presence?.last_seen || null,
      unreadCount,
      profile: {
        name,
        emoji,
        color,
        role,
        model,
        worktree,
        prompt,
        briefSource,
      },
    });
  }

  // Sort alphabetically with active/working agents first
  list.sort((a, b) => {
    if (a.status === "working" && b.status !== "working") return -1;
    if (b.status === "working" && a.status !== "working") return 1;
    return a.handle.localeCompare(b.handle);
  });

  return list;
}

function readAgentProfile(profilePath) {
  try {
    const content = readMaildirMessageFile(profilePath, 1024 * 1024);
    if (content === null) return null;
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeAgentProfile(agentDir, profileData) {
  const profilePath = path.join(agentDir, "profile.json");
  writeBoundedFileAtomic(profilePath, JSON.stringify(profileData, null, 2), 1024 * 1024);
}

function normalizeText(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function normalizeModel(value, fallback = null) {
  const normalized = normalizeText(value, fallback, 200);
  if (typeof normalized !== "string") return normalized;
  return normalized.toLowerCase() === LEGACY_PLACEHOLDER_MODEL ? null : normalized;
}

function normalizeMultiline(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function withAgentRegistrationLock(agentDir, operation) {
  const lockDir = path.join(agentDir, ".registration.lock");
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > 30000) fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {}
      if (Date.now() >= deadline) throw new Error("Timed out waiting for agent registration lock");
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }

  try {
    return operation();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function defaultWelcomeBody(handle, name) {
  return `Welcome to AMQ.\nAgent data: name=${JSON.stringify(name)}; handle=${JSON.stringify(handle)}.\nRun herdr-amq mail drain --me ${handle} --include-body to read messages. No reply is required.`.slice(0, 2048);
}

function selectProfileFields(profile) {
  if (!profile || typeof profile !== "object") return {};
  const selected = {};
  for (const key of ["name", "role", "model", "emoji", "color", "worktree", "prompt", "createdAt", "registrationId"]) {
    if (Object.prototype.hasOwnProperty.call(profile, key)) selected[key] = profile[key];
  }
  if (profile.welcome && typeof profile.welcome === "object" && !Array.isArray(profile.welcome)) {
    selected.welcome = {};
    for (const key of ["status", "messageId", "sentAt", "templatePath", "templateSha256", "source", "lastError"]) {
      if (Object.prototype.hasOwnProperty.call(profile.welcome, key)) selected.welcome[key] = profile.welcome[key];
    }
  }
  return selected;
}

/**
 * Register a new agent or update an existing agent profile with model configuration and prompt
 */
export function registerAgent(amqRoot, options = {}) {
  if (!amqRoot || !fs.existsSync(amqRoot)) return { ok: false, error: "Invalid AMQ root" };

  const safeHandle = (options.handle || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!isSafeMailIdentifier(safeHandle, 128)) return { ok: false, error: "Invalid agent handle" };

  try {
    const agentDir = ensureAgentMailbox(amqRoot, safeHandle);
    return withAgentRegistrationLock(agentDir, () => registerAgentLocked(amqRoot, agentDir, safeHandle, options));
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function registerAgentLocked(amqRoot, agentDir, safeHandle, options) {
  const { name, role, model, emoji, color, worktree, prompt, brief, syncDisk = true } = options;
  const profilePath = path.join(agentDir, "profile.json");
  const existingProfile = readAgentProfile(profilePath);
  const now = new Date().toISOString();
  const registrationId = isSafeMailIdentifier(existingProfile?.registrationId, 128)
    ? existingProfile.registrationId
    : crypto.randomUUID();
  const shouldDeliverWelcome = !existingProfile || existingProfile?.welcome?.status === "pending";
  const welcomeMessageId = isSafeMailIdentifier(existingProfile?.welcome?.messageId)
    ? existingProfile.welcome.messageId
    : `welcome-${registrationId}`;
  const defaultName = formatAgentTitle(safeHandle);
  const defaultEmoji = safeHandle === "user" ? "👤" : safeHandle.slice(0, 1).toUpperCase();
  const promptContent = normalizeMultiline(
    prompt ?? brief,
    normalizeMultiline(existingProfile?.prompt, "", 256 * 1024),
    256 * 1024
  );
  const profileData = {
    ...selectProfileFields(existingProfile),
    handle: safeHandle,
    name: normalizeText(name, normalizeText(existingProfile?.name, defaultName, 120), 120),
    role: normalizeText(role, normalizeText(existingProfile?.role, "Autonomous Specialist", 240), 240),
    model: normalizeModel(model, normalizeModel(existingProfile?.model)),
    emoji: normalizeText(emoji, normalizeText(existingProfile?.emoji, defaultEmoji, 16), 16),
    color: normalizeText(color, normalizeText(existingProfile?.color, getAgentColor(safeHandle), 64), 64),
    worktree: normalizeText(worktree, normalizeText(existingProfile?.worktree, "", 1024), 1024) || null,
    prompt: promptContent,
    createdAt: existingProfile?.createdAt || now,
    registrationId,
    updatedAt: now,
  };

  if (shouldDeliverWelcome) {
    profileData.welcome = {
      status: "pending",
      messageId: welcomeMessageId,
      ...(typeof existingProfile?.welcome?.lastError === "string"
        ? { lastError: normalizeText(existingProfile.welcome.lastError, "delivery pending", 512) }
        : {}),
    };
  }
  writeAgentProfile(agentDir, profileData);

  if (syncDisk && promptContent) {
    try {
      const repoRoot = getRepoRootFromAmq(amqRoot);
      saveAgentBrief(repoRoot, safeHandle, {
        description: profileData.role,
        prompt: promptContent,
        model: profileData.model,
        role: profileData.role,
      });
    } catch {}
  }

  if (!shouldDeliverWelcome) return { ok: true, agent: profileData, welcome: { ok: true, skipped: true } };

  const rendered = renderLocalTemplate(
    amqRoot,
    "welcome",
    {
      agent: {
        handle: safeHandle,
        name: profileData.name,
        role: profileData.role,
        model: profileData.model,
        emoji: profileData.emoji,
        color: profileData.color,
        worktree: profileData.worktree || "",
      },
    },
    defaultWelcomeBody(safeHandle, profileData.name)
  );

  let deliveredMessage = findMessageForRecipient(amqRoot, safeHandle, welcomeMessageId);
  let deliveryError = null;
  if (!deliveredMessage) {
    try {
      sendMaildirMessage(amqRoot, {
        id: welcomeMessageId,
        from: "coordinator",
        to: [safeHandle],
        subject: `Welcome to AMQ, ${safeHandle}`,
        thread: `welcome/${safeHandle}`,
        body: rendered.text,
        priority: "normal",
        kind: "status",
        labels: ["welcome", "registration"],
        context: {
          template: "welcome",
          templateSource: rendered.source,
          templateSha256: rendered.sha256,
          registrationId,
        },
        created: now,
      });
      deliveredMessage = findMessageForRecipient(amqRoot, safeHandle, welcomeMessageId);
    } catch (error) {
      deliveryError = error;
      deliveredMessage = findMessageForRecipient(amqRoot, safeHandle, welcomeMessageId);
    }
  }

  if (!deliveredMessage) {
    profileData.welcome = {
      status: "pending",
      messageId: welcomeMessageId,
      lastError: normalizeText(
        deliveryError?.message,
        "Welcome delivery was not observed",
        512
      ),
    };
    writeAgentProfile(agentDir, profileData);
    return {
      ok: true,
      agent: profileData,
      welcome: { ok: false, pending: true, error: profileData.welcome.lastError },
    };
  }

  profileData.welcome = {
    status: "sent",
    messageId: welcomeMessageId,
    sentAt: deliveredMessage.header?.created || now,
    templatePath: rendered.source === "template" && rendered.path ? path.relative(amqRoot, rendered.path) : null,
    templateSha256: rendered.source === "template" ? rendered.sha256 : null,
    source: rendered.source,
  };
  writeAgentProfile(agentDir, profileData);
  return {
    ok: true,
    agent: profileData,
    welcome: { ok: true, id: welcomeMessageId, sentAt: profileData.welcome.sentAt },
  };
}

/**
 * Calculate disk space usage of .agent-mail in MB
 */
export function getStorageUsage(amqRoot) {
  let totalBytes = 0;
  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          try {
            totalBytes += fs.statSync(full).size;
          } catch {}
        }
      }
    } catch {}
  }
  if (amqRoot && fs.existsSync(amqRoot)) {
    walk(amqRoot);
  }
  const mb = totalBytes / (1024 * 1024);
  return {
    bytes: totalBytes,
    mb: Number(mb.toFixed(1)),
    display: `${mb.toFixed(1)} MB`,
  };
}

const VALID_AMQ_KINDS = new Set([
  "brainstorm",
  "review_request",
  "review_response",
  "question",
  "answer",
  "decision",
  "status",
  "todo",
]);

function normalizeAmqKind(rawKind) {
  if (!rawKind) return null;
  const k = String(rawKind).trim().toLowerCase();
  if (VALID_AMQ_KINDS.has(k)) return k;
  if (k === "task") return "todo";
  if (k === "alert") return "status";
  return null;
}

/**
 * Send an AMQ message using amq CLI or fallback to file creation
 */
/**
 * Send an AMQ message using amq CLI or fallback to atomic Maildir delivery
 */
export function sendAmqMessage(amqRoot, { from, to, subject, body, thread, priority, kind, attachments }) {
  const recipients = Array.isArray(to) ? to : [to];
  const safeFrom = from || "coordinator";
  const safeThread = thread || computeCanonicalThread(safeFrom, recipients);
  const safePriority = priority || "normal";
  const safeKind = normalizeAmqKind(kind);
  const safeSubject = subject || "(no subject)";

  const args = [
    "send",
    "--root",
    amqRoot,
    "--me",
    safeFrom,
    "--to",
    recipients.join(","),
    "--subject",
    safeSubject,
  ];

  if (safeThread) args.push("--thread", safeThread);
  if (safePriority) args.push("--priority", safePriority);
  if (safeKind) args.push("--kind", safeKind);

  // Write body via temp file or arg
  const tmpFile = path.join(os.tmpdir(), `amq_msg_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  try {
    fs.writeFileSync(tmpFile, body || "", "utf8");
    args.push("--body", `@${tmpFile}`);

    const out = execCmd("amq", args);
    try { fs.unlinkSync(tmpFile); } catch {}
    return { ok: true, output: out, method: "cli" };
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}

    // Pure JavaScript atomic Maildir delivery (DJB tmp -> new rename)
    if (amqRoot && fs.existsSync(amqRoot)) {
      try {
        const result = sendMaildirMessage(amqRoot, {
          from: safeFrom,
          to: recipients,
          subject: safeSubject,
          body: body || "",
          thread: safeThread,
          priority: safePriority,
          kind: safeKind,
          attachments: attachments || [],
        });
        return { ok: true, msgId: result.id, method: "maildir_native" };
      } catch (fallbackErr) {
        return { ok: false, error: `${err.message} (native fallback failed: ${fallbackErr.message})` };
      }
    }

    return { ok: false, error: err.message };
  }
}

/**
 * Reply to an AMQ message by ID
 */
export function replyAmqMessage(amqRoot, { from, replyToId, body, subject, kind, attachments }) {
  const tmpFile = path.join(os.tmpdir(), `amq_reply_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  try {
    fs.writeFileSync(tmpFile, body || "", "utf8");
    const args = [
      "reply",
      "--root",
      amqRoot,
      "--me",
      from,
      "--id",
      replyToId,
      "--body",
      `@${tmpFile}`,
    ];

    const out = execCmd("amq", args);
    try { fs.unlinkSync(tmpFile); } catch {}
    return { ok: true, output: out, method: "cli" };
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}

    // Pure JavaScript RFC 5322 In-Reply-To chaining
    if (amqRoot && fs.existsSync(amqRoot)) {
      try {
        const result = replyMaildirMessage(amqRoot, {
          from,
          replyToId,
          body,
          subject,
          kind,
          attachments,
        });
        return { ok: true, msgId: result.id, method: "maildir_native" };
      } catch (nativeErr) {
        return { ok: false, error: `${err.message} (native reply failed: ${nativeErr.message})` };
      }
    }

    return { ok: false, error: err.message };
  }
}
