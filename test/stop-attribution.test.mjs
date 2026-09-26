// Bridge stop attempts must be ATTRIBUTED, not suppressed.
//
// The storm ran 23 restarts with no record of who sent the signals. The instinct after
// that is to disable the CLI stop path -- and that would convert a recurring, observable
// event into silence. These tests exist to make sure the log records the caller, records
// REFUSED attempts as well as allowed ones, and never becomes the reason a stop fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordStopAttempt, readStopLog, describeCaller, getStopLogFile } from "../src/stop-attribution.mjs";

// Static import + per-test state dir, matching the rest of the suite. A top-level
// `await import()` here made the module evaluate asynchronously, and node:test exited
// before running anything - a file that reports nothing is not a passing file.
let tmp;
let prevState;
function useTempState() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stopattr-"));
  prevState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = tmp;
}
function restoreState() {
  if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
  fs.rmSync(tmp, { recursive: true, force: true });
}

test("an attempt is recorded with a timestamp and a source", () => {
  useTempState();
  try {
    recordStopAttempt({ source: "cli:stop", pid: 1, outcome: "requested" });
    const [row] = readStopLog();
    assert.equal(row.source, "cli:stop");
    assert.equal(row.outcome, "requested");
    assert.ok(Date.parse(row.at) > 0, "every record must carry a real timestamp");
  } finally {
    restoreState();
  }
});

test("a REFUSED attempt is recorded too - refusals are attempts", () => {
  useTempState();
  try {
    // If only successful stops were logged, a caller polling a supervised daemon would
    // leave no trace at all, and "no log entries" would read as "nobody called".
    recordStopAttempt({ source: "http:toggle", pid: 42, outcome: "refused-supervised" });
    assert.ok(
      readStopLog().some((r) => r.outcome === "refused-supervised"),
      "refusal must be visible"
    );
  } finally {
    restoreState();
  }
});

// The server path is what the coordinator actually asked for, and no test exercised it -
// the unit test above only proves recordStopAttempt() can store an outcome, not that the
// endpoint ever calls it. This posts to the real endpoint and reads the real file.
test("the toggle endpoint records the caller, including refusals", async () => {
  useTempState();
  let server;
  try {
    const { startWebServer } = await import("../src/server.mjs");
    server = startWebServer({ port: 0, amqRoot: path.join(tmp, "mail") });
    await new Promise((r) => server.once("listening", r));
    const port = server.address().port;

    const res = await fetch(`http://127.0.0.1:${port}/api/bridge/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, "X-AGmail-Doorbell": "1" },
      body: "{}",
    });
    await res.json();

    // No daemon is running, so this takes the start branch. Either way the toggle must
    // have been ATTRIBUTED: a call that leaves no record is how tonight started.
    const onDisk = fs.existsSync(getStopLogFile())
      ? fs.readFileSync(getStopLogFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const viaHttp = onDisk.filter((r) => r.source === "http:toggle");
    assert.ok(viaHttp.length > 0, "a toggle call must leave an attributed record");
    assert.ok(viaHttp.at(-1).pid > 0, "the record must name a pid");
    assert.ok(viaHttp.at(-1).remoteAddress, "the record must name the peer");
  } finally {
    server?.close();
    restoreState();
  }
});

test("HTTP attempts record the peer address and Origin", () => {
  useTempState();
  try {
    recordStopAttempt({ source: "http:toggle", remoteAddress: "127.0.0.1", origin: "http://127.0.0.1:8505" });
    const row = readStopLog().at(-1);
    assert.equal(row.remoteAddress, "127.0.0.1");
    assert.equal(row.origin, "http://127.0.0.1:8505");
  } finally {
    restoreState();
  }
});

test("describeCaller names the process: pid, ppid, argv, cwd", () => {
  const c = describeCaller({ pid: process.pid, source: "test" });
  assert.equal(c.pid, process.pid);
  assert.equal(typeof c.ppid, "number");
  assert.ok(Array.isArray(c.argv) && c.argv.length > 0, "argv must be read from /proc");
  assert.ok(c.cwd, "cwd must be read from /proc");
});

test("an unreadable /proc entry yields nulls, not a throw", () => {
  useTempState();
  try {
    // A dead pid is the normal case mid-hunt; attribution must degrade, not crash.
    const c = describeCaller({ pid: 999999, source: "test" });
    assert.equal(c.pid, 999999);
    assert.equal(c.argv, null);
    assert.doesNotThrow(() => recordStopAttempt({ ...c, outcome: "requested" }));
  } finally {
    restoreState();
  }
});

test("the log is bounded - a hunt that never ends must not grow it without limit", () => {
  useTempState();
  try {
    for (let i = 0; i < 260; i++) recordStopAttempt({ source: "cli:stop", n: i });
    // Read the FILE, not readStopLog(): the reader caps its own output at MAX_LINES, so
    // asserting through it measures the reader and stays green even with the write-side
    // truncation removed. The first version of this test did exactly that and could not
    // fail.
    const onDisk = fs.readFileSync(getStopLogFile(), "utf8").split("\n").filter(Boolean);
    assert.ok(onDisk.length <= 200, `expected a bounded file, got ${onDisk.length}`);
    assert.equal(JSON.parse(onDisk.at(-1)).n, 259, "the newest record must survive truncation");
  } finally {
    restoreState();
  }
});

test("attribution never becomes the reason a stop fails", () => {
  useTempState();
  try {
    // Point the state dir at a path that cannot be created. It must be a path whose
    // PARENT IS A REGULAR FILE, not something exotic: getStateDir() mkdirs whatever it
    // is handed, and `mkdirSync("/proc/…", {recursive:true})` does not fail - it HANGS,
    // which silently hung the whole runner and reported zero tests. A test that makes
    // the harness disappear is worse than a test that fails.
    const blocker = path.join(tmp, "not-a-directory");
    fs.writeFileSync(blocker, "x", "utf8");
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(blocker, "state");
    assert.doesNotThrow(() => recordStopAttempt({ source: "cli:stop" }));
  } finally {
    restoreState();
  }
});

test("reading an absent log returns an empty list, not an error", () => {
  useTempState();
  try {
    fs.rmSync(getStopLogFile(), { force: true });
    assert.deepEqual(readStopLog(), []);
  } finally {
    restoreState();
  }
});
