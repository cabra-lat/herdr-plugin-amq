import fs from "node:fs";
import path from "node:path";

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

export function loadMetricsHistory(file, limit = 500) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      schemaVersion: Number(parsed.schemaVersion) || 1,
      samples: Array.isArray(parsed.samples) ? parsed.samples.slice(-limit) : [],
      retention: { limit },
    };
  } catch {
    return { schemaVersion: 1, samples: [], retention: { limit } };
  }
}

export function recordMetricsSample(file, metrics, { limit = 500, at = new Date().toISOString() } = {}) {
  const history = loadMetricsHistory(file, limit);
  history.samples.push({
    at,
    agents: metrics?.agents?.byStatus || {},
    queueDepth: metrics?.queue?.activeCards ?? 0,
    jobQueueDepth: metrics?.jobs?.queueDepth ?? 0,
    outcomes: metrics?.jobs?.outcomes || {},
    concurrency: metrics?.jobs?.concurrency?.current ?? 0,
  });
  history.samples = history.samples.slice(-limit);
  writeAtomic(file, history);
  return history;
}
