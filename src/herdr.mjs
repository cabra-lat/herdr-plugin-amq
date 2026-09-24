/**
 * herdr.mjs — Herdr Socket API client for AGmail
 *
 * Connects to the running Herdr server via its Unix socket and provides:
 *   - getHerdrAgents()        – one-shot snapshot of live agent records
 *   - subscribeAgentEvents()  – long-lived event subscription, calls cb on each state change
 *   - getSocketPath()         – resolve the Herdr socket path
 *
 * Protocol: JSON-RPC 2.0 over a Unix domain socket (newline-delimited JSON frames).
 * See: https://herdr.dev/docs/socket-api/
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { getOpenCodeSessionModels, resolveRuntimeModel } from "./runtime-models.mjs";
import { findAmqRoot, getAgentHandles } from "./config.mjs";

// ─── Socket Path Resolution ──────────────────────────────────────────────────

export function getSocketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  // Default: ~/.config/herdr/herdr.sock
  return path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

// ─── Low-level request helper (one-shot connect, send, read response) ────────

function socketRequest(method, params = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath();
    const id = `amq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const payload = JSON.stringify({ id, method, params }) + "\n";

    const sock = net.createConnection(socketPath);
    let buf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(`herdr socket request timed out (${method})`));
      }
    }, timeoutMs);

    sock.on("connect", () => {
      sock.write(payload);
    });

    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id && !settled) {
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch {}
      }
    });

    sock.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    sock.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("herdr socket closed before response"));
      }
    });
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the list of agent records from the live Herdr session snapshot.
 * Each record has: { name, agent, agent_status, pane_id, workspace_id, cwd, terminal_title, ... }
 * Returns [] if Herdr is not running or socket unavailable.
 */
export async function getHerdrAgents() {
  try {
    const result = await socketRequest("session.snapshot", {});
    const snapshot = result?.snapshot || result || {};
    return Array.isArray(snapshot.agents) ? snapshot.agents : [];
  } catch {
    return [];
  }
}

/**
 * Returns a map of  handle → { agent_status, pane_id, workspace_id, terminal_title }
 * by matching `name` field from Herdr agent records to AMQ handles.
 * Handles without a `name` in Herdr are skipped.
 */
export async function getHerdrStatusMap() {
  const agents = await getHerdrAgents();
  const observedAt = new Date().toISOString();
  const sessionModels = getOpenCodeSessionModels(agents);
  // Pi records do not consistently carry Herdr's `name` field. Resolve their
  // handle from the canonical title (for example, `π - qa`) and only accept
  // handles registered in this workspace; a generic or human title must not
  // silently become an AMQ agent.
  const knownHandles = new Set(getAgentHandles(findAmqRoot()).map((handle) => normalizeHandle(handle)));
  const map = new Map();
  for (const agent of agents) {
    const activity = mapHerdrAgentActivity(agent, observedAt, resolveRuntimeModel(agent, sessionModels), knownHandles);
    if (activity) map.set(activity.herdrHandle, activity);
  }
  return map;
}

function normalizeHandle(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,127}$/.test(text) ? text : "";
}

