// A raw view that is itself lossy is worse than no raw view, because it is trusted.
//
// The confusion this exists to prevent: a 42-byte probe attachment was read as a broken
// deliverable, because nothing on the surface let a reader open the file and see that it was
// deliberate. Every arm here therefore asserts on BYTES and never on a rendered string.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRawMaildirMessage } from "../src/protocol.mjs";

function fixture(body, subject = "s") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rawview-"));
  const amqRoot = path.join(root, ".agent-mail");
  const dir = path.join(amqRoot, "agents", "user", "inbox", "new");
  fs.mkdirSync(dir, { recursive: true });
  const id = "2026-01-01T00:00:00.000Z_pid1_aaaa";
  const header = { schema: 1, id, from: "qa", to: ["user"], thread: "t", subject, created: "2026-01-01T00:00:00.000Z", priority: "normal" };
  fs.writeFileSync(path.join(dir, `${id}.md`), `---json\n${JSON.stringify(header, null, 2)}\n---\n${body}`);
  return { root, amqRoot, id };
}

// ARM 1: the raw body is returned byte for byte, including markdown the renderer escapes.
test("ARM 1: the raw body is the source, not a re-rendering of it", () => {
  const body = "x\n\n# Attachments (4)\n\n| a | `b` | <script> | [l](u) |\n|---|-----|-----------|-------|\n| 1 | 2 | 3 | 4 |\n\n  indented, and a trailing line  \n";
  const f = fixture(body);
  try {
    const r = readRawMaildirMessage(f.amqRoot, "user", f.id);
    assert.ok(r.ok, r.error || "");
    assert.equal(r.raw, body, "the raw view must be byte identical to the source");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("ARM 1b: a body of a single character is a single character, not a summary", () => {
  const f = fixture("x");
  try {
    const r = readRawMaildirMessage(f.amqRoot, "user", f.id);
    assert.equal(r.raw, "x");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("ARM 1c: trailing newlines and blank lines survive, because they are the source", () => {
  const body = "line\n\n\n";
  const f = fixture(body);
  try {
    assert.equal(readRawMaildirMessage(f.amqRoot, "user", f.id).raw, body);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("the header is exposed alongside the raw body, for the copy action and the context", () => {
  const f = fixture("body", "the subject");
  try {
    const r = readRawMaildirMessage(f.amqRoot, "user", f.id);
    assert.equal(r.from, "qa");
    assert.equal(r.subject, "the subject");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a message that is not in this mailbox is not readable through it", () => {
  const f = fixture("b");
  try {
    const r = readRawMaildirMessage(f.amqRoot, "worker", f.id);
    assert.equal(r.ok, false, "another mailbox must not serve this message");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("an unknown id fails loudly rather than returning an empty body", () => {
  // An empty string is a valid-looking raw view of nothing, which is how a reader ends up
  // believing a message had no content.
  const f = fixture("b");
  try {
    const r = readRawMaildirMessage(f.amqRoot, "user", "no-such-message");
    assert.equal(r.ok, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
