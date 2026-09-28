#!/usr/bin/env node
// THE TEMPLATE WRITER, OVER HTTP, AGAINST A REAL SERVER.
//
// The card asked for a doorbell editor. The loader could always read a template; nothing could
// write one, so the dashboard had nothing to show. This covers the two routes that close that
// gap, through the wire, because the failure mode of a writer is a save that reports success and
// does not take effect - and a unit test of the writer function cannot see that.
//
// Three properties are worth more than the happy path:
//   - a REFUSED write must not damage the template that is already there
//   - the loader must actually render what the route saved
//   - removing must restore the built-in default, because "I want the default back" is a normal
//     request and an empty template is correctly refused as empty
//
// Isolated on both boundaries: HERDR_PLUGIN_STATE_DIR and AM_ROOT. The live dashboard is serving
// right now and a test that wrote to it would edit a real mailbox.
//
// Run: node test/template-writer-routes.test.mjs

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWebServer } from "../src/server.mjs";
import { loadLocalTemplate } from "../src/templates.mjs";

let tempRoot;
let server;
let baseUrl;
let amqRoot;
const saved = {};

before(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-routes-"));
  amqRoot = path.join(tempRoot, ".agent-mail");
  fs.mkdirSync(path.join(amqRoot, "bus"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "state"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "config"), { recursive: true });

  for (const k of ["HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_CONFIG_DIR", "HERDR_SOCKET_PATH", "AM_ROOT"]) {
    saved[k] = process.env[k];
  }
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(tempRoot, "state");
  process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(tempRoot, "config");
  process.env.HERDR_SOCKET_PATH = path.join(tempRoot, "missing-herdr.sock");
  process.env.AM_ROOT = amqRoot;

  // startWebServer is SYNCHRONOUS and takes amqRoot as an argument; it does not read AM_ROOT for
  // its own argument default at call time in the way I assumed, and awaiting it yields the
  // function's own return value's `then`, which is not a server - hence the null deref on
  // `address()`. The port comes from the listening event, not from the return.
  server = startWebServer({ port: 0, host: "127.0.0.1", amqRoot });
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const get = (name) => fetch(`${baseUrl}/api/templates/${name}`);
const put = (name, source) =>
  fetch(`${baseUrl}/api/templates/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  });

test("GET reports the vocabulary and that nothing is deployed yet", async () => {
  const r = await get("doorbell");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.exists, false, "nothing is deployed in a fresh mailbox");
  assert.equal(body.source, null);
  assert.ok(
    body.variables.includes("mail.count"),
    "the editor needs the vocabulary to offer it, and it must be the real one",
  );
});

test("a valid template saves, is read back, and is rendered by the LOADER", async () => {
  const source = "HEY {{agent.handle}} - {{mail.count}} from {{mail.senders}}";
  const putRes = await put("doorbell", source);
  const putBody = await putRes.text();
  assert.equal(putRes.status, 200, `a legal template must save: ${putBody}`);

  const readBack = await (await get("doorbell")).json();
  assert.equal(readBack.exists, true);
  assert.equal(readBack.source, source, "what came back must be what was written, byte for byte");

  // The point of the whole exercise: the BRIDGE reads templates, not the route. If the loader
  // cannot see it, the doorbell silently keeps using the built-in text and the save "worked".
  const loaded = loadLocalTemplate(amqRoot, "doorbell");
  assert.ok(loaded?.source, "the loader must find the file the route wrote");
  assert.equal(loaded.source, source);
});

test("a refused write returns 400 with the problem AND leaves the good template intact", async () => {
  // The reason this test exists rather than only the success case: a writer that truncates
  // before it validates would turn a typo into a doorbell that is broken for every lane.
  const before = (await (await get("doorbell")).json()).source;
  const r = await put("doorbell", "{{mail.countt}} new");
  assert.equal(r.status, 400, "a typo must be refused");
  const body = await r.json();
  assert.equal(body.written, false);
  assert.ok(
    body.problems.some((p) => p.kind === "unknown_variable"),
    `expected an unknown_variable problem, got ${JSON.stringify(body.problems)}`,
  );
  const after = (await (await get("doorbell")).json()).source;
  assert.equal(after, before, "the previously saved template must survive a refused write");
});

test("a name outside ALLOWED_TEMPLATES is refused", async () => {
  const r = await put("evil", "hello");
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.written, false);
  assert.match(JSON.stringify(body), /not an editable template/);
});

test("an empty source REMOVES the template and restores the built-in default", async () => {
  // Not "saves an empty file". An empty template is refused as empty, correctly, so without this
  // an operator who disliked their template would have no way back to the default but a shell.
  const r = await put("doorbell", "   ");
  // Read the body ONCE. The first version put `await r.text()` inside the assert message and then
  // called r.json() on the same response, which throws "Body is unusable" - a fetch detail that
  // has nothing to do with the code under test and cost a run to diagnose.
  const body = await r.json();
  assert.equal(r.status, 200, `removal must succeed: ${JSON.stringify(body)}`);
  assert.equal(body.removed, true);
  assert.equal(loadLocalTemplate(amqRoot, "doorbell"), null, "the loader must fall back to the built-in text");
  const readBack = await (await get("doorbell")).json();
  assert.equal(readBack.exists, false, "and the editor must now show the default state");
});

test("removing when nothing is deployed is not an error", async () => {
  const r = await put("doorbell", "");
  assert.equal(r.status, 200, "the caller wanted the default and the default is what they have");
  const body = await r.json();
  assert.equal(body.removed, false);
  assert.match(body.reason, /no template was deployed/);
});

test("a missing source field is refused rather than treated as a removal", async () => {
  // Distinct from an empty string, and the distinction matters: `{}` is a malformed request,
  // `""` is a deliberate removal. Treating the first as the second would let a UI bug silently
  // delete somebody's template.
  const r = await fetch(`${baseUrl}/api/templates/doorbell`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notSource: "oops" }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.written, false);
  assert.ok(body.problems.some((p) => p.kind === "no_source"));
});

test("a write with no body at all is refused, not read as a removal", async () => {
  const r = await fetch(`${baseUrl}/api/templates/doorbell`, { method: "PUT" });
  assert.ok(r.status === 400, `expected 400 for a bodyless write, got ${r.status}`);
});
