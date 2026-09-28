import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ALLOWED_TEMPLATES = new Set(["welcome", "doorbell"]);
const MAX_TEMPLATE_BYTES = 64 * 1024;
const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function normalizeScalar(value) {
  if (typeof value === "string") {
    return value
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/`/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  throw new Error("Template values must be finite scalars");
}

function boundedFallback(fallback) {
  const text = typeof fallback === "string" ? fallback : String(fallback ?? "");
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= MAX_TEMPLATE_BYTES ? text : bytes.subarray(0, MAX_TEMPLATE_BYTES).toString("utf8");
}

function resolveVariable(context, expression) {
  const key = expression.trim();
  if (!VARIABLE_PATTERN.test(key)) throw new Error(`Unsupported template variable: ${key}`);
  const segments = key.split(".");
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    throw new Error(`Unsupported template variable: ${key}`);
  }

  let value = context;
  for (const segment of segments) {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, segment)) {
      throw new Error(`Missing template variable: ${key}`);
    }
    value = value[segment];
  }
  return normalizeScalar(value);
}

/**
 * THE VARIABLE VOCABULARY a template may reference, per template name.
 *
 * The loader never needed this: it resolves whatever the source asks for and throws if the name
 * is unknown. A WRITER does, and an editor behind the writer does more still, because both have
 * to say "this placeholder is real" before a reader is told it will work. The contract was
 * implicit in the prompt builders that call renderTemplate, which is the wrong place for a
 * contract - the builders decide the shape and nothing recorded what they decided.
 *
 * Anything not listed here throws "Missing template variable" at render time, which surfaces to
 * a lane as a doorbell that silently failed to build. That is worse than refusing the write, and
 * it is why this list exists rather than a regex over names.
 */
export const TEMPLATE_VARIABLES = {
  doorbell: [
    "agent.handle",
    "mail.count",
    "mail.senders",
    "board.backlog",
    "board.doing",
    "board.blocked",
    "board.done",
  ],
  welcome: ["agent.handle", "agent.persona", "agent.role"],
};

/**
 * Validate a template WITHOUT rendering it, and return the problems found.
 *
 * This is deliberately the SAME rules the loader enforces, reached by a different door. An editor
 * validating against its own copy of the rules would drift from the loader, and the symptom of
 * that drift is a template the UI reports as saved and the bridge then refuses. A saved template
 * that will not render is the worst outcome available here, because the person who made it is not
 * present when it fails - every lane is.
 *
 * The optional context is what upgrades this from a shape check to a real one: given a context,
 * every referenced variable is resolved, which catches a name that is listed but absent.
 */
export function validateTemplateSource(source, { name, context } = {}) {
  const problems = [];
  if (typeof source !== "string" || !source.trim()) {
    return { ok: false, problems: [{ kind: "empty", message: "Template is empty" }] };
  }
  if (Buffer.byteLength(source, "utf8") > MAX_TEMPLATE_BYTES) {
    return {
      ok: false,
      problems: [{ kind: "too_large", message: "Template is larger than " + MAX_TEMPLATE_BYTES + " bytes" }],
    };
  }
  if (source.includes("{%") || source.includes("{#")) {
    problems.push({ kind: "unsupported_syntax", message: "Unsupported template syntax: {% and {# are not this template language" });
  }
  const withoutExpressions = source.replace(/{{([\s\S]*?)}}/g, "");
  if (withoutExpressions.includes("{") || withoutExpressions.includes("}")) {
    problems.push({ kind: "malformed", message: "Malformed template expression: a brace outside {{ }}" });
  }

  const referenced = [...source.matchAll(/{{([\s\S]*?)}}/g)].map((m) => m[1].trim());
  const allowed = name && TEMPLATE_VARIABLES[name] ? new Set(TEMPLATE_VARIABLES[name]) : null;
  const unknown = new Set();
  for (const key of referenced) {
    if (!VARIABLE_PATTERN.test(key)) {
      problems.push({ kind: "bad_variable", message: '"' + key + '" is not a valid variable name' });
      continue;
    }
    if (key.split(".").some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      problems.push({ kind: "forbidden_variable", message: '"' + key + '" is not an allowed variable' });
      continue;
    }
    if (allowed && !allowed.has(key)) unknown.add(key);
  }
  for (const key of unknown) {
    problems.push({
      kind: "unknown_variable",
      message: '"' + key + '" is not available to the ' + name + " template",
      available: allowed ? [...allowed] : undefined,
    });
  }

  if (context) {
    for (const key of new Set(referenced)) {
      try {
        resolveVariable(context, key);
      } catch (e) {
        problems.push({ kind: "missing_at_render", message: e.message });
      }
    }
  }
  return { ok: problems.length === 0, problems, variables: [...new Set(referenced)] };
}

/**
 * Where a template lives, and whether that location is safe to write to.
 *
 * The loader does its own version of this check on every read: it refuses a templates directory
 * that is a symlink, and compares the realpath against the literal path so a link cannot redirect
 * a write somewhere else. A writer MUST make the same judgement, in the same place, or the two
 * halves disagree about where the file is - and the failure is a template saved in one directory
 * and read from another, which looks exactly like the template silently not being there.
 *
 * Returns null when the location is unusable, with a reason, rather than throwing: the caller
 * turns that into a 4xx with a sentence a person can act on.
 */
export function templateWriteTarget(amqRoot, name) {
  if (!amqRoot) return { error: "no mailbox is selected" };
  if (!ALLOWED_TEMPLATES.has(name)) {
    return { error: `"${name}" is not an editable template`, allowed: [...ALLOWED_TEMPLATES] };
  }
  let root;
  try {
    root = fs.realpathSync(path.resolve(amqRoot));
  } catch {
    return { error: "the mailbox directory does not exist" };
  }
  const templateDir = path.join(root, "templates");
  if (fs.existsSync(templateDir)) {
    let stat;
    try {
      stat = fs.lstatSync(templateDir);
    } catch {
      return { error: "the templates directory could not be read" };
    }
    // A symlink here is refused for the same reason the loader refuses it: it is a way to make a
    // write land outside the mailbox, and a write is more dangerous than a read.
    if (stat.isSymbolicLink()) return { error: "the templates directory is a symlink and will not be written through" };
    let realDir;
    try {
      realDir = fs.realpathSync(templateDir);
    } catch {
      return { error: "the templates directory could not be resolved" };
    }
    if (realDir !== templateDir) return { error: "the templates directory resolves elsewhere and will not be written to" };
  } else {
    try {
      fs.mkdirSync(templateDir, { recursive: false });
    } catch (e) {
      return { error: `the templates directory could not be created: ${e.code || e.message}` };
    }
  }
  return { templateDir, templatePath: path.join(templateDir, `${name}.md`) };
}

/**
 * Validate and then write a template. Returns the validation problems instead of writing, so a
 * refused template never reaches disk and never reaches a lane.
 *
 * The write is atomic: a temporary file in the same directory, then a rename. A doorbell can be
 * emitted at any moment by the bridge, and a half-written template would be read as a broken one
 * - which is a doorbell that fails to build for every lane, from a file that is briefly short.
 */
export function saveLocalTemplate(amqRoot, name, source) {
  const validation = validateTemplateSource(source, { name });
  if (!validation.ok) return { ok: false, written: false, ...validation };

  const target = templateWriteTarget(amqRoot, name);
  if (target.error) return { ok: false, written: false, problems: [{ kind: "unsafe_location", message: target.error }], allowed: target.allowed };

  const tmp = `${target.templatePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, source, { mode: 0o644 });
    fs.renameSync(tmp, target.templatePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* the temp file is best-effort cleanup */ }
    return { ok: false, written: false, problems: [{ kind: "write_failed", message: e.message }] };
  }
  return { ok: true, written: true, path: target.templatePath, variables: validation.variables };
}

