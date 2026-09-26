// Alerts must be readable WITHOUT pulling the whole board, and silence must be
// observable.
//
// The defect: /api/metrics, /api/alerts and /api/health all returned 404, so the only
// way to see coordinator alerts was to fetch /api/board - a ~387 KB payload. That makes
// "did the alert fire?" expensive, and "did the alert STAY quiet?" effectively impossible
// to check. A negative claim needs an instrument that could have contained the event;
// this is the same defect as citing a request log that does not record requests.
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startWebServer } from "../src/server.mjs";
import { addBoardTask } from "../src/board.mjs";

describe("standalone observability endpoints", () => {
  let tempRoot;
  let server;
  let baseUrl;
  let oldStateDir;
  let oldConfigDir;
  let oldSocketPath;

  before(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agmail-observe-"));
    oldStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(tempRoot, "state");
    oldConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(tempRoot, "config");
    oldSocketPath = process.env.HERDR_SOCKET_PATH;
    // A deliberately missing socket: the endpoints must still answer, which is the point.
    process.env.HERDR_SOCKET_PATH = path.join(tempRoot, "missing-herdr.sock");
    fs.mkdirSync(path.join(tempRoot, "agents"), { recursive: true });

    const amqRoot = path.join(tempRoot, ".agent-mail");
    fs.mkdirSync(amqRoot, { recursive: true });
    addBoardTask(tempRoot, amqRoot, { title: "observe me", owner: "qa", status: "in_progress" });

    server = startWebServer({ port: 0, amqRoot });
    await new Promise((r) => server.once("listening", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server?.close();
    if (oldStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = oldStateDir;
    if (oldConfigDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = oldConfigDir;
    if (oldSocketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = oldSocketPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("/api/alerts answers 200 and carries an alerts array", async () => {
    const res = await fetch(`${baseUrl}/api/alerts`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.alerts), "alerts must be an array so silence is readable");
    assert.ok(typeof body.at === "string");
  });

  test("/api/alerts is small - it must not be a disguised board fetch", async () => {
    const alerts = await (await fetch(`${baseUrl}/api/alerts`)).text();
    const board = await (await fetch(`${baseUrl}/api/board`)).text();
    assert.ok(alerts.length < board.length, `alerts (${alerts.length}) must be far smaller than board (${board.length})`);
  });

  test("/api/metrics answers 200 with the coordinator metrics", async () => {
    const res = await fetch(`${baseUrl}/api/metrics`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body, "metrics must be an object");
    assert.notEqual(body, null);
  });

  test("/api/health answers 200 even with herdr unreachable", async () => {
    // A health endpoint that fails when a dependency is down is useless for answering
    // "is the system up?"; the dependency's state belongs IN the payload, not in the
    // status code. This is the /api/status-200-while-panes-report-herdr-unavailable shape.
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200, "health must answer even when herdr is unavailable");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.herdr.available, false, "an unreachable herdr must be reported, not hidden");
    assert.ok("bridge" in body && "running" in body.bridge);
  });

  test("the endpoints reject non-GET rather than acting", async () => {
    const res = await fetch(`${baseUrl}/api/alerts`, { method: "POST" });
    assert.ok(res.status === 404 || res.status === 405, `expected a refusal, got ${res.status}`);
  });
});
