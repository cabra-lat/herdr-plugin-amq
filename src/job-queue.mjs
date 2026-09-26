import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";

const STATES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const DEFAULT_LEASE_MS = 30_000;

function nowMs(now) {
  return typeof now === "function" ? now() : Date.now();
}

function id() {
  return `job_${crypto.randomBytes(8).toString("hex")}`;
}

function safeString(value, max = 512) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function defaultState() {
  return {
    schema_version: 1,
    jobs: [],
    idempotency: {},
    history: [],
    concurrency_samples: [],
  };
}

function normalizeCommand(command) {
  if (!Array.isArray(command) || command.length === 0) throw new Error("command must be a non-empty argv array");
  if (command.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))) {
    throw new Error("command contains an invalid argument");
  }
  return [...command];
}

/**
 * Durable, deliberately small job queue. It is independent from the Godot
 * shared lock: non-Godot work may run concurrently, while Godot work is
 * serialized and must be launched through the supplied lock wrapper.
 */
export class JobQueue {
  constructor({ stateFile, expectedLockWrapper, maxConcurrency = 2, godotConcurrency = 1, leaseMs = DEFAULT_LEASE_MS, historyLimit = 500, runner, now } = {}) {
    if (!stateFile) throw new Error("stateFile is required");
    this.stateFile = path.resolve(stateFile);
    this.expectedLockWrapper = expectedLockWrapper ? path.resolve(expectedLockWrapper) : null;
    this.maxConcurrency = Math.max(1, Math.min(32, Number(maxConcurrency) || 2));
    this.godotConcurrency = Math.max(1, Math.min(this.maxConcurrency, Number(godotConcurrency) || 1));
    this.leaseMs = Math.max(1000, Number(leaseMs) || DEFAULT_LEASE_MS);
    this.historyLimit = Math.max(10, Math.min(10_000, Number(historyLimit) || 500));
    this.runner = runner || defaultRunner;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.state = this.#load();
    this.runningWorkers = new Map();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (Array.isArray(parsed)) return { ...defaultState(), jobs: parsed };
      const state = { ...defaultState(), ...parsed };
      state.jobs = Array.isArray(state.jobs) ? state.jobs : [];
      state.idempotency = state.idempotency && typeof state.idempotency === "object" ? state.idempotency : {};
      state.history = Array.isArray(state.history) ? state.history : [];
      state.concurrency_samples = Array.isArray(state.concurrency_samples) ? state.concurrency_samples : [];
      return state;
    } catch {
      return defaultState();
    }
  }

  #save() {
    if (this.state.history.length > this.historyLimit) this.state.history = this.state.history.slice(-this.historyLimit);
    if (this.state.concurrency_samples.length > this.historyLimit) this.state.concurrency_samples = this.state.concurrency_samples.slice(-this.historyLimit);
    const terminal = this.state.jobs.filter((job) => TERMINAL.has(job.status));
    if (terminal.length > this.historyLimit) {
      const keep = new Set(terminal.slice(-this.historyLimit).map((job) => job.id));
      this.state.jobs = this.state.jobs.filter((job) => !TERMINAL.has(job.status) || keep.has(job.id));
    }
    atomicWrite(this.stateFile, this.state);
  }

  #sample() {
    const running = this.state.jobs.filter((job) => job.status === "running").length;
    this.state.concurrency_samples.push({ at: new Date(this.now()).toISOString(), running });
  }

  #recoverExpired() {
    const current = this.now();
    let changed = false;
    for (const job of this.state.jobs) {
      if (job.status !== "running" || Number(job.lease_until) > current) continue;
      job.status = "failed";
      job.error = "lease expired";
      job.finished_at = new Date(current).toISOString();
      job.lease_until = null;
      job.worker_id = null;
      this.state.history.push({ ...job });
      changed = true;
    }
    return changed;
  }

  recoverExpiredLeases() {
    this.#recoverExpired();
    this.#sample();
    this.#save();
    return this.snapshot();
  }

  enqueue(input = {}) {
    const command = normalizeCommand(input.command);
    const kind = input.kind === "godot" ? "godot" : "non-godot";
    if (kind === "non-godot" && ["godot", "godot.exe"].includes(path.basename(command[0]).toLowerCase())) {
      throw new Error("Godot commands must use kind=godot and the shared lock wrapper");
    }
    const idempotencyKey = safeString(input.idempotencyKey, 256);
    if (!idempotencyKey) throw new Error("idempotencyKey is required");
    const fingerprint = JSON.stringify({ kind, command, title: safeString(input.title, 256) });
    const existingId = this.state.idempotency[idempotencyKey];
    if (existingId) {
      const existing = this.get(existingId);
      if (existing && existing.fingerprint === fingerprint) return existing;
      throw new Error("idempotencyKey is already used by a different job");
    }
    if (kind === "godot") {
      const lockWrapper = safeString(input.lockWrapper, 1024);
      if (!lockWrapper) throw new Error("godot jobs require lockWrapper");
      const resolvedWrapper = path.resolve(lockWrapper);
      if (!this.expectedLockWrapper || resolvedWrapper !== this.expectedLockWrapper) {
        throw new Error("godot jobs require the canonical repository tools/godot-lock.sh wrapper");
      }
      try {
        if (!fs.statSync(resolvedWrapper).isFile()) throw new Error("not a file");
        const contract = fs.readFileSync(resolvedWrapper, "utf8");
        if (!/flock -w 900/.test(contract) || !/LOCK_FILE="\/tmp\/shooter\/verify-all\./.test(contract) || !/exec\s+["']?\$GODOT_BIN/.test(contract)) {
          throw new Error("wrapper does not contain the shared-lock execution contract");
        }
      } catch {
        throw new Error("godot lockWrapper must be the canonical shared-lock executable");
      }
    }
    const timestamp = new Date(this.now()).toISOString();
    const job = {
      id: id(),
      title: safeString(input.title, 256) || command[0],
      kind,
      command,
      lockWrapper: kind === "godot" ? this.expectedLockWrapper : null,
      idempotencyKey,
      fingerprint,
      status: "queued",
      attempts: 0,
      available_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
      lease_until: null,
      worker_id: null,
      result: null,
      error: null,
      cancel_requested: false,
    };
    this.state.jobs.push(job);
    this.state.idempotency[idempotencyKey] = job.id;
    this.#sample();
    this.#save();
    return { ...job };
  }

  get(jobId) {
    const job = this.state.jobs.find((entry) => entry.id === jobId);
    return job ? { ...job } : null;
  }

  list({ status } = {}) {
    if (this.#recoverExpired()) {
      this.#sample();
      this.#save();
    }
    return this.state.jobs
      .filter((job) => !status || job.status === status)
      .map((job) => ({ ...job }));
  }

  claimNext({ workerId = `worker_${crypto.randomBytes(4).toString("hex")}`, leaseMs = this.leaseMs } = {}) {
    const recovered = this.#recoverExpired();
    const active = this.state.jobs.filter((job) => job.status === "running");
    const godotActive = active.filter((job) => job.kind === "godot").length;
    if (active.length >= this.maxConcurrency) return null;
    const current = this.now();
    const job = this.state.jobs.find((candidate) => {
      if (candidate.status !== "queued" || candidate.cancel_requested) return false;
      if (candidate.kind === "godot" && godotActive >= this.godotConcurrency) return false;
      return !candidate.available_at || Date.parse(candidate.available_at) <= current;
    });
    if (!job) {
      if (recovered) {
        this.#sample();
        this.#save();
      }
      return null;
    }
    const timestamp = new Date(current).toISOString();
    job.status = "running";
    job.attempts += 1;
    job.started_at = job.started_at || timestamp;
    job.updated_at = timestamp;
    job.heartbeat_at = timestamp;
    job.lease_until = current + Math.max(1000, Number(leaseMs) || this.leaseMs);
    job.worker_id = workerId;
    this.runningWorkers.set(job.id, workerId);
    this.#sample();
    this.#save();
    return { ...job };
  }

  heartbeat(jobId, workerId) {
    const job = this.state.jobs.find((entry) => entry.id === jobId);
    if (!job || job.status !== "running" || job.worker_id !== workerId) return false;
    const timestamp = this.now();
    if (Number(job.lease_until) <= timestamp) {
      this.#recoverExpired();
      this.#sample();
      this.#save();
      return false;
    }
    job.heartbeat_at = new Date(timestamp).toISOString();
    job.lease_until = timestamp + this.leaseMs;
    job.updated_at = new Date(timestamp).toISOString();
    this.#save();
    return true;
  }

  complete(jobId, workerId, result = null) {
    const job = this.state.jobs.find((entry) => entry.id === jobId);
    if (!job || job.status !== "running" || job.worker_id !== workerId) throw new Error("job is not owned by this worker");
    if (Number(job.lease_until) <= this.now()) {
      this.#recoverExpired();
      this.#sample();
      this.#save();
      throw new Error("worker lease expired");
    }
    job.status = "succeeded";
    job.result = result;
    job.finished_at = new Date(this.now()).toISOString();
    job.updated_at = job.finished_at;
    job.lease_until = null;
    job.worker_id = null;
    this.runningWorkers.delete(jobId);
    this.state.history.push({ ...job });
    this.#sample();
    this.#save();
    return { ...job };
  }

  fail(jobId, workerId, error) {
    const job = this.state.jobs.find((entry) => entry.id === jobId);
    if (!job || job.status !== "running" || job.worker_id !== workerId) throw new Error("job is not owned by this worker");
    if (Number(job.lease_until) <= this.now()) {
      this.#recoverExpired();
      this.#sample();
      this.#save();
      throw new Error("worker lease expired");
    }
    job.status = "failed";
    job.error = safeString(error, 1024) || "job failed";
    job.finished_at = new Date(this.now()).toISOString();
    job.updated_at = job.finished_at;
    job.lease_until = null;
    job.worker_id = null;
    this.runningWorkers.delete(jobId);
    this.state.history.push({ ...job });
    this.#sample();
    this.#save();
    return { ...job };
  }

  cancel(jobId) {
    const job = this.state.jobs.find((entry) => entry.id === jobId);
    if (!job) throw new Error("job not found");
    if (TERMINAL.has(job.status)) return { ...job };
    job.cancel_requested = true;
    job.status = "cancelled";
    job.cancelled_at = new Date(this.now()).toISOString();
    job.updated_at = job.cancelled_at;
    job.lease_until = null;
    job.worker_id = null;
    this.runningWorkers.delete(jobId);
    this.state.history.push({ ...job });
    this.#sample();
    this.#save();
    return { ...job };
  }

  async runOne({ workerId } = {}) {
    const job = this.claimNext({ workerId });
    if (!job) return null;
    const owner = job.worker_id;
    try {
      const result = await this.runner(job, {
        heartbeat: () => this.heartbeat(job.id, owner),
        cancelRequested: () => Boolean(this.get(job.id)?.cancel_requested),
      });
      if (this.get(job.id)?.status === "cancelled") return { ...job, status: "cancelled" };
      return this.complete(job.id, owner, result);
    } catch (error) {
      if (this.get(job.id)?.status === "cancelled") return { ...job, status: "cancelled" };
      // The loadavg pair rides along with the failure so a timeout can be read as a
      // hang or as contention without re-running anything. It is reported, never
      // scored: a job that failed on a busy host failed, and a job that timed out on
      // a busy host is a fact about the host, not a pass.
      const detail = error?.contention
        ? ` [${error.contention.classification || "unknown"}: ${error.contention.reason}${error.contention.timedOut ? " (timeout)" : ""}]`
        : "";
      return this.fail(job.id, owner, `${error?.message || String(error)}${detail}`);
    }
  }

  async drain({ concurrency = this.maxConcurrency, workerPrefix = "worker" } = {}) {
    const limit = Math.max(1, Math.min(this.maxConcurrency, Number(concurrency) || this.maxConcurrency));
    const results = [];
    const workers = Array.from({ length: limit }, (_, index) => (async () => {
      while (true) {
        const result = await this.runOne({ workerId: `${workerPrefix}_${index + 1}` });
        if (!result) break;
        results.push(result);
      }
    })());
    await Promise.all(workers);
    return results;
  }

  metrics() {
    if (this.#recoverExpired()) {
      this.#sample();
      this.#save();
    }
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const job of this.state.jobs) if (Object.hasOwn(counts, job.status)) counts[job.status]++;
    const historyCounts = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const job of this.state.history) if (Object.hasOwn(historyCounts, job.status)) historyCounts[job.status]++;
    return {
      queueDepth: counts.queued,
      active: counts.running,
      counts,
      outcomes: historyCounts,
      concurrency: {
        current: counts.running,
        max: this.maxConcurrency,
        godotMax: this.godotConcurrency,
        samples: this.state.concurrency_samples.slice(-this.historyLimit),
      },
      retention: { historyLimit: this.historyLimit, historyCount: this.state.history.length, sampleCount: this.state.concurrency_samples.length },
    };
  }

  snapshot() {
    return { ok: true, metrics: this.metrics(), jobs: this.list() };
  }
}

