import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { clearOwnedDaemonRegistration, getLockHolder, getUnregisteredDaemon, healAgentName, startDaemonBackground } from "../src/bridge.mjs";

function runnerFactory({ panes, tabs }) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "list") {
      return JSON.stringify({ result: { panes } });
    }
    if (args[0] === "tab" && args[1] === "list") {
      return JSON.stringify({ result: { tabs } });
    }
    if (args[0] === "agent" && args[1] === "rename") {
      return JSON.stringify({ ok: true });
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  };
  return { run, calls };
}

const OPENCODE_PANE = {
  pane_id: "w4:p1G",
  tab_id: "w4:t1F",
  terminal_title: "OpenCode",
  terminal_title_stripped: "OpenCode",
};

test("heal matches legacy title pattern without touching tabs", () => {
  const panes = [{ ...OPENCODE_PANE, terminal_title_stripped: "fleet - range - opencode" }];
  const { run, calls } = runnerFactory({ panes, tabs: [] });
  assert.equal(healAgentName("range", false, run), true);
  assert.deepEqual(calls.at(-1), ["agent", "rename", "w4:p1G", "range"]);
  assert.ok(!calls.some((c) => c[0] === "tab"), "tab list must not be consulted");
});

test("heal matches the live Pi title without touching tabs", () => {
  const panes = [{ ...OPENCODE_PANE, terminal_title_stripped: "π - range", terminal_title: "π - range" }];
  const { run, calls } = runnerFactory({ panes, tabs: [] });
  assert.equal(healAgentName("range", false, run), true);
  assert.deepEqual(calls.at(-1), ["agent", "rename", "w4:p1G", "range"]);
  assert.ok(!calls.some((c) => c[0] === "tab"), "tab list must not be consulted");
});

test("heal falls back to exact tab label when title is overwritten", () => {
  const panes = [{ ...OPENCODE_PANE }];
  const tabs = [{ tab_id: "w4:t1F", label: "agsuite-dev" }];
  const { run, calls } = runnerFactory({ panes, tabs });
  assert.equal(healAgentName("agsuite-dev", false, run), true);
  assert.deepEqual(calls.at(-1), ["agent", "rename", "w4:p1G", "agsuite-dev"]);
});

test("heal skips multi-pane tabs as ambiguous", () => {
  const panes = [{ ...OPENCODE_PANE }, { ...OPENCODE_PANE, pane_id: "w4:p1H" }];
  const tabs = [{ tab_id: "w4:t1F", label: "agsuite-dev" }];
  const { run, calls } = runnerFactory({ panes, tabs });
  assert.equal(healAgentName("agsuite-dev", false, run), false);
  assert.ok(!calls.some((c) => c[0] === "agent"), "must not rename an ambiguous pane");
});

test("heal returns false when neither title nor tab matches", () => {
  const panes = [{ ...OPENCODE_PANE }];
  const tabs = [{ tab_id: "w4:t1F", label: "something-else" }];
  const { run } = runnerFactory({ panes, tabs });
  assert.equal(healAgentName("missing-lane", false, run), false);
});

test("heal dry-run reports without renaming", () => {
  const panes = [{ ...OPENCODE_PANE }];
  const tabs = [{ tab_id: "w4:t1F", label: "agsuite-dev" }];
  const { run, calls } = runnerFactory({ panes, tabs });
  assert.equal(healAgentName("agsuite-dev", true, run), true);
  assert.ok(!calls.some((c) => c[0] === "agent"), "dry-run must not rename");
});

