import fs from "node:fs";
import path from "node:path";
import { parseMessage, serializeMessage } from "./protocol.mjs";
import { ingestAttachment } from "./blobs.mjs";

/**
 * Scan all messages across agent mailboxes in amqRoot and migrate attachments once.
 * - Resolves ephemeral files (/tmp/...) into immutable CAS blobs.
 * - Pins deleted or historical repository assets to their git commits.
 * - Writes pinned/frozen attachments directly into the message frontmatter.
 * - Once migrated, parseMessageFile reads attachments in 0ms without git execution.
 */
export function migrateMessageAttachments(amqRoot, { dryRun = false, verbose = false, onProgress = null } = {}) {
  if (!amqRoot) throw new Error("amqRoot is required");
  const repoRoot = path.resolve(path.dirname(amqRoot));

  const stats = {
    totalScanned: 0,
    alreadyMigrated: 0,
    migrated: 0,
    blobsStored: 0,
    gitPinned: 0,
    errors: 0,
  };

  const agentsDir = path.join(amqRoot, "agents");
  if (!fs.existsSync(agentsDir)) {
    return stats;
  }

  // Find all message files across inbox/new, inbox/cur, and outbox/sent
  const messageFiles = [];
  const agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const agentEnt of agentEntries) {
    if (!agentEnt.isDirectory()) continue;
    const agentDir = path.join(agentsDir, agentEnt.name);
    const subdirs = [
      path.join(agentDir, "inbox", "new"),
      path.join(agentDir, "inbox", "cur"),
      path.join(agentDir, "outbox", "sent"),
    ];

    for (const subdir of subdirs) {
      if (!fs.existsSync(subdir)) continue;
      const files = fs.readdirSync(subdir);
      for (const f of files) {
        if (f.endsWith(".md")) {
          messageFiles.push(path.join(subdir, f));
        }
      }
    }
  }

  stats.totalScanned = messageFiles.length;

  const candidateRegex = /(?:(?:(?:\/|\.\/|[a-zA-Z0-9_.-]+\/)[a-zA-Z0-9_./-]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|log|txt|csv|json|diff|patch|out))|(?:\b[a-zA-Z0-9_.-]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|log|diff|patch|out)\b))/gi;

  for (let i = 0; i < messageFiles.length; i++) {
    const filePath = messageFiles[i];
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const { header, body } = parseMessage(raw);

      if (!header || typeof header !== "object") {
        continue;
      }

      // Check if already migrated
      const existingAttachments = header.attachments;
      const isAlreadyMigrated =
        Array.isArray(existingAttachments) &&
        existingAttachments.length > 0 &&
        existingAttachments.every(
          (a) => typeof a === "object" && a !== null && (a.type === "blob" || a.type === "git" || a.exists !== undefined)
        );

      if (isAlreadyMigrated) {
        stats.alreadyMigrated++;
        if (onProgress && i % 100 === 0) onProgress({ ...stats, current: i + 1 });
        continue;
      }

      // Collect candidates: existing raw attachments + body regex matches
      const seen = new Set();
      const candidates = [];

      function addCand(ref) {
        if (!ref) return;
        let clean = typeof ref === "string" ? ref.trim().replace(/^["'<(\[]+|[>"')\],;:]+$/g, "") : "";
        if (typeof ref === "object") clean = ref.path || ref.sha256 || ref.name || "";
        if (!clean || seen.has(clean) || clean.startsWith("http://") || clean.startsWith("https://")) return;
        seen.add(clean);
        const base = path.basename(clean);
        if (["config.json", "package.json", "pyproject.toml", "Cargo.toml", "flake.lock"].includes(base)) return;
        candidates.push(ref);
      }

      if (Array.isArray(existingAttachments)) {
        for (const a of existingAttachments) addCand(a);
      }

      const matches = body.match(candidateRegex) || [];
      for (const m of matches) addCand(m);

      if (candidates.length === 0) {
        if (onProgress && i % 100 === 0) onProgress({ ...stats, current: i + 1 });
        continue;
      }

      // Ingest each candidate
      const resolved = [];
      for (const cand of candidates) {
        try {
          const ing = ingestAttachment(cand, amqRoot, repoRoot, {
            timestamp: header.created || null,
            text: body,
          });
          if (ing && ing.exists) {
            resolved.push(ing);
            if (ing.type === "blob") stats.blobsStored++;
            if (ing.type === "git") stats.gitPinned++;
          }
        } catch {}
      }

      if (resolved.length > 0) {
        header.attachments = resolved;
        const serialized = serializeMessage({
          ...header,
          body,
        });

        if (!dryRun) {
          const tmp = `${filePath}.mig.${Date.now()}`;
          fs.writeFileSync(tmp, serialized, "utf8");
          fs.renameSync(tmp, filePath);
        }

        stats.migrated++;
      }

      if (onProgress && (i % 50 === 0 || i === messageFiles.length - 1)) {
        onProgress({ ...stats, current: i + 1 });
      }
    } catch (err) {
      stats.errors++;
      if (verbose) {
        console.error(`Error migrating ${filePath}:`, err.message);
      }
    }
  }

  return stats;
}
