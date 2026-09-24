import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  handleStatus,
  handleTaskCommand,
  handleMailCommand,
  handleStartup,
  handleDoorbell,
  handleAgentStatusChanged,
} from "../src/actions.mjs";

describe("actions.mjs CLI integration", () => {
  let tempRoot;
  let oldAmRoot;
  let oldStateDir;
  let oldDisablePrompt;
  let oldEventJson;
  let oldCwd;

  before(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "actions-test-"));
    const amqRoot = path.join(tempRoot, ".agent-mail");
    oldAmRoot = process.env.AM_ROOT;
    process.env.AM_ROOT = amqRoot;
    oldStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(tempRoot, "state");
    oldDisablePrompt = process.env.HERDR_DISABLE_PROMPT;
    process.env.HERDR_DISABLE_PROMPT = "1";
    oldEventJson = process.env.HERDR_PLUGIN_EVENT_JSON;

    // Set up agent directory inside amqRoot
    const agentsDir = path.join(amqRoot, "agents");
    fs.mkdirSync(path.join(agentsDir, "alice", "inbox", "new"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "alice", "outbox", "sent"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "bob", "inbox", "new"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "bob", "outbox", "sent"), { recursive: true });

    // Set up bus directory structure for task commands
    const busBacklog = path.join(tempRoot, ".opencode", "bus", "backlog");
    fs.mkdirSync(busBacklog, { recursive: true });
    fs.writeFileSync(
      path.join(busBacklog, "test-card-1.md"),
      `---\nid: test-card-1\ntitle: Implement feature X\nassignee: unassigned\nstatus: backlog\n---\nTask description here`
    );

    oldCwd = process.cwd();
    process.chdir(tempRoot);
  });

  after(() => {
    process.chdir(oldCwd);
    if (oldAmRoot !== undefined) {
      process.env.AM_ROOT = oldAmRoot;
    } else {
      delete process.env.AM_ROOT;
    }
    if (oldStateDir !== undefined) {
      process.env.HERDR_PLUGIN_STATE_DIR = oldStateDir;
    } else {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    }
    if (oldDisablePrompt !== undefined) {
      process.env.HERDR_DISABLE_PROMPT = oldDisablePrompt;
    } else {
      delete process.env.HERDR_DISABLE_PROMPT;
    }
    if (oldEventJson !== undefined) {
      process.env.HERDR_PLUGIN_EVENT_JSON = oldEventJson;
    } else {
      delete process.env.HERDR_PLUGIN_EVENT_JSON;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("handleStatus prints status output without throwing", () => {
    let output = "";
    const origLog = console.log;
    try {
      console.log = (msg = "") => {
        output += msg + "\n";
      };
      handleStatus();
    } finally {
      console.log = origLog;
    }

    assert.ok(output.includes("Herdr AMQ Bridge Status"));
    assert.ok(output.includes("Version:"));
    assert.ok(output.includes("Registered Agents"));
  });

  test("handleTaskCommand list displays cards", () => {
    let output = "";
    const origLog = console.log;
    try {
      console.log = (msg = "") => {
        output += msg + "\n";
      };
      handleTaskCommand("list", []);
    } finally {
      console.log = origLog;
    }

    assert.ok(output.includes("test-card-1"));
    assert.ok(output.includes("Implement feature X"));
  });

  test("handleTaskCommand claim, block, and done transition card cleanly", () => {
    let output = "";
    const origLog = console.log;
    try {
      console.log = (msg = "") => {
        output += msg + "\n";
      };
      // Claim
      handleTaskCommand("claim", ["test-card-1", "--me", "alice"]);
      assert.ok(fs.existsSync(path.join(tempRoot, ".opencode", "bus", "doing", "test-card-1.md")));

      // Block
      handleTaskCommand("block", ["test-card-1", "--reason", "Waiting on review"]);
      assert.ok(fs.existsSync(path.join(tempRoot, ".opencode", "bus", "blocked", "test-card-1.md")));

      // Done
      handleTaskCommand("done", ["test-card-1", "--proof", "All tests passed"]);
      assert.ok(fs.existsSync(path.join(tempRoot, ".opencode", "bus", "done", "test-card-1.md")));
    } finally {
      console.log = origLog;
    }
  });

  test("handleTaskCommand drain and next commands drain assigned cards", () => {
    // Write a new card assigned to alice in backlog
    const busBacklog = path.join(tempRoot, ".opencode", "bus", "backlog");
    fs.writeFileSync(
      path.join(busBacklog, "alice-task.md"),
      `---\nid: alice-task\ntitle: Alice unit test\nowner: alice\nstatus: backlog\n---\nDetailed test description`
    );

    let output = "";
    const origLog = console.log;
    try {
      console.log = (msg = "") => {
        output += msg + "\n";
      };

      // Drain without claim
      handleTaskCommand("drain", ["--me", "alice"]);
      assert.ok(output.includes("Task Drain for alice"));
      assert.ok(output.includes("Alice unit test"));
      assert.ok(output.includes("alice-task"));

      // Auto-claim via next
      handleTaskCommand("next", ["--me", "alice"]);
      assert.ok(output.includes("Auto-claimed task alice-task"));
      assert.ok(fs.existsSync(path.join(tempRoot, ".opencode", "bus", "doing", "alice-task.md")));
    } finally {
      console.log = origLog;
    }
  });

  test("handleMailCommand send, drain, and reply workflow", () => {
    let output = "";
    const origLog = console.log;
    try {
      console.log = (msg = "") => {
        output += msg + "\n";
      };

      // Alice sends message to Bob
      handleMailCommand("send", [
        "--from", "alice",
        "--to", "bob",
        "--subject", "Hello Bob",
        "--body", "Testing mail commands",
      ]);

      // Bob drains
      output = "";
      handleMailCommand("drain", ["--me", "bob", "--include-body"]);
      assert.ok(output.includes("Hello Bob"));
      assert.ok(output.includes("Testing mail commands"));

      // Extract msg id
      const match = output.match(/ID:\s*([^\s]+)/);
      assert.ok(match, "Message ID should be present");
      const msgId = match[1];

      // Bob replies to Alice
      handleMailCommand("reply", [
        "--from", "bob",
        "--id", msgId,
        "--body", "Got your message, Alice!",
      ]);

      // Alice drains
      output = "";
      handleMailCommand("drain", ["--me", "alice", "--include-body"]);
      assert.ok(output.includes("Got your message, Alice!"));
    } finally {
      console.log = origLog;
    }
  });

  test("handleStartup executes cleanly", () => {
    let output = "";
    const origLog = console.log;
    try {
      console.log = (msg = "") => {
        output += msg + "\n";
      };
      handleStartup();
      assert.ok(output.includes("Startup hook executed"));
    } finally {
      console.log = origLog;
    }
  });

  test("handleDoorbell runs doorbell pass on registered agents", () => {
    let output = "";
    const origLog = console.log;
    try {
      console.log = (msg = "") => {
        output += msg + "\n";
      };
      handleDoorbell();
      assert.ok(output.includes("Checking AMQ inboxes"));
    } finally {
      console.log = origLog;
    }
  });

  test("handleAgentStatusChanged processes event payload", () => {
    process.env.HERDR_PLUGIN_EVENT_JSON = JSON.stringify({
      event: "agent_status_changed",
      data: { agent_name: "alice", agent_status: "idle" },
    });
    try {
      handleAgentStatusChanged();
    } finally {
      delete process.env.HERDR_PLUGIN_EVENT_JSON;
    }
  });
});
