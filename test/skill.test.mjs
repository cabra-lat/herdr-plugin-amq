import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { handleSkillCommand } from "../src/actions.mjs";

test("skill command prints SKILL.md with valid YAML frontmatter", () => {
  let output = "";
  const origWrite = process.stdout.write;
  try {
    process.stdout.write = (chunk) => {
      output += chunk;
      return true;
    };
    handleSkillCommand([]);
  } finally {
    process.stdout.write = origWrite;
  }

  assert.ok(output.includes("name: herdr-amq"), "Should include skill name");
  assert.ok(output.includes("metadata:"), "Should include metadata");
  assert.ok(output.includes("Herdr AMQ Autonomous Coordination"), "Should include title");
  assert.ok(output.includes("herdr-amq mail drain"), "Should include drain instructions");
});

test("skill command with --install copies SKILL.md to destination directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-test-"));
  try {
    const installedPath = handleSkillCommand(["--install", tmpDir]);
    assert.strictEqual(installedPath, path.join(tmpDir, "SKILL.md"));
    assert.ok(fs.existsSync(installedPath), "Target SKILL.md should exist");

    const content = fs.readFileSync(installedPath, "utf-8");
    assert.ok(content.startsWith("---\nname: herdr-amq"), "Installed file must have frontmatter");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CLI bin/herdr-amq.mjs --skill runs successfully via child_process", () => {
  const binPath = path.resolve("bin/herdr-amq.mjs");
  const stdout = execFileSync("node", [binPath, "--skill"], { encoding: "utf-8" });

  assert.ok(stdout.includes("name: herdr-amq"));
  assert.ok(stdout.includes("herdr-amq task claim"));
});
