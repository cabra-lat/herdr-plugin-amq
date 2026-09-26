// One predicate over a whole mail tree, every handle, no call-site knowledge:
//
//   A message whose `from` is one of its own `to` addresses, and whose subject is not a board
//   notification, is a MISATTRIBUTION. A lane cannot legitimately mail itself.
//
// This exists as a tool and not only as a test because the interesting run is against the LIVE
// tree, and a test cannot reach that without being told where it is. The test enforces the
// predicate against planted fixtures; this reports the real population. Both read the same
// function, so the tool cannot drift into measuring something the test does not check.
//
//   node tools/scan-attribution.mjs [root] [--since <iso>]
//
// --since restricts the failure set to messages at or after a timestamp, which is how you ask
// "is this still happening" rather than "did this ever happen". The historical population is
// not the interesting number; the population since a fix landed is.
//
// MEASURED 2026-09-26 on the live tree, 6577 unique messages across 14 mailboxes, deduped by id
// because every message is present twice, once in the sender's outbox and once in the
// recipient's inbox. Counting both would have doubled every number in this file.
//
//   from === to, not a board notification, total 31, and AT OR AFTER the CLI fix (21:05:40Z): 0
//   13 of the 31 are replies, and in those the recipient coordinator is CORRECT - a lane
//   replying to a coordinator message should address the coordinator. Only the sender was wrong.
//   board notifications: 1105, of which 447 carried from=coordinator, 247 of those on
//   [ASSIGNED] alone, which is the create-path default now stamped `board`.
//   messages with a missing or empty from: 0, tree-wide, which is why protocol.mjs's
//   `origHeader.from || "coordinator"` reply-recipient fallback has never fired: it can only
//   fire on a header with no sender, and there are none.
import fs from "node:fs";
import path from "node:path";

const BOARD_SUBJECT = /^\[AGboard\]/;

export function isMisattribution(header) {
  const to = Array.isArray(header.to) ? header.to : [header.to].filter(Boolean);
  if (!header.from) return false;
  if (BOARD_SUBJECT.test(header.subject || "")) return false;
  return to.includes(header.from);
}

export function isBoardNotification(header) {
  return BOARD_SUBJECT.test(header.subject || "");
}

/** Every message header in a root, deduped by id, read from disk. */
export function scanTree(root) {
  const agentsDir = path.join(root, "agents");
  if (!fs.existsSync(agentsDir)) return [];
  const byId = new Map();
  for (const handle of fs.readdirSync(agentsDir)) {
    for (const rel of ["inbox/new", "inbox/cur", "outbox/sent"]) {
      const dir = path.join(agentsDir, handle, rel);
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!f.endsWith(".md")) continue;
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        const m = text.match(/^---json\n([\s\S]*?)\n---\n?/);
        if (!m) continue;
        let header;
        try { header = JSON.parse(m[1]); } catch { continue; }
        if (!header?.id || byId.has(header.id)) continue;
        byId.set(header.id, header);
      }
    }
  }
  return [...byId.values()];
}

export function report(root, since = null) {
  const all = scanTree(root);
  const board = all.filter(isBoardNotification);
  const selfMail = all.filter(isMisattribution);
  const noFrom = all.filter((h) => !String(h?.from ?? "").trim());
  const after = (h) => !since || Date.parse(h.created || "") >= Date.parse(since);
  return {
    total: all.length,
    boardNotifications: board.length,
    boardFromCoordinator: board.filter((h) => h.from === "coordinator").length,
    selfMail: selfMail.length,
    selfMailAfter: selfMail.filter(after).length,
    selfMailAfterMessages: selfMail.filter(after),
    missingFrom: noFrom.length,
  };
}

function main(argv) {
  const args = argv.slice(2);
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
  const root = args.find((a) => !a.startsWith("--") && a !== since) || ".";
  let stats;
  try { stats = report(root, since); } catch (err) {
    console.error(`cannot scan ${root}: ${err.message}`);
    process.exit(2);
  }
  console.log(`root:                 ${root}`);
  console.log(`unique messages:      ${stats.total}`);
  console.log(`board notifications:  ${stats.boardNotifications} (from=coordinator: ${stats.boardFromCoordinator})`);
  console.log(`self-mail, non-board: ${stats.selfMail}${since ? `, at or after ${since}: ${stats.selfMailAfter}` : ""}`);
  console.log(`missing/empty from:   ${stats.missingFrom}`);
  for (const h of stats.selfMailAfterMessages) {
    console.log(`  MISATTRIBUTED ${h.created} ${h.id} from=${h.from} to=${JSON.stringify(h.to)} ${String(h.subject).slice(0, 70)}`);
  }
  // A non-zero exit only when --since was asked for: the historical population is a fact
  // about the past and failing on it would make this tool unusable as a report.
  process.exit(since && stats.selfMailAfter > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main(process.argv);
