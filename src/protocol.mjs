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

export function isSafeMailIdentifier(value, maxLength = 200) {
  if (typeof value !== "string") return false;
  if (!value || value.length > maxLength || value === "." || value === "..") return false;
  return !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function canonicalMessageId(value) {
  return String(value || "").replace(/[:.]/g, "-");
}

function messageIdsMatch(left, right) {
  return left === right || canonicalMessageId(left) === canonicalMessageId(right);
}

function resolveAgentDirectory(amqRoot, handle, create = false) {
  if (!amqRoot || !fs.existsSync(amqRoot) || !isSafeMailIdentifier(handle, 128)) {
    throw new Error("Invalid AMQ agent path");
  }

  const root = fs.realpathSync(amqRoot);
  const agentsDir = path.join(root, "agents");
  if (create) fs.mkdirSync(agentsDir, { recursive: true });
  if (!fs.existsSync(agentsDir)) return null;

  const agentsStat = fs.lstatSync(agentsDir);
  if (!agentsStat.isDirectory() || agentsStat.isSymbolicLink()) {
    throw new Error("Invalid AMQ agents directory");
  }

  const agentDir = path.join(agentsDir, handle);
  if (create && !fs.existsSync(agentDir)) ensureDirectoryExists(agentDir);
  if (!fs.existsSync(agentDir)) return null;

  const agentStat = fs.lstatSync(agentDir);
  if (!agentStat.isDirectory() || agentStat.isSymbolicLink()) {
    throw new Error("Invalid AMQ agent directory");
  }

  const realAgentsDir = fs.realpathSync(agentsDir);
  const realAgentDir = fs.realpathSync(agentDir);
  if (path.dirname(realAgentDir) !== realAgentsDir) {
    throw new Error("AMQ agent directory escaped the queue root");
  }
  return realAgentDir;
}

const MAX_MAILDIR_FILE_BYTES = 8 * 1024 * 1024;

function openNoFollow(filePath, flags, mode) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  return fs.openSync(filePath, flags | noFollow, mode);
}

function isDirectoryHandle(handle) {
  return Boolean(handle && typeof handle === "object");
}

function closeDirectory(handle) {
  if (!isDirectoryHandle(handle)) fs.closeSync(handle);
}

function descriptorPath(handle) {
  if (isDirectoryHandle(handle)) return handle.path;
  const base = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";
  return path.join(base, String(handle));
}

function openRelativeNoFollow(dirHandle, name, flags, mode) {
  if (!name || path.basename(name) !== name) throw new Error("Invalid relative Maildir name");
  return openNoFollow(path.join(descriptorPath(dirHandle), name), flags, mode);
}

function resolveDarwinDirectory(dirPath) {
  const resolved = path.resolve(dirPath);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const systemSymlinkRoots = new Set(["/private", "/tmp", "/var"]);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      if (!systemSymlinkRoots.has(current)) throw new Error("Symlinked directory is not allowed");
      current = fs.realpathSync(current);
      continue;
    }
    if (!stat.isDirectory()) throw new Error("Maildir path is not a directory");
  }
  const realPath = fs.realpathSync(current);
  if (!fs.statSync(realPath).isDirectory()) throw new Error("Maildir path is not a directory");
  return realPath;
}

function openDirectorySecure(dirPath) {
  if (process.platform === "darwin") return { path: resolveDarwinDirectory(dirPath) };
  const resolved = path.resolve(dirPath);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const directoryFlag = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0);
  let current = openNoFollow(parsed.root, directoryFlag, undefined);
  try {
    for (const segment of segments) {
      const next = openRelativeNoFollow(current, segment, directoryFlag);
      closeDirectory(current);
      current = next;
    }
    return current;
  } catch (error) {
    closeDirectory(current);
    throw error;
  }
}

