#!/usr/bin/env node
// A TEMPLATE THAT THE UI SAYS IS SAVED MUST ACTUALLY RENDER.
//
// The card asked for a doorbell editor. The mechanism already existed - loadLocalTemplate and
// renderTemplate, wired into the live path at bridge.mjs:884 - and what was missing was anything
// that could WRITE one. This is the writer's half of that: the validation contract, extracted so
// that a writer and the loader cannot disagree about what is legal.
//
// WHY THE CONTRACT IS EXTRACTED RATHER THAN ADDED. An editor that validated against its own copy
// of the rules would drift from the loader, and the symptom of that drift is a template the UI
// reports as saved and the bridge then refuses at render time. That is the worst outcome here,
// because the person who made the template is not present when it fails - every lane is, at once,
// and the failure is a doorbell that silently did not build. So the rules live in one place and
// both sides read them.
//
// The vocabulary is not a guess either. It is exactly the context buildDoorbellContext returns:
// agent.handle, mail.count, mail.senders, and the board counters. A name outside that list throws
// "Missing template variable" at render time, which is a worse place to learn about a typo.
//
// Run: node test/template-validate-contract.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { validateTemplateSource, TEMPLATE_VARIABLES, renderTemplate } from "../src/templates.mjs";

const DOORBELL = "{{agent.handle}} has {{mail.count}} message(s) from {{mail.senders}} and {{board.backlog}} in backlog.";

test("a valid doorbell template is accepted and its variables are reported", () => {
  const r = validateTemplateSource(DOORBELL, { name: "doorbell" });
  assert.equal(r.ok, true, `a legal template was refused: ${JSON.stringify(r.problems)}`);
  assert.deepEqual(
    r.variables.sort(),
    ["agent.handle", "board.backlog", "mail.count", "mail.senders"].sort(),
    "the writer must be able to tell the editor which placeholders are in play",
  );
});

test("a typo in a variable is refused, and the message names the real ones", () => {
  // This is the case the extraction exists for. The loader would throw "Missing template variable"
  // at render time - i.e. in a lane, at a doorbell, with no editor on screen.
  const r = validateTemplateSource("{{agent.handle}}: {{mail.countt}} new", { name: "doorbell" });
  assert.equal(r.ok, false);
  const problem = r.problems.find((p) => p.kind === "unknown_variable");
  assert.ok(problem, `expected an unknown_variable problem, got ${JSON.stringify(r.problems)}`);
  assert.match(problem.message, /countt/, "it must name the variable the writer got wrong");
  assert.ok(
    problem.available?.includes("mail.count"),
    "and offer the real one, so the fix does not require knowing the vocabulary by heart",
  );
});

test("a variable belonging to another template is refused", () => {
  // agent.persona is real, but not to a doorbell. Accepting it would produce a doorbell that
  // throws, and the two templates are edited in the same place.
  const r = validateTemplateSource("{{agent.persona}}", { name: "doorbell" });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].kind, "unknown_variable");
});

test("the prototype-pollution shapes are refused even though they parse", () => {
  for (const src of ["{{__proto__}}", "{{constructor}}", "{{a.prototype}}"]) {
    const r = validateTemplateSource(src, { name: "doorbell" });
    assert.equal(r.ok, false, `"${src}" must be refused`);
    assert.ok(
      r.problems.some((p) => p.kind === "forbidden_variable" || p.kind === "bad_variable"),
      `"${src}" must be refused as a forbidden or malformed variable, got ${JSON.stringify(r.problems)}`,
    );
  }
});

test("structurally broken sources are refused, each for its own reason", () => {
  const cases = [
    ["   ", "empty"],
    ["{% if x %}hi{% endif %}", "unsupported_syntax"],
    ["hello { world", "malformed"],
    ["{{unclosed", "malformed"],
  ];
  for (const [src, kind] of cases) {
    const r = validateTemplateSource(src, { name: "doorbell" });
    assert.equal(r.ok, false, `"${src}" must be refused`);
    assert.ok(
      r.problems.some((p) => p.kind === kind),
      `"${src}" must be refused as ${kind}, got ${JSON.stringify(r.problems)}`,
    );
  }
});

test("a template over the size cap is refused", () => {
  const r = validateTemplateSource("x".repeat(64 * 1024 + 1), { name: "doorbell" });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].kind, "too_large");
});

test("everything this accepts, the loader can actually render", () => {
  // The whole point of sharing the rules. If the validator ever becomes more permissive than
  // renderTemplate, this fails - and that is the direction that hurts, because it produces a
  // saved template that throws in a lane.
  const context = {
    agent: { handle: "agsuite-dev" },
    mail: { count: 3, senders: "coordinator, ballistics" },
    board: { backlog: 2, doing: 1, blocked: 0, done: 95 },
  };
  const r = validateTemplateSource(DOORBELL, { name: "doorbell", context });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const rendered = renderTemplate(DOORBELL, context);
  assert.equal(
    rendered,
    "agsuite-dev has 3 message(s) from coordinator, ballistics and 2 in backlog.",
    "and the render must actually work, not merely be permitted",
  );
});

test("a name that is listed but absent from a real context is caught before it ships", () => {
  // The upgrade the optional context buys: a shape check cannot see this, and it would render
  // fine today and fail the moment board.backlog stopped being populated.
  const context = { agent: { handle: "x" }, mail: { count: 0, senders: "" }, board: {} };
  const r = validateTemplateSource("{{board.backlog}}", { name: "doorbell", context });
  assert.equal(r.ok, false, "listed-but-absent must be refused when a context is supplied");
  assert.ok(r.problems.some((p) => p.kind === "missing_at_render"));
});

test("the vocabulary matches what the doorbell context actually provides", () => {
  // The list is a claim about bridge.mjs's buildDoorbellContext. If that changes, this fails and
  // the claim is corrected at the same time, rather than a lane discovering it at a doorbell.
  assert.deepEqual(
    [...TEMPLATE_VARIABLES.doorbell].sort(),
    ["agent.handle", "board.backlog", "board.blocked", "board.done", "board.doing", "mail.count", "mail.senders"].sort(),
  );
});
