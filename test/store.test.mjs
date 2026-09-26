import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadAgentDirectory,
  loadTransportIdentities,
  loadAllMessages,
  loadThreads,
  extractAttachments,
  resolveAttachmentPath,
  parseMessageFile,
  isPathSafe,
  registerAgent,
  getCachedMessage,
  invalidateMessageCache,
  sendAmqMessage,
} from "../src/store.mjs";
import {
  listWorktrees,
  ensureAgentWorktree,
  ensureAllWorktrees,
} from "../src/worktrees.mjs";
import { computeCanonicalThread } from "../src/protocol.mjs";

describe("store.mjs tests with mock AMQ root", () => {
  let tempRoot;

  before(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amq-store-test-"));
    const agentsDir = path.join(tempRoot, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    // Agent alpha: has unread inbox and sent messages
    const alphaDir = path.join(agentsDir, "agent-alpha");
    fs.mkdirSync(path.join(alphaDir, "inbox", "new"), { recursive: true });
    fs.mkdirSync(path.join(alphaDir, "inbox", "cur"), { recursive: true });
    fs.mkdirSync(path.join(alphaDir, "outbox", "sent"), { recursive: true });

    // Agent beta: has read inbox and sent messages
    const betaDir = path.join(agentsDir, "agent-beta");
    fs.mkdirSync(path.join(betaDir, "inbox", "cur"), { recursive: true });
    fs.mkdirSync(path.join(betaDir, "outbox", "sent"), { recursive: true });

    // Registration. These two used to be bare directories and the assertion below was that a
    // bare directory is an agent, which is the fiction this commit removes: on the live tree it
    // listed `board` (a sender identity) and `worker` (a probe mailbox) as teammates, and
    // invented a "Swarm Agent" role for each. So the fixture now registers them the way an
    // agent gets registered, and the arms further down pin what a directory alone does NOT buy.
    for (const [dir, name] of [[alphaDir, "Agent Alpha"], [betaDir, "Agent Beta"]]) {
      fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ handle: path.basename(dir), name }));
    }

    // Message 1: sent by beta to alpha (unread in alpha's new inbox)
    const msg1Content = `---json
{
  "id": "msg-001",
  "from": "agent-beta",
  "to": ["agent-alpha"],
  "subject": "Initial transmission",
  "thread": "thread-100",
  "created": "2026-09-22T10:00:00.000Z"
}
---
Hello from beta! Here is an image: ![artifact](/tmp/shooter/test.png)`;

    fs.writeFileSync(path.join(alphaDir, "inbox", "new", "msg-001.md"), msg1Content);

    // Message 2: reply sent by alpha to beta (in alpha's outbox/sent)
    const msg2Content = `---json
{
  "id": "msg-002",
  "from": "agent-alpha",
  "to": ["agent-beta"],
  "subject": "Re: Initial transmission",
  "thread": "thread-100",
  "created": "2026-09-22T10:05:00.000Z"
}
---
Acknowledged beta, processing task.`;

    fs.writeFileSync(path.join(alphaDir, "outbox", "sent", "msg-002.md"), msg2Content);

    // Message 3: independent sent message from beta (in beta's outbox/sent)
    const msg3Content = `---json
{
  "id": "msg-003",
  "from": "agent-beta",
  "to": ["agent-alpha"],
  "subject": "Status matrix",
  "thread": "thread-200",
  "created": "2026-09-22T11:00:00.000Z"
}
---
| Gate | Result |
|---|---|
| Invariants | PASS |`;

    fs.writeFileSync(path.join(betaDir, "outbox", "sent", "msg-003.md"), msg3Content);
  });

  after(() => {
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("loadAgentDirectory dynamically discovers agents and counts unread messages", () => {
    const agents = loadAgentDirectory(tempRoot);
    assert.equal(agents.length, 2);

    const alpha = agents.find((a) => a.handle === "agent-alpha");
    assert.ok(alpha);
    assert.equal(alpha.unreadCount, 1);
    assert.ok(alpha.profile.name);
    assert.ok(alpha.profile.color);
    assert.equal(alpha.profile.model, null);

    const beta = agents.find((a) => a.handle === "agent-beta");
    assert.ok(beta);
    assert.equal(beta.unreadCount, 0);
    assert.equal(beta.profile.model, null);
  });

  // ── A mailbox is not an agent ────────────────────────────────────────────────
  // The failure these pin is not "a stray directory shows up in the UI". It is that the
  // listing had to invent a role for it, because the directory carried no role at all: the
  // default was the string "Swarm Agent", so an un-registered mailbox was described as a
  // swarm agent with a name, a colour and an offline status. Absence read as a value.

  test("a bare mailbox directory is not an agent, and gets no invented profile", () => {
    const dir = path.join(tempRoot, "agents", "board");
    fs.mkdirSync(path.join(dir, "inbox", "new"), { recursive: true });
    fs.mkdirSync(path.join(dir, "outbox", "sent"), { recursive: true });
    try {
      const agents = loadAgentDirectory(tempRoot);
      assert.equal(
        agents.find((a) => a.handle === "board"),
        undefined,
        "a mailbox that was never registered must not appear in the roster"
      );
      const ids = loadTransportIdentities(tempRoot);
      const board = ids.find((t) => t.handle === "board");
      assert.ok(board, "it must still be reported as a transport identity, not silently dropped");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("presence.json is not a registration signal (the `board` falsification)", () => {
    // This arm exists because I got it wrong first. presence.json holds a handle, a status and
    // a timestamp, and "an agent that has checked in at least once" is a sentence that reads
    // as obviously true. It is false: nothing in src/ writes presence.json, and on the live
    // tree board/presence.json said {"status":"active"} written 39 ms after a notification was
    // SENT, because the external amq CLI records presence for whichever handle it acts as. A
    // signal that the act of mailing creates cannot also be evidence of registration.
    const dir = path.join(tempRoot, "agents", "board");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "presence.json"),
      JSON.stringify({ schema: 1, handle: "board", status: "active", last_seen: "2026-09-26T18:08:37.266Z" })
    );
    try {
      assert.equal(loadAgentDirectory(tempRoot).find((a) => a.handle === "board"), undefined);
      assert.ok(loadTransportIdentities(tempRoot).find((t) => t.handle === "board"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the operator account stays a member despite having no profile and no brief", () => {
    // `user` is the human. It has no profile.json and no brief, so the signal test would drop
    // it, and dropping the operator from the roster is a far worse phantom than the two
    // mailboxes this commit removes. This arm is here so that "fix the roster" cannot
    // eventually be implemented as "require a profile" without someone noticing.
    const dir = path.join(tempRoot, "agents", "user");
    fs.mkdirSync(path.join(dir, "inbox", "new"), { recursive: true });
    try {
      const user = loadAgentDirectory(tempRoot).find((a) => a.handle === "user");
      assert.ok(user, "the operator must remain in the roster");
      assert.equal(user.profile.role, "Human Operator");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parseMessageFile detects metadata, folder, and image attachments", () => {
    const filePath = path.join(tempRoot, "agents", "agent-alpha", "inbox", "new", "msg-001.md");
    const parsed = parseMessageFile(filePath, tempRoot);
    assert.ok(parsed);
    assert.equal(parsed.id, "msg-001");
    assert.equal(parsed.from, "agent-beta");
    assert.equal(parsed.isNew, true);
    assert.equal(parsed.hasImage, true);
    assert.equal(parsed.hasAttachment, true);
  });

  test("loadAllMessages with folder=sent populates from outbox/sent", () => {
    const sentAll = loadAllMessages(tempRoot, { account: "all", folder: "sent" });
    assert.equal(sentAll.length, 2);
    assert.ok(sentAll.every((m) => m.folder === "sent"));

    const sentAlpha = loadAllMessages(tempRoot, { account: "agent-alpha", folder: "sent" });
    assert.equal(sentAlpha.length, 1);
    assert.equal(sentAlpha[0].id, "msg-002");
  });

  test("loadAllMessages with folder=inbox populates inbox files", () => {
    const inboxAlpha = loadAllMessages(tempRoot, { account: "agent-alpha", folder: "inbox" });
    assert.equal(inboxAlpha.length, 1);
    assert.equal(inboxAlpha[0].id, "msg-001");
  });

  test("loadThreads groups conversation by thread and filters sent folder", () => {
    const sentThreads = loadThreads(tempRoot, { account: "agent-alpha", folder: "sent" });
    assert.equal(sentThreads.length, 1);
    assert.equal(sentThreads[0].threadId, "thread-100");

    const allSentThreads = loadThreads(tempRoot, { account: "all", folder: "sent" });
    assert.equal(allSentThreads.length, 2);
  });

  test("loadThreads with from:me query resolves to active persona", () => {
    const threadsAlphaMe = loadThreads(tempRoot, {
      account: "all",
      persona: "agent-alpha",
      query: "from:me",
    });
    assert.equal(threadsAlphaMe.length, 1);
    assert.equal(threadsAlphaMe[0].threadId, "thread-100");

    const threadsBetaMe = loadThreads(tempRoot, {
      account: "all",
      persona: "agent-beta",
      query: "from:me",
    });
    assert.equal(threadsBetaMe.length, 2);
  });

  test("extractAttachments finds markdown image artifacts", () => {
    const body = "Screenshot: ![/tmp/shooter/capture_01.png] and file `STATUS.md`";
    const atts = extractAttachments(body, [], tempRoot);
    assert.ok(atts.some((a) => a.isImage && a.name.includes("capture_01.png")));
  });

  test("resolveAttachmentPath locates existing file and returns null for non-existent path", () => {
    const repoRoot = path.resolve(path.dirname(tempRoot));
    const sampleFile = path.join(repoRoot, "sample-artifact.png");
    fs.writeFileSync(sampleFile, "PNG_MOCK");

    try {
      const resolved = resolveAttachmentPath("sample-artifact.png", tempRoot);
      assert.equal(resolved, sampleFile);

      const nonExistent = resolveAttachmentPath("/tmp/non-existent-artifact-123456.png", tempRoot);
      assert.equal(nonExistent, null);
    } finally {
      if (fs.existsSync(sampleFile)) {
        fs.unlinkSync(sampleFile);
      }
    }
  });

  test("isPathSafe blocks forbidden files and allows approved root files", () => {
    const repoRoot = path.resolve(path.dirname(tempRoot));
    assert.equal(isPathSafe("/home/cabra.lat/.ssh/config", repoRoot, tempRoot), false);
    assert.equal(isPathSafe("/home/cabra.lat/.env", repoRoot, tempRoot), false);
    assert.equal(isPathSafe("/etc/passwd", repoRoot, tempRoot), false);
    assert.equal(isPathSafe("/tmp/shooter/capture.png", repoRoot, tempRoot), true);
    assert.equal(isPathSafe(path.join(repoRoot, "src/player.gd"), repoRoot, tempRoot), true);
    assert.equal(isPathSafe(path.join(tempRoot, "agents/alpha/profile.json"), repoRoot, tempRoot), true);
  });

  test("registerAgent initializes a profile and sends one rendered welcome", () => {
    const templatesDir = path.join(tempRoot, "templates");
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(templatesDir, "welcome.md"),
      "Welcome {{ agent.name }}. Handle: {{ agent.handle }}. Role: {{ agent.role }}.\n"
    );

    const reg = registerAgent(tempRoot, {
      handle: "code-reviewer",
      name: "Code Reviewer",
      role: "Static Analysis",
      model: "claude-3-7-sonnet",
    });
    assert.equal(reg.ok, true);
    assert.equal(reg.agent.handle, "code-reviewer");
    assert.equal(reg.agent.model, "claude-3-7-sonnet");

    const agentDir = path.join(tempRoot, "agents", "code-reviewer");
    const profileFile = path.join(agentDir, "profile.json");
    const saved = JSON.parse(fs.readFileSync(profileFile, "utf8"));
    assert.equal(saved.model, "claude-3-7-sonnet");
    assert.equal(saved.role, "Static Analysis");
    assert.ok(saved.createdAt);
    assert.ok(saved.registrationId);
    assert.equal(saved.welcome.status, "sent");
    assert.equal(saved.welcome.source, "template");

    const inboxDir = path.join(agentDir, "inbox", "new");
    const welcomeFiles = fs.readdirSync(inboxDir).filter((file) => file.endsWith(".md"));
    assert.equal(welcomeFiles.length, 1);
    const welcome = parseMessageFile(path.join(inboxDir, welcomeFiles[0]), tempRoot);
    assert.equal(welcome.from, "coordinator");
    assert.match(welcome.body, /Welcome Code Reviewer/);
    assert.match(welcome.body, /Handle: code-reviewer/);
    assert.match(welcome.body, /Role: Static Analysis/);

    const sentAt = saved.welcome.sentAt;
    registerAgent(tempRoot, {
      handle: "code-reviewer",
      name: "Code Reviewer",
      role: "Static Analysis",
      model: "claude-3-7-sonnet",
    });
    const updated = JSON.parse(fs.readFileSync(profileFile, "utf8"));
    assert.equal(updated.welcome.sentAt, sentAt);
    assert.equal(fs.readdirSync(inboxDir).filter((file) => file.endsWith(".md")).length, 1);
  });

  test("does not invent or preserve a placeholder model", () => {
    const registered = registerAgent(tempRoot, {
      handle: "placeholder-free",
      name: "Placeholder Free",
      role: "No invented model",
      model: "Gemini 3.8 Flash (High)",
      syncDisk: false,
    });
    assert.equal(registered.ok, true);
    assert.equal(registered.agent.model, null);

    const legacyDir = path.join(tempRoot, "agents", "legacy-placeholder");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "profile.json"),
      JSON.stringify({ model: "Gemini 3.8 Flash (High)" }),
      "utf8",
    );
    const loaded = loadAgentDirectory(tempRoot).find((agent) => agent.handle === "legacy-placeholder");
    assert.ok(loaded);
    assert.equal(loaded.profile.model, null);
  });

  test("getCachedMessage caches parsed messages and invalidates on request", () => {
    const filePath = path.join(tempRoot, "agents", "agent-alpha", "inbox", "new", "msg-001.md");
    const m1 = getCachedMessage(filePath, tempRoot);
    const m2 = getCachedMessage(filePath, tempRoot);
    assert.equal(m1.id, "msg-001");
    assert.equal(m1, m2); // Same object reference from cache

    invalidateMessageCache();
    const m3 = getCachedMessage(filePath, tempRoot);
    assert.equal(m3.id, "msg-001");
    assert.notEqual(m1, m3); // New object parsed after cache invalidation
  });

  test("listWorktrees parses git worktrees safely", () => {
    // Calling with repo root (which is a real git repo)
    const worktrees = listWorktrees(process.cwd());
    assert.ok(Array.isArray(worktrees));
    assert.ok(worktrees.length >= 1);
    assert.ok(worktrees[0].path);
  });

  test("ensureAgentWorktree handles non-existent or existing worktrees gracefully", () => {
    // Using invalid path safely returns error object
    const bad = ensureAgentWorktree("/nonexistent/fake/repo/root", "auditor");
    assert.equal(bad.ok, false);

    // Using real git repo detects existing or sets safe parameters
    const check = ensureAgentWorktree(process.cwd(), "test-probe");
    assert.ok(check);
    assert.ok(typeof check.ok === "boolean");
  });

  test("ensureAllWorktrees processes batch array of agent handles", () => {
    const batch = ensureAllWorktrees(process.cwd(), ["probe-1", "probe-2"]);
    assert.equal(Array.isArray(batch), true);
    assert.equal(batch.length, 2);
  });

  test("sendAmqMessage computes a canonical thread before delivery", () => {
    const result = sendAmqMessage(tempRoot, {
      from: "coordinator",
      to: "agent-alpha",
      subject: "Canonical thread regression",
      body: "The dashboard must not crash while sending this message.",
    });
    assert.equal(result.ok, true, result.error || "sendAmqMessage failed");
    const delivered = loadAllMessages(tempRoot, { account: "agent-alpha", folder: "inbox" })
      .find((message) => message.subject === "Canonical thread regression");
    assert.ok(delivered, "canonical-thread regression message was not delivered");
    assert.equal(delivered.thread, computeCanonicalThread("coordinator", ["agent-alpha"]));
  });
});
