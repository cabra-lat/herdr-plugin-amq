import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAmqRoot } from "../src/config.mjs";

/**
 * A mailbox inside a mailbox is a scaffold, not a second project.
 *
 * Measured on this machine before the fix: there is exactly ONE real mailbox, and
 * `findAmqRoot("<real>/bus")` returned `<real>/.agent-mail/.agent-mail` - an empty scaffold that
 * exists because something created a queue relative to a cwd already inside a queue. The result
 * is not a partial answer: the nested root has no agents, no messages and no cards, so every
 * caller sees a HEALTHY EMPTY BOARD. Nothing in the return value says the lookup went wrong.
 *
 * This matters for the multi-mailbox question directly. Today one mailbox means the bug is a
 * wrong answer. The moment a second project exists, a tool resolving from the wrong directory
 * picks a mailbox by ACCIDENT, and the dashboard the user is asking about would show an empty
 * project with no indication of why.
 */
function scaffold(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  const real = path.join(root, ".agent-mail");
  fs.mkdirSync(path.join(real, "agents"), { recursive: true });
  fs.mkdirSync(path.join(real, "bus"), { recursive: true });
  // The scaffold: a queue created relative to a cwd that was already inside the queue.
  fs.mkdirSync(path.join(real, ".agent-mail", "agents"), { recursive: true });
  fs.mkdirSync(path.join(real, ".agent-mail", "bus"), { recursive: true });
  return { root, real, nested: path.join(real, ".agent-mail") };
}

test("a cwd INSIDE the mailbox resolves to the real mailbox, not the nested scaffold", () => {
  const { real, nested } = scaffold("nested-1-");
  const prev = process.env.AM_ROOT;
  delete process.env.AM_ROOT;                 // exercise the walk, not the explicit override
  try {
    for (const from of [real, path.join(real, "bus"), path.join(real, "agents")]) {
      const got = findAmqRoot(from);
      assert.equal(got, real, `cwd ${from} resolved to ${got}, which is ${got === nested ? "the EMPTY SCAFFOLD" : "the wrong root"}`);
    }
  } finally {
    if (prev !== undefined) process.env.AM_ROOT = prev;
  }
});

test("the scaffold is skipped, and resolution walks PAST it to the outer mailbox", () => {
  const { real } = scaffold("nested-2-");
  const prev = process.env.AM_ROOT;
  delete process.env.AM_ROOT;
  try {
    // From INSIDE the scaffold - the worst case, because a naive walk finds it immediately.
    const got = findAmqRoot(path.join(real, ".agent-mail", "bus"));
    assert.equal(got, real, "resolution must not stop at a mailbox nested inside another");
  } finally {
    if (prev !== undefined) process.env.AM_ROOT = prev;
  }
});

test("an EXPLICIT AM_ROOT still wins, so the multi-mailbox mechanism is untouched by this fix", () => {
  // The whole multi-mailbox story rests on AM_ROOT selecting a mailbox. This fix is about
  // AMBIGUITY, not about restricting choice: an explicitly named root must still be honoured
  // even when it is itself nested, because the operator named it on purpose.
  const { nested } = scaffold("nested-3-");
  const prev = process.env.AM_ROOT;
  process.env.AM_ROOT = nested;
  try {
    assert.equal(findAmqRoot(process.cwd()), nested, "an explicit root is the operator's decision and is not second-guessed");
  } finally {
    if (prev === undefined) delete process.env.AM_ROOT; else process.env.AM_ROOT = prev;
  }
});

test("RED ARM: the scaffold is genuinely EMPTY, which is what makes the bug silent", () => {
  // Establishes why this was dangerous rather than merely untidy. If the nested root had content
  // the failure would be visible; being empty is what turns it into a healthy-looking answer.
  const { nested } = scaffold("nested-4-");
  assert.deepEqual(fs.readdirSync(path.join(nested, "bus")), [], "the scaffold's bus is empty");
  assert.deepEqual(fs.readdirSync(path.join(nested, "agents")), [], "and it has no agents, so it reads as an idle empty project");
});
