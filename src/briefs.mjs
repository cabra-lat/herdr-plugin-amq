import fs from "node:fs";
import path from "node:path";
import { formatAgentTitle } from "./store.mjs";

const CANDIDATE_BRIEF_DIRS = [
  path.join(".opencode", "agents"),
  ".agents",
  path.join(".pi", "agents"),
  "agents",
  path.join(".claude", "agents"),
  path.join(".gemini", "agents"),
];

/**
 * Parse an agent definition file (Markdown with YAML frontmatter or JSON)
 */
export function parseAgentBriefFile(filePath, repoRoot = "") {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null;
    }

    const ext = path.extname(filePath).toLowerCase();
    const raw = fs.readFileSync(filePath, "utf8");
    const baseName = path.basename(filePath, ext);
    const relPath = repoRoot ? path.relative(repoRoot, filePath) : filePath;

    if (ext === ".json") {
      const obj = JSON.parse(raw);
      const handle = obj.handle || baseName;
      return {
        handle,
        name: obj.name || formatAgentTitle(handle),
        description: obj.description || "",
        role: obj.role || obj.description || formatAgentTitle(handle),
        model: obj.model || null,
        mode: obj.mode || "subagent",
        prompt: (obj.prompt || obj.systemPrompt || obj.brief || "").trim(),
        source: relPath,
        fullPath: filePath,
      };
    }

    // Markdown with YAML frontmatter: --- ... --- body
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    const frontmatter = {};
    let prompt = raw.trim();

    if (match) {
      prompt = (match[2] || "").trim();
      const yamlContent = match[1];

      for (const line of yamlContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx !== -1) {
          const key = trimmed.slice(0, colonIdx).trim();
          let val = trimmed.slice(colonIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          frontmatter[key] = val;
        }
      }
    }

    const handle = frontmatter.handle || baseName;
    const name = frontmatter.name || formatAgentTitle(handle);
    const description = frontmatter.description || "";
    const role = frontmatter.role || description || formatAgentTitle(handle);
    const model = frontmatter.model || null;
    const mode = frontmatter.mode || "subagent";

    return {
      handle,
      name,
      description,
      role,
      model,
      mode,
      prompt,
      source: relPath,
      fullPath: filePath,
    };
  } catch {
    return null;
  }
}

/**
 * Scan all standard brief directories in repository
 * Searches: .opencode/agents, .agents, .pi/agents, agents, etc.
 */
export function scanAgentBriefs(repoRoot) {
  const briefs = new Map();
  if (!repoRoot || !fs.existsSync(repoRoot)) {
    return briefs;
  }

  for (const relDir of CANDIDATE_BRIEF_DIRS) {
    const dirPath = path.join(repoRoot, relDir);
    if (!fs.existsSync(dirPath)) continue;

    try {
      const files = fs.readdirSync(dirPath);
      for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (ext !== ".md" && ext !== ".json" && ext !== ".yaml" && ext !== ".yml") {
          continue;
        }
        const fullPath = path.join(dirPath, f);
        const parsed = parseAgentBriefFile(fullPath, repoRoot);
        if (parsed && parsed.handle && !briefs.has(parsed.handle)) {
          briefs.set(parsed.handle, parsed);
        }
      }
    } catch {}
  }

  return briefs;
}

/**
 * Get brief for a single agent handle across candidate directories
 */
export function getAgentBrief(repoRoot, handle) {
  if (!handle || !repoRoot) return null;
  const safeHandle = handle.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");

  // Check known candidate directories in order
  for (const relDir of CANDIDATE_BRIEF_DIRS) {
    const dirPath = path.join(repoRoot, relDir);
    if (!fs.existsSync(dirPath)) continue;

    const candidates = [
      path.join(dirPath, `${safeHandle}.md`),
      path.join(dirPath, `${safeHandle}.json`),
      path.join(dirPath, `${safeHandle}.yaml`),
      path.join(dirPath, `${safeHandle}.yml`),
      path.join(dirPath, safeHandle, "brief.md"),
      path.join(dirPath, safeHandle, "prompt.md"),
    ];

    for (const fileCandidate of candidates) {
      if (fs.existsSync(fileCandidate)) {
        const parsed = parseAgentBriefFile(fileCandidate, repoRoot);
        if (parsed) return parsed;
      }
    }
  }

  return null;
}

/**
 * Save or update agent brief file on disk
 */
export function saveAgentBrief(repoRoot, handle, { description = "", prompt = "", model = null, role = "" }) {
  if (!handle || !repoRoot || !fs.existsSync(repoRoot)) {
    return { ok: false, error: "Invalid repository root or handle" };
  }

  const safeHandle = handle.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  let targetDir = path.join(repoRoot, ".opencode", "agents");
  if (!fs.existsSync(targetDir)) {
    if (fs.existsSync(path.join(repoRoot, ".agents"))) {
      targetDir = path.join(repoRoot, ".agents");
    } else if (fs.existsSync(path.join(repoRoot, ".pi", "agents"))) {
      targetDir = path.join(repoRoot, ".pi", "agents");
    } else {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  }

  const targetFile = path.join(targetDir, `${safeHandle}.md`);
  const effectiveDesc = description || role || `Specialist agent for ${safeHandle}`;
  const frontmatterLines = [
    "---",
    `description: ${effectiveDesc}`,
    "mode: subagent",
  ];
  if (model) {
    frontmatterLines.push(`model: ${model}`);
  }
  frontmatterLines.push("---");
  frontmatterLines.push("");
  frontmatterLines.push(prompt.trim() || `You are the ${safeHandle} agent.`);
  frontmatterLines.push("");

  try {
    fs.writeFileSync(targetFile, frontmatterLines.join("\n"), "utf8");
    return {
      ok: true,
      path: targetFile,
      relPath: path.relative(repoRoot, targetFile),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
