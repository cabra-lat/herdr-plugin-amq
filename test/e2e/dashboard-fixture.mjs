import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startWebServer } from "../../src/server.mjs";

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

class FakeHerdr {
  constructor(socketPath, agents) {
    this.socketPath = socketPath;
    this.agents = agents;
    this.sockets = new Set();
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  handleConnection(socket) {
    this.sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        if (request.method === "session.snapshot") {
          this.respond(socket, request.id, { snapshot: { agents: this.agents } });
        } else if (request.method === "events.subscribe") {
          this.respond(socket, request.id, {});
        } else {
          this.respond(socket, request.id, null, { code: -32601, message: "Method not found" });
        }
      }
    });
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
  }

  respond(socket, id, result, error = null) {
    socket.write(`${JSON.stringify(error ? { id, error } : { id, result })}\n`);
  }

  setAgents(agents) {
    this.agents = agents;
  }

  emit(event) {
    const payload = `${JSON.stringify({ method: event.type, params: event })}\n`;
    for (const socket of this.sockets) {
      if (!socket.destroyed) socket.write(payload);
    }
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
    try {
      fs.unlinkSync(this.socketPath);
    } catch {}
  }
}

function seedAgent(amqRoot, handle, profile) {
  const agentDir = path.join(amqRoot, "agents", handle);
  fs.mkdirSync(path.join(agentDir, "inbox", "new"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "inbox", "cur"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "outbox", "sent"), { recursive: true });
  writeJson(path.join(agentDir, "profile.json"), profile);
  return agentDir;
}

function seedMessage(agentDir) {
  const messages = [
    {
      id: "2026-09-24T07-55-00-000Z_fixture-message-1",
      from: "coordinator",
      created: "2026-09-24T07:55:00.000Z",
      body: "Start the arena refresh and keep the integrated Gunsmith scene in the verification path.",
    },
    {
      id: "2026-09-24T08-00-00-000Z_fixture-message-2",
      from: "range",
      created: "2026-09-24T08:00:00.000Z",
      body: "The scene is wired. I am now checking spawn adapters and the final integrated preview.",
    },
    {
      id: "2026-09-24T08-05-00-000Z_fixture-message-3",
      from: "range",
      created: "2026-09-24T08:05:00.000Z",
      body: `Latest gate evidence is ready.\n\nArena refresh: PASS\nIntegrated Gunsmith preview: PASS\nSpawn adapter: PASS\nHeadless screenshot: PASS\nMobile journey: PASS\n\nSee https://example.com/docs for the verification notes.\nUnicode boundary: préhttps://not-a-link.example and https://unicode.example/café.\nMultiple URLs: https://one.example/a and https://two.example/b.\nTrailing punctuation: https://trailing.example/path.\nMarkdown label: [documentation](https://markdown.example/path).\nInline code: \`https://inline.example/code\`.\n\n\`\`\`\nhttps://fenced.example/code\n\`\`\`\n\nThe final gate is now the only remaining action.`,
    },
  ];
  for (const message of messages) {
    const metadata = {
      schema: 1,
      id: message.id,
      from: message.from,
      to: ["range"],
      subject: message === messages[0] ? "Refresh arena v4 with integrated Gunsmith" : "Re: Refresh arena v4 with integrated Gunsmith",
      thread: "agboard/task-ui-fixture",
      created: message.created,
      kind: "task",
    };
    const content = `---json\n${JSON.stringify(metadata, null, 2)}\n---\n${message.body}\n`;
    fs.writeFileSync(path.join(agentDir, "inbox", "new", `${message.id}.md`), content, "utf8");
  }
  return messages.at(-1).id;
}

function seedUserMessage(amqRoot) {
  const userDir = seedAgent(amqRoot, "user", {
    name: "Human Operator",
    role: "Dashboard operator",
    model: "opencode/space-bunny-free (max)",
    emoji: "U",
    color: "#1a73e8",
  });
  const id = "2026-09-24T08-10-00-000Z_fixture-user-message";
  const content = `---json\n${JSON.stringify({
    schema: 1,
    id,
    from: "coordinator",
    to: ["user"],
    subject: "User mailbox read-state check",
    thread: "agboard/user-read-fixture",
    created: "2026-09-24T08:10:00.000Z",
    kind: "status",
  }, null, 2)}\n---\nOpen this message from the user account to verify it becomes read.\n`;
  fs.writeFileSync(path.join(userDir, "inbox", "new", `${id}.md`), content, "utf8");
}

