// A REGISTRY OF KNOWN MAILBOXES: FOR DISCOVERY, NEVER FOR RESOLUTION.
//
// The shape is Godot's. Godot remembers the projects you have opened in
// ~/.config/godot/projects/, but it never asks that list WHERE a project is - it finds
// project.godot from the directory you are standing in, and uses the list only to fill a
// picker. That distinction is the whole design, and it is the part that must not be blurred.
//
// WHY THE LIST MUST NOT RESOLVE. If resolution consulted a list, a moved or stale entry would
// point the bridge daemon or a doorbell at the wrong board, and a doorbell about project A
// silently reading project B is the nested-mailbox ambiguity this repo already paid for once.
// So resolution stays exactly as it was - AM_ROOT, then Herdr context, then a walk up from the
// cwd - and nothing in this file is on that path. The registry answers one question: which
// mailboxes exist, so a human can choose one on purpose.
//
// WHY A MARKER FILE AND NOT A STRUCTURAL RULE. "Is this directory a mailbox" cannot be answered
// by looking: a nested .agent-mail/.agent-mail scaffold has bus/ and agents/ too, and it had
// four bus stages and zero cards when this was written. isNestedMailbox is a dir-name GUESS, and
// it exists only because the guess was needed. A marker makes the question a fact. The cost is
// that a mailbox is invisible until someone adds it, which is the intended behaviour: adding is
// a decision, and a decision that is automatic is not one.
//
// A MISSING REGISTRY IS NOT AN ERROR. A fresh install with no ~/.config/herdr-amq/projects
// behaves exactly as it does today. If absence changed behaviour, adding this would break every
// running lane on upgrade, which is a worse outcome than having no registry at all.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.mjs";

/** The file that makes a directory a mailbox. Its presence is the whole test. */
export const MAILBOX_MARKER = "mailbox.json";

/** A mailbox the user has added. Named after the Godot field, for the same reason. */
export function getProjectsDir() {
  return path.join(getConfigDir(), "projects");
}

/**
 * A stable id for a mailbox, derived from its RESOLVED path.
 *
 * Stable means: the same path always gets the same id, so a state file keyed by it keeps
 * working across restarts. It also means a MOVED mailbox gets a NEW id, which is correct -
 * a different directory is a different mailbox, and pretending otherwise would let stale state
 * attach itself to unrelated work.
 */
export function mailboxId(root) {
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(root));
  } catch {
    resolved = path.resolve(root);
  }
  return createHash("sha1").update(resolved).digest("hex").slice(0, 12);
}

/**
 * Does this directory HAVE THE SHAPE of a mailbox? bus/ with its stages, agents/.
 *
 * This is the pre-marker check, and it is deliberately weaker than isMailboxRoot. It exists so
 * `add` can accept a real-but-unmarked mailbox - a chicken-and-egg the first version had, where
 * add refused anything without a marker while add was the only thing that wrote one, so an
 * unmarked mailbox could never be added at all. The live CLI run caught that; the unit tests had
 * every mailbox pre-marked and sailed past it.
 */
export function hasMailboxShape(root) {
  if (!root) return false;
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  try {
    return fs.statSync(path.join(root, "bus")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Is this a REGISTERED mailbox? A marker, and the shape, both.
 *
 * The nested .agent-mail/.agent-mail scaffold passes the shape test and fails the marker test,
 * which is exactly the discrimination shape alone cannot make. A dir-name guess is what this
 * replaced.
 */
export function isMailboxRoot(root) {
  if (!hasMailboxShape(root)) return false;
  return fs.existsSync(path.join(root, MAILBOX_MARKER));
}

/**
 * A name a human can recognise in a list.
 *
 * A mailbox root is usually called `.agent-mail`, so baselining the root gives every project the
 * same name and a picker of N rows all reading `.agent-mail`. The PROJECT directory is the name
 * people actually recognise - fps-basegame, not .agent-mail - so that is what a root falls back to.
 */
export function defaultMailboxName(root) {
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(root));
  } catch {
    resolved = path.resolve(root);
  }
  const base = path.basename(resolved);
  if (base === ".agent-mail") return path.basename(path.dirname(resolved)) || base;
  return base;
}

/** Write the marker. Never overwrites an existing one: a name is a human's choice. */
export function writeMailboxMarker(root, { name, id } = {}) {
  const file = path.join(root, MAILBOX_MARKER);
  if (fs.existsSync(file)) return { written: false, reason: "already_marked" };
  const body = {
    schema: 1,
    name: name || defaultMailboxName(root),
    id: id || mailboxId(root),
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return { written: true, ...body };
}

/** A filename that is safe and unique even when two projects share a directory name. */
function entryFile(root) {
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(root));
  } catch {
    resolved = path.resolve(root);
  }
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "mailbox";
  return path.join(getProjectsDir(), `${base}-${mailboxId(resolved)}.json`);
}