function writeFileAtomicBetweenDirectories(fileName, tempDirFd, targetDirFd, content, maxBytes = MAX_MAILDIR_FILE_BYTES) {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new Error("Message exceeds the Maildir size limit");
  }

  const tempName = `.amq-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = openRelativeNoFollow(
      tempDirFd,
      tempName,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(
      path.join(descriptorPath(tempDirFd), tempName),
      path.join(descriptorPath(targetDirFd), fileName)
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(path.join(descriptorPath(tempDirFd), tempName)); } catch {}
  }
}

export function writeBoundedFileAtomic(filePath, content, maxBytes = MAX_MAILDIR_FILE_BYTES) {
  const dirFd = openDirectorySecure(path.dirname(filePath));
  try {
    writeFileAtomicBetweenDirectories(path.basename(filePath), dirFd, dirFd, content, maxBytes);
  } finally {
    closeDirectory(dirFd);
  }
}

export function listMaildirMessageFiles(dirPath) {
  const dirFd = openDirectorySecure(dirPath);
  try {
    return fs.readdirSync(descriptorPath(dirFd));
  } finally {
    closeDirectory(dirFd);
  }
}

export function moveMaildirMessage(amqRoot, handle, fromFolder, toFolder, fileName) {
  if (!isSafeMailIdentifier(handle, 128) || !isSafeMailIdentifier(fileName)) {
    throw new Error("Invalid Maildir message path");
  }
  const agentDir = resolveAgentDirectory(amqRoot, handle, false);
  if (!agentDir) return null;
  const fromDir = ensureContainedDirectory(agentDir, ["inbox", fromFolder]);
  const toDir = ensureContainedDirectory(agentDir, ["inbox", toFolder]);
  const fromFd = openDirectorySecure(fromDir);
  let toFd;
  try {
    toFd = openDirectorySecure(toDir);
    fs.renameSync(
      path.join(descriptorPath(fromFd), fileName),
      path.join(descriptorPath(toFd), fileName)
    );
    return path.join(toDir, fileName);
  } finally {
    closeDirectory(fromFd);
    if (toFd !== undefined) closeDirectory(toFd);
  }
}

export function readMaildirMessageFile(filePath, maxBytes = MAX_MAILDIR_FILE_BYTES) {
  const dirFd = openDirectorySecure(path.dirname(filePath));
  let fd;
  try {
    fd = openRelativeNoFollow(
      dirFd,
      path.basename(filePath),
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0)
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;

    const chunks = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      total += bytes;
      if (total > maxBytes) return null;
      chunks.push(Buffer.from(buffer.subarray(0, bytes)));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    closeDirectory(dirFd);
  }
}

function ensureDirectoryExists(dir) {
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

function ensureContainedDirectory(rootDir, segments) {
  let current = rootDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) ensureDirectoryExists(current);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid AMQ mailbox directory");
    const real = fs.realpathSync(current);
    if (real !== current || !real.startsWith(`${rootDir}${path.sep}`)) {
      throw new Error("AMQ mailbox directory escaped the queue root");
    }
  }
  return current;
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
  const agentDir = resolveAgentDirectory(amqRoot, handle, true);
  ensureContainedDirectory(agentDir, ["inbox"]);
  ensureContainedDirectory(agentDir, ["inbox", "tmp"]);
  ensureContainedDirectory(agentDir, ["inbox", "new"]);
  ensureContainedDirectory(agentDir, ["inbox", "cur"]);
  ensureContainedDirectory(agentDir, ["outbox"]);
  ensureContainedDirectory(agentDir, ["outbox", "tmp"]);
  ensureContainedDirectory(agentDir, ["outbox", "sent"]);
  ensureContainedDirectory(agentDir, ["receipts"]);
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
  if (!isSafeMailIdentifier(from, 128)) throw new Error("Invalid sender handle");
  const recipients = Array.isArray(to) ? to : (to ? [to] : []);
  if (!recipients.length) throw new Error("At least one recipient in 'to' is required");
  if (!recipients.every((recipient) => isSafeMailIdentifier(recipient, 128))) {
    throw new Error("Invalid recipient handle");
  }

  const msgId = options.id || generateMessageId();
  if (!isSafeMailIdentifier(msgId)) throw new Error("Invalid message id");
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

  if (Buffer.byteLength(fileText, "utf8") > MAX_MAILDIR_FILE_BYTES) {
    throw new Error("Message exceeds the Maildir size limit");
  }

  for (const recipient of recipients) {
    const recipientDir = ensureAgentMailbox(amqRoot, recipient);
    const tmpFd = openDirectorySecure(path.join(recipientDir, "inbox", "tmp"));
    let newFd;
    try {
      newFd = openDirectorySecure(path.join(recipientDir, "inbox", "new"));
      writeFileAtomicBetweenDirectories(`${msgId}.md`, tmpFd, newFd, fileText);
    } finally {
      closeDirectory(tmpFd);
      if (newFd !== undefined) closeDirectory(newFd);
    }
  }

  const senderDir = ensureAgentMailbox(amqRoot, from);
  const sentFd = openDirectorySecure(path.join(senderDir, "outbox", "sent"));
  try {
    writeFileAtomicBetweenDirectories(`${msgId}.md`, sentFd, sentFd, fileText);
  } finally {
    closeDirectory(sentFd);
  }

  return {
    ok: true,
    id: msgId,
    from,
    to: recipients,
    subject,
    thread,
    refs,
    created,
    attachmentsCount: processedAttachments.length,
  };
}

/**
 * Locate any message across all agent maildirs by ID.
 */
function findMessageInDirectory(dir, msgId) {
  if (!isSafeMailIdentifier(msgId)) return null;
  let files;
  try {
    files = listMaildirMessageFiles(dir);
  } catch {
    return null;
  }
  for (const fileName of files) {
    if (!fileName.endsWith(".md")) continue;
    const filePath = path.join(dir, fileName);
    const content = readMaildirMessageFile(filePath);
    if (content === null) continue;
    const { header, body } = parseMessage(content);
    if (messageIdsMatch(header.id, msgId)) return { fileName, filePath, header, body };
  }
  return null;
}

export function markMaildirMessageRead(amqRoot, handle, msgId) {
  if (!amqRoot || !isSafeMailIdentifier(handle, 128) || !isSafeMailIdentifier(msgId)) {
    return { ok: false, error: "Invalid mailbox or message identifier" };
  }

  try {
    const agentDir = resolveAgentDirectory(amqRoot, handle, false);
    if (!agentDir) return { ok: false, error: "Mailbox not found" };
    const newDir = path.join(agentDir, "inbox", "new");
    const curDir = path.join(agentDir, "inbox", "cur");
    const foundNew = findMessageInDirectory(newDir, msgId);
    const found = foundNew || findMessageInDirectory(curDir, msgId);
    if (!found) return { ok: false, error: "Message not found" };

    const { header } = found;
    const recipients = Array.isArray(header.to) ? header.to : [header.to];
    if (!recipients.includes(handle)) {
      return { ok: false, error: "Message is not addressed to this mailbox" };
    }

    const logicalCurPath = path.join(amqRoot, "agents", handle, "inbox", "cur", found.fileName);
    if (!foundNew) return { ok: true, alreadyRead: true, id: msgId, filePath: logicalCurPath };

    const filePath = moveMaildirMessage(amqRoot, handle, "new", "cur", found.fileName);
    if (!filePath) return { ok: false, error: "Message could not be marked read" };
    return { ok: true, alreadyRead: false, id: msgId, filePath: logicalCurPath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function findMessageForRecipient(amqRoot, recipient, msgId) {
  if (!amqRoot || !isSafeMailIdentifier(recipient, 128) || !isSafeMailIdentifier(msgId)) return null;

  try {
    const agentDir = resolveAgentDirectory(amqRoot, recipient, false);
    if (!agentDir) return null;

    for (const dir of [path.join(agentDir, "inbox", "new"), path.join(agentDir, "inbox", "cur")]) {
      const found = findMessageInDirectory(dir, msgId);
      if (!found) continue;
      const recipients = Array.isArray(found.header.to) ? found.header.to : [found.header.to];
      if (recipients.includes(recipient)) {
        return { id: msgId, header: found.header, body: found.body, filePath: found.filePath, foundIn: recipient };
      }
    }
  } catch {}

  return null;
}

export function findMessageById(amqRoot, msgId) {
  if (!amqRoot || !isSafeMailIdentifier(msgId)) return null;
  const agentsDir = path.join(amqRoot, "agents");
  if (!fs.existsSync(agentsDir)) return null;

  for (const agent of fs.readdirSync(agentsDir)) {
    if (!isSafeMailIdentifier(agent, 128)) continue;
    try {
      const agentDir = resolveAgentDirectory(amqRoot, agent, false);
      if (!agentDir) continue;
      const candidateDirs = [
        path.join(agentDir, "inbox", "new"),
        path.join(agentDir, "inbox", "cur"),
        path.join(agentDir, "outbox", "sent"),
      ];

      for (const dir of candidateDirs) {
        const found = findMessageInDirectory(dir, msgId);
        if (found) return { id: msgId, header: found.header, body: found.body, filePath: found.filePath, foundIn: agent };
      }
    } catch {}
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
// PHASE 1: read what is waiting, WITHOUT consuming it.
//
// Promotion used to be inseparable from reading, which made this a silent consumer of
// every message it touched. The old drain moved new -> cur and only then returned the
// content for the caller to print, so anything that stopped the output - a closed pipe
// from an ordinary `| head -3`, a throw, a caller that ignored the result - left the
// message marked consumed with nothing shown and no record it had ever been read.
export function readMaildirMessages(amqRoot, handle) {
  if (!amqRoot || !isSafeMailIdentifier(handle, 128)) return [];
  const agentDir = resolveAgentDirectory(amqRoot, handle, true);
  const newDir = ensureContainedDirectory(agentDir, ["inbox", "new"]);
  const files = listMaildirMessageFiles(newDir).filter((f) => f.endsWith(".md"));
  const waiting = [];

  for (const file of files) {
    try {
      const content = readMaildirMessageFile(path.join(newDir, file));
      if (content === null) continue;
      const { header, body } = parseMessage(content);
      waiting.push({ id: file.replace(/\.md$/, ""), file, header, body });
    } catch {}
  }
  return waiting;
}

/**
 * Record that a message was consumed, so "present in cur/" stops being ambiguous.
 *
 * A message sitting in cur/ with no receipt could mean it was read, or that whatever
 * read it never got as far as showing anyone - indistinguishable without this file. The
 * schema matches the standalone amq binary's receipt so the two drain implementations
 * produce one comparable audit trail rather than two.
 */
export function writeDrainReceipt(amqRoot, handle, message, { stage = "drained", now = new Date() } = {}) {
  try {
    if (!amqRoot || !isSafeMailIdentifier(handle, 128)) return null;
    const agentDir = resolveAgentDirectory(amqRoot, handle, true);
    const receiptsDir = ensureContainedDirectory(agentDir, ["receipts"]);
    const id = message.id || message.file?.replace(/\.md$/, "");
    if (!isSafeMailIdentifier(id, 256)) return null;
    const receipt = {
      schema: 1,
      msg_id: id,
      thread: message.header?.thread || null,
      sender: message.header?.from || null,
      consumer: handle,
      stage,
      emitted_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    };
    writeBoundedFileAtomic(path.join(receiptsDir, `${id}__${handle}__${stage}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    return true;
  } catch {
    // A receipt that cannot be written must not cost the caller its promotion: the
    // content has already been shown, and failing here would strand the message in new/
    // where it would be shown a second time.
    return null;
  }
}

// PHASE 2: consume, only after the caller has successfully surfaced the content.
export function commitMaildirMessages(amqRoot, handle, waiting, { now = new Date() } = {}) {
  const committed = [];
  for (const message of waiting || []) {
    try {
      const filePath = moveMaildirMessage(amqRoot, handle, "new", "cur", message.file);
      if (!filePath) continue;
      writeDrainReceipt(amqRoot, handle, message, { now });
      committed.push({ ...message, filePath });
    } catch {}
  }
  return committed;
}

/**
 * Drain an agent inbox in one step.
 *
 * Prefer readMaildirMessages + commitMaildirMessages wherever the content is going to be
 * shown to somebody: this wrapper commits BEFORE the caller has printed anything, which
 * is the ordering that let `mail drain | head` consume messages nobody ever saw.
 */
export function drainMaildir(amqRoot, handle) {
  return commitMaildirMessages(amqRoot, handle, readMaildirMessages(amqRoot, handle));
}
