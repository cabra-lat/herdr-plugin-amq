import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseAgentsMdHandles,
  discoverFleetPersonas,
  prepopulateFleet,
  buildFleetEnvPath,
  defaultLaunchArgs,
  readOpencodeModel,
  createOpencodeLauncher,
  launchFleet,
  stopFleet,
} from "../src/fleet.mjs";

test("Fleet & Bootstrap Management Suite", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amq-fleet-test-"));
  const repoDir = path.join(tmpDir, "repo");
  const amqRoot = path.join(repoDir, ".agent-mail");

  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(amqRoot, { recursive: true });

  // 1. Create mock AGENTS.md
  fs.writeFileSync(
    path.join(repoDir, "AGENTS.md"),
    `# AGENTS.md
Queue root is .agent-mail/. Handles: \`coordinator\`, \`spotter\`, \`qa\`.
Conventions: never commit.
`
  );

  // 2. Create mock brief in .opencode/agents/ballistics.md
  const briefDir = path.join(repoDir, ".opencode", "agents");
  fs.mkdirSync(briefDir, { recursive: true });
  fs.writeFileSync(
    path.join(briefDir, "ballistics.md"),
    `---
description: Gunplay math specialist
mode: subagent
---
You own ballistics.
`
  );

  // 3. Create mock worktree directory
  const wtDir = path.join(repoDir, ".worktrees", "verifier");
  fs.mkdirSync(wtDir, { recursive: true });

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test("parseAgentsMdHandles extracts handles from AGENTS.md", () => {
    const handles = parseAgentsMdHandles(repoDir);
    assert.ok(handles.includes("coordinator"));
    assert.ok(handles.includes("spotter"));
    assert.ok(handles.includes("qa"));
  });

  await t.test("discoverFleetPersonas unions briefs, rules, and worktrees", () => {
    const personas = discoverFleetPersonas(repoDir);
    assert.ok(personas.has("ballistics"), "Should discover ballistics from brief");
    assert.ok(personas.has("coordinator"), "Should discover coordinator from AGENTS.md");
    assert.ok(personas.has("verifier"), "Should discover verifier from .worktrees");

    const ballistics = personas.get("ballistics");
    assert.equal(ballistics.sourceType, "brief");
    assert.equal(ballistics.description, "Gunplay math specialist");

    const coord = personas.get("coordinator");
    assert.equal(coord.sourceType, "rule");

    const verif = personas.get("verifier");
    assert.equal(verif.sourceType, "worktree");
  });

  await t.test("prepopulateFleet initializes maildirs for all discovered personas", () => {
    const results = prepopulateFleet(amqRoot, repoDir);
    assert.ok(results.length >= 4);

    for (const r of results) {
      assert.ok(r.maildirOk, `Maildir creation failed for ${r.handle}`);
      const agentMaildir = path.join(amqRoot, "agents", r.handle, "inbox", "new");
      assert.ok(fs.existsSync(agentMaildir), `Expected ${agentMaildir} to exist`);
    }

    const coordinatorProfile = JSON.parse(fs.readFileSync(path.join(amqRoot, "agents", "coordinator", "profile.json"), "utf8"));
    assert.equal(coordinatorProfile.model, null);
  });

  await t.test("buildFleetEnvPath includes ~/.local/bin and system paths", () => {
    const p = buildFleetEnvPath();
    assert.ok(p.includes(".local/bin"));
    assert.ok(p.includes("/bin"));
  });

  await t.test("OpenCode launch defaults select the named persona", () => {
    assert.deepEqual(defaultLaunchArgs("agy", "spotter"), ["--dangerously-skip-permissions"]);
    assert.deepEqual(defaultLaunchArgs("opencode", "spotter"), ["--agent", "spotter", "--auto"]);
  });

  await t.test("OpenCode model and temporary launcher preserve persona mode", () => {
    fs.writeFileSync(
      path.join(repoDir, "opencode.json"),
      JSON.stringify({ model: "opencode/muse-spark-1.3-contributor-free" }),
    );
    const model = readOpencodeModel(repoDir);
    assert.equal(model, "opencode/muse-spark-1.3-contributor-free");
    const launcher = createOpencodeLauncher("spotter", model, "/bin/sh");
    try {
      const config = JSON.parse(launcher.config);
      assert.deepEqual(config.agent.spotter, { mode: "all", model });
      assert.ok(fs.readFileSync(launcher.launcher, "utf8").includes("OPENCODE_CONFIG_CONTENT"));
      assert.ok((fs.statSync(launcher.launcher).mode & 0o111) !== 0);
    } finally {
      fs.rmSync(launcher.root, { recursive: true, force: true });
    }
  });

  await t.test("fleet up replaces a mismatched kind and launches the named OpenCode persona", async () => {
    const worktree = path.join(repoDir, ".worktrees", "coordinator");
    fs.mkdirSync(worktree, { recursive: true });
    const calls = [];
    const result = await launchFleet(amqRoot, repoDir, {
      kind: "opencode",
      agents: "coordinator",
      timeout: 1,
      prepopulate: () => [{ handle: "coordinator", worktree }],
      getLiveAgents: async () => [{
        name: "coordinator",
        agent: "agy",
        agent_status: "idle",
        pane_id: "w:old",
        cwd: worktree,
      }],
      execHerdr: (args) => {
        calls.push(args);
        if (args[0] === "workspace") {
          return JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "repo" }] } });
        }
        if (args[0] === "tab") {
          return JSON.stringify({ result: { root_pane: { pane_id: "w:new" } } });
        }
        return "{}";
      },
      sleep: async () => {},
      envPath: "/usr/bin",
      opencodeExecutable: "/bin/sh",
      createOpencodeLauncher: () => ({
        root: path.join(tmpDir, "launcher"),
        binDir: path.join(tmpDir, "launcher", "coordinator"),
      }),
    });

    assert.deepEqual(result.replaced.map((entry) => entry.handle), ["coordinator"]);
    assert.deepEqual(result.launched.map((entry) => entry.handle), ["coordinator"]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(calls.find((args) => args[0] === "pane"), ["pane", "close", "w:old"]);
    const startCall = calls.find((args) => args[0] === "agent");
    assert.deepEqual(startCall.slice(startCall.indexOf("--")), ["--", "--agent", "coordinator", "--auto"]);
    const tabCall = calls.find((args) => args[0] === "tab");
    assert.equal(
      tabCall[tabCall.indexOf("--env") + 1],
      `PATH=${path.join(tmpDir, "launcher", "coordinator")}${path.delimiter}/usr/bin`,
    );
    assert.equal(tabCall[tabCall.indexOf("HERDR_AGENT_HANDLE=coordinator") - 1], "--env");
    assert.equal(tabCall[tabCall.indexOf("AMQ_AGENT_HANDLE=coordinator") - 1], "--env");
  });

  await t.test("fleet up keeps matching agents exactly once", async () => {
    const worktree = path.join(repoDir, ".worktrees", "coordinator");
    let execCount = 0;
    const result = await launchFleet(amqRoot, repoDir, {
      kind: "opencode",
      agents: "coordinator",
      prepopulate: () => [{ handle: "coordinator", worktree }],
      getLiveAgents: async () => [{
        name: "coordinator",
        agent: "opencode",
        agent_status: "idle",
        pane_id: "w:opencode",
        cwd: worktree,
      }],
      execHerdr: () => {
        execCount += 1;
        return "{}";
      },
    });

    assert.deepEqual(result.alreadyRunning, ["coordinator"]);
    assert.deepEqual(result.launched, []);
    assert.deepEqual(result.failed, []);
    assert.equal(execCount, 0);
  });

  await t.test("fleet down closes only matching kind and preserves worktrees", async () => {
    const coordinatorWorktree = path.join(repoDir, ".worktrees", "coordinator");
    const spotterWorktree = path.join(repoDir, ".worktrees", "spotter");
    fs.mkdirSync(spotterWorktree, { recursive: true });
    const calls = [];
    const result = await stopFleet(amqRoot, repoDir, {
      kind: "agy",
      agents: "coordinator,spotter",
      getLiveAgents: async () => [
        { name: "coordinator", agent: "agy", pane_id: "w:agy", cwd: coordinatorWorktree },
        { name: "spotter", agent: "opencode", pane_id: "w:opencode", cwd: spotterWorktree },
      ],
      execHerdr: (args) => calls.push(args),
    });

    assert.deepEqual(result.stopped, [{ handle: "coordinator", paneId: "w:agy", kind: "agy" }]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].handle, "spotter");
    assert.deepEqual(calls, [["pane", "close", "w:agy"]]);
    assert.ok(fs.existsSync(coordinatorWorktree));
    assert.ok(fs.existsSync(spotterWorktree));
  });
});
