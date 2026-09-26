import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startWebServer } from "../src/server.mjs";
import { sendMaildirMessage } from "../src/protocol.mjs";

describe("server.mjs API integration tests", () => {
  let tempRoot;
  let server;
  let baseUrl;
  let oldStateDir;
  let oldConfigDir;
  let oldSocketPath;
  let oldJobToken;

  before(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amq-server-test-"));
    oldStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(tempRoot, "state");
    oldConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(tempRoot, "config");
    oldSocketPath = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = path.join(tempRoot, "missing-herdr.sock");
    oldJobToken = process.env.AGMAIL_JOB_TOKEN;
    process.env.AGMAIL_JOB_TOKEN = "test-job-token";
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
    if (oldStateDir !== undefined) process.env.HERDR_PLUGIN_STATE_DIR = oldStateDir;
    else delete process.env.HERDR_PLUGIN_STATE_DIR;
    if (oldConfigDir !== undefined) process.env.HERDR_PLUGIN_CONFIG_DIR = oldConfigDir;
    else delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    if (oldSocketPath !== undefined) process.env.HERDR_SOCKET_PATH = oldSocketPath;
    else delete process.env.HERDR_SOCKET_PATH;
    if (oldJobToken !== undefined) process.env.AGMAIL_JOB_TOKEN = oldJobToken;
    else delete process.env.AGMAIL_JOB_TOKEN;
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    // Clean up brief files leaked into /tmp by saveAgentBrief (repoRoot = /tmp)
    const leaked = path.join(os.tmpdir(), ".opencode");
    if (fs.existsSync(leaked)) fs.rmSync(leaked, { recursive: true, force: true });
  });

  test("API routes declare JSON, and an unknown route is a 404 rather than a 200", async () => {
    // The deploy check that shipped a false green for hours was a bare status code.
    // The 404 is what makes a 200 mean something, so both are asserted here: a
    // route answering with the wrong content type is a broken API that still
    // answers 200, and a status-code-only check cannot tell the difference.
    for (const route of ["/api/status", "/api/agents", "/api/board", "/api/panes"]) {
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200, `${route} did not answer 200`);
      assert.match(
        res.headers.get("content-type") || "",
        /application\/json/,
        `${route} must declare application/json, got ${res.headers.get("content-type")}`,
      );
      const body = await res.json();
      assert.notEqual(body, null, `${route} body did not parse as JSON`);
    }

    const missing = await fetch(`${baseUrl}/api/definitely-not-a-route`);
    assert.equal(missing.status, 404, "an unknown route must be 404, not 200");
    assert.doesNotMatch(missing.headers.get("content-type") || "", /application\/json/);
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

  test("POST /api/messages/:id/read marks a user message read", async () => {
    const sent = sendMaildirMessage(tempRoot, {
      from: "agent-one",
      to: ["user"],
      subject: "User read state",
      body: "Opening this message should mark it read.",
    });
    const endpoint = `${baseUrl}/api/messages/${encodeURIComponent(sent.id)}/read?account=user`;
    const first = await fetch(endpoint, { method: "POST" });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      ok: true,
      alreadyRead: false,
      id: sent.id,
      filePath: path.join(tempRoot, "agents", "user", "inbox", "cur", `${sent.id}.md`),
    });
    assert.equal(fs.existsSync(path.join(tempRoot, "agents", "user", "inbox", "new", `${sent.id}.md`)), false);
    assert.equal(fs.existsSync(path.join(tempRoot, "agents", "user", "inbox", "cur", `${sent.id}.md`)), true);

    const second = await fetch(endpoint, { method: "POST" });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).alreadyRead, true);
    const invalid = await fetch(`${baseUrl}/api/messages/${sent.id}/read?account=all`, { method: "POST" });
    assert.equal(invalid.status, 400);
    for (const filePath of [
      path.join(tempRoot, "agents", "user", "inbox", "new", `${sent.id}.md`),
      path.join(tempRoot, "agents", "user", "inbox", "cur", `${sent.id}.md`),
      path.join(tempRoot, "agents", "agent-one", "outbox", "sent", `${sent.id}.md`),
    ]) fs.rmSync(filePath, { force: true });
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

  test("POST /api/agents rejects oversized request bodies", async () => {
    const res = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "oversized", name: "x".repeat(1024 * 1024) }),
    });
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.equal(data.ok, false);
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
     assert.ok(text.includes("Working = active turn"));
     assert.ok(text.includes("nav-view-panes"));
     assert.ok(text.includes("panes-view-section"));
     assert.ok(!text.includes("hangout-dialog"));
     assert.ok(text.includes("search-input"));
    assert.ok(text.includes("sidebar-backdrop"));
    assert.ok(text.includes("chat-context-menu"));
    assert.ok(text.includes("model-suggestions"));
    assert.ok(text.includes("brief-chips-list"));
    assert.ok(text.includes('id="open-settings-btn"'));
    assert.ok(text.includes('id="settings-backdrop"'));
    assert.ok(text.includes('name="reading-layout" value="full"'));
    assert.ok(text.includes('name="theme" value="dark"'));
    assert.ok(text.includes('id="agent-activity-dialog"'));
    assert.ok(text.includes('id="agent-activity-headline"'));
    assert.ok(text.includes('id="view-agent-task-btn"'));
  });

  test("GET / serves persisted reading layout and dark theme preferences", async () => {
    const appRes = await fetch(`${baseUrl}/app.js`);
    const appText = await appRes.text();
    const styleRes = await fetch(`${baseUrl}/style.css`);
    const styleText = await styleRes.text();

    assert.equal(appRes.status, 200);
    assert.equal(styleRes.status, 200);
    assert.match(appRes.headers.get("cache-control") || "", /no-store/);
    assert.match(styleRes.headers.get("cache-control") || "", /no-store/);
    assert.ok(appText.includes("agmail_reading_layout"));
    assert.ok(appText.includes("agmail_theme"));
    assert.ok(appText.includes("applyThemePreference"));
    assert.ok(appText.includes("applyReadingLayout"));
    assert.ok(appText.includes("herdr_agents_refresh"));
    assert.ok(appText.includes("getAgentTask"));
    assert.ok(appText.includes("openAgentActivity"));
    assert.ok(appText.includes("account-item-role"));
    const showMessageDetailBody = appText.match(/function showMessageDetail\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
    const hideMessageDetailBody = appText.match(/function hideMessageDetail\([^)]*\) \{([\s\S]*?)\n  \}/)?.[1] || "";
    assert.ok(showMessageDetailBody.includes('contentSplitterEl.classList.add("detail-open")'));
    assert.ok(showMessageDetailBody.includes('mailDetailViewEl.classList.remove("hidden")'));
    assert.equal(showMessageDetailBody.includes("showMessageDetail()"), false);
    assert.ok(hideMessageDetailBody.includes('contentSplitterEl.classList.remove("detail-open")'));
    assert.ok(hideMessageDetailBody.includes('mailDetailViewEl.classList.add("hidden")'));
    assert.ok(styleText.includes('html[data-theme="dark"]'));
    assert.ok(styleText.includes(".agent-activity-dialog"));
    assert.ok(styleText.includes(".presence-item:focus-visible"));
    assert.ok(styleText.includes('#splitter-view[data-reading-layout="full"].detail-open .mail-list-container'));
  });

  test("security headers allow same-origin video attachments", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") || "";
    assert.match(csp, /media-src 'self'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    // app.js renders pilot <video> cards for isVideo attachments
    const appText = await (await fetch(`${baseUrl}/app.js`)).text();
    assert.ok(appText.includes("<video controls"));
    assert.ok(appText.includes('preload="metadata"'));
  });

  test("GET /api/panes returns bounded terminal tails per lane", async () => {
    const res = await fetch(`${baseUrl}/api/panes?lines=10`);
    assert.equal(res.status, 200);
    const panes = await res.json();
    assert.equal(Array.isArray(panes), true);
    assert.ok(panes.length >= 1);
    for (const p of panes) {
      assert.equal(typeof p.handle, "string");
      assert.equal(typeof p.ok, "boolean");
      assert.equal(typeof p.output, "string");
      assert.ok(p.output.length <= 6000);
      assert.ok(typeof p.at === "string");
    }
    const filtered = await (await fetch(`${baseUrl}/api/panes?handle=agent-one`)).json();
    assert.ok(filtered.every((p) => p.handle === "agent-one"));
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

  test("GET and POST /api/coordinator-doorbell expose and persist the toggle", async () => {
    const getRes = await fetch(`${baseUrl}/api/coordinator-doorbell`);
    assert.equal(getRes.status, 200);
    const initial = await getRes.json();
    const doorbellCookie = (getRes.headers.get("set-cookie") || "").split(";")[0];
    assert.match(doorbellCookie, /^agmail_doorbell_[a-f0-9]+=1$/);
    assert.equal(initial.ok, true);
    assert.equal(initial.config.enabled, true);
    assert.ok(Array.isArray(initial.log));

    const postRes = await fetch(`${baseUrl}/api/coordinator-doorbell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(postRes.status, 200);
    const updated = await postRes.json();
    assert.equal(updated.ok, true);
    assert.equal(updated.config.enabled, false);
    const oldDisablePrompt = process.env.HERDR_DISABLE_PROMPT;
    process.env.HERDR_DISABLE_PROMPT = "1";
    const missingAuth = await fetch(`${baseUrl}/api/coordinator-doorbell/ping`, { method: "POST" });
    assert.equal(missingAuth.status, 403);
    const invalidAuth = await fetch(`${baseUrl}/api/coordinator-doorbell/ping`, { method: "POST", headers: { "X-AGmail-Job-Token": "wrong" } });
    assert.equal(invalidAuth.status, 403);
    const ping = await (await fetch(`${baseUrl}/api/coordinator-doorbell/ping`, { method: "POST", headers: { "X-AGmail-Job-Token": "test-job-token" } })).json();
    assert.equal(ping.prompted, true);
    const uiPing = await fetch(`${baseUrl}/api/coordinator-doorbell/ping`, { method: "POST", headers: { Origin: baseUrl, "X-AGmail-Doorbell": "1", Cookie: doorbellCookie } });
    assert.equal(uiPing.status, 200);
    if (oldDisablePrompt === undefined) delete process.env.HERDR_DISABLE_PROMPT;
    else process.env.HERDR_DISABLE_PROMPT = oldDisablePrompt;
    assert.equal((await uiPing.json()).prompted, true);
    /* The token path above is the API path; the cookie path is the dashboard path. */
    if (oldDisablePrompt === undefined) delete process.env.HERDR_DISABLE_PROMPT;
    else process.env.HERDR_DISABLE_PROMPT = oldDisablePrompt;
    assert.equal(ping.ok, true);
    assert.equal(ping.manual, true);
    assert.equal(ping.prompted, true);
  });

  test("manual doorbell supports same-origin dashboard authorization without a token", async () => {
    const noTokenServer = startWebServer({ port: 0, amqRoot: tempRoot, jobTokenOverride: "", doorbellTokenOverride: "" });
    await new Promise((resolve) => noTokenServer.once("listening", resolve));
    const noTokenBase = `http://127.0.0.1:${noTokenServer.address().port}`;
    const oldDisablePrompt = process.env.HERDR_DISABLE_PROMPT;
    process.env.HERDR_DISABLE_PROMPT = "1";
    try {
      const settings = await fetch(`${noTokenBase}/api/coordinator-doorbell`);
      const cookie = (settings.headers.get("set-cookie") || "").split(";")[0];
      assert.equal((await fetch(`${noTokenBase}/api/coordinator-doorbell/ping`, { method: "POST" })).status, 403);
      assert.equal((await fetch(`${noTokenBase}/api/coordinator-doorbell/ping`, { method: "POST", headers: { Origin: noTokenBase, "X-AGmail-Doorbell": "1", Cookie: "agmail_doorbell_wrong=1" } })).status, 403);
      const ok = await fetch(`${noTokenBase}/api/coordinator-doorbell/ping`, { method: "POST", headers: { Origin: noTokenBase, "X-AGmail-Doorbell": "1", Cookie: cookie } });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).prompted, true);
    } finally {
      if (oldDisablePrompt === undefined) delete process.env.HERDR_DISABLE_PROMPT;
      else process.env.HERDR_DISABLE_PROMPT = oldDisablePrompt;
      noTokenServer.closeAllConnections?.();
      await new Promise((resolve) => noTokenServer.close(resolve));
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
    assert.ok(data.coordinator);
    assert.ok(data.coordinator.agents);
    assert.ok(data.coordinator.cards);
    assert.ok(data.coordinator.jobs);
    assert.equal(data.coordinator.jobs.queueDepth, 0);
    assert.ok(Array.isArray(data.coordinator.alerts));
    const history = await (await fetch(`${baseUrl}/api/coordinator/history`)).json();
    assert.ok(Array.isArray(history.samples));
    assert.ok(history.samples.length >= 1);
    assert.equal(typeof history.samples[0].agents, "object");
  });

  test("job queue API is durable, idempotent, observable, and cancellable", async () => {
    const payload = { title: "API echo", command: ["echo", "queued"], idempotencyKey: "api-echo-1" };
    const unauthorized = await fetch(`${baseUrl}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal(unauthorized.status, 403);
    const enqueue = await fetch(`${baseUrl}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", "X-AGmail-Job-Token": "test-job-token" }, body: JSON.stringify(payload) });
    assert.equal(enqueue.status, 201);
    const first = (await enqueue.json()).job;
    const duplicate = await (await fetch(`${baseUrl}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", "X-AGmail-Job-Token": "test-job-token" }, body: JSON.stringify(payload) })).json();
    assert.equal(duplicate.job.id, first.id);
    const listed = await (await fetch(`${baseUrl}/api/jobs`)).json();
    assert.equal(listed.metrics.queueDepth, 1);
    const cancelled = await (await fetch(`${baseUrl}/api/jobs/${first.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-AGmail-Job-Token": "test-job-token" }, body: JSON.stringify({ action: "cancel" }) })).json();
    assert.equal(cancelled.job.status, "cancelled");
    const runEnqueue = await (await fetch(`${baseUrl}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", "X-AGmail-Job-Token": "test-job-token" }, body: JSON.stringify({ command: [process.execPath, "-e", "process.stdout.write('ok')"], idempotencyKey: "api-run-1" }) })).json();
    const run = await (await fetch(`${baseUrl}/api/jobs/run`, { method: "POST", headers: { "Content-Type": "application/json", "X-AGmail-Job-Token": "test-job-token" }, body: JSON.stringify({ concurrency: 1 }) })).json();
    assert.equal(run.ok, true);
    assert.equal(run.results[0].status, "succeeded");
    assert.equal(run.results[0].id, runEnqueue.job.id);
    const board = await (await fetch(`${baseUrl}/api/board`)).json();
    assert.equal(board.coordinator.jobs.outcomes.cancelled, 1);
    assert.equal(board.coordinator.jobs.outcomes.succeeded, 1);
  });

  // PATCH and DELETE existed without a read, so "GET returns Not Found" was
  // indistinguishable from "this card does not exist" for a card that plainly did -
  // a caller could mutate a card it had no way to read back.
  test("GET /api/board/tasks/:id reads a card that PATCH can update", async () => {
    const postRes = await fetch(`${baseUrl}/api/board/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Readable card", owner: "worker", description: "d" }),
    });
    assert.equal(postRes.status, 200);
    const { task } = await postRes.json();
    const taskId = task.id;
    assert.ok(taskId);

    const getRes = await fetch(`${baseUrl}/api/board/tasks/${encodeURIComponent(taskId)}`);
    assert.equal(getRes.status, 200, "a card the write path accepts must be readable");
    assert.match(getRes.headers.get("content-type") || "", /application\/json/);
    const body = await getRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.task.id, taskId);
    assert.equal(body.task.title, "Readable card");
    // The stage must be reported, so a reader knows where the card lives.
    assert.ok(body.stage);

    // And a card that does not exist is a 404, distinct from the above.
    const missing = await fetch(`${baseUrl}/api/board/tasks/task_definitely_not_here`);
    assert.equal(missing.status, 404);
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