function seedTask(amqRoot) {
  const taskDir = path.join(amqRoot, "bus", "in_progress");
  fs.mkdirSync(taskDir, { recursive: true });
  const content = `---
id: task-ui-fixture
title: Refresh arena v4 with integrated Gunsmith
owner: range
status: in_progress
created: 2026-09-24T08:00:00.000Z
updated: 2026-09-24T08:05:00.000Z
thread: agboard/task-ui-fixture
---
Verify the mobile activity journey and current task detail.
`;
  fs.writeFileSync(path.join(taskDir, "task-ui-fixture.md"), content, "utf8");
  const blockedDir = path.join(amqRoot, "bus", "blocked");
  fs.mkdirSync(blockedDir, { recursive: true });
  const blockedContent = `---
id: task-ui-blocked-fixture
title: Review mobile task assignment copy
owner: range
status: blocked
created: 2026-09-24T08:10:00.000Z
updated: 2026-09-24T08:15:00.000Z
thread: agboard/task-ui-blocked-fixture
---
Confirm the owner warning is visible when a peer has blocked work.
`;
  fs.writeFileSync(path.join(blockedDir, "task-ui-blocked-fixture.md"), blockedContent, "utf8");
}

export async function createDashboardFixture({ registerAmqRootEnv = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amq-browser-fixture-"));
  const amqRoot = path.join(root, ".agent-mail");
  const stateDir = path.join(root, "state");
  const socketPath = path.join(root, "herdr.sock");
  fs.mkdirSync(amqRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const rangeProfile = {
    name: "Range Owner",
    role: "Shooting range systems engineer",
    model: "opencode/gpt-5.4",
    emoji: "R",
    color: "#1a73e8",
  };
  const qaProfile = {
    name: "Quality Auditor",
    role: "Code quality and invariant reviewer",
    model: "opencode/gpt-5.4",
    emoji: "Q",
    color: "#188038",
  };
  const rangeDir = seedAgent(amqRoot, "range", rangeProfile);
  seedAgent(amqRoot, "qa", qaProfile);
  seedAgent(amqRoot, "spotter", { name: "Spotter", role: "Numeric and visual verification", model: "opencode/gpt-5.4", emoji: "S", color: "#a142f4" });
  const latestMessageId = seedMessage(rangeDir);
  seedUserMessage(amqRoot);
  seedTask(amqRoot);

  const workingAgent = {
    name: "range",
    agent: "opencode",
    model: { id: "space-bunny-free", providerID: "opencode", variant: "max" },
    agent_session: { agent: "opencode", source: "herdr:opencode", value: "ses_e2e_range_fixture" },
    agent_status: "working",
    pane_id: "pane-range",
    workspace_id: "workspace-range",
    tab_id: "tab-range",
    terminal_id: "terminal-range",
    terminal_title_stripped: "Refreshing arena v4",
    title: { label: "Range implementation" },
    state_labels: { working: "Implementing arena refresh", idle: "Waiting for the next gate" },
    tokens: ["Gunsmith integration", "Final gate pending"],
    state_change_seq: 42,
    interactive_ready: true,
    focused: true,
  };
  const idleAgent = {
    name: "qa",
    agent: "opencode",
    model: { id: "space-bunny-free", providerID: "opencode", variant: "max" },
    agent_session: { agent: "opencode", source: "herdr:opencode", value: "ses_e2e_qa_fixture" },
    agent_status: "idle",
    pane_id: "pane-qa",
    workspace_id: "workspace-qa",
    terminal_title_stripped: "QA console",
    state_labels: { idle: "Reviewing verification evidence" },
    tokens: [],
    state_change_seq: 12,
    interactive_ready: true,
  };
  // Negative control: this agent is reported by the fake Herdr session but is NOT
  // registered in this AMQ root. It must never become an agent row, so a passing
  // presence assertion cannot be vacuous.
  const intruderAgent = {
    name: "unregistered-intruder",
    agent: "pi",
    model: { id: "space-bunny-free", providerID: "opencode", variant: "max" },
    agent_session: { agent: "pi", source: "herdr:pi", value: "ses_e2e_intruder" },
    agent_status: "working",
    pane_id: "pane-intruder",
    workspace_id: "workspace-intruder",
    tab_id: "tab-intruder",
    terminal_id: "terminal-intruder",
    terminal_title_stripped: "Someone else's session",
    state_labels: { working: "Doing unrelated work" },
    tokens: ["unrelated"],
    state_change_seq: 7,
    interactive_ready: true,
  };

  // Title-only agent: no Herdr `name`, identity can only come from the canonical
  // pane title, and only when the handle is registered in the AMQ root.
  const titleOnlyAgent = {
    name: "",
    agent: "pi",
    model: { id: "space-bunny-free", providerID: "opencode", variant: "max" },
    agent_session: { agent: "pi", source: "herdr:pi", value: "ses_e2e_spotter" },
    agent_status: "idle",
    pane_id: "pane-spotter",
    workspace_id: "workspace-spotter",
    tab_id: "tab-spotter",
    terminal_id: "terminal-spotter",
    terminal_title_stripped: "π - spotter",
    state_labels: { idle: "Watching the arena" },
    tokens: [],
    state_change_seq: 3,
    interactive_ready: true,
  };

  const herdr = new FakeHerdr(socketPath, [workingAgent, idleAgent, intruderAgent, titleOnlyAgent]);
  await herdr.start();

  const previous = {
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
    HERDR_PLUGIN_STATE_DIR: process.env.HERDR_PLUGIN_STATE_DIR,
    AM_ROOT: process.env.AM_ROOT,
    OPENCODE_BIN_PATH: process.env.OPENCODE_BIN_PATH,
  };
  process.env.HERDR_SOCKET_PATH = socketPath;
  process.env.HERDR_BIN_PATH = path.join(root, "missing-herdr");
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
  // Identity resolution reads the registered handles from findAmqRoot(), not from
  // the server's amqRoot argument. Agents whose Herdr record has no `name` can only
  // be resolved from the canonical pane title, and only when that handle is
  // registered here.
  if (registerAmqRootEnv) process.env.AM_ROOT = amqRoot;
  // Never spawn a real `opencode` binary from a test: the runtime-model lookup is a
  // synchronous child process, and one that hangs would freeze the event loop
  // instead of failing an assertion.
  process.env.OPENCODE_BIN_PATH = path.join(root, "missing-opencode");

  const server = startWebServer({ port: 0, host: "127.0.0.1", amqRoot });
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Herdr identity is resolved asynchronously after the server starts listening, so
  // returning earlier hands callers a fixture whose presence assertions fail for a
  // timing reason. Wait for the first real resolution instead of leaving a sleep in
  // every test, and fail loudly with what was actually seen if it never happens.
  const readyDeadline = Date.now() + 10000;
  let ready = false;
  let lastAgents = null;
  while (Date.now() < readyDeadline) {
    lastAgents = await fetch(`${baseUrl}/api/agents`)
      .then((response) => response.json())
      .catch(() => null);
    if (lastAgents && lastAgents.some((agent) => agent.handle === "range" && agent.herdrStatus)) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!ready) {
    const seen = (lastAgents || []).map((agent) => `${agent.handle}:${agent.herdrStatus || agent.status}`).join(", ");
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    throw new Error(`Dashboard fixture never resolved fake Herdr identity (saw: ${seen || "no agents"}).`);
  }

  return {
    baseUrl,
    herdr,
    latestMessageId,
    /** Registered handles this fixture expects to resolve from the Herdr session. */
    registeredHandles: ["range", "qa", "spotter", "user"],
    /** Handle present in the fake Herdr session but absent from the AMQ root. */
    unregisteredHandle: "unregistered-intruder",
    async close() {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await herdr.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
