---
name: herdr-amq
description: Autonomous coordination, inter-agent messaging, task claiming, and CAS blob attachments via AMQ Maildir and Herdr. Use when communicating between agents, claiming board tasks, sending reports with attachments, or inspecting the live AGmail dashboard.
metadata:
  short-description: AMQ Maildir & Herdr Multi-Agent Autonomous Coordination
  compatibility: herdr, opencode, antigravity, claude-code, codex-cli
---

# Herdr AMQ Autonomous Coordination (`herdr-amq`)

`herdr-amq` provides native multi-agent messaging, decentralized task tracking, and immutable Content-Addressed Storage (CAS) attachments over standard Maildir queues (`.agent-mail/`) without requiring external binaries.

## Golden Rules for Agents

1. **Drain First**: Whenever awakened by a doorbell notification or starting a turn, drain your inbox and check assigned backlog tasks:
   ```bash
   herdr-amq mail drain --me <handle> --include-body
   herdr-amq task drain --me <handle>
   ```
2. **Reply to the Sender**: Always reply to the sender on the same thread/ref chain. Never drop thread context:
   ```bash
   herdr-amq mail reply --me <handle> --id <msg_id> --body "..."
   ```
3. **Atomic Task Claiming**: Claim cards from the directory bus before modifying shared code:
   ```bash
   herdr-amq task drain --me <handle>
   herdr-amq task claim <task-id> --me <handle>
   # Or auto-claim next in a single command:
   herdr-amq task next --me <handle>
   ```
   When finished, complete with proof:
   ```bash
   herdr-amq task done <task-id> --proof "Tests passed (70/70), commit abc123"
   ```
   If blocked, flag with reason:
   ```bash
   herdr-amq task block <task-id> --reason "Waiting for schema migration"
   ```
4. **CAS Blob Attachments**: Use `--attach <path>` when sending logs, diffs, images, or test outputs. The file is automatically frozen into immutable Content-Addressed Storage (`.agent-mail/blobs/<sha256>`) and exposed via persistent HTTP URLs:
   ```bash
   herdr-amq mail send --me <handle> --to coordinator --subject "Test run output" --body "Attached full test logs" --attach /tmp/shooter/test.log
   ```

## CLI Reference

### Inter-Agent Mail (`herdr-amq mail` or shortcuts `send`, `reply`, `drain`)

| Command | Usage | Description |
|---|---|---|
| `drain` | `herdr-amq mail drain --me <handle> [--include-body]` | Atomic Maildir drain (moves `inbox/new` -> `inbox/cur`, marks seen) |
| `send` | `herdr-amq mail send --to <handle> --subject <subj> --body <text\|@file> [--me <handle>] [--attach <path>]` | Send an RFC 5322 message with optional CAS attachment |
| `reply` | `herdr-amq mail reply --id <msg_id> --body <text\|@file> [--me <handle>] [--attach <path>]` | Reply preserving `thread`, `in-reply-to`, and `references` |

### Task Board & Bus (`herdr-amq task`)

Operates against decentralized card files in `.agent-mail/bus/{backlog,doing,blocked,done}/`:

| Command | Usage | Description |
|---|---|---|
| `list` | `herdr-amq task list [--json]` | List cards grouped by column |
| `drain` | `herdr-amq task drain --me <handle> [--claim]` | Drain assigned backlog cards with full description bodies, optionally claiming |
| `next` | `herdr-amq task next --me <handle>` | Shortcut to auto-claim and start next assigned backlog card |
| `claim` | `herdr-amq task claim <task-id> --me <handle>` | Atomically moves card to `doing/<task-id>.md` and updates assignee |
| `done` | `herdr-amq task done <task-id> --proof "<proof>"` | Moves card to `done/` with timestamp, proof, and duration |
| `block` | `herdr-amq task block <task-id> --reason "<reason>"` | Moves card to `blocked/` with blocker reason |

### Fleet Management & Cold-Start (`herdr-amq fleet` / `bootstrap`)

Unifies external tool agent briefs (`.opencode/agents`, `.agents`, `.pi/agents`, `.claude/agents`, `AGENTS.md`) and automates swarm provisioning:

| Command | Usage | Description |
|---|---|---|
| `fleet status` | `herdr-amq fleet status` | Discover personas across external tools and show live Herdr pane states |
| `fleet prepopulate` | `herdr-amq fleet prepopulate` | Ensure Maildirs, Git worktrees, and workspace trust exist for all personas |
| `fleet up` | `herdr-amq fleet up [--kind agy\|opencode\|pi]` | Launch missing fleet agents into isolated Herdr tabs with auto-trust & clean PATH |
| `bootstrap` | `herdr-amq bootstrap [--kind agy]` | Instant cold-start: prepopulate + launch fleet + start bridge daemon + doorbell pass |
| `migrate` | `herdr-amq migrate [--dry-run]` | Migrate historical attachments into CAS blobs or pinned Git commits |

### Bridge, Dashboard & Status

| Command | Usage | Description |
|---|---|---|
| `status` | `herdr-amq status` | Show bridge daemon status, unread counts per handle, and paths |
| `doorbell` | `herdr-amq doorbell` | Run a single doorbell pass alerting idle/blocked agents |
| `dashboard` | `herdr-amq dashboard [--port 8505]` | Launch web AGmail UI & REST API |
| `--skill` | `herdr-amq --skill [--install [dir]]` | Print or install this agentic skill definition |
