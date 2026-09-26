// Attribution for bridge-stop attempts.
//
// WHY THIS EXISTS
// A SIGTERM storm ran for hours across 23 restarts. The bridge has no self-stop path --
// cleanup() only runs on SIGINT/SIGTERM -- and the only two callers of stopDaemon() are
// the dashboard toggle and the CLI action. Neither recorded who called it, so the hunt
// was pure archaeology against a dashboard log that could not contain the event.
//
// WHY IT IS A LOG AND NOT A GUARD
// Guarding the CLI path would remove a signal. If something is calling it, disabling it
// turns a recurring, observable event into silence, and the next thing anyone learns is
// that the storm "stopped" for the same reason a clock stops when you put your hand over
// it. Attribution keeps the event visible AND names it. A guard that refuses is still
// right for the supervised-toggle case -- there the refusal is the point, because the
// action would not have the effect the caller believes it would -- but that is a
// correctness fix, not a way of making a symptom quieter.
//
// WHAT IT RECORDS
// Not "who", in the human sense: every process here runs as the same OS user, so a
// username would be constant and useless. What is actually diagnostic is WHICH PROCESS
// and WHICH CONNECTION -- pid, ppid, argv, cwd, and for HTTP the peer address and
// Origin. That is enough to name the caller, which is what was missing.
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "./config.mjs";

const MAX_LINES = 200;

export function getStopLogFile() {
  return path.join(getStateDir(), "stop-attempts.jsonl");
}

function readProcCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

// Best-effort caller identity. Every field may be null: the point is to record what we
// CAN see, not to fail when something is unavailable.
export function describeCaller({ pid = process.pid, remoteAddress = null, origin = null, source } = {}) {
  let ppid = null;
  try {
    // readFileSync, NOT readlinkSync: /proc/<pid>/stat is a regular file, and readlink
    // on one yields nothing useful, which silently produced a null ppid that looked
    // like a permission problem rather than a wrong syscall.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || null;
  } catch {
    ppid = null;
  }
  let cwd = null;
  try {
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    cwd = null;
  }
  return {
    source: source || "unknown",
    pid,
    ppid,
    argv: readProcCmdline(pid),
    cwd,
    remoteAddress,
    origin,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
  };
}

export function recordStopAttempt(details = {}) {
  const record = { at: new Date().toISOString(), ...details };
  // Everything below is inside the try, INCLUDING resolving the path. getStateDir()
  // mkdirs whatever it is handed, so a bad state dir throws from inside getStateDir()
  // rather than from the write - and an unwrapped throw here would mean attribution is
  // the reason a stop fails, which is the one thing this module must never be.
  try {
    const file = getStopLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let existing = "";
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      existing = "";
    }
    const lines = existing.split("\n").filter(Boolean);
    lines.push(JSON.stringify(record));
    // Bounded: a hunt that never ends must not grow a log without limit either.
    const kept = lines.slice(-MAX_LINES);
    fs.writeFileSync(file, kept.join("\n") + "\n", "utf8");
  } catch {
    // Attribution must never be the reason a stop fails.
  }
  return record;
}

export function readStopLog({ limit = MAX_LINES } = {}) {
  try {
    return fs
      .readFileSync(getStopLogFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  } catch {
    return [];
  }
}
