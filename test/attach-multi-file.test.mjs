import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * `herdr-amq send --attach a --attach b --attach c` reported success and delivered one file.
 *
 * CONFIRMED BY MEASUREMENT by coordinator from the CLI: three files in, ONE sha256 entry in the
 * delivered message, and the survivor was the first. In the user's case seven files were sent and
 * a single mp4 arrived - the dropped payloads were evidence somebody had asked for, so the failure
 * mode was a person concluding that work they were promised does not exist. That is worse than an
 * outright failure, because an outright failure is visible.
 *
 * The class is a SUCCESS SIGNAL THAT DOES NOT DEPEND ON THE THING IT REPORTS. Same shape as
 * godot-lock.sh printing "lock acquired" after a 900s timeout in which the command ran unlocked,
 * and as a gate printing "bot_direction ? checks" while passing.
 *
 * WHERE THE DEFECT ACTUALLY IS, because it is NOT where the report assumed. The report explicitly
 * declined to read the source of the flag handling. Having read it: the CLI parser was never the
 * problem - `getMultiArg` has accumulated repeated flags since the Maildir engine landed
 * (5be3cec), and it errors loudly on a value-less flag. `sendMaildirMessage` also loops over every
 * attachment. So both ends of the obvious path are correct, and the defect had to be found by
 * running it. The arms below are the ones that keep it found.
 *
 * The assertion is on the RECIPIENT's delivered message, by content, never on the sender's exit
 * code: a green that only checks `exit 0` is the defect it is supposed to catch.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "herdr-amq.mjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attach-multi-"));
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
    encoding: "utf8",
    cwd: root,
  });
}

/** Every attachment fingerprint recorded in what the RECIPIENT received. */
function deliveredShas(amqRoot) {
  const dir = path.join(amqRoot, "agents", "user", "inbox", "new");
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(/"sha256":\s*"([a-f0-9]{64})"/g)) out.push(m[1]);
  }
  return out;
}

function threeFiles(root) {
  const names = ["alpha.txt", "bravo.txt", "charlie.txt"];
  const bodies = ["first payload\n", "second payload\n", "third payload\n"];
  const paths = names.map((n, i) => {
    const p = path.join(root, n);
    fs.writeFileSync(p, bodies[i]);
    return p;
  });
  return { names, paths, shas: bodies.map((b) => sha(b)) };
}

describe("repeated --attach delivers EVERY file", () => {
  test("three repeated flags arrive as three attachments, by content", () => {
    // THE ARM. Against the defect this is 3 in, 1 out, survivor first.
    const { root, amqRoot } = makeRoot();
    const { paths, shas } = threeFiles(root);

    run(amqRoot, root, [
      "send", "--to", "user", "--subject", "bundle",
      "--body", "three files",
      "--attach", paths[0], "--attach", paths[1], "--attach", paths[2],
    ]);

    const got = deliveredShas(amqRoot);
    for (const want of shas) {
      assert.ok(got.includes(want),
        `every attached file must arrive; missing ${want.slice(0, 12)} (got ${got.length} of ${shas.length})`);
    }
    assert.equal(got.length, 3, "and no more than were sent");
  });

  test("the comma-separated form delivers every file too", () => {
    // The pre-existing spelling. A fix for the repeated-flag form that quietly broke this one
    // would halve the delivery rate while still looking correct on the new test.
    const { root, amqRoot } = makeRoot();
    const { paths, shas } = threeFiles(root);
    run(amqRoot, root, [
      "send", "--to", "user", "--subject", "csv bundle", "--body", "three files",
      "--attach", paths.join(","),
    ]);
    const got = deliveredShas(amqRoot);
    for (const want of shas) assert.ok(got.includes(want), `missing ${want.slice(0, 12)}`);
  });

  test("MIXED forms - repeated flags AND a comma list - deliver the union", () => {
    // The real shape of a human command line, and the case a findIndex-based parser loses.
    const { root, amqRoot } = makeRoot();
    const { paths, shas } = threeFiles(root);
    run(amqRoot, root, [
      "send", "--to", "user", "--subject", "mixed", "--body", "three files",
      "--attach", paths[0], "--attach", `${paths[1]},${paths[2]}`,
    ]);
    const got = deliveredShas(amqRoot);
    for (const want of shas) assert.ok(got.includes(want), `missing ${want.slice(0, 12)}`);
  });

  test("the count is reported, so a caller is not left to count by hand", () => {
    // A sender who cannot tell how many files went has no way to notice a short delivery except
    // by reading the recipient's inbox. The CLI already prints a summary; it must state the
    // attachment count, because "success" was the whole problem.
    //
    // The assertion is on an explicit phrase, and that specificity is the point: my first version
    // of this arm asserted /3/ against the send summary, which PASSED - because the timestamp in
    // the message id contains a 3. A vacuous arm is worse than a wrong one, because it reads as
    // coverage. Any looseness here and the arm would keep passing after the count is removed.
    const { root, amqRoot } = makeRoot();
    const { paths } = threeFiles(root);
    const out = run(amqRoot, root, [
      "send", "--to", "user", "--subject", "counted", "--body", "three files",
      "--attach", paths[0], "--attach", paths[1], "--attach", paths[2],
    ]);
    assert.match(out, /\b3 attachments?\b/i,
      `the summary must state that three files were sent; got: ${out.trim()}`);
  });

  test("a single attachment is stated as one, not as a bare count", () => {
    // The other direction: a count that only appears when it is large is a count nobody can rely
    // on. One file must be reported as one file.
    const { root, amqRoot } = makeRoot();
    const { paths } = threeFiles(root);
    const out = run(amqRoot, root, [
      "send", "--to", "user", "--subject", "one", "--body", "one file", "--attach", paths[0],
    ]);
    assert.match(out, /\b1 attachment\b/i, `got: ${out.trim()}`);
  });
});

describe("a send that cannot carry its payload fails loudly", () => {
  test("a valueless --attach exits non-zero and sends NOTHING", () => {
    // The other half of the acceptance: when the tool cannot do the thing, it must say so. An
    // exit 0 here is the same class of defect as a dropped file.
    const { root, amqRoot } = makeRoot();
    const { paths } = threeFiles(root);
    let code = 0;
    try {
      run(amqRoot, root, [
        "send", "--to", "user", "--subject", "broken", "--body", "x",
        "--attach", paths[0], "--attach",
      ]);
    } catch (e) {
      code = e.status;
    }
    assert.notEqual(code, 0, "a valueless flag must not exit 0");
  });

  test("a missing attachment file exits non-zero rather than reporting a partial send", () => {
    // The variant nobody had tested: the path is well-formed and the flag has a value, but the
    // file is not there. If that sends the other two and exits 0, the sender believes the
    // evidence was delivered.
    const { root, amqRoot } = makeRoot();
    const { paths } = threeFiles(root);
    let code = 0;
    try {
      run(amqRoot, root, [
        "send", "--to", "user", "--subject", "missing", "--body", "x",
        "--attach", paths[0], "--attach", path.join(root, "nope.txt"), "--attach", paths[2],
      ]);
    } catch (e) {
      code = e.status;
    }
    assert.notEqual(code, 0, "a missing file must not exit 0");
  });
});
