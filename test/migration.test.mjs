import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { migrateMessageAttachments } from "../src/migration.mjs";
import { parseMessageFile } from "../src/store.mjs";

test("AMQ Attachment Migration Suite", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amq-mig-test-"));
  const repoDir = path.join(tmpDir, "repo");
  const amqRoot = path.join(repoDir, ".agent-mail");

  // Setup git repo
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "agent@test.internal"], { cwd: repoDir, stdio: "ignore" });

  // Commit 1: add test-asset.png
  const assetRel = "assets/models/test_asset.png";
  const assetFull = path.join(repoDir, assetRel);
  fs.mkdirSync(path.dirname(assetFull), { recursive: true });
  fs.writeFileSync(assetFull, "PNG-MOCK-DATA-CONTENT-XYZ");
  execFileSync("git", ["add", assetRel], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add test asset"], { cwd: repoDir, stdio: "ignore" });
  const commit1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

  // Wait 1 sec and Commit 2: delete test-asset.png
  fs.rmSync(assetFull);
  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "delete test asset"], { cwd: repoDir, stdio: "ignore" });
  const commit2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

  // Create ephemeral file in os.tmpdir
  const ephemFile = path.join(tmpDir, "ephem_render.png");
  fs.writeFileSync(ephemFile, "EPHEMERAL-IMAGE-BUFFER-123");

  // Create agent maildir
  const curDir = path.join(amqRoot, "agents", "worker", "inbox", "cur");
  fs.mkdirSync(curDir, { recursive: true });

  // Legacy message 1: references historical deleted asset
  const msg1Path = path.join(curDir, "2026-09-20T10-00-00.000Z_pid100_aaa.md");
  fs.writeFileSync(
    msg1Path,
    `---json
{
  "schema": 1,
  "id": "2026-09-20T10-00-00.000Z_pid100_aaa",
  "from": "coordinator",
  "to": ["worker"],
  "subject": "Deleted asset check",
  "created": "2026-09-20T10:00:00.000Z"
}
---
Worker, please verify assets/models/test_asset.png from commit ${commit1}.
`
  );

  // Legacy message 2: references ephemeral /tmp file
  const msg2Path = path.join(curDir, "2026-09-20T11-00-00.000Z_pid100_bbb.md");
  fs.writeFileSync(
    msg2Path,
    `---json
{
  "schema": 1,
  "id": "2026-09-20T11-00-00.000Z_pid100_bbb",
  "from": "worker",
  "to": ["coordinator"],
  "subject": "Ephemeral render",
  "created": "2026-09-20T11:00:00.000Z"
}
---
Here is the frame: ${ephemFile}
`
  );

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test("migrateMessageAttachments updates legacy frontmatters", () => {
    const stats = migrateMessageAttachments(amqRoot, { dryRun: false });
    assert.equal(stats.totalScanned, 2);
    assert.equal(stats.migrated, 2);
    assert.equal(stats.gitPinned, 1);
    assert.equal(stats.blobsStored, 1);

    // Verify msg1 was rewritten with git pinned attachment
    const parsed1 = parseMessageFile(msg1Path, amqRoot);
    assert.ok(parsed1.attachments.length >= 1);
    const gitAtt = parsed1.attachments.find((a) => a.name === "test_asset.png");
    assert.ok(gitAtt, "Expected test_asset.png to be in attachments");
    assert.equal(gitAtt.type, "git");
    assert.equal(gitAtt.commit, commit1);
    assert.equal(gitAtt.exists, true);
    assert.ok(gitAtt.url.includes("/api/git-file"));

    // Verify msg2 was rewritten with CAS blob attachment
    const parsed2 = parseMessageFile(msg2Path, amqRoot);
    assert.ok(parsed2.attachments.length >= 1);
    const blobAtt = parsed2.attachments.find((a) => a.type === "blob");
    assert.ok(blobAtt, "Expected blob attachment");
    assert.equal(blobAtt.exists, true);
    assert.ok(blobAtt.url.includes("/api/blob/"));
  });

  await t.test("migrateMessageAttachments is idempotent on re-run", () => {
    const stats2 = migrateMessageAttachments(amqRoot, { dryRun: false });
    assert.equal(stats2.totalScanned, 2);
    assert.equal(stats2.alreadyMigrated, 2);
    assert.equal(stats2.migrated, 0);
  });
});
