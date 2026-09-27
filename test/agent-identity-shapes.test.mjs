import os from "node:os";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { mapHerdrAgentActivity } from "../src/herdr.mjs";

/**
 * A FAKE MORE PERMISSIVE THAN REALITY CANNOT FAIL.
 *
 * The e2e fixture emitted `name: ""` for a title-only agent, where the real server omits the
 * key entirely. The two behave identically for any truthiness test, and differently for any
 * test of PRESENCE - `if ("name" in agent)`, `agent.name !== undefined`,
 * `Object.keys(agent).includes("name")`. So the fixture was exercising code paths the real socket
 * never produces, and the pane tests were green against a shape that cannot occur.
 *
 * Making the fixture stricter did NOT turn anything red, which is the finding: nothing in the
 * production path branches on the key's presence, so the permissiveness was hiding nothing
 * today. It was one refactor away from hiding something, and the fixture would have been the
 * last place that showed it - because the fake, not the code, defined the input.
 *
 * So the arm that makes the strictness worth having is HERE: these cases are pinned directly,
 * against the real consumer, so the guarantee no longer depends on a fixture happening to be
 * honest.
 */

const base = {
  agent: "pi",
  model: { id: "space-bunny-free", providerID: "opencode", variant: "max" },
  agent_session: { agent: "pi", source: "herdr:pi", value: "ses_x" },
  agent_status: "idle",
  pane_id: "pane-1",
  workspace_id: "ws-1",
  tab_id: "tab-1",
  terminal_id: "term-1",
  terminal_title_stripped: "pi - spotter",
};

const KNOWN = ["spotter", "qa", "range"];

test("an ABSENT name falls through to the terminal title", () => {
  const a = mapHerdrAgentActivity({ ...base }, new Date().toISOString(), null, new Set(KNOWN));
  assert.equal(a?.herdrHandle, "spotter", "identity comes from the title, which is the point");
});

test("an EMPTY name behaves identically to an absent one", () => {
  // The fake used to send "" here. If these ever diverge, a consumer has started testing
  // presence rather than truthiness, and the fixture's permissiveness would be masking it.
  const absent = mapHerdrAgentActivity({ ...base }, new Date().toISOString(), null, new Set(KNOWN));
  const empty = mapHerdrAgentActivity({ ...base, name: "" }, new Date().toISOString(), null, new Set(KNOWN));
  const blank = mapHerdrAgentActivity({ ...base, name: "   " }, new Date().toISOString(), null, new Set(KNOWN));
  assert.equal(empty?.herdrHandle, absent?.herdrHandle, '"" must resolve exactly like absent');
  assert.equal(blank?.herdrHandle, absent?.herdrHandle, "whitespace must resolve exactly like absent");
});

test("a REAL name wins over the title", () => {
  // The one case where a title-only agent is NOT the answer, so a regression that always
  // preferred the title would pass every other arm in this file.
  const a = mapHerdrAgentActivity({ ...base, name: "qa" }, new Date().toISOString(), null, new Set(KNOWN));
  assert.equal(a?.herdrHandle, "qa", "an explicit name outranks the pane title");
});

test("the fixture no longer sends the field the real server omits", () => {
  // Guards the fake itself, so it cannot drift back to being more permissive. Reading the source
  // is deliberate: a unit test of the fixture's exports would pass against a shape the real
  // server does not produce, which is the whole problem restated.
  const src = readFileSync(
    path.join(import.meta.dirname, "..", "test", "e2e", "dashboard-fixture.mjs"), "utf8");
  const titleOnly = src.slice(src.indexOf("const titleOnlyAgent"));
  assert.ok(!/^\s*name:\s*"",?\s*$/m.test(titleOnly),
    "the title-only agent must omit `name`, exactly as the real server does");
});

// ─── stage directories vs the status field: two vocabularies, one card ─────────
//
// The live bus uses backlog/ blocked/ doing/ done/ queued/ for DIRECTORIES, and
// backlog blocked in_progress done queued for the STATUS field inside the card. A card reads
// `status: "in_progress"` while living in doing/. Coordinator measured all 433 live cards and
// found the mapping one-to-one with no violations, and confirmed bus/in_progress does not exist.
//
// WHY THIS NEEDS AN ARM RATHER THAN A COMMENT. resolveStageDir() has a fallback: if a bus has
// in_progress/ and lacks doing/, it returns in_progress. That fallback is what let MY OWN TEST
// BOARD adopt in_progress/ without anyone noticing, so the divergence between fixture and
// production was incidental rather than deliberate - and an incidental agreement is the state
// where a fixture quietly stops being able to catch a class of bug.
//
// The hazard is concrete: any code or repair that builds a path by string-substituting the
// status - bus/ + status - targets bus/in_progress, which does not exist and which nothing
// reads. That does not fail loudly; the write lands in a path with no reader and appears to
// have applied. Creating the directory on a miss is how a phantom stage appears and quietly
// absorbs writes.
test("the DIRECTORY vocabulary is doing/, and the status vocabulary is in_progress", async () => {
  const { STAGE_DIRS, resolveStageDir } = await import("../src/board.mjs");
  assert.equal(STAGE_DIRS.in_progress, "doing",
    "the mapping is the contract: in_progress LIVES in doing/");
  assert.ok(!("in_progress" in ["/"].concat(Object.values(STAGE_DIRS))),
    "and no stage directory is ever spelled in_progress on the live board");
});

test("a live-shaped bus resolves in_progress to doing/", async () => {
  const { resolveStageDir } = await import("../src/board.mjs");
  const bus = fs.mkdtempSync(path.join(os.tmpdir(), "bus-live-"));
  try {
    for (const d of ["backlog", "blocked", "doing", "done", "queued"]) fs.mkdirSync(path.join(bus, d));
    assert.equal(resolveStageDir(bus, "in_progress"), "doing",
      "a bus laid out like production puts an in_progress card in doing/");
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});

test("the in_progress/ fallback is asserted DELIBERATELY, not left incidental", async () => {
  const { resolveStageDir } = await import("../src/board.mjs");
  const bus = fs.mkdtempSync(path.join(os.tmpdir(), "bus-alt-"));
  try {
    fs.mkdirSync(path.join(bus, "in_progress"));
    assert.equal(resolveStageDir(bus, "in_progress"), "in_progress",
      "the fallback branch still works, and now it is a known behaviour with a name");
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});

test("and a bus with BOTH directories prefers doing/, which is the production shape", async () => {
  const { resolveStageDir } = await import("../src/board.mjs");
  const bus = fs.mkdtempSync(path.join(os.tmpdir(), "bus-both-"));
  try {
    fs.mkdirSync(path.join(bus, "doing"));
    fs.mkdirSync(path.join(bus, "in_progress"));
    assert.equal(resolveStageDir(bus, "in_progress"), "doing",
      "doing/ wins, so a stray empty in_progress/ cannot absorb writes");
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});