// The production incident, encoded as a test. On 2026-09-25 two bridge daemons ran
// for hours: `cleanup()` unlinked the pid file unconditionally, so stopping a
// superseded daemon deleted the LIVE daemon's registration, and the next
// `herdr-amq start` spawned a second one that nothing could stop. Killing a pid
// would not have fixed it; only the singleton lock does.
function countDaemons() {
  const out = spawnSync("sh", [
    "-c",
    "for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null) || continue; " +
      "case \"$c\" in *'herdr-amq.mjs bridge-daemon'*) case \"$c\" in *bash*) ;; *) echo ${p#/proc/};; esac;; esac; done",
  ], { encoding: "utf8" });
  return out.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

test("a lost pid file no longer produces a second daemon", { timeout: 60000 }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-singleton-"));
  // The daemon refuses to run without a queue root, so give it a real one.
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-singleton-queue-"));
  fs.mkdirSync(path.join(queueDir, ".agent-mail", "agents"), { recursive: true });
  fs.mkdirSync(path.join(queueDir, ".agent-mail", "bus", "backlog"), { recursive: true });
  const prevState = process.env.HERDR_PLUGIN_STATE_DIR;
  const prevAmRoot = process.env.AM_ROOT;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
  process.env.AM_ROOT = path.join(queueDir, ".agent-mail");
  let first = null;
  try {
    first = startDaemonBackground();
    assert.equal(first.ok, true, `first start failed: ${first.error}`);
    await new Promise((r) => setTimeout(r, 1500));

    const afterFirst = countDaemons();
    assert.ok(afterFirst.length >= 1, "no daemon running after first start");

    // Reproduce the production condition: the pid file disappears while a daemon
    // is still alive. This is the only input the old guard consulted.
    fs.unlinkSync(path.join(stateDir, "bridge.pid"));

    const second = startDaemonBackground();
    assert.notEqual(second.ok, true, "a second daemon must be refused when the lock is held");
    assert.match(second.error, /singleton lock/i);
    await new Promise((r) => setTimeout(r, 1500));

    const afterSecond = countDaemons();
    assert.equal(
      afterSecond.length,
      afterFirst.length,
      `daemon count grew from ${afterFirst.length} to ${afterSecond.length} (${afterSecond.join(",")})`,
    );

    // The lock holder is discoverable even with no pid file, so the daemon is
    // still stoppable rather than invisible.
    const holder = getLockHolder();
    assert.ok(holder && afterFirst.includes(String(holder)), `lock holder ${holder} not among ${afterFirst.join(",")}`);
    const unregistered = getUnregisteredDaemon();
    assert.ok(unregistered, "the missing pid file must be reported as a divergence");
    assert.equal(unregistered.lockHolder, holder);
  } finally {
    if (first?.pid) { try { process.kill(first.pid, "SIGTERM"); } catch {} }
    await new Promise((r) => setTimeout(r, 800));
    for (const pid of countDaemons()) { try { process.kill(Number(pid), "SIGTERM"); } catch {} }
    process.env.HERDR_PLUGIN_STATE_DIR = prevState;
    if (prevAmRoot === undefined) delete process.env.AM_ROOT; else process.env.AM_ROOT = prevAmRoot;
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(queueDir, { recursive: true, force: true });
  }
});

test("a daemon's cleanup never removes a registration owned by another process", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ownership-"));
  const prev = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
  try {
    const pidFile = path.join(stateDir, "bridge.pid");
    const lockFile = path.join(stateDir, "bridge.lock");

    // The live daemon owns both files.
    fs.writeFileSync(pidFile, "4242", "utf8");
    fs.writeFileSync(lockFile, "4242", "utf8");

    // A superseded daemon (pid 1111) is stopped. Its cleanup must not touch the
    // live daemon's registration: this is the exact step that made the live daemon
    // invisible to `herdr-amq stop` and let a duplicate start.
    const foreign = clearOwnedDaemonRegistration(1111);
    assert.equal(foreign.pidFileCleared, false, "a foreign pid must not clear the pid file");
    assert.equal(foreign.lockFileCleared, false, "a foreign pid must not clear the lock file");
    assert.equal(fs.readFileSync(pidFile, "utf8"), "4242", "the live daemon's pid file was deleted by a foreign cleanup");
    assert.equal(fs.readFileSync(lockFile, "utf8"), "4242", "the live daemon's lock file was cleared by a foreign cleanup");

    // The owner may remove its own registration, and the lock FILE is truncated
    // rather than unlinked because flock is held on the inode.
    const owner = clearOwnedDaemonRegistration(4242);
    assert.equal(owner.pidFileCleared, true);
    assert.equal(owner.lockFileCleared, true);
    assert.equal(fs.existsSync(pidFile), false);
    assert.equal(fs.existsSync(lockFile), true, "the lock file must survive its holder so flock keeps guarding the same inode");
    assert.equal(fs.readFileSync(lockFile, "utf8"), "");
  } finally {
    if (prev === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR; else process.env.HERDR_PLUGIN_STATE_DIR = prev;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
