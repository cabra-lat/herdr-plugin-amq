import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  computeSha256,
  storeBlob,
  getBlob,
  pinGitRef,
  readGitRef,
  ingestAttachment,
  getCommitAtTimestamp,
  extractMentionedCommits,
  getMimeType,
} from "../src/blobs.mjs";

test("MIME type detection", () => {
  assert.equal(getMimeType(".png"), "image/png");
  assert.equal(getMimeType(".log"), "text/plain; charset=utf-8");
  assert.equal(getMimeType(".gd"), "text/plain; charset=utf-8");
  assert.equal(getMimeType(".unknown"), "application/octet-stream");
});

test("Option A: CAS Blobstore storing and retrieving", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amq-blob-test-"));
  try {
    const content = "Hello world from AMQ autonomous blob attachment!\n";
    const expectedHash = computeSha256(Buffer.from(content, "utf8"));

    // Store from string buffer
    const blob1 = storeBlob(content, tmpDir, "sample.log");
    assert.equal(blob1.type, "blob");
    assert.equal(blob1.sha256, expectedHash);
    assert.equal(blob1.name, "sample.log");
    assert.equal(blob1.ext, ".log");
    assert.equal(blob1.isLog, true);
    assert.match(blob1.url, new RegExp(`^/api/blob/${expectedHash}`));

    // Retrieve blob
    const retrieved = getBlob(expectedHash, tmpDir);
    assert.ok(retrieved);
    assert.equal(retrieved.sha256, expectedHash);
    assert.equal(retrieved.sizeBytes, content.length);
    assert.equal(fs.readFileSync(retrieved.filePath, "utf8"), content);

    // Reject malicious hash tokens
    assert.equal(getBlob("../../etc/passwd", tmpDir), null);
    assert.equal(getBlob("invalid-short-hash", tmpDir), null);
    assert.equal(getBlob("", tmpDir), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Option A: Freezes ephemeral /tmp files automatically", () => {
  const tmpAmq = fs.mkdtempSync(path.join(os.tmpdir(), "amq-root-"));
  const tmpFile = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
  fs.writeFileSync(tmpFile, "fake-png-binary-bytes");

  try {
    const ingested = ingestAttachment(tmpFile, tmpAmq);
    assert.ok(ingested);
    assert.equal(ingested.type, "blob");
    assert.equal(ingested.isImage, true);

    // Verify it is now in the amqRoot blobstore
    const fromStore = getBlob(ingested.sha256, tmpAmq);
    assert.ok(fromStore);
    assert.equal(fs.readFileSync(fromStore.filePath, "utf8"), "fake-png-binary-bytes");

    // Even if original tmpFile is wiped, blob remains!
    fs.unlinkSync(tmpFile);
    assert.equal(fs.existsSync(tmpFile), false);
    const postWipe = getBlob(ingested.sha256, tmpAmq);
    assert.ok(postWipe);
    assert.equal(fs.existsSync(postWipe.filePath), true);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    fs.rmSync(tmpAmq, { recursive: true, force: true });
  }
});

test("Option B: Git commit & object pinning", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "amq-git-test-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpRepo });
    execFileSync("git", ["config", "user.name", "AMQ Test"], { cwd: tmpRepo });
    execFileSync("git", ["config", "user.email", "test@amq.local"], { cwd: tmpRepo });

    const sampleFile = "sample.json";
    fs.writeFileSync(path.join(tmpRepo, sampleFile), JSON.stringify({ name: "amq-test" }));
    execFileSync("git", ["add", sampleFile], { cwd: tmpRepo });
    execFileSync("git", ["commit", "-m", "Initial test commit"], { cwd: tmpRepo });

    // Pin sample.json in this git repo
    const pinned = pinGitRef(tmpRepo, sampleFile, "HEAD");
    assert.ok(pinned);
    assert.equal(pinned.type, "git");
    assert.match(pinned.commit, /^[a-f0-9]{40}$/);
    assert.match(pinned.blob, /^[a-f0-9]{40}$/);
    assert.equal(pinned.name, "sample.json");
    assert.equal(pinned.ext, ".json");
    assert.match(pinned.url, /\/api\/git-file\?commit=/);

    // Read the pinned file
    const read = readGitRef(tmpRepo, pinned.commit, sampleFile);
    assert.ok(read);
    assert.ok(read.buffer.length > 0);
    assert.equal(read.mime, "application/json; charset=utf-8");

    // Reject malicious path traversal in git read
    assert.equal(readGitRef(tmpRepo, pinned.commit, "../../../etc/passwd"), null);
    assert.equal(readGitRef(tmpRepo, "invalid-commit-hash", sampleFile), null);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("Option B: Historical git pinning by message timestamp & mentioned commit", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "amq-git-time-test-"));
  const tmpAmq = fs.mkdtempSync(path.join(os.tmpdir(), "amq-root-time-"));
  try {
    execFileSync("git", ["init"], { cwd: tmpRepo });
    execFileSync("git", ["config", "user.name", "AMQ Test"], { cwd: tmpRepo });
    execFileSync("git", ["config", "user.email", "test@amq.local"], { cwd: tmpRepo });

    // Commit 1: create old_asset.png
    const assetPath = "old_asset.png";
    fs.writeFileSync(path.join(tmpRepo, assetPath), "old-asset-bytes");
    execFileSync("git", ["add", assetPath], { cwd: tmpRepo });
    execFileSync("git", ["commit", "-m", "Add old_asset.png"], { cwd: tmpRepo });
    const commit1Sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).trim();
    const commit1Time = new Date().toISOString();

    // Commit 2: delete old_asset.png
    fs.unlinkSync(path.join(tmpRepo, assetPath));
    execFileSync("git", ["rm", assetPath], { cwd: tmpRepo });
    execFileSync("git", ["commit", "-m", "Delete old_asset.png"], { cwd: tmpRepo });

    // File is physically missing on disk now!
    assert.equal(fs.existsSync(path.join(tmpRepo, assetPath)), false);

    // Pinning via HEAD should fail because it was deleted
    const headPin = pinGitRef(tmpRepo, assetPath, "HEAD");
    assert.equal(headPin, null);

    // But with message timestamp from when it existed:
    const timePin = ingestAttachment(assetPath, tmpAmq, tmpRepo, {
      timestamp: commit1Time,
      text: `Notice: old_asset.png was modified in commit ${commit1Sha}`,
    });

    assert.ok(timePin);
    assert.equal(timePin.exists, true);
    assert.equal(timePin.type, "git");
    assert.equal(timePin.commit, commit1Sha);
    assert.match(timePin.url, new RegExp(`/api/git-file\\?commit=${commit1Sha}`));

    // Read the historical file directly from git
    const read = readGitRef(tmpRepo, timePin.commit, assetPath);
    assert.ok(read);
    assert.equal(read.buffer.toString("utf8"), "old-asset-bytes");

    // extractMentionedCommits works on varied formats
    const commits = extractMentionedCommits("FIXADO (75d5785 + 9a65b0d), commitado: fbdcab1");
    assert.ok(commits.includes("75d5785"));
    assert.ok(commits.includes("9a65b0d"));
    assert.ok(commits.includes("fbdcab1"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpAmq, { recursive: true, force: true });
  }
});
