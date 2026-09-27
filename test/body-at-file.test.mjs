import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * `mail send --body @/no/such/file` printed a normal receipt, generated a message id, exited 0,
 * and delivered the literal pathname to the recipient.
 *
 * REPRODUCED BY COORDINATOR with a control: `ls` on the exact path returns "No such file or
 * directory" - checked before the send, not assumed. They explicitly did NOT test `mail reply`,
 * saying it "may take a different path through the argument handling". It took the same path,
 * with the same bug, which is why there is an arm for it here.
 *
 * THE MECHANISM, once read: the body expansion was
 *     if (bodyArg.startsWith("@")) { if (fs.existsSync(f)) body = read(f); }
 * so an unreadable path fell through with the literal "@/no/such/file" still in `body`, and the
 * message went out looking entirely normal. Meanwhile `expandAtFile` - which fails closed and
 * names the path and the reason - already existed in this same file and was used by five other
 * call sites. The correct helper was there; two call sites had their own inline version.
 *
 * THE DOCUMENTATION AUTHORISED IT, which is the part worth keeping. The operations reference said
 * "a literal string or `@file` is used as-is". That is a POSITIVE PERMISSION, not an omission: an
 * implementer following the spec carefully would reproduce this bug correctly and forever. The doc
 * was corrected first and the code second, in that order, because a stricter rule the
 * documentation still contradicts is not a fix.
 *
 * Same class as the --attach partial send in 12b4d48, and the general form is now stated in the
 * docs too: a documented permission is a mechanism.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "herdr-amq.mjs");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atfile-"));
  const amqRoot = path.join(root, ".agent-mail");
  for (const h of ["worker", "user"]) {
    for (const stage of ["new", "cur", "tmp"]) {
      fs.mkdirSync(path.join(amqRoot, "agents", h, "inbox", stage), { recursive: true });
    }
    fs.writeFileSync(path.join(amqRoot, "agents", h, "profile.json"),
      JSON.stringify({ name: h, role: "test", model: "test", emoji: "T", color: "#000000" }));
  }
  return { root, amqRoot };
}

function run(amqRoot, root, args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, AM_ME: "worker", AM_ROOT: amqRoot },
    encoding: "utf8", cwd: root,
  });
}

/** Every delivered message body in the recipient's inbox. */
function deliveredBodies(amqRoot) {
  const dir = path.join(amqRoot, "agents", "user", "inbox", "new");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
}

function attempt(fn) {
  try {
    return { code: 0, out: fn() };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

describe("an @file body that cannot be read refuses to send", () => {
  test("send exits non-zero and the recipient gets NOTHING", () => {
    // THE ARM. Under the old code: exit 0, a message id, a normal receipt, and the literal
    // pathname sitting in the recipient's inbox as the body.
    const { root, amqRoot } = makeRoot();
    const missing = path.join(root, "definitely-not-here.txt");
    assert.ok(!fs.existsSync(missing), "the control: the path really does not exist");

    const r = attempt(() => run(amqRoot, root, [
      "send", "--to", "user", "--subject", "should not ship", "--body", `@${missing}`,
    ]));
    assert.notEqual(r.code, 0, "must not exit 0");
    assert.equal(deliveredBodies(amqRoot).length, 0,
      "nothing may be delivered, and certainly not the pathname");
    assert.match(r.out, /Nothing was sent/,
      `the error must say that nothing was sent; got: ${r.out.trim()}`);
  });

  test("the refusal names the path, so the sender can see which file failed", () => {
    const { root, amqRoot } = makeRoot();
    const missing = path.join(root, "nope.txt");
    const r = attempt(() => run(amqRoot, root, [
      "send", "--to", "user", "--subject", "s", "--body", `@${missing}`,
    ]));
    assert.match(r.out, /nope\.txt/, "the failing path must appear in the error");
  });

  test("reply refuses identically - the path the coordinator did not test", () => {
    const { root, amqRoot } = makeRoot();
    // Send a real message first so there is an id to reply to.
    const sent = run(amqRoot, root, ["send", "--to", "user", "--subject", "hi", "--body", "hello"]);
    const id = (sent.match(/Sent (\S+) to/) || [])[1];
    assert.ok(id, `could not find a message id in: ${sent.trim()}`);

    const missing = path.join(root, "absent.txt");
    const r = attempt(() => run(amqRoot, root, [
      "reply", "--id", id, "--body", `@${missing}`,
    ]));
    assert.notEqual(r.code, 0, "reply must fail closed too");
    assert.match(r.out, /Nothing was sent/);
    // The original message is still the only one delivered.
    assert.equal(deliveredBodies(amqRoot).length, 1, "no reply may have been delivered");
  });
});

describe("a readable @file still works", () => {
  test("the body is the file's contents, not the path", () => {
    // The control for the whole file. A fix that made every @file fail would pass the three arms
    // above and be catastrophic, so the working path is asserted as loudly as the refusal.
    const { root, amqRoot } = makeRoot();
    const file = path.join(root, "reply.txt");
    fs.writeFileSync(file, "the real body, with a @ in it: @notafile\n");
    run(amqRoot, root, ["send", "--to", "user", "--subject", "s", "--body", `@${file}`]);

    const bodies = deliveredBodies(amqRoot);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /the real body, with a @ in it/);
    assert.doesNotMatch(bodies[0], /@\/tmp|@.*atfile-\w+\/reply\.txt/,
      "the path must not appear as the body");
  });

  test("a literal body beginning with a word, not @, is untouched", () => {
    // The doc now says a literal string is used as-is. That must remain true, or the fix has
    // broken ordinary sends.
    const { root, amqRoot } = makeRoot();
    run(amqRoot, root, ["send", "--to", "user", "--subject", "s", "--body", "plain text body"]);
    assert.match(deliveredBodies(amqRoot)[0], /plain text body/);
  });
});
