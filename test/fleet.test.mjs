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
  });

  await t.test("buildFleetEnvPath includes ~/.local/bin and system paths", () => {
    const p = buildFleetEnvPath();
    assert.ok(p.includes(".local/bin"));
    assert.ok(p.includes("/bin"));
  });
});