// loadavg is a damped 1/5/15-minute average, so a single reading describes the box
// BEFORE the work rather than during it: a host that was quiet at start and loaded by
// the job itself would be recorded as healthy, which is the case the pair exists to
// catch. Reading at both ends lets a timeout be classified instead of guessed:
//   both low            -> the timeout is a hang, and a hang is a finding
//   pair high, or
//     start low/exit high -> contention-limited, and not a finding about the job
export function readLoadavg() {
  try {
    const raw = fs.readFileSync("/proc/loadavg", "utf8");
    const [one, five, fifteen] = raw.trim().split(/\s+/);
    const cores = os.cpus().length || 1;
    return {
      one: Number(one),
      five: Number(five),
      fifteen: Number(fifteen),
      cores,
      // Per-core load is the comparable number: a 1.0 one-minute average means a
      // different thing on 4 cores than on 64, and the whole question is whether
      // other work was competing for the ones this job needed.
      perCore: Number((Number(one) / cores).toFixed(3)),
    };
  } catch {
    return null;
  }
}

// Contention is a judgement about the host, not about the job, so it is classified
// from the pair and kept out of the pass/fail verdict. `classification` is null when
// the job finished on its own, because a healthy job on a loaded host is still a
// healthy job.
// Exported for direct test: the classification is a decision about the host, and it
// is the part that has to be right on a box nobody can load on demand.
export function classifyContention(start, exit) {
  if (!start || !exit) return { classification: null, reason: "loadavg unavailable" };
  const busy = (sample) => sample.perCore >= 0.5;
  if (busy(start) && busy(exit)) {
    return { classification: "contention-limited", reason: `loadavg per-core high at both ends (start ${start.perCore}, exit ${exit.perCore})` };
  }
  if (!busy(start) && busy(exit)) {
    return { classification: "contention-limited", reason: `host was quiet at start (${start.perCore}) and busy at exit (${exit.perCore}): the job loaded the box` };
  }
  if (busy(start) && !busy(exit)) {
    return { classification: "started-contended", reason: `host was busy at start (${start.perCore}) and quiet at exit (${exit.perCore})` };
  }
  return { classification: "uncontended", reason: `loadavg per-core low at both ends (start ${start.perCore}, exit ${exit.perCore})` };
}

