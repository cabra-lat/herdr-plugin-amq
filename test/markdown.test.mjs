import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, escapeHtml } from "../src/markdown.mjs";

test("escapeHtml escapes special characters safely", () => {
  assert.equal(escapeHtml('<script>alert("xss")&</script>'), "&lt;script&gt;alert(&quot;xss&quot;)&amp;&lt;/script&gt;");
  assert.equal(escapeHtml("a > b && c < d"), "a &gt; b &amp;&amp; c &lt; d");
});

test("GDScript comments inside fenced code blocks are never treated as headings", () => {
  const input = [
    "Here is the GDScript snippet:",
    "```gdscript",
    "# Check if target is valid and call range_hit",
    "## Documentation for class method",
    "### Sub-comment",
    "func _on_bullet_hit(body):",
    "    # Indented inner comment",
    "    if body.has_method('range_hit'):",
    "        body.range_hit()",
    "```",
  ].join("\n");

  const output = renderMarkdown(input);

  // Must contain code block wrapper and pre/code
  assert.ok(output.includes('<div class="code-block-wrapper">'));
  assert.ok(output.includes('<span class="code-lang">gdscript</span>'));
  assert.ok(output.includes("<code># Check if target is valid and call range_hit"));

  // Crucial check: MUST NOT contain heading tags for GDScript comments
  assert.equal(output.includes("<h1"), false, "Must not convert # comment to h1");
  assert.equal(output.includes("<h2"), false, "Must not convert ## doc comment to h2");
  assert.equal(output.includes("<h3"), false, "Must not convert ### sub-comment to h3");
});

test("Real headings in prose outside code blocks are properly formatted", () => {
  const input = [
    "# Project Status",
    "Intro paragraph text.",
    "## Verification Gates",
    "```bash",
    "# Run golden quick gate",
    "bash tools/verify-all.sh --quick",
    "```",
    "### Invariant Checks",
  ].join("\n");

  const output = renderMarkdown(input);

  // Prose headings must be converted
  assert.ok(output.includes('<h1 class="md-h1">Project Status</h1>'));
  assert.ok(output.includes('<h2 class="md-h2">Verification Gates</h2>'));
  assert.ok(output.includes('<h3 class="md-h3">Invariant Checks</h3>'));

  // Code comment must remain inside code and NOT be converted to h1
  assert.ok(output.includes("# Run golden quick gate"));
  const h1Count = (output.match(/<h1/g) || []).length;
  assert.equal(h1Count, 1, "Only the prose heading should be h1");
});

test("Comments inside inline code are not treated as headings", () => {
  const input = "Use `# godot-lock.sh` before running headless imports.";
  const output = renderMarkdown(input);

  assert.ok(output.includes('<code class="inline-code"># godot-lock.sh</code>'));
  assert.equal(output.includes("<h1"), false);
});

test("Code with math operators and asterisks does not produce italic/bold tags inside code blocks", () => {
  const input = [
    "```python",
    "# Exponentiation and pointer arithmetic",
    "result = 2 ** 8 * 10",
    "def func(*args, **kwargs):",
    "    return len(args) * len(kwargs)",
    "```",
  ].join("\n");

  const output = renderMarkdown(input);

  assert.ok(output.includes("result = 2 ** 8 * 10"));
  assert.ok(output.includes("def func(*args, **kwargs):"));
  assert.equal(output.includes("<strong>"), false);
  assert.equal(output.includes("<em>"), false);
  assert.equal(output.includes("<h1"), false);
});

test("GDScript node paths with dollar signs are not corrupted by regex replacements", () => {
  const input = [
    "```gdscript",
    "# Node path lookups",
    "var cam = $Camera3D",
    "var pivot = $Head/Pivot",
    "```",
  ].join("\n");

  const output = renderMarkdown(input);

  assert.ok(output.includes("var cam = $Camera3D"));
  assert.ok(output.includes("var pivot = $Head/Pivot"));
  assert.equal(output.includes("<h1"), false);
});

test("Unclosed code blocks at end of message are safely handled", () => {
  const input = [
    "Partial transmission:",
    "```gdscript",
    "# Trailing block without closing backticks",
    "var speed = 250.0",
  ].join("\n");

  const output = renderMarkdown(input);

  assert.ok(output.includes('<div class="code-block-wrapper">'));
  assert.ok(output.includes("# Trailing block without closing backticks"));
  assert.equal(output.includes("<h1"), false);
});

test("Blockquotes in prose are rendered correctly", () => {
  const input = "> Ack, running verification now.\n> Will report back shortly.";
  const output = renderMarkdown(input);

  assert.ok(output.includes('<blockquote class="md-quote">Ack, running verification now.<br>Will report back shortly.</blockquote>'));
});

test("Markdown tables are rendered properly with alignments", () => {
  const input = [
    "| Agent | Status | Unread |",
    "| :--- | :---: | ---: |",
    "| spotter | active | 0 |",
    "| coordinator | idle | 3 |",
  ].join("\n");

  const output = renderMarkdown(input);

  assert.ok(output.includes('<table class="md-table">'));
  assert.ok(output.includes('<th style="text-align: left">Agent</th>'));
  assert.ok(output.includes('<th style="text-align: center">Status</th>'));
  assert.ok(output.includes('<th style="text-align: right">Unread</th>'));
  assert.ok(output.includes('<td style="text-align: left">spotter</td>'));
});
