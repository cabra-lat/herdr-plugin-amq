import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanAgentBriefs, getAgentBrief, saveAgentBrief, parseAgentBriefFile } from "../src/briefs.mjs";
import { loadAgentDirectory, registerAgent } from "../src/store.mjs";

test("parseAgentBriefFile extracts frontmatter and prompt body", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-test-"));
  try {
    const filePath = path.join(tempDir, "spotter.md");
    fs.writeFileSync(
      filePath,
      `---
description: Verification runner: headless checks and GPU captures
mode: subagent
model: claude-3-7-sonnet
---

You prove things work.
Run tools/verify-all.sh --quick and report results.`
    );

    const parsed = parseAgentBriefFile(filePath, tempDir);
    assert.ok(parsed);
    assert.equal(parsed.handle, "spotter");
    assert.equal(parsed.description, "Verification runner: headless checks and GPU captures");
    assert.equal(parsed.model, "claude-3-7-sonnet");
    assert.ok(parsed.prompt.includes("You prove things work."));
    assert.equal(parsed.source, "spotter.md");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("scanAgentBriefs discovers agents from .opencode/agents and .agents", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-test-"));
  try {
    const opencodeDir = path.join(repoRoot, ".opencode", "agents");
    fs.mkdirSync(opencodeDir, { recursive: true });

    fs.writeFileSync(
      path.join(opencodeDir, "ballistics.md"),
      `---
description: Gunplay math and penetration models
---

You own the shooter math core.`
    );

    const agentsDir = path.join(repoRoot, ".agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    fs.writeFileSync(
      path.join(agentsDir, "security-scanner.md"),
      `---
description: Security vulnerability auditor
model: deepseek-r1
---

Inspect dependencies and AST.`
    );

    const briefs = scanAgentBriefs(repoRoot);
    assert.equal(briefs.has("ballistics"), true);
    assert.equal(briefs.has("security-scanner"), true);

    const ballistics = briefs.get("ballistics");
    assert.equal(ballistics.description, "Gunplay math and penetration models");

    const sec = briefs.get("security-scanner");
    assert.equal(sec.model, "deepseek-r1");
    assert.ok(sec.prompt.includes("Inspect dependencies"));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("loadAgentDirectory enriches agents with discovered briefs", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-repo-"));
  try {
    const amqRoot = path.join(repoRoot, ".agent-mail");
    fs.mkdirSync(path.join(amqRoot, "agents", "spotter", "inbox", "new"), { recursive: true });

    const opencodeDir = path.join(repoRoot, ".opencode", "agents");
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(opencodeDir, "spotter.md"),
      `---
description: Verification runner and evidence capturer
model: gemini-2.5-flash
---

Prove all features before merge.`
    );

    const directory = loadAgentDirectory(amqRoot);
    const spotter = directory.find((a) => a.handle === "spotter");
    assert.ok(spotter);
    assert.equal(spotter.profile.role, "Verification runner and evidence capturer");
    assert.equal(spotter.profile.model, "gemini-2.5-flash");
    assert.ok(spotter.profile.prompt.includes("Prove all features"));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("saveAgentBrief writes updated prompt and frontmatter back to disk", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "save-repo-"));
  try {
    const result = saveAgentBrief(repoRoot, "qa-tester", {
      description: "Automated regression testing",
      prompt: "Execute test suite and report flaky specs.",
      model: "claude-3-5-sonnet",
      role: "QA Lead",
    });

    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(result.path));

    const content = fs.readFileSync(result.path, "utf8");
    assert.ok(content.includes("description: Automated regression testing"));
    assert.ok(content.includes("model: claude-3-5-sonnet"));
    assert.ok(content.includes("Execute test suite"));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