/** Read a template for editing. Returns null source when none is deployed yet. */
export function readLocalTemplate(amqRoot, name) {
  const loaded = loadLocalTemplate(amqRoot, name);
  return {
    name,
    source: loaded?.source ?? null,
    exists: Boolean(loaded?.source),
    variables: TEMPLATE_VARIABLES[name] || [],
  };
}

/**
 * Remove a deployed template, restoring the built-in text.
 *
 * Removal is not the same as writing an empty file, and the difference matters. An empty template
 * is REFUSED by the validator - correctly, because an empty doorbell is a doorbell that tells a
 * lane nothing - so without a remove path an operator who disliked their template would have no
 * way back to the default except deleting the file by hand. "I want the default back" is a normal
 * request and it must not require a shell.
 */
export function removeLocalTemplate(amqRoot, name) {
  const target = templateWriteTarget(amqRoot, name);
  if (target.error) return { ok: false, removed: false, problems: [{ kind: "unsafe_location", message: target.error }] };
  if (!fs.existsSync(target.templatePath)) {
    // Already on the default. Reported as ok, because the caller wanted the default and the
    // default is what they now have; an error here would make a UI show a failure for the state
    // the user asked for.
    return { ok: true, removed: false, reason: "no template was deployed" };
  }
  try {
    fs.unlinkSync(target.templatePath);
  } catch (e) {
    return { ok: false, removed: false, problems: [{ kind: "remove_failed", message: e.message }] };
  }
  return { ok: true, removed: true, path: target.templatePath };
}

