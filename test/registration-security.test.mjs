import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { registerAgent } from "../src/store.mjs";
import { runDoorbellPass } from "../src/bridge.mjs";
import { ensureAgentMailbox, readMaildirMessageFile, sendMaildirMessage } from "../src/protocol.mjs";

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePendingProfile(root, handle, registrationId, messageId) {
  const agentDir = ensureAgentMailbox(root, handle);
  fs.writeFileSync(
    path.join(agentDir, "profile.json"),
    JSON.stringify({
      handle,
      name: handle,
      role: "Test",
      model: "test/model",
      createdAt: new Date().toISOString(),
      registrationId,
      welcome: { status: "pending", messageId },
    }),
  );
}

function runRegistrationChild(root) {
  const moduleUrl = pathToFileURL(path.resolve("src/store.mjs")).href;
  const source = `import { registerAgent } from ${JSON.stringify(moduleUrl)}; const result = registerAgent(process.argv[1], { handle: "parallel", name: "Parallel", role: "Test", model: "test/model" }); process.exit(result.ok ? 0 : 1);`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, root], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

describe("welcome registration security", () => {
  test("rejects symlinked agent directories", () => {
    const root = makeTempRoot("welcome-symlink-");
    const outside = makeTempRoot("welcome-outside-");
    try {
      fs.mkdirSync(path.join(root, "agents"), { recursive: true });
      fs.symlinkSync(outside, path.join(root, "agents", "worker"));
      const result = registerAgent(root, { handle: "worker" });
      assert.equal(result.ok, false);
      assert.equal(fs.existsSync(path.join(outside, "profile.json")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("replaces symlinked profile files without reading outside the mailbox", () => {
    const root = makeTempRoot("welcome-profile-link-");
    const outside = makeTempRoot("welcome-profile-outside-");
    try {
      const outsideProfile = path.join(outside, "profile.json");
      fs.writeFileSync(outsideProfile, JSON.stringify({ handle: "worker", secret: "outside" }));
      const agentDir = ensureAgentMailbox(root, "worker");
      fs.symlinkSync(outsideProfile, path.join(agentDir, "profile.json"));
      const result = registerAgent(root, { handle: "worker" });
      assert.equal(result.ok, true);
      assert.equal(fs.lstatSync(path.join(agentDir, "profile.json")).isSymbolicLink(), false);
      assert.equal(JSON.parse(fs.readFileSync(outsideProfile, "utf8")).secret, "outside");
      assert.equal(result.agent.secret, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects symlinked mailbox subdirectories", () => {
    const root = makeTempRoot("welcome-mailbox-symlink-");
    const outside = makeTempRoot("welcome-mailbox-outside-");
    try {
      const agentDir = path.join(root, "agents", "worker");
      fs.mkdirSync(path.join(agentDir, "inbox"), { recursive: true });
      fs.symlinkSync(outside, path.join(agentDir, "inbox", "new"));
      const result = registerAgent(root, { handle: "worker" });
      assert.equal(result.ok, false);
      assert.equal(fs.readdirSync(outside).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("does not follow message-file symlinks during delivery or proof", () => {
    const root = makeTempRoot("welcome-file-symlink-");
    const outside = makeTempRoot("welcome-file-outside-");
    try {
      const outsideFile = path.join(outside, "target.md");
      fs.writeFileSync(outsideFile, "outside");
      const agentDir = ensureAgentMailbox(root, "worker");
      fs.symlinkSync(outsideFile, path.join(agentDir, "inbox", "tmp", "welcome-registration-file.md"));
      fs.symlinkSync(outsideFile, path.join(agentDir, "inbox", "new", "welcome-registration-file.md"));
      writePendingProfile(root, "worker", "registration-file", "welcome-registration-file");

      const result = registerAgent(root, { handle: "worker" });
      assert.equal(result.welcome.ok, true);
      const deliveredPath = path.join(agentDir, "inbox", "new", "welcome-registration-file.md");
      assert.equal(fs.lstatSync(deliveredPath).isSymbolicLink(), false);
      assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("replaces unsafe persisted welcome ids without writing outside the queue", () => {
    const root = makeTempRoot("welcome-id-");
    try {
      assert.throws(() => sendMaildirMessage(root, {
        id: "../../escape",
        from: "coordinator",
        to: ["worker"],
        subject: "escape",
        body: "escape",
      }), /Invalid message id/);
      writePendingProfile(root, "worker", "registration-1", "../../escape");
      const result = registerAgent(root, { handle: "worker" });
      assert.equal(result.ok, true);
      assert.equal(result.welcome.ok, true);
      assert.match(result.welcome.id, /^welcome-registration-1$/);
      assert.equal(fs.existsSync(path.resolve(root, "../../escape.md")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not accept an outbox-only copy as welcome delivery", () => {
    const root = makeTempRoot("welcome-outbox-");
    try {
      writePendingProfile(root, "worker", "registration-2", "welcome-registration-2");
      sendMaildirMessage(root, {
        id: "welcome-registration-2",
        from: "coordinator",
        to: ["worker"],
        subject: "Welcome",
        body: "old copy",
      });
      fs.unlinkSync(path.join(root, "agents", "worker", "inbox", "new", "welcome-registration-2.md"));

      const result = registerAgent(root, { handle: "worker" });
      assert.equal(result.welcome.ok, true);
      assert.equal(fs.existsSync(path.join(root, "agents", "worker", "inbox", "new", "welcome-registration-2.md")), true);
      const profile = JSON.parse(fs.readFileSync(path.join(root, "agents", "worker", "profile.json"), "utf8"));
      assert.equal(profile.welcome.status, "sent");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent registrations into one welcome", async () => {
    const root = makeTempRoot("welcome-concurrent-");
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => runRegistrationChild(root)));
      assert.deepEqual(results.map((result) => result.code), [0, 0, 0, 0, 0, 0]);
      const inbox = path.join(root, "agents", "parallel", "inbox", "new");
      assert.equal(fs.readdirSync(inbox).filter((file) => file.endsWith(".md")).length, 1);
      const profile = JSON.parse(fs.readFileSync(path.join(root, "agents", "parallel", "profile.json"), "utf8"));
      assert.equal(profile.welcome.status, "sent");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves omitted fields on legacy profile updates", () => {
    const root = makeTempRoot("welcome-legacy-");
    try {
      const agentDir = ensureAgentMailbox(root, "legacy");
      fs.writeFileSync(path.join(agentDir, "profile.json"), JSON.stringify({
        handle: "legacy",
        name: "Legacy Name",
        role: "Legacy Role",
        model: "provider/model",
        worktree: "/tmp/legacy",
        prompt: "Legacy prompt",
        secret: "must not persist",
      }));
      const result = registerAgent(root, { handle: "legacy" });
      assert.equal(result.ok, true);
      assert.equal(result.agent.name, "Legacy Name");
      assert.equal(result.agent.role, "Legacy Role");
      assert.equal(result.agent.model, "provider/model");
      assert.equal(result.agent.worktree, "/tmp/legacy");
      assert.equal(result.agent.prompt, "Legacy prompt");
      assert.equal(result.welcome.skipped, true);
      assert.equal(result.agent.secret, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects oversized messages and skips FIFO inbox entries without blocking", () => {
    const root = makeTempRoot("welcome-special-files-");
    try {
      ensureAgentMailbox(root, "worker");
      assert.throws(() => sendMaildirMessage(root, {
        from: "coordinator",
        to: ["worker"],
        subject: "oversized",
        body: "x".repeat(8 * 1024 * 1024 + 1),
      }), /Maildir size limit/);

      const fifo = path.join(root, "agents", "worker", "inbox", "new", "blocked.fifo");
      const mkfifo = spawnSync("mkfifo", [fifo]);
      assert.equal(mkfifo.status, 0);
      assert.equal(readMaildirMessageFile(fifo), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("atomically replaces symlinked bridge state without overwriting outside state", () => {
    const root = makeTempRoot("bridge-state-link-");
    const outside = makeTempRoot("bridge-state-outside-");
    const oldStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
    try {
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir);
      const outsideState = path.join(outside, "state.json");
      fs.writeFileSync(outsideState, "outside-state");
      fs.symlinkSync(outsideState, path.join(stateDir, "bridge-state.json"));
      process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

      ensureAgentMailbox(root, "coordinator");
      sendMaildirMessage(root, {
        from: "alice",
        to: ["coordinator"],
        subject: "state test",
        body: "state test",
      });
      const result = runDoorbellPass({
        amqRoot: root,
        allowPrompt: true,
        persistState: true,
        getStatus: () => "idle",
        healName: () => false,
        prompt: () => true,
      });
      assert.equal(result.doorbelled, 1);
      const statePath = path.join(stateDir, "bridge-state.json");
      assert.equal(fs.lstatSync(statePath).isSymbolicLink(), false);
      assert.equal(fs.readFileSync(outsideState, "utf8"), "outside-state");
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(statePath, "utf8")).delivered).length, 1);
    } finally {
      if (oldStateDir !== undefined) process.env.HERDR_PLUGIN_STATE_DIR = oldStateDir;
      else delete process.env.HERDR_PLUGIN_STATE_DIR;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("caps oversized registration values and fallback output", () => {
    const root = makeTempRoot("welcome-bounds-");
    try {
      const result = registerAgent(root, { handle: "large", name: "x".repeat(1024 * 1024) });
      assert.equal(result.ok, true);
      assert.equal(result.agent.name.length, 120);
      const inbox = path.join(root, "agents", "large", "inbox", "new");
      const message = fs.readFileSync(path.join(inbox, fs.readdirSync(inbox)[0]), "utf8");
      assert.ok(Buffer.byteLength(message) < 4096);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
