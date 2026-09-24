import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAmqRoot, getAgentHandles } from "./config.mjs";
import { markMaildirMessageRead } from "./protocol.mjs";
import {
  loadAllMessages,
  loadThreads,
  loadAgentDirectory,
  sendAmqMessage,
  replyAmqMessage,
  resolveAttachmentPath,
  getStorageUsage,
  isPathSafe,
  registerAgent,
  invalidateMessageCache,
} from "./store.mjs";
import {
  listWorktrees,
  createWorktree,
  removeWorktree,
  ensureAgentWorktree,
  ensureAllWorktrees,
} from "./worktrees.mjs";
import {
  scanAgentBriefs,
  getAgentBrief,
  saveAgentBrief,
} from "./briefs.mjs";
import {
  isDaemonRunning,
  startDaemonBackground,
  stopDaemon,
  listInbox,
} from "./bridge.mjs";
import {
  getHerdrAgents,
  getHerdrStatusMap,
  normalizeHerdrStatus,
  subscribeHerdrEvents,
  isHerdrAvailable,
  getSocketPath,
} from "./herdr.mjs";
import {
  findStatusFile,
  loadBoard,
  addBoardTask,
  updateBoardTask,
  deleteBoardTask,
} from "./board.mjs";
import {
  getBlob,
  readGitRef,
  storeBlob,
} from "./blobs.mjs";



const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, "web");
const HERDR_STATUS_EVENT_TYPES = new Set(["pane_agent_status_changed", "pane.agent_status_changed", "pane.updated", "agent.state_changed", "agent.updated"]);
const HERDR_REFRESH_EVENT_TYPES = new Set(["pane_agent_detected", "pane.created", "pane.closed", "workspace.created", "workspace.closed", "agent.created", "agent.closed"]);

// Strict CSP for the local dashboard. media-src 'self' covers same-origin
// <video> attachments streamed from /api/blob/* and /api/file.
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; frame-ancestors 'none';";

export function isHerdrStatusEvent(type) {
  return HERDR_STATUS_EVENT_TYPES.has(String(type || ""));
}

export function isHerdrRefreshEvent(type) {
  return HERDR_REFRESH_EVENT_TYPES.has(String(type || ""));
}

export function findHerdrEventHandle(cache, event) {
  if (!cache || !event) return null;
  const directHandle = String(event.name || event.handle || "").trim();
  if (directHandle && cache.has(directHandle)) return directHandle;
  const paneId = String(event.pane_id || "").trim();
  if (!paneId) return null;
  for (const [handle, activity] of cache.entries()) {
    if (activity?.herdrPaneId === paneId) return handle;
  }
  return null;
}

export function mergeHerdrStatusEvent(cache, event, observedAt = new Date().toISOString()) {
  const handle = findHerdrEventHandle(cache, event);
  if (!handle || !event?.agent_status) return null;
  const current = cache.get(handle) || {};
  const nextSeq = Number(event.state_change_seq);
  const currentSeq = Number(current.herdrStateChangeSeq);
  if (Number.isFinite(nextSeq) && Number.isFinite(currentSeq) && nextSeq < currentSeq) return null;

  const next = {
    ...current,
    herdrStatus: normalizeHerdrStatus(event.agent_status),
    herdrObservedAt: observedAt,
  };
  if (Number.isFinite(nextSeq)) next.herdrStateChangeSeq = nextSeq;
  if (event.state_labels && typeof event.state_labels === "object" && !Array.isArray(event.state_labels)) {
    next.herdrStateLabels = { ...event.state_labels };
  }
  if (typeof event.title === "string" && event.title.trim()) next.herdrTitle = event.title.trim();
  cache.set(handle, next);
  return { handle, activity: next };
}