function titleHandle(agent, knownHandles = null) {
  const title = herdrText(agent?.terminal_title_stripped) || herdrText(agent?.terminal_title);
  const match = title.match(/(?:^|\s)[-–—]\s*([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
  const candidate = normalizeHandle(match?.[1]);
  if (!candidate) return "";
  if (knownHandles && !knownHandles.has(candidate)) return "";
  return candidate;
}

function resolveHerdrHandle(agent, knownHandles = null) {
  const named = normalizeHandle(herdrText(agent?.name));
  if (named) return named;

  const fromTitle = titleHandle(agent, knownHandles);
  if (fromTitle) return fromTitle;

  // A manually started agent may have lost its title/name, but its worktree
  // still identifies it unambiguously. This intentionally never guesses from
  // the repository root: the human's root pane is not an AMQ agent.
  const cwd = herdrText(agent?.cwd);
  if (cwd && knownHandles) {
    const normalizedCwd = path.resolve(cwd);
    for (const handle of knownHandles) {
      if (normalizedCwd.endsWith(`${path.sep}.worktrees${path.sep}${handle}`)) return handle;
    }
  }
  return "";
}

export function normalizeHerdrStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (status === "online") return "idle";
  if (status === "active") return "working";
  if (["idle", "working", "blocked", "done", "error", "unknown"].includes(status)) return status;
  return "unknown";
}

function herdrText(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  for (const key of ["text", "label", "title", "value"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return "";
}

function herdrStateLabels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [status, label] of Object.entries(value)) {
    const text = herdrText(label);
    if (text) result[status] = text;
  }
  return result;
}

function herdrTokens(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map(herdrText).filter(Boolean);
}

export function mapHerdrAgentActivity(agent, observedAt = new Date().toISOString(), runtime = null, knownHandles = null) {
  const handle = resolveHerdrHandle(agent, knownHandles);
  if (!handle) return null;
  const status = normalizeHerdrStatus(agent?.agent_status);
  const terminalTitle = herdrText(agent?.terminal_title_stripped) || herdrText(agent?.terminal_title);
  const metadataTitle = herdrText(agent?.title);
  const model = runtime || resolveRuntimeModel(agent);
  return {
    herdrHandle: handle,
    herdrStatus: status,
    herdrPaneId: herdrText(agent?.pane_id),
    herdrWorkspaceId: herdrText(agent?.workspace_id),
    herdrTabId: herdrText(agent?.tab_id),
    herdrTerminalId: herdrText(agent?.terminal_id),
    herdrTitle: terminalTitle || metadataTitle,
    herdrTerminalTitle: terminalTitle,
    herdrMetadataTitle: metadataTitle,
    herdrStateLabels: herdrStateLabels(agent?.state_labels),
    herdrTokens: herdrTokens(agent?.tokens),
    herdrStateChangeSeq: Number.isFinite(agent?.state_change_seq) ? agent.state_change_seq : null,
    interactiveReady: Boolean(agent?.interactive_ready),
    herdrFocused: Boolean(agent?.focused),
    herdrLaunchPending: Boolean(agent?.launch_pending),
    agentType: herdrText(agent?.agent),
    herdrSessionId: model.sessionId || null,
    herdrModel: model.model || null,
    herdrModelSource: model.source || null,
    herdrObservedAt: observedAt,
  };
}

export function normalizeHerdrEvent(message) {
  if (!message || typeof message !== "object") return null;
  if (message.method && message.params && typeof message.params === "object") {
    return { type: String(message.method), ...message.params };
  }
  if (message.event && message.data && typeof message.data === "object") {
    const payload = message.data.pane && typeof message.data.pane === "object" ? message.data.pane : message.data;
    return { ...payload, type: String(message.event).replace("_", ".") };
  }
  return null;
}

// ─── Long-lived event subscription ──────────────────────────────────────────

/**
 * Opens a persistent connection to Herdr's events.subscribe endpoint.
 * Calls onEvent(event) for each incoming event object.
 * Calls onDisconnect() when the socket closes.
 * Returns a { close() } handle.
 *
 * Relevant event types:
 *   agent.state_changed   — { pane_id, name, agent_status, ... }
 *   pane.created / pane.closed
 *   workspace.created / workspace.closed
 */
export function subscribeHerdrEvents({ onEvent, onDisconnect, onConnect } = {}) {
  const socketPath = getSocketPath();
  const subId = `amq_sub_${Date.now()}`;
  const payload =
    JSON.stringify({
      id: subId,
      method: "events.subscribe",
      params: {
        subscriptions: [{ type: "pane.updated" }],
      },
    }) + "\n";

  let sock = null;
  let closed = false;
  let buf = "";

  function connect() {
    if (closed) return;
    try {
      sock = net.createConnection(socketPath);

      sock.on("connect", () => {
        buf = "";
        sock.write(payload);
        if (onConnect) onConnect();
      });

      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === subId && msg.result) continue;
            const event = normalizeHerdrEvent(msg);
            if (event && onEvent) onEvent(event);
          } catch {}
        }
      });

      sock.on("error", () => {});
      sock.on("close", () => {
        if (!closed && onDisconnect) onDisconnect();
      });
    } catch {}
  }

  connect();

  return {
    close() {
      closed = true;
      if (sock) {
        try { sock.destroy(); } catch {}
      }
    },
  };
}

// ─── Herdr availability check ────────────────────────────────────────────────

/**
 * Returns true if the Herdr socket file exists and is reachable.
 */
export async function isHerdrAvailable() {
  try {
    await socketRequest("session.snapshot", {}, 2000);
    return true;
  } catch {
    return false;
  }
}