export function renderTemplate(source, context) {
  if (typeof source !== "string" || !source.trim()) throw new Error("Template is empty");
  if (Buffer.byteLength(source, "utf8") > MAX_TEMPLATE_BYTES) throw new Error("Template is too large");

  if (source.includes("{%") || source.includes("{#")) throw new Error("Unsupported template syntax");
  const withoutExpressions = source.replace(/{{([\s\S]*?)}}/g, "");
  if (withoutExpressions.includes("{") || withoutExpressions.includes("}")) {
    throw new Error("Malformed template expression");
  }

  const rendered = source.replace(/{{([\s\S]*?)}}/g, (_, expression) => String(resolveVariable(context, expression)));
  if (Buffer.byteLength(rendered, "utf8") > MAX_TEMPLATE_BYTES) throw new Error("Rendered template is too large");
  return rendered;
}

export function loadLocalTemplate(amqRoot, name) {
  if (!amqRoot || !ALLOWED_TEMPLATES.has(name)) return null;

  try {
    const root = fs.realpathSync(path.resolve(amqRoot));
    const templateDir = path.join(root, "templates");
    const dirStat = fs.lstatSync(templateDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;

    const realTemplateDir = fs.realpathSync(templateDir);
    if (realTemplateDir !== templateDir) return null;

    const templatePath = path.join(templateDir, `${name}.md`);
    const realTemplatePath = fs.realpathSync(templatePath);
    if (path.dirname(realTemplatePath) !== realTemplateDir) return null;

    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const fd = fs.openSync(templatePath, fs.constants.O_RDONLY | noFollow);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_TEMPLATE_BYTES) return null;
      const source = fs
        .readFileSync(fd, "utf8")
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n");
      if (!source.trim() || source.includes("\0") || Buffer.byteLength(source, "utf8") > MAX_TEMPLATE_BYTES) return null;

      return {
        name,
        path: realTemplatePath,
        source,
        sha256: crypto.createHash("sha256").update(source).digest("hex"),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function renderLocalTemplate(amqRoot, name, context, fallback) {
  const safeFallback = boundedFallback(fallback);
  const template = loadLocalTemplate(amqRoot, name);
  if (!template) return { text: safeFallback, source: "fallback", path: null, sha256: null };

  try {
    return {
      text: renderTemplate(template.source, context),
      source: "template",
      path: template.path,
      sha256: template.sha256,
    };
  } catch {
    return { text: safeFallback, source: "fallback", path: null, sha256: null };
  }
}
