import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The gate 5970ae4 needed and did not have.
 *
 * 5970ae4 added `loadBoard(repoRoot, amqRoot)` to the daemon's TICK, but `repoRoot` is declared
 * inside `runDoorbellPass` - a different function. Every pass therefore threw
 * "repoRoot is not defined", the try/catch around the tick swallowed it, and the daemon looked
 * perfectly alive while delivering nothing. The log filled with a repeating error and no alarm
 * went off.
 *
 * Why nothing caught it, which is the point of this file:
 *  - `node --check` only PARSES. A ReferenceError is not a syntax error.
 *  - A unit test on `buildCoordinatorMetricsWithWorkAge` stays green, because the bug is in the
 *    CALLER. The builder was never wrong.
 *  - The 721-test guard was green with the daemon dead on every pass.
 *
 * So this runs the ACTUAL DAEMON LOOP in a child process, from the working tree, and fails on a
 * repeating pass error. It is the cheapest test that would have caught it, and it is the shape
 * coordinator asked for: silence from a bridge that looks alive IS the defect.
 */
test("the daemon LOOP runs a pass without throwing - a swallowed ReferenceError is the failure", () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const bin = path.join(repo, "bin", "herdr-amq.mjs");

  // A throwaway queue, so this can never doorbell a real agent.
  const amqRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-gate-"));
  for (const h of ["coordinator", "agsuite-dev"]) {
    fs.mkdirSync(path.join(amqRoot, "agents", h), { recursive: true });
    fs.writeFileSync(path.join(amqRoot, "agents", h, "profile.json"), JSON.stringify({ handle: h }));
  }
  fs.mkdirSync(path.join(amqRoot, "bus"), { recursive: true });

  const res = spawnSync(process.execPath, [bin, "bridge-daemon", "--once", "--dry-run"], {
    cwd: repo, encoding: "utf8", timeout: 15_000,
    // ISOLATE THE PID FILE. The daemon records itself at getStateDir()/bridge.pid and
    // getStateDir() defaults to the REAL ~/.herdr-amq-state. Without this, a test daemon
    // overwrites the LIVE daemon pid file, and its cleanup unlinks it - which can stop the real
    // mail doorbell being recognised as already running, or let a second one start.
    // A test that reaches outside its own temp directories is not isolated, whatever AM_ROOT says.
    env: { ...process.env, AM_ROOT: amqRoot, HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "gate-state-")) },
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;

  // The specific regression, named rather than pattern-matched loosely.
  assert.equal(/repoRoot is not defined/.test(out), false,
    `the tick referenced repoRoot outside its scope:\n${out}`);

  // ANY pass error, because the swallowed-catch is the general failure mode here and the next
  // one will not be named repoRoot.
  assert.equal(/\[bridge\] Error in pass/.test(out), false,
    `a daemon pass threw and the try/catch swallowed it - the daemon would look alive while delivering nothing:\n${out}`);

  // And positively: the loop must actually have run a pass, or "no errors" is vacuous.
  assert.ok(/\[bridge\] AMQ Herdr Bridge started/.test(out), `the daemon never started:\n${out}`);
  assert.equal(res.status, 0, `the daemon exited ${res.status}:\n${out}`);
});

test("the daemon REPORTS which repo it resolved, so a wrong root is visible rather than inferred", () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const amqRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-gate2-"));
  for (const h of ["coordinator", "agsuite-dev"]) {
    fs.mkdirSync(path.join(amqRoot, "agents", h), { recursive: true });
    fs.writeFileSync(path.join(amqRoot, "agents", h, "profile.json"), JSON.stringify({ handle: h }));
  }
  fs.mkdirSync(path.join(amqRoot, "bus"), { recursive: true });
  const res = spawnSync(process.execPath, [path.join(repo, "bin", "herdr-amq.mjs"), "bridge-daemon", "--once", "--dry-run"],
    { cwd: repo, encoding: "utf8", timeout: 15_000, env: { ...process.env, AM_ROOT: amqRoot } });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  // Printed rather than merely computed. A repo root that is wrong is otherwise invisible until
  // citations silently resolve against nothing, which is the class of failure that looks fine.
  assert.ok(/\[bridge\] Repo: /.test(out), `the daemon does not report its resolved repo root:\n${out}`);
});

test("RED ARM: a ReferenceError inside the tick must fail this file, not slip through the catch", () => {
  // Proves the gate is real. The bug is reintroduced by shadowing a binding OUT OF SCOPE at the
  // point of use, exactly as 5970ae4 did, and the assertion is that a child process printing a
  // pass error is DETECTABLE. If this test could not distinguish the two states it would be the
  // kind of green that let the regression ship in the first place.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rederr-"));
  const script = path.join(scratch, "tick.mjs");
  fs.writeFileSync(script, `
    function runDoorbellPass() { const repoRoot = "scoped-elsewhere"; return repoRoot; }
    function tick() {
      try { return loadBoard(repoRoot); }            // ReferenceError: not in scope
      catch (err) { console.log("[bridge] Error in pass: " + err.message); }
    }
    function loadBoard() { return "ok"; }
    tick();
  `);
  const res = spawnSync(process.execPath, [script], { encoding: "utf8" });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  assert.ok(/Error in pass/.test(out), "the catch DOES swallow it - which is exactly why the gate asserts on the log");
  assert.ok(/Error in pass/.test(out) && !/not defined/.test(out) === false,
    "and the message names the missing binding, so the log line is specific enough to act on");
});