/**
 * Add a mailbox to the registry. Idempotent by path: adding the same root twice is one entry,
 * because a picker with the same project twice is a bug the user has to notice and work around.
 */
export function addProject(root, { name } = {}) {
  const resolved = (() => {
    try {
      return fs.realpathSync(path.resolve(root));
    } catch {
      return path.resolve(root);
    }
  })();
  // Accept a real-but-unmarked mailbox: write the marker, THEN register. Refusing here for a
  // missing marker is the chicken-and-egg above, and it made writeMailboxMarker unreachable.
  if (!hasMailboxShape(resolved)) {
    const err = new Error(`not a mailbox: ${resolved} has no bus/ directory`);
    err.code = "NOT_A_MAILBOX";
    err.hint = "A mailbox has a bus/ directory. Point at the project, or at its .agent-mail.";
    throw err;
  }
  // BUT NOT A SCAFFOLD. Once the marker stopped being a precondition, a nested .agent-mail would
  // have become addable, and that is a phantom project: it sits inside a real mailbox, it mirrors
  // it, and listing it invites picking the empty one. The test is SHAPE, not name - "is my parent
  // itself a mailbox" - because the real path is .../.agent-mail/.agent-mail while a test or a
  // relayout may name the outer root anything at all. It only inspects the immediate parent, so a
  // mailbox nested two deep would slip past; that is stated rather than overclaimed.
  if (hasMailboxShape(path.dirname(resolved))) {
    const err = new Error(`not a project: ${resolved} is nested inside another mailbox`);
    err.code = "NOT_A_MAILBOX";
    err.hint = "it is a scaffold inside a real mailbox, not a second project. Add the outer one.";
    throw err;
  }
  const marker = writeMailboxMarker(resolved, { name });
  const id = mailboxId(resolved);
  const entry = {
    schema: 1,
    id,
    name: name || marker.name || defaultMailboxName(resolved),
    path: resolved,
    addedAt: new Date().toISOString(),
  };
  fs.mkdirSync(getProjectsDir(), { recursive: true });
  fs.writeFileSync(entryFile(resolved), `${JSON.stringify(entry, null, 2)}\n`);
  return entry;
}

function readEntry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed.path !== "string" || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null; // a corrupt entry is skipped, never fatal: a bad file must not hide the good ones
  }
}

/**
 * Every registered mailbox, with liveness marked.
 *
 * `exists` is the field that earns the registry its keep: a path that moved or was deleted is
 * still listed, and listed as STALE, instead of silently vanishing from a picker at the moment
 * the user needs to know it is gone.
 */
export function listProjects() {
  let files;
  try {
    files = fs.readdirSync(getProjectsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    const entry = readEntry(path.join(getProjectsDir(), f));
    if (!entry) continue;
    let exists = false;
    let marked = false;
    try {
      exists = fs.statSync(entry.path).isDirectory();
      marked = exists && fs.existsSync(path.join(entry.path, MAILBOX_MARKER));
    } catch { /* a path that no longer resolves is simply not there */ }
    out.push({ ...entry, exists, marked });
  }
  return out;
}

export function removeProject(ref) {
  const all = listProjects();
  const hit = all.find((p) => p.id === ref || p.name === ref)
    || all.find((p) => path.basename(p.path) === ref);
  if (!hit) return { removed: false, reason: "not_found" };
  try {
    fs.unlinkSync(entryFile(hit.path));
  } catch (e) {
    return { removed: false, reason: e.code || "unlink_failed" };
  }
  return { removed: true, entry: hit };
}
