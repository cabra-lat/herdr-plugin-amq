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
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

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
  const map = new Map();
  for (const a of agents) {
    const handle = a.name; // e.g. "ballistics", "testkit"
    if (handle) {
      map.set(handle, {
        herdrStatus: a.agent_status || "unknown",
        herdrPaneId: a.pane_id,
        herdrWorkspaceId: a.workspace_id,
        herdrTabId: a.tab_id,
        herdrTitle: a.terminal_title_stripped || a.terminal_title,
        interactiveReady: a.interactive_ready || false,
        agentType: a.agent,
      });
    }
  }
  return map;
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
      params: {},
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
            // Skip the ack for the subscribe call itself
            if (msg.id === subId && msg.result) continue;
            if (msg.method && msg.params && onEvent) {
              onEvent({ type: msg.method, ...msg.params });
            }
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
