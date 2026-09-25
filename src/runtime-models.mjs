import { execFileSync } from "node:child_process";

const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]{1,200}$/;
const MODEL_CACHE_TTL_MS = 5000;
const modelCache = new Map();
let modelCacheExpiresAt = 0;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseJson(value) {
  if (objectValue(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function normalizeRuntimeModel(value) {
  const parsed = parseJson(value);
  if (typeof parsed === "string") return normalizeRuntimeModel(parsed);
  if (!objectValue(parsed)) return text(value) || null;

  const id = text(parsed.id) || text(parsed.model) || text(parsed.name);
  const provider = text(parsed.providerID) || text(parsed.provider);
  const variant = text(parsed.variant) || text(parsed.reasoning);
  if (!id) return null;
  const qualified = provider && !id.includes("/") ? `${provider}/${id}` : id;
  return variant ? `${qualified} (${variant})` : qualified;
}

export function getHarnessSessionId(agent) {
  const session = objectValue(agent?.agent_session) || objectValue(agent?.session);
  return text(session?.value) || text(session?.id) || text(session?.session_id) || text(agent?.session_id) || text(agent?.sessionId);
}

function directModel(agent) {
  const session = objectValue(agent?.agent_session) || objectValue(agent?.session);
  const metadata = objectValue(agent?.metadata);
  const config = objectValue(agent?.config);
  const candidates = [
    agent?.model,
    agent?.model_id,
    agent?.modelId,
    session?.model,
    metadata?.model,
    config?.model,
  ];
  for (const candidate of candidates) {
    const model = normalizeRuntimeModel(candidate);
    if (model) return model;
  }
  return null;
}

export function resolveRuntimeModel(agent, sessionModels = new Map()) {
  const direct = directModel(agent);
  const sessionId = getHarnessSessionId(agent);
  if (direct) return { model: direct, source: "herdr-record", sessionId };
  const sessionModel = sessionId ? sessionModels.get(sessionId) : null;
  if (sessionModel) return { model: sessionModel, source: "opencode-session", sessionId };
  return { model: null, source: null, sessionId };
}

function isOpenCodeAgent(agent) {
  const session = objectValue(agent?.agent_session);
  return [agent?.agent, session?.agent, session?.source].some((value) => text(value).toLowerCase().includes("opencode"));
}

function queryOpenCodeModels(ids, execFile = execFileSync) {
  if (!ids.length) return [];
  const bin = process.env.OPENCODE_BIN_PATH || process.env.OPENCODE_BIN || "opencode";
  const list = ids.map((id) => `'${id}'`).join(",");
  const output = execFile(bin, ["db", `SELECT id, model FROM session WHERE id IN (${list})`, "--format", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = parseJson(output);
  return Array.isArray(parsed) ? parsed : [];
}

export function clearRuntimeModelCache() {
  modelCache.clear();
  modelCacheExpiresAt = 0;
}

export function getOpenCodeSessionModels(agents, { now = Date.now(), queryModels = queryOpenCodeModels } = {}) {
  // Only agents whose model is NOT already in the Herdr record can need the
  // session lookup. `queryOpenCodeModels` is a synchronous child process, so
  // querying ids that will never be read costs a blocking spawn on every status
  // refresh (and, in tests, on every request).
  const ids = [...new Set((Array.isArray(agents) ? agents : [])
    .filter((agent) => isOpenCodeAgent(agent) && !directModel(agent))
    .map(getHarnessSessionId)
    .filter((id) => SESSION_ID_PATTERN.test(id)))];
  if (!ids.length) return new Map();

  if (now >= modelCacheExpiresAt) {
    modelCache.clear();
    modelCacheExpiresAt = now + MODEL_CACHE_TTL_MS;
  }
  const missing = ids.filter((id) => !modelCache.has(id));
  if (missing.length) {
    try {
      for (const row of queryModels(missing)) {
        const id = text(row?.id);
        const model = normalizeRuntimeModel(row?.model);
        if (id && model) modelCache.set(id, model);
      }
    } catch {}
  }
  return new Map(ids.filter((id) => modelCache.has(id)).map((id) => [id, modelCache.get(id)]));
}
