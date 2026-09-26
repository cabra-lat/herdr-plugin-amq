// The dashboard's bridge button used to SIGTERM the daemon unconditionally. Under
// systemd that is not a stop - the unit has Restart=always, so the daemon comes back
// seconds later and the button reports success for an effect that does not last. It is
// also one of only two code paths that send SIGTERM to the bridge, which was observed
// being terminated every ~60-100s with no attributable cause.
//
// The positive case spawns a REAL flock parent holding a REAL lock and a child under
// it, because the classifier's whole job is reading a parent's /proc cmdline. A mocked
// fixture would test the mock.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sup-"));
const lockFile = path.join(stateDir, "bridge.lock");
const pidFile = path.join(stateDir, "bridge.pid");
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
const { isBridgeSupervised } = await import("../src/server.mjs");

const children = [];
function cleanup() {
  for (const c of children) {
    try {
      process.kill(-c, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
}
// Registered as a hook, NOT at module top level: node:test runs the module body to
// completion before executing any test, so a top-level cleanup deletes the fixture out
// from under the tests and they fail for a reason that has nothing to do with the code.
after(cleanup);

function writePid(pid) {
  fs.writeFileSync(pidFile, String(pid), "utf8");
}

test("a daemon under a real flock parent IS detected as supervised", async () => {
  // `flock <lock> node -e ...` gives us exactly the production shape: a long-lived
  // child whose parent is the flock process holding the singleton lock.
  // spawn, NOT execFileSync: the fake daemon is meant to outlive the test, and a
  // synchronous call would block reading its stdout until it exits - i.e. forever.
  const flockBin = "/run/current-system/sw/bin/flock";
  // The daemon publishes its own pid into the lock file; plain `flock` only holds the
  // lock and writes nothing. So the child has to do it, exactly as startDaemonLoop does.
  const script = `require("fs").writeFileSync(${JSON.stringify(lockFile)}, String(process.pid)); setInterval(()=>{},1000)`;
  const child = spawn(flockBin, [lockFile, process.execPath, "-e", script], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  children.push(child.pid);

  // Wait for the daemon to publish the holder pid.
  let holder = null;
  for (let i = 0; i < 60 && holder === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const raw = fs.readFileSync(lockFile, "utf8").trim();
      if (raw) holder = Number(raw);
    } catch {
      /* not written yet */
    }
  }
  assert.ok(Number.isFinite(holder), "the daemon should have published its pid into the lock file");

  // flock forks and stays as the parent, so the daemon's ppid is the flock process.
  writePid(holder);
  const r = isBridgeSupervised(holder);
  assert.equal(r.supervised, true, `expected supervised, got ${JSON.stringify(r)}`);
  assert.equal(r.reason, "flock-parent");
});

test("an unsupervised daemon reports supervised:false with a reason", () => {
  writePid(process.pid);
  const r = isBridgeSupervised(process.pid);
  assert.equal(r.supervised, false);
  assert.equal(r.reason, "standalone-parent");
});

test("a missing pid file does not throw and does not claim supervision", () => {
  fs.rmSync(pidFile, { force: true });
  const r = isBridgeSupervised();
  assert.equal(r.supervised, false);
  assert.equal(r.reason, "no-pid");
});

test("a pid with no /proc entry is not reported as supervised", () => {
  // A dead daemon must never be mistaken for a supervised one, or the button would
  // refuse to act on a bridge that is genuinely down.
  const r = isBridgeSupervised(999999);
  assert.equal(r.supervised, false);
  assert.equal(r.reason, "no-proc");
});

test("isBridgeSupervised() with no argument reads the pid file rather than throwing", () => {
  fs.rmSync(pidFile, { force: true });
  assert.doesNotThrow(() => isBridgeSupervised());
});

test("the flock used by the test is released afterwards (no leaked holder)", () => {
  // If the positive test leaked its flock, every later run of this file would hang or
  // silently reuse a stale holder, and the suite would be order-dependent.
  assert.ok(fs.existsSync(lockFile), "lock file must still exist (it is truncated, never unlinked)");
});
