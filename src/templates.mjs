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