function defaultRunner(job) {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = job.kind === "godot"
      ? [job.lockWrapper, ...job.command]
      : job.command;
    const loadavgAtStart = readLoadavg();
    execFile(executable, args, { cwd: process.cwd(), timeout: 15 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      // Read at exit on every path, including the timeout path, which is the one
      // that needs it: a timeout is only a hang if the host was not the reason.
      const loadavgAtExit = readLoadavg();
      const contention = classifyContention(loadavgAtStart, loadavgAtExit);
      const timedOut = Boolean(error && (error.killed || error.signal === "SIGTERM"));
      if (error) {
        const detail = {
          ...contention,
          loadavgAtStart,
          loadavgAtExit,
          timedOut,
          // The pair is reported for a timeout because that is the one verdict that
          // cannot be made without it.
          ...(timedOut ? { note: "A timeout is only a hang if the host was not the reason; compare the loadavg pair above." } : {}),
        };
        reject(Object.assign(new Error(`${error.message}${stderr ? `: ${safeString(stderr, 512)}` : ""}`), { contention: detail }));
      } else {
        resolve({ stdout: safeString(stdout, 4096), stderr: safeString(stderr, 4096), contention: { ...contention, loadavgAtStart, loadavgAtExit } });
      }
    });
  });
}

export function getJobQueue({ amqRoot, ...options } = {}) {
  const repositoryRoot = path.dirname(path.resolve(amqRoot));
  return new JobQueue({
    stateFile: path.join(amqRoot, "job-queue.json"),
    expectedLockWrapper: path.join(repositoryRoot, "tools", "godot-lock.sh"),
    ...options,
  });
}
