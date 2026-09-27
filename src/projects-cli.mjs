// `herdr-amq projects` - the discovery list. It NEVER decides which mailbox a command reads.
//
// That is the whole contract, and it is the one worth stating in the CLI itself: `projects`
// writes to a list, and nothing else in the program reads that list to resolve a path. If a
// future change makes resolution consult it, every safety property this feature has evaporates
// at once - a stale entry would point the bridge daemon at another project's board.

import {
  addProject,
  listProjects,
  removeProject,
  isMailboxRoot,
  hasMailboxShape,
  MAILBOX_MARKER,
} from "./projects.mjs";
import { findAmqRoot } from "./config.mjs";

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** Resolve a user-supplied path, defaulting to the mailbox this command is running inside. */
function targetRoot(explicit) {
  if (explicit) return explicit;
  const here = findAmqRoot();
  if (!here) {
    const err = new Error("no mailbox here, and no path given. Pass the project directory.");
    err.code = "NO_MAILBOX";
    throw err;
  }
  return here;
}

export function handleProjectsCommand(sub, argv = []) {
  switch (sub) {
    case "list":
    case "ls": {
      const rows = listProjects();
      if (!rows.length) {
        console.log("No mailboxes added yet.");
        console.log(`Add one with:  herdr-amq projects add [path]`);
        console.log(`A directory counts once it contains ${MAILBOX_MARKER} - "add" writes it.`);
        return 0;
      }
      // STALE is a first-class state, not an absence. A path that moved is still listed, so the
      // moment the user needs to know it is gone is visible instead of silent.
      const w = Math.max(...rows.map((r) => r.name.length), 4);
      console.log(`${"NAME".padEnd(w)}  ${"ID".padEnd(12)}  STATE     PATH`);
      for (const r of rows) {
        const state = !r.exists ? "STALE" : r.marked ? "ok" : "UNMARKED";
        console.log(`${r.name.padEnd(w)}  ${r.id.padEnd(12)}  ${state.padEnd(8)}  ${r.path}`);
      }
      return 0;
    }

    case "add": {
      const root = targetRoot(argv.find((a) => !a.startsWith("--")));
      // A refusal is a MESSAGE, not a stack trace. The first version let addProject throw and the
      // user got twenty lines of ESM frames for what is a one-line "that is not a mailbox". A CLI
      // that dumps internals for an ordinary mistake trains people not to read its output.
      let entry;
      try {
        entry = addProject(root, { name: flag(argv, "name") });
      } catch (e) {
        console.log(e.code === "NOT_A_MAILBOX" ? e.message : `Could not add: ${e.message}`);
        if (e.hint) console.log(`  ${e.hint}`);
        return 1;
      }
      console.log(`Added ${entry.name} (${entry.id})`);
      console.log(`  ${entry.path}`);
      return 0;
    }

    case "remove":
    case "rm": {
      const ref = argv.find((a) => !a.startsWith("--"));
      if (!ref) {
        console.log("Usage: herdr-amq projects remove <name|id>");
        return 2;
      }
      const r = removeProject(ref);
      if (!r.removed) {
        console.log(`Not in the registry: ${ref} (${r.reason})`);
        return 1;
      }
      console.log(`Removed ${r.entry.name} (${r.entry.id})`);
      console.log(`  the mailbox itself is untouched: ${r.entry.path}`);
      return 0;
    }

    case "check": {
      // Answers "is what I typed actually a mailbox", without registering anything. Useful before
      // `add`, and the place to explain a refusal that `add` would otherwise make silently.
      const root = targetRoot(argv.find((a) => !a.startsWith("--")));
      if (!hasMailboxShape(root)) {
        console.log(`NOT a mailbox: ${root}`);
        console.log("  no bus/ directory in it. Point at the project, or at its .agent-mail.");
        return 1;
      }
      const marked = isMailboxRoot(root);
      console.log(`mailbox${marked ? "" : ", not yet added"}: ${root}`);
      if (!marked) {
        console.log(`  it has no ${MAILBOX_MARKER}, so nothing can discover it yet.`);
        console.log('  "projects add" writes one. That is the whole registration step.');
      }
      return 0;
    }

    default:
      console.log("Usage: herdr-amq projects <list|add|remove|check> [path] [--name <name>]");
      console.log("");
      console.log("  list     known mailboxes, with STALE marked for a path that moved");
      console.log("  add      register a mailbox and write its marker");
      console.log("  remove   drop it from the list; the mailbox itself is untouched");
      console.log("  check    is this path a mailbox, without registering it");
      console.log("");
      console.log("This list is for DISCOVERY. It never decides which mailbox a command reads:");
      console.log("that is AM_ROOT, then the Herdr workspace, then a walk up from the cwd.");
      return 2;
  }
}
