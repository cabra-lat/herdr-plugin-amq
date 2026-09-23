import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { findAmqRoot, getAgentHandles, execCmd } from "./config.mjs";
import { listInbox } from "./bridge.mjs";

import { startWebServer } from "./server.mjs";

export function launchDashboardPane() {
  const amqRoot = findAmqRoot();
  console.log("\x1b[1m✉️  AGmail Dashboard (Pure JS)\x1b[0m\n");

  if (!amqRoot) {
    console.error("❌ No .agent-mail directory found in current workspace.");
    process.exit(1);
  }

  const port = parseInt(process.env.AGMAIL_PORT || "8505", 10);
  const server = startWebServer({ port, amqRoot });

  // Open browser in background if xdg-open exists
  try {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [`http://localhost:${port}`], { stdio: "ignore", detached: true }).unref();
  } catch {}

  console.log("\nPress Ctrl+C to stop the dashboard server.");
}

export function launchInboxPeekPane() {
  const amqRoot = findAmqRoot();
  if (!amqRoot) {
    console.log("❌ No .agent-mail directory found.");
    process.exit(1);
  }

  renderInboxSummary(amqRoot);
}

export function renderInboxSummary(amqRoot) {
  const handles = getAgentHandles(amqRoot);
  console.log(`\x1b[1m📫 AMQ Mailbox Overview\x1b[0m: \x1b[36m${amqRoot}\x1b[0m\n`);

  let totalMsgs = 0;
  for (const h of handles) {
    const msgs = listInbox(amqRoot, h);
    if (!msgs.length) continue;
    totalMsgs += msgs.length;

    console.log(`\x1b[1m\x1b[33m📥 ${h}\x1b[0m (\x1b[32m${msgs.length} unread\x1b[0m)`);
    for (const m of msgs.slice(0, 5)) {
      const from = m.from || "unknown";
      const subject = m.subject || "(no subject)";
      const id = m.id ? `[${m.id.slice(0, 8)}]` : "";
      console.log(`   • \x1b[90m${id}\x1b[0m \x1b[1m${from}\x1b[0m: ${subject}`);
    }
    if (msgs.length > 5) {
      console.log(`   \x1b[90m... and ${msgs.length - 5} more\x1b[0m`);
    }
    console.log("");
  }

  if (totalMsgs === 0) {
    console.log("✨ All inboxes are clear! No unread transmissions.");
  }

  console.log("\x1b[90mPress Enter or Escape to close.\x1b[0m");
}
