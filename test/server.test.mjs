import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startWebServer } from "../src/server.mjs";

describe("server.mjs API integration tests", () => {
  let tempRoot;
  let server;
  let baseUrl;

  before(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amq-server-test-"));
    const agentsDir = path.join(tempRoot, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    // Mock agent-one
    const a1Dir = path.join(agentsDir, "agent-one");
    fs.mkdirSync(path.join(a1Dir, "inbox", "new"), { recursive: true });
    fs.mkdirSync(path.join(a1Dir, "outbox", "sent"), { recursive: true });

    // Mock agent-two
    const a2Dir = path.join(agentsDir, "agent-two");
    fs.mkdirSync(path.join(a2Dir, "inbox", "cur"), { recursive: true });
    fs.mkdirSync(path.join(a2Dir, "outbox", "sent"), { recursive: true });

    // Add a sent message from agent-one
    fs.writeFileSync(
      path.join(a1Dir, "outbox", "sent", "msg-1.md"),
      `---json
{
  "id": "msg-1",
  "from": "agent-one",
  "to": ["agent-two"],
  "subject": "Server test transmission",
  "thread": "th-1",
  "created": "2026-09-22T12:00:00.000Z"
}
---
Test body`
    );

    // Start server on an ephemeral port
    server = startWebServer({ port: 0, amqRoot: tempRoot });
    await new Promise((resolve) => server.once("listening", resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    // Clean up brief files leaked into /tmp by saveAgentBrief (repoRoot = /tmp)
    const leaked = path.join(os.tmpdir(), ".opencode");
    if (fs.existsSync(leaked)) fs.rmSync(leaked, { recursive: true, force: true });
  });

  test("GET /api/status returns server metadata and agent count", async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.agentCount, 2);
    assert.equal(typeof data.storage, "object");
  });

  test("GET /api/agents returns discovered agents dynamically", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    assert.equal(res.status, 200);
    const agents = await res.json();
    assert.equal(Array.isArray(agents), true);
    assert.ok(agents.length >= 2, `expected at least 2 agents, got ${agents.length}`);
    const handles = agents.map((a) => a.handle);
    assert.ok(handles.includes("agent-one"), "agent-one must be present");
    assert.ok(handles.includes("agent-two"), "agent-two must be present");
  });

  test("GET /api/messages?folder=sent returns sent transmissions", async () => {
    const res = await fetch(`${baseUrl}/api/messages?folder=sent`);
    assert.equal(res.status, 200);
    const msgs = await res.json();
    assert.equal(Array.isArray(msgs), true);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].id, "msg-1");
    assert.equal(msgs[0].folder, "sent");
  });

  test("GET /api/threads?folder=sent returns conversation threads", async () => {
    const res = await fetch(`${baseUrl}/api/threads?folder=sent`);
    assert.equal(res.status, 200);
    const threads = await res.json();
    assert.equal(Array.isArray(threads), true);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].threadId, "th-1");
  });

  test("GET /api/threads with query=from:me resolves to persona", async () => {
    const resOne = await fetch(`${baseUrl}/api/threads?query=from:me&persona=agent-one`);
    assert.equal(resOne.status, 200);
    const threadsOne = await resOne.json();
    assert.equal(threadsOne.length, 1);

    const resTwo = await fetch(`${baseUrl}/api/threads?query=from:me&persona=agent-two`);
    assert.equal(resTwo.status, 200);
    const threadsTwo = await resTwo.json();
    assert.equal(threadsTwo.length, 0);
  });

  test("GET /api/file rejects unauthorized path traversal", async () => {
    const res = await fetch(`${baseUrl}/api/file?path=/etc/passwd`);
    assert.equal(res.status, 403);
  });

  test("GET /api/file strictly blocks .ssh and .env security exploits", async () => {
    const resSsh = await fetch(`${baseUrl}/api/file?path=/home/cabra.lat/.ssh/config`);
    assert.equal(resSsh.status, 403);
    const sshData = await resSsh.json();
    assert.ok(sshData.error.includes("Access denied"));

    const resEnv = await fetch(`${baseUrl}/api/file?path=%2Fhome%2Fcabra.lat%2F.env`);
    assert.equal(resEnv.status, 403);

    const resKey = await fetch(`${baseUrl}/api/file?path=/tmp/shooter/../../id_rsa`);
    assert.equal(resKey.status, 403);
  });

  test("GET /api/messages with paginate=true returns paginated envelope", async () => {
    const res = await fetch(`${baseUrl}/api/messages?folder=sent&paginate=true&pageSize=10`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.total, "number");
    assert.equal(data.page, 1);
    assert.equal(data.pageSize, 10);
    assert.equal(Array.isArray(data.items), true);
    assert.equal(data.items.length, 1);
  });

  test("GET /api/threads with paginate=true returns paginated envelope", async () => {
    const res = await fetch(`${baseUrl}/api/threads?folder=sent&paginate=true&pageSize=10`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.total, "number");
    assert.equal(data.page, 1);
    assert.equal(Array.isArray(data.items), true);
  });

  test("POST /api/agents registers new agent with backend model and directory", async () => {
    const payload = {
      handle: "auditor-bot",
      name: "Security Auditor",
      role: "Vulnerability Scanning",
      model: "gemini-2.5-flash",
      emoji: "🛡️",
    };

    const res = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.agent.handle, "auditor-bot");
    assert.equal(data.agent.model, "gemini-2.5-flash");
    assert.ok(data.worktreeResult !== undefined);

    // Verify it is returned in GET /api/agents
    const listRes = await fetch(`${baseUrl}/api/agents`);
    const agents = await listRes.json();
    const created = agents.find((a) => a.handle === "auditor-bot");
    assert.ok(created);
    assert.equal(created.profile.model, "gemini-2.5-flash");
    assert.equal(created.profile.role, "Vulnerability Scanning");
  });

  test("GET /api/worktrees returns worktree list", async () => {
    const res = await fetch(`${baseUrl}/api/worktrees`);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(Array.isArray(list), true);
  });

  test("GET /api/models returns dynamic model suggestions", async () => {
    const res = await fetch(`${baseUrl}/api/models`);
    assert.equal(res.status, 200);
    const models = await res.json();
    assert.equal(Array.isArray(models), true);
    assert.ok(models.length > 0);
    assert.ok(models.some((m) => m.id === "claude-3-7-sonnet"));
    assert.ok(models.some((m) => m.id === "gemini-2.5-flash"));
  });

  test("POST /api/worktrees/ensure-all processes swarm worktree isolation", async () => {
    const res = await fetch(`${baseUrl}/api/worktrees/ensure-all`, { method: "POST" });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(Array.isArray(data.results), true);
  });

  test("GET / serves the AGmail HTML interface with responsive layout elements", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("AGmail"));
    assert.ok(text.includes("search-input"));
    assert.ok(text.includes("sidebar-backdrop"));
    assert.ok(text.includes("chat-context-menu"));
    assert.ok(text.includes("model-suggestions"));
    assert.ok(text.includes("brief-chips-list"));
  });

  test("GET /api/agent-briefs returns array of disk agent definitions", async () => {
    const res = await fetch(`${baseUrl}/api/agent-briefs`);
    assert.equal(res.status, 200);
    const briefs = await res.json();
    assert.equal(Array.isArray(briefs), true);
  });

  test("POST /api/agent-briefs saves brief to disk and GET retrieves it", async () => {
    const payload = {
      handle: "perf-benchmarker",
      role: "Frame time analyzer",
      description: "Profiles GPU and CPU frametimes across harnesses",
      prompt: "Monitor frametimes under 120fps cap and flag regressions.",
      model: "claude-3-7-sonnet",
    };

    const postRes = await fetch(`${baseUrl}/api/agent-briefs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(postData.ok, true);

    const getRes = await fetch(`${baseUrl}/api/agent-briefs/perf-benchmarker`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.ok, true);
    assert.equal(getData.brief.handle, "perf-benchmarker");
    assert.ok(getData.brief.prompt.includes("Monitor frametimes"));
  });

  test("GET /api/herdr-agents returns an array (empty if Herdr not running)", async () => {
    const res = await fetch(`${baseUrl}/api/herdr-agents`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data), "herdr-agents should be an array");
    // In test environment Herdr socket is not available → empty array is fine
    // If Herdr IS running, each agent has agent_status
    for (const agent of data) {
      assert.ok(typeof agent.agent_status === "string", "each agent has agent_status");
    }
  });

  test("GET /api/agents merges herdrStatus when Herdr is running", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data), "agents is an array");
    // Each agent that was enriched by Herdr has herdrStatus field
    for (const agent of data) {
      if (agent.herdrStatus !== undefined) {
        assert.ok(
          ["idle", "working", "done", "blocked", "unknown", "error"].includes(agent.herdrStatus),
          `herdrStatus should be a known value, got: ${agent.herdrStatus}`
        );
      }
    }
  });

  test("GET /api/board returns board structure and stats", async () => {
    const res = await fetch(`${baseUrl}/api/board`);

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.columns);
    assert.ok(Array.isArray(data.columns.backlog));
    assert.ok(Array.isArray(data.columns.in_progress));
    assert.ok(Array.isArray(data.columns.blocked));
    assert.ok(Array.isArray(data.columns.done));
    assert.ok(typeof data.stats === "object");
  });

  test("POST, PATCH, and DELETE /api/board/tasks manages custom tasks", async () => {
    // 1. Create task
    const postRes = await fetch(`${baseUrl}/api/board/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Task via API",
        owner: "coordinator",
        status: "backlog",
        description: "Integration test for board",
      }),
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(postData.ok, true);
    assert.ok(postData.task.id);
    const taskId = postData.task.id;

    // Verify task is in backlog
    const boardRes = await fetch(`${baseUrl}/api/board`);
    const boardData = await boardRes.json();
    assert.ok(boardData.columns.backlog.some((t) => t.id === taskId));

    // 2. Move task to in_progress
    const patchRes = await fetch(`${baseUrl}/api/board/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    assert.equal(patchRes.status, 200);
    const patchData = await patchRes.json();
    assert.equal(patchData.ok, true);

    const boardRes2 = await fetch(`${baseUrl}/api/board`);
    const boardData2 = await boardRes2.json();
    assert.ok(boardData2.columns.in_progress.some((t) => t.id === taskId));
    assert.ok(!boardData2.columns.backlog.some((t) => t.id === taskId));

    // 3. Delete task
    const delRes = await fetch(`${baseUrl}/api/board/tasks/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.equal(delData.ok, true);

    const boardRes3 = await fetch(`${baseUrl}/api/board`);
    const boardData3 = await boardRes3.json();
    assert.ok(!boardData3.columns.in_progress.some((t) => t.id === taskId));
  });

  test("POST /api/blobs and GET /api/blob/:sha256 serves CAS artifacts immutably", async () => {
    const rawData = "Screenshot buffer or binary log file from agent execution.";
    const postRes = await fetch(`${baseUrl}/api/blobs?name=spotter_report.log`, {
      method: "POST",
      body: rawData,
    });
    assert.equal(postRes.status, 201);
    const postData = await postRes.json();
    assert.equal(postData.ok, true);
    assert.ok(postData.blob.sha256);
    assert.equal(postData.blob.name, "spotter_report.log");

    // Fetch the blob by its content-addressed hash
    const getRes = await fetch(`${baseUrl}/api/blob/${postData.blob.sha256}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(getRes.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const fetchedText = await getRes.text();
    assert.equal(fetchedText, rawData);

    // 404 for unknown blob hash
    const unknownRes = await fetch(`${baseUrl}/api/blob/0000000000000000000000000000000000000000000000000000000000000000`);
    assert.equal(unknownRes.status, 404);
  });
});