export function startWebServer({
  port = 8505,
  host = process.env.AGMAIL_HOST || "127.0.0.1",
  amqRoot = findAmqRoot(),
} = {}) {
  if (!amqRoot) {
    console.error("❌ Cannot start web server: No .agent-mail directory found.");
    process.exit(1);
  }

  // Active SSE clients
  const sseClients = new Set();

  // ─── Herdr live agent status cache ─────────────────────────────────────────
  // Map<handle, { herdrStatus, herdrPaneId, herdrWorkspaceId, ... }>
  let herdrStatusCache = new Map();
  let herdrSubscription = null;
  let herdrRefreshDebounce = null;
  let herdrStatusFlushTimer = null;
  const pendingHerdrStatusEvents = new Map();

  function broadcastSSE(payload) {
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try { client.write(msg); } catch {}
    }
  }

  async function refreshHerdrCache() {
    try {
      herdrStatusCache = await getHerdrStatusMap();
    } catch {}
  }

  function scheduleHerdrRefresh(reason = "event") {
    if (isClosing) return;
    clearTimeout(herdrRefreshDebounce);
    herdrRefreshDebounce = setTimeout(async () => {
      await refreshHerdrCache();
      broadcastSSE({ type: "herdr_agents_refresh", reason, at: new Date().toISOString() });
    }, 80);
  }

  function queueHerdrStatusEvent(event) {
    const handle = findHerdrEventHandle(herdrStatusCache, event);
    if (!handle || !event?.agent_status) {
      scheduleHerdrRefresh("status");
      return;
    }
    const current = herdrStatusCache.get(handle);
    const nextStatus = normalizeHerdrStatus(event.agent_status);
    if (current?.herdrStatus === nextStatus && !event.state_labels && !event.title) return;
    pendingHerdrStatusEvents.set(handle, event);
    if (herdrStatusFlushTimer) return;
    herdrStatusFlushTimer = setTimeout(() => {
      herdrStatusFlushTimer = null;
      const pending = new Map(pendingHerdrStatusEvents);
      pendingHerdrStatusEvents.clear();
      for (const [pendingHandle, pendingEvent] of pending) {
        const merged = mergeHerdrStatusEvent(herdrStatusCache, pendingEvent);
        if (!merged || merged.handle !== pendingHandle) continue;
        broadcastSSE({
          type: "herdr_agent_update",
          handle: merged.handle,
          herdrStatus: merged.activity.herdrStatus,
          stateLabels: merged.activity.herdrStateLabels || {},
          title: merged.activity.herdrTitle || null,
          at: merged.activity.herdrObservedAt,
        });
      }
    }, 250);
  }

  let isClosing = false;
  let herdrReconnectTimeout = null;

  function startHerdrSubscription() {
    if (isClosing) return;
    if (herdrSubscription) {
      try { herdrSubscription.close(); } catch {}
    }
    herdrSubscription = subscribeHerdrEvents({
      onConnect: () => {
        scheduleHerdrRefresh("connected");
      },
      onEvent: (event) => {
        const type = String(event?.type || "");
        if (isHerdrStatusEvent(type)) {
          queueHerdrStatusEvent(event);
        } else if (isHerdrRefreshEvent(type)) {
          scheduleHerdrRefresh(type);
        }
      },
      onDisconnect: () => {
        herdrStatusCache = new Map();
        pendingHerdrStatusEvents.clear();
        if (herdrStatusFlushTimer) clearTimeout(herdrStatusFlushTimer);
        herdrStatusFlushTimer = null;
        broadcastSSE({ type: "herdr_agents_refresh", reason: "disconnected", at: new Date().toISOString() });
        if (!isClosing) {
          herdrReconnectTimeout = setTimeout(startHerdrSubscription, 5000);
        }
      },
    });
  }

  // Start Herdr integration (non-fatal if Herdr not running)
  refreshHerdrCache().then(() => startHerdrSubscription()).catch(() => {});

  let watchDebounce = null;
  let watcher = null;
  try {
    watcher = fs.watch(amqRoot, { recursive: true }, (eventType, filename) => {
      if (!filename || filename.includes(".git") || filename.includes(".tmp")) return;

      invalidateMessageCache();

      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        broadcastSSE({ type: "mail_update", at: new Date().toISOString() });
      }, 200);
    });
  } catch (err) {
    console.warn(`[web] Warning: could not setup fs.watch on ${amqRoot}: ${err.message}`);
  }

  // Watch .opencode/bus/STATUS.md for real-time board updates
  const repoRoot = path.resolve(path.dirname(amqRoot));
  const statusFile = findStatusFile(repoRoot);
  let statusWatcher = null;
  let statusDebounce = null;
  if (statusFile && fs.existsSync(statusFile)) {
    try {
      statusWatcher = fs.watch(statusFile, () => {
        clearTimeout(statusDebounce);
        statusDebounce = setTimeout(() => {
          broadcastSSE({ type: "board_update", at: new Date().toISOString() });
        }, 150);
      });
    } catch {}
  }



  const requestHandler = async (req, res) => {
    // ─── Compliance: Strict Security Headers ───────────────────────────────
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      CONTENT_SECURITY_POLICY
    );
    res.setHeader("Referrer-Policy", "no-referrer");

    // ─── Compliance: Host Header & DNS Rebinding Protection ───────────────
    const rawHost = (req.headers.host || "").toLowerCase().trim();
    let hostHeader = rawHost;
    if (hostHeader.startsWith("[")) {
      const closeBracket = hostHeader.indexOf("]");
      hostHeader = closeBracket !== -1 ? hostHeader.slice(1, closeBracket) : hostHeader;
    } else {
      hostHeader = hostHeader.split(":")[0];
    }

    const isLocalHost =
      hostHeader === "localhost" ||
      hostHeader === "127.0.0.1" ||
      hostHeader === "::1" ||
      !rawHost; // In-memory or direct tests without host header

    if (!isLocalHost) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: "Forbidden: Invalid Host header (DNS rebinding protection). AGmail is strictly local-only.",
          rejectedHost: rawHost,
        })
      );
      return;
    }

    // ─── Compliance: Null-byte injection check ──────────────────────────────
    if (req.url && (req.url.includes("\0") || req.url.includes("%00"))) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Forbidden: Null-byte injection detected" }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // ─── API Routes ──────────────────────────────────────────────────────────

    if (pathname === "/api/status" && req.method === "GET") {
      const pid = isDaemonRunning();
      const handles = getAgentHandles(amqRoot);
      let totalUnread = 0;
      for (const h of handles) {
        totalUnread += listInbox(amqRoot, h).length;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          amqRoot,
          daemonRunning: Boolean(pid),
          pid: pid || null,
          totalUnread,
          agentCount: handles.length,
          storage: getStorageUsage(amqRoot),
        })
      );
      return;
    }

    if (pathname === "/api/models" && req.method === "GET") {
      // Suggestion models list for flexible combo input (not hardcoded restricted)
      const models = [
        { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet (Thinking & Code)" },
        { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
        { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
        { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "o3-mini", name: "o3-mini" },
        { id: "deepseek-r1", name: "DeepSeek R1" },
        { id: "deepseek-chat", name: "DeepSeek V3" },
        { id: "ollama/qwen2.5-coder", name: "Qwen 2.5 Coder (Local Ollama)" },
        { id: "ollama/llama3.3", name: "Llama 3.3 (Local Ollama)" },
      ];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(models));
      return;
    }

    if (pathname === "/api/agents" && req.method === "GET") {
      const agents = loadAgentDirectory(amqRoot);
      // Merge live Herdr status into each agent record
      const enriched = agents.map((a) => {
        const h = herdrStatusCache.get(a.handle);
        if (!h) return a;
        return {
          ...a,
          herdrStatus: h.herdrStatus,
          herdrPaneId: h.herdrPaneId,
          herdrWorkspaceId: h.herdrWorkspaceId,
          herdrTabId: h.herdrTabId,
          herdrTitle: h.herdrTitle,
          herdrObservedAt: h.herdrObservedAt,
           interactiveReady: h.interactiveReady,
           agentType: h.agentType,
           runtimeModel: h.herdrModel || null,
           modelSource: h.herdrModelSource || null,
           herdrActivity: {
            status: h.herdrStatus,
            title: h.herdrMetadataTitle || h.herdrTitle,
            terminalTitle: h.herdrTerminalTitle,
            metadataTitle: h.herdrMetadataTitle,
            stateLabels: h.herdrStateLabels || {},
            tokens: h.herdrTokens || [],
            stateChangeSeq: h.herdrStateChangeSeq,
            observedAt: h.herdrObservedAt,
             focused: h.herdrFocused,
             launchPending: h.herdrLaunchPending,
             model: h.herdrModel || null,
             modelSource: h.herdrModelSource || null,
           },
          status: h.herdrStatus !== "unknown" ? h.herdrStatus : (a.status || "offline"),
        };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(enriched));
      return;
    }

    if (pathname === "/api/herdr-agents" && req.method === "GET") {
      // Raw Herdr agent snapshot — all panes, not just named ones
      const agents = await getHerdrAgents();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(agents));
      return;
    }

    if (pathname === "/api/agents" && req.method === "POST") {
      const body = await parseJsonBody(req);
      if (body.__error) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: body.__error }));
        return;
      }
      const repoRoot = path.resolve(path.dirname(amqRoot));
      // Workspaces are the default under the hood: automatically isolate agent in .worktrees/<handle>
      const worktreeResult = ensureAgentWorktree(repoRoot, body.handle, body.branch);
      const result = registerAgent(amqRoot, {
        ...body,
        worktree: worktreeResult?.ok ? worktreeResult.path : body.worktree,
      });
      // Refresh Herdr cache after registration
      scheduleHerdrRefresh("agent_registered");
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...result, worktreeResult }));
      return;
    }


    if (pathname === "/api/agent-briefs" && req.method === "GET") {
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const handle = url.searchParams.get("handle");
      if (handle) {
        const brief = getAgentBrief(repoRoot, handle);
        if (brief) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, brief }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `Brief not found for ${handle}` }));
        }
        return;
      }
      const briefsMap = scanAgentBriefs(repoRoot);
      const list = Array.from(briefsMap.values());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    if (pathname.startsWith("/api/agent-briefs/") && req.method === "GET") {
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const handle = decodeURIComponent(pathname.slice("/api/agent-briefs/".length));
      const brief = getAgentBrief(repoRoot, handle);
      if (brief) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, brief }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `Brief not found for ${handle}` }));
      }
      return;
    }

    if (pathname === "/api/agent-briefs" && req.method === "POST") {
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const body = await parseJsonBody(req);
      const result = saveAgentBrief(repoRoot, body.handle, body);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === "/api/worktrees" && req.method === "GET") {
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const worktrees = listWorktrees(repoRoot);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(worktrees));
      return;
    }

    if (pathname === "/api/worktrees" && req.method === "POST") {
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const body = await parseJsonBody(req);
      const result = createWorktree(repoRoot, body);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === "/api/worktrees/ensure" && req.method === "POST") {
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const body = await parseJsonBody(req);
      const result = ensureAgentWorktree(repoRoot, body.handle, body.branch);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === "/api/worktrees/ensure-all" && req.method === "POST") {
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const handles = getAgentHandles(amqRoot);
      const results = ensureAllWorktrees(repoRoot, handles);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, results }));
      return;
    }

    if (pathname === "/api/worktrees" && req.method === "DELETE") {
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const body = await parseJsonBody(req);
      const targetPath = body.targetPath || url.searchParams.get("path");
      const force = body.force ?? (url.searchParams.get("force") === "true");
      const result = removeWorktree(repoRoot, { targetPath, force });
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ─── Kanban Board Routes ─────────────────────────────────────────────────

    if (pathname === "/api/board" && req.method === "GET") {
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const board = loadBoard(repoRoot, amqRoot);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...board }));
      return;
    }

    if (pathname === "/api/board/tasks" && req.method === "POST") {
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const body = await parseJsonBody(req);
      const result = addBoardTask(repoRoot, amqRoot, body);
      if (result.ok) {
        broadcastSSE({ type: "board_update", at: new Date().toISOString() });
      }
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname.startsWith("/api/board/tasks/") && req.method === "PATCH") {
      const taskId = decodeURIComponent(pathname.slice("/api/board/tasks/".length));
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const body = await parseJsonBody(req);
      const result = updateBoardTask(repoRoot, amqRoot, taskId, body);
      if (result.ok) {
        broadcastSSE({ type: "board_update", at: new Date().toISOString() });
      }
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname.startsWith("/api/board/tasks/") && req.method === "DELETE") {
      const taskId = decodeURIComponent(pathname.slice("/api/board/tasks/".length));
      const repoRoot = path.resolve(path.dirname(amqRoot));
      const result = deleteBoardTask(repoRoot, amqRoot, taskId);
      if (result.ok) {
        broadcastSSE({ type: "board_update", at: new Date().toISOString() });
      }
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }


    if (pathname.startsWith("/api/messages/") && pathname.endsWith("/read") && req.method === "POST") {
      const messageId = decodeURIComponent(pathname.slice("/api/messages/".length, -"/read".length));
      const account = url.searchParams.get("account") || "user";
      if (account === "all" || !/^[A-Za-z0-9_-]{1,128}$/.test(account)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "A concrete mailbox account is required" }));
        return;
      }
      const result = markMaildirMessageRead(amqRoot, account, messageId);
      if (result.ok) {
        invalidateMessageCache();
        broadcastSSE({ type: "mail_update", reason: "message_read", account, messageId, at: new Date().toISOString() });
      }
      res.writeHead(result.ok ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === "/api/messages" && req.method === "GET") {
      const account = url.searchParams.get("account") || "all";
      const folder = url.searchParams.get("folder") || "inbox";
      const query = url.searchParams.get("query") || "";
      const persona = url.searchParams.get("persona") || "";
      const page = url.searchParams.get("page") ? parseInt(url.searchParams.get("page"), 10) : undefined;
      const pageSize = url.searchParams.get("pageSize") ? parseInt(url.searchParams.get("pageSize"), 10) : 50;
      const paginate = url.searchParams.get("paginate") === "true" || page !== undefined;

      const msgs = loadAllMessages(amqRoot, { account, folder, query, persona, page, pageSize, paginate });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(msgs));
      return;
    }

    if (pathname === "/api/threads" && req.method === "GET") {
      const account = url.searchParams.get("account") || "all";
      const folder = url.searchParams.get("folder") || "inbox";
      const query = url.searchParams.get("query") || "";
      const persona = url.searchParams.get("persona") || "";
      const page = url.searchParams.get("page") ? parseInt(url.searchParams.get("page"), 10) : undefined;
      const pageSize = url.searchParams.get("pageSize") ? parseInt(url.searchParams.get("pageSize"), 10) : 50;
      const paginate = url.searchParams.get("paginate") === "true" || page !== undefined;

      const threads = loadThreads(amqRoot, { account, folder, query, persona, page, pageSize, paginate });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(threads));
      return;
    }

    if (pathname === "/api/send" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const result = sendAmqMessage(amqRoot, body);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === "/api/reply" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const result = replyAmqMessage(amqRoot, body);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === "/api/bridge/toggle" && req.method === "POST") {
      const pid = isDaemonRunning();
      let result;
      if (pid) {
        result = stopDaemon();
      } else {
        result = startDaemonBackground();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ─── Option A: Content-Addressed Blobstore Endpoint ───────────────────
    if ((pathname.startsWith("/api/blob/") || pathname.startsWith("/api/blobs/")) && (req.method === "GET" || req.method === "HEAD")) {
      const parts = pathname.split("/");
      const hashPart = parts[3] || parts[2] || "";
      const cleanHash = hashPart.split(".")[0];

      const blob = getBlob(cleanHash, amqRoot);
      if (!blob || !fs.existsSync(blob.filePath)) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Blob not found in store", sha256: cleanHash }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": blob.mime,
        "Content-Length": blob.sizeBytes,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const stream = fs.createReadStream(blob.filePath);
      stream.pipe(res);
      return;
    }

    if (pathname === "/api/blobs" && req.method === "POST") {
      let bodyBuffers = [];
      req.on("data", (chunk) => bodyBuffers.push(chunk));
      req.on("end", () => {
        try {
          const totalBuffer = Buffer.concat(bodyBuffers);
          if (!totalBuffer.length) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Empty upload content" }));
            return;
          }
          const filename = url.searchParams.get("name") || "artifact";
          const blobDesc = storeBlob(totalBuffer, amqRoot, filename);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, blob: blobDesc }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ─── Option B: Git Commit & Object Pinning Endpoint ────────────────────
    if (pathname === "/api/git-file" && (req.method === "GET" || req.method === "HEAD")) {
      const commit = url.searchParams.get("commit");
      const gitPath = url.searchParams.get("path");
      if (!commit || !gitPath) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Missing required commit or path parameter" }));
        return;
      }

      const repoRoot = path.resolve(path.dirname(amqRoot));
      const gitRef = readGitRef(repoRoot, commit, gitPath);
      if (!gitRef) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Git object not found at commit", commit, path: gitPath }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": gitRef.mime,
        "Content-Length": gitRef.sizeBytes,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(gitRef.buffer);
      return;
    }

    if (pathname === "/api/file" && (req.method === "GET" || req.method === "HEAD")) {
      const targetPath = url.searchParams.get("path");
      if (!targetPath) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing path parameter");
        return;
      }

      const repoRoot = path.resolve(path.dirname(amqRoot));

      // Security check: reject forbidden path tokens
      const lowerReq = targetPath.toLowerCase();
      const forbiddenTokens = [
        ".ssh",
        ".env",
        ".git",
        "/etc",
        "/proc",
        "/sys",
        "/root",
        "id_rsa",
        "id_ed25519",
        "credentials",
        ".pem",
        ".key",
        ".bash_history",
      ];
      if (forbiddenTokens.some((token) => lowerReq.includes(token))) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Access denied: path contains forbidden patterns", requested: targetPath }));
        return;
      }

      // If absolute path was requested, verify it is strictly within allowed roots
      if (path.isAbsolute(targetPath) && !isPathSafe(targetPath, repoRoot, amqRoot)) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Access denied: absolute path outside allowed roots", requested: targetPath }));
        return;
      }

      const resolved = resolveAttachmentPath(targetPath, amqRoot);
      if (!resolved || !isPathSafe(resolved, repoRoot, amqRoot) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "File not found or access denied", requested: targetPath }));
        return;
      }

      const ext = path.extname(resolved).toLowerCase();
      const mimeTypes = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".bmp": "image/bmp",
        ".log": "text/plain; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".csv": "text/plain; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".gd": "text/plain; charset=utf-8",
        ".tscn": "text/plain; charset=utf-8",
        ".tres": "text/plain; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".sh": "text/plain; charset=utf-8",
        ".diff": "text/plain; charset=utf-8",
        ".patch": "text/plain; charset=utf-8",
      };

      const contentType = mimeTypes[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(resolved).pipe(res);
      return;
    }

    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": ok\n\n");

      sseClients.add(res);

      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    // ─── Static Files ────────────────────────────────────────────────────────

    let filePath;
    if (pathname === "/" || pathname === "/index.html") {
      filePath = path.join(WEB_ROOT, "index.html");
    } else if (pathname === "/style.css") {
      filePath = path.join(WEB_ROOT, "style.css");
    } else if (pathname === "/app.js") {
      filePath = path.join(WEB_ROOT, "app.js");
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mime =
        ext === ".html"
          ? "text/html; charset=utf-8"
          : ext === ".css"
          ? "text/css; charset=utf-8"
          : "application/javascript; charset=utf-8";

    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-store, max-age=0",
    });
    fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("File not found");
    }
  };

  const server = http.createServer(requestHandler);
  let server6 = null;

  server.listen(port, host, () => {
    const boundPort = server.address()?.port || port;
    console.log(`\x1b[32m● AGmail Webmail Server running at:\x1b[0m \x1b[1mhttp://${host}:${boundPort}\x1b[0m (local only)`);
    console.log(`  Queue Root: \x1b[36m${amqRoot}\x1b[0m`);
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.warn(`\x1b[33m⚠️  SECURITY WARNING: Server is listening on '${host}'. AGmail contains sensitive agent data and should strictly be local-only!\x1b[0m`);
    }

    // If host is loopback, also listen on ::1 so browser 'localhost' connects seamlessly in IPv6-first browsers (Firefox/Chrome)
    if (host === "127.0.0.1" || host === "localhost") {
      try {
        server6 = http.createServer(requestHandler);
        server6.listen(boundPort, "::1", () => {});
        server6.on("error", () => {
          // Graceful fallback if system does not support IPv6 loopback
          server6 = null;
        });
      } catch {}
    }

    // Workspaces are the default: automatically isolate agents in worktrees in background
    setImmediate(() => {
      try {
        const repoRoot = getRepoRootFromAmq(amqRoot);
        const handles = getAgentHandles(amqRoot);
        ensureAllWorktrees(repoRoot, handles);
      } catch {}
    });
  });

  const originalCloseAll = server.closeAllConnections?.bind(server);
  server.closeAllConnections = function () {
    if (originalCloseAll) originalCloseAll();
    if (server6 && typeof server6.closeAllConnections === "function") {
      try { server6.closeAllConnections(); } catch {}
    }
  };

  server.on("close", () => {
    isClosing = true;
    if (server6) {
      try {
        if (typeof server6.closeAllConnections === "function") {
          server6.closeAllConnections();
        }
        server6.close();
      } catch {}
      server6 = null;
    }
    if (herdrReconnectTimeout) clearTimeout(herdrReconnectTimeout);
    if (herdrRefreshDebounce) clearTimeout(herdrRefreshDebounce);
    if (herdrStatusFlushTimer) clearTimeout(herdrStatusFlushTimer);
    pendingHerdrStatusEvents.clear();
    if (watchDebounce) clearTimeout(watchDebounce);
    if (herdrSubscription) {
      try { herdrSubscription.close(); } catch {}
    }
    if (watcher) {
      try { watcher.close(); } catch {}
    }
    if (statusWatcher) {
      try { statusWatcher.close(); } catch {}
    }
    for (const client of sseClients) {
      try { client.end(); } catch {}
    }
    sseClients.clear();
  });

  return server;
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let acc = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      acc += chunk;
      if (Buffer.byteLength(acc) > 1024 * 1024) {
        acc = "";
        tooLarge = true;
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        resolve({ __error: "request body too large" });
        return;
      }
      try {
        resolve(JSON.parse(acc));
      } catch {
        resolve({});
      }
    });
  });
}
