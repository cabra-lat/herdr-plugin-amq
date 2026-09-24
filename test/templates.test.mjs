import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLocalTemplate, renderLocalTemplate, renderTemplate } from "../src/templates.mjs";

describe("local prompt templates", () => {
  test("renders scalar dotted variables without recursive replacement", () => {
    const source = "Agent {{ agent.handle }} has {{ board.blocked }} blocked from {{ mail.senders }}";
    const context = {
      agent: { handle: "range" },
      board: { blocked: 3 },
      mail: { senders: "$&" },
    };
    assert.equal(renderTemplate(source, context), "Agent range has 3 blocked from $&");
    assert.equal(
      renderTemplate("{{ mail.senders }}", { mail: { senders: "{{ agent.handle }}" } }),
      "{{ agent.handle }}",
    );
  });

  test("rejects unsupported or missing variables", () => {
    assert.throws(() => renderTemplate("{{ agent.handle | upper }}", { agent: { handle: "range" } }));
    assert.throws(() => renderTemplate("{% include \"/etc/passwd\" %}", {}));
    assert.throws(() => renderTemplate("{# comment #}", {}));
    assert.throws(() => renderTemplate("{{ constructor }}", {}));
    assert.throws(() => renderTemplate("{{ agent.missing }}", { agent: { handle: "range" } }));
    assert.throws(() => renderTemplate("{{ agent.handle", { agent: { handle: "range" } }));
    assert.throws(() => renderTemplate("{{ agent.handle }}}", { agent: { handle: "range" } }));
    assert.throws(() => renderTemplate("{{ agent.handle }}", { agent: { handle: {} } }));
  });

  test("loads fixed local templates and sees edits on the next load", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "amq-template-test-"));
    const templates = path.join(root, "templates");
    try {
      fs.mkdirSync(templates);
      const welcomePath = path.join(templates, "welcome.md");
      fs.writeFileSync(welcomePath, "Welcome {{ agent.handle }}\n");
      const first = loadLocalTemplate(root, "welcome");
      assert.equal(first.source, "Welcome {{ agent.handle }}\n");
      assert.match(first.sha256, /^[a-f0-9]{64}$/);

      fs.writeFileSync(welcomePath, "Hello {{ agent.name }}\n");
      const second = loadLocalTemplate(root, "welcome");
      assert.equal(second.source, "Hello {{ agent.name }}\n");
      assert.equal(loadLocalTemplate(root, "../welcome"), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses safe fallback for missing or invalid templates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "amq-template-fallback-"));
    const templates = path.join(root, "templates");
    try {
      assert.deepEqual(renderLocalTemplate(root, "doorbell", {}, "fallback"), {
        text: "fallback",
        source: "fallback",
        path: null,
        sha256: null,
      });

      fs.mkdirSync(templates);
      fs.writeFileSync(path.join(templates, "doorbell.md"), "Hello {{ missing.value }}\n");
      const invalid = renderLocalTemplate(root, "doorbell", {}, "fallback");
      assert.equal(invalid.text, "fallback");
      assert.equal(invalid.source, "fallback");
      assert.equal(invalid.sha256, null);
      assert.equal(invalid.path, null);

      const oversizedFallback = renderLocalTemplate(root, "welcome", {}, "x".repeat(70 * 1024));
      assert.ok(Buffer.byteLength(oversizedFallback.text) <= 64 * 1024);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects empty, oversized, and symlinked templates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "amq-template-security-"));
    const templates = path.join(root, "templates");
    try {
      fs.mkdirSync(templates);
      const welcomePath = path.join(templates, "welcome.md");
      fs.writeFileSync(welcomePath, "   ");
      assert.equal(loadLocalTemplate(root, "welcome"), null);

      fs.writeFileSync(welcomePath, "x".repeat(64 * 1024 + 1));
      assert.equal(loadLocalTemplate(root, "welcome"), null);

      const outside = path.join(root, "outside.md");
      fs.writeFileSync(outside, "outside");
      fs.unlinkSync(welcomePath);
      fs.symlinkSync(outside, welcomePath);
      assert.equal(loadLocalTemplate(root, "welcome"), null);

      fs.unlinkSync(welcomePath);
      fs.linkSync(outside, welcomePath);
      assert.equal(loadLocalTemplate(root, "welcome"), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
