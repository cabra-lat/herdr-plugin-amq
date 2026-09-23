import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { storeBlob, ingestAttachment } from "./blobs.mjs";

// ─── Constants & Allowed Kinds ───────────────────────────────────────────────

export const VALID_KINDS = new Set([
  "brainstorm",
  "review_request",
  "review_response",
  "question",
  "answer",
  "decision",
  "status",
  "todo",
]);

export function normalizeKind(kind) {
  if (!kind) return null;
  const k = String(kind).trim().toLowerCase();
  if (VALID_KINDS.has(k)) return k;
  if (k === "task") return "todo";
  if (k === "alert") return "status";
  return null;
}

// ─── AMQ / RFC 5322 Identifier Generation ────────────────────────────────────

/**
 * Generate a canonical AMQ message ID.
 * Format: <ISO8601-compact>_pid<pid>_<randomHex8>
 * Example: 2026-09-23T10-25-30.123Z_pid12345_a1b2c3d4
 */
export function generateMessageId(date = new Date(), pid = process.pid) {
  const iso = date.toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${iso}_pid${pid}_${rand}`;
}

/**
 * Determine a canonical p2p or group thread ID.
 * For 2 participants, sorts lexicographically: p2p/<agentA>__<agentB>
 */
export function computeCanonicalThread(from, toList) {
  const recipients = Array.isArray(toList) ? toList : [toList];
  const all = [...new Set([from, ...recipients].filter(Boolean))];
  if (all.length === 2) {
    all.sort();
    return `p2p/${all[0]}__${all[1]}`;
  }
  return `group/${all.sort().join("__")}`;
}

// ─── Serialization & Deserialization ─────────────────────────────────────────

/**
 * Serialize message metadata and body into AMQ RFC 5322 JSON frontmatter format.
 */
export function serializeMessage({
  id,
  from,
  to,
  subject = "",
  body = "",
  thread = null,
  refs = [],
  priority = "normal",
  kind = null,
  labels = [],
  attachments = [],
  context = null,
  created = new Date().toISOString(),
}) {
  const recipients = Array.isArray(to) ? to : [to];
  const safeThread = thread || computeCanonicalThread(from, recipients);
  const safeKind = normalizeKind(kind);

  const header = {
    schema: 1,
    id,
    from,
    to: recipients,
    thread: safeThread,
    subject: subject || "(no subject)",
    created,
    priority: priority || "normal",
  };

  if (refs && refs.length) header.refs = refs;
  if (safeKind) header.kind = safeKind;
  if (labels && labels.length) header.labels = labels;
  if (attachments && attachments.length) header.attachments = attachments;
  if (context && typeof context === "object") header.context = context;

  return `---json\n${JSON.stringify(header, null, 2)}\n---\n${body || ""}\n`;
}

/**
 * Parse an AMQ message string into frontmatter header and body.
 */
export function parseMessage(content = "") {
  const jsonMatch = content.match(/^---json\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (jsonMatch) {
    try {
      const header = JSON.parse(jsonMatch[1]);
      return { header, body: jsonMatch[2] };
    } catch {}
  }

  const yamlMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (yamlMatch) {
    // Basic fallback parsing for YAML frontmatter
    const header = {};
    const lines = yamlMatch[1].split(/\r?\n/);
    for (const l of lines) {
      const kv = l.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (kv) {
        const key = kv[1];
        let val = kv[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        header[key] = val;
      }
    }
    return { header, body: yamlMatch[2] };
  }

  return { header: {}, body: content };
}

// ─── Native Maildir Mailbox Operations ────────────────────────────────────────

/**
 * Initialize maildir directory structure for an agent:
 * - inbox/tmp
 * - inbox/new
 * - inbox/cur
 * - outbox/sent
 */
export function ensureAgentMailbox(amqRoot, handle) {
  const agentDir = path.join(amqRoot, "agents", handle);
  const dirs = [
    path.join(agentDir, "inbox", "tmp"),
    path.join(agentDir, "inbox", "new"),
    path.join(agentDir, "inbox", "cur"),
    path.join(agentDir, "outbox", "sent"),
  ];

  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  return agentDir;
}

/**
 * Send an AMQ message natively using pure Maildir atomic delivery.
 * Adheres to DJB Maildir spec:
 * 1. Write to inbox/tmp/<id>.md
 * 2. Atomic rename to inbox/new/<id>.md
 * 3. Store copy in outbox/sent/<id>.md
 */
export function sendMaildirMessage(amqRoot, options = {}) {
  if (!amqRoot) throw new Error("amqRoot is required");
  const { from, to, subject, body, priority, kind, thread, refs, labels, context, attachments = [] } = options;

  if (!from) throw new Error("Sender 'from' is required");
  const recipients = Array.isArray(to) ? to : (to ? [to] : []);
  if (!recipients.length) throw new Error("At least one recipient in 'to' is required");

  const msgId = options.id || generateMessageId();
  const created = options.created || new Date().toISOString();

  // Process attachments: auto-freeze ephemeral files into CAS blobstore if needed
  const repoRoot = path.resolve(path.dirname(amqRoot));
  const processedAttachments = [];
  for (const att of attachments) {
    const ingested = ingestAttachment(att, amqRoot, repoRoot);
    if (ingested) {
      processedAttachments.push(ingested);
    } else if (typeof att === "string") {
      processedAttachments.push({ path: att, name: path.basename(att) });
    }
  }

  const fileText = serializeMessage({
    id: msgId,
    from,
    to: recipients,
    subject: subject || "(no subject)",
    body: body || "",
    thread: thread || computeCanonicalThread(from, recipients),
    refs: refs || [],
    priority: priority || "normal",
    kind,
    labels: labels || [],
    attachments: processedAttachments,
    context: context || null,
    created,
  });

  // Ensure sender mailbox exists & record in outbox/sent
  ensureAgentMailbox(amqRoot, from);
  const senderSentDir = path.join(amqRoot, "agents", from, "outbox", "sent");
  fs.writeFileSync(path.join(senderSentDir, `${msgId}.md`), fileText, "utf8");

  // Deliver to each recipient using atomic Maildir tmp -> new rename
  for (const recipient of recipients) {
    ensureAgentMailbox(amqRoot, recipient);
    const tmpPath = path.join(amqRoot, "agents", recipient, "inbox", "tmp", `${msgId}.md`);
    const newPath = path.join(amqRoot, "agents", recipient, "inbox", "new", `${msgId}.md`);

    // Write to tmp
    fs.writeFileSync(tmpPath, fileText, "utf8");
    // Atomic move to new (POSIX atomic rename guarantee)
    fs.renameSync(tmpPath, newPath);
  }

  return {
    ok: true,
    id: msgId,
    from,
    to: recipients,
    subject,
    created,
    attachmentsCount: processedAttachments.length,
  };
}

/**
 * Locate any message across all agent maildirs by ID.
 */
export function findMessageById(amqRoot, msgId) {
  if (!amqRoot || !msgId) return null;
  const agentsDir = path.join(amqRoot, "agents");
  if (!fs.existsSync(agentsDir)) return null;

  const agentFolders = fs.readdirSync(agentsDir);
  for (const agent of agentFolders) {
    const candidateDirs = [
      path.join(agentsDir, agent, "inbox", "new"),
      path.join(agentsDir, agent, "inbox", "cur"),
      path.join(agentsDir, agent, "outbox", "sent"),
    ];

    for (const dir of candidateDirs) {
      const filePath = path.join(dir, `${msgId}.md`);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const { header, body } = parseMessage(content);
          return {
            id: msgId,
            header,
            body,
            filePath,
            foundIn: agent,
          };
        } catch {}
      }
    }
  }

  return null;
}

/**
 * Reply to an existing message using RFC 5322 In-Reply-To / References chaining.
 */
export function replyMaildirMessage(amqRoot, options = {}) {
  const { from, replyToId, body, subject, priority, kind, labels, attachments } = options;
  if (!replyToId) throw new Error("replyToId is required");
  if (!from) throw new Error("Sender 'from' is required");

  const original = findMessageById(amqRoot, replyToId);
  if (!original) {
    throw new Error(`Original message with ID '${replyToId}' not found`);
  }

  const origHeader = original.header;
  // Reply to original sender
  const recipients = [origHeader.from || "coordinator"];
  // Preserve thread or compute canonical
  const thread = origHeader.thread || computeCanonicalThread(from, recipients);
  // RFC 5322 References chaining: append current ID to refs
  const existingRefs = Array.isArray(origHeader.refs) ? origHeader.refs : [];
  const refs = [...new Set([...existingRefs, replyToId])];

  const safeSubject = subject || (
    origHeader.subject?.toLowerCase().startsWith("re:")
      ? origHeader.subject
      : `Re: ${origHeader.subject || ""}`
  );

  return sendMaildirMessage(amqRoot, {
    from,
    to: recipients,
    subject: safeSubject,
    body: body || "",
    thread,
    refs,
    priority: priority || origHeader.priority || "normal",
    kind: kind || origHeader.kind || null,
    labels: labels || origHeader.labels || [],
    attachments: attachments || [],
  });
}

/**
 * Drain all new messages for an agent (atomic Maildir new/ -> cur/ transition).
 */
export function drainMaildir(amqRoot, handle) {
  if (!amqRoot || !handle) return [];
  const newDir = path.join(amqRoot, "agents", handle, "inbox", "new");
  const curDir = path.join(amqRoot, "agents", handle, "inbox", "cur");

  if (!fs.existsSync(newDir)) return [];
  if (!fs.existsSync(curDir)) fs.mkdirSync(curDir, { recursive: true });

  const files = fs.readdirSync(newDir).filter((f) => f.endsWith(".md"));
  const drained = [];

  for (const f of files) {
    const fromPath = path.join(newDir, f);
    const toPath = path.join(curDir, f);
    try {
      const content = fs.readFileSync(fromPath, "utf8");
      const { header, body } = parseMessage(content);
      // Atomic move to cur
      fs.renameSync(fromPath, toPath);
      drained.push({
        id: f.replace(/\.md$/, ""),
        header,
        body,
        filePath: toPath,
      });
    } catch {}
  }

  return drained;
}
