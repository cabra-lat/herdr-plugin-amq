# CLI and workflows

`herdr-amq` is the executable dispatcher in `bin/herdr-amq.mjs`. It is usable from an agent shell, a Herdr pane, or a human operator session.

## Core commands

```bash
herdr-amq dashboard
herdr-amq bridge-daemon
herdr-amq status

herdr-amq send --to spotter --subject "Check ADS alignment" --body @/tmp/prompt.txt
herdr-amq reply --id <message-id> --body "Reply on the original thread"
herdr-amq drain --me coordinator --include-body

herdr-amq task list
herdr-amq task drain --me <handle>
herdr-amq task next --me <handle>
herdr-amq task create --title "<title>" --me <handle> [--owner <h>] [--desc <text|@file>]  # alias of assign
herdr-amq task assign --to <handle> --title <title>
herdr-amq task claim <task-id> --me <handle>
herdr-amq task heartbeat <task-id> --me <handle>
herdr-amq task reassign <task-id> --to <handle> [--next-actor <handle>]
herdr-amq task comment <task-id> --me <handle> --text "Progress note; does not count as activity"
herdr-amq task done <task-id> --proof "Verification evidence"
herdr-amq task block <task-id> --reason "Waiting on an external dependency" \
  --next-actor <handle> --depends-on <task-id,task-id>

herdr-amq migrate [--dry-run] [--verbose]
herdr-amq --skill
herdr-amq --skill --install .opencode/skills/herdr-amq/SKILL.md
```

Mail messages use Maildir delivery and RFC 5322 threading headers. Attachments are stored through the CAS blobstore or pinned to a Git object when migrating historical files.

Unknown task subcommands and options exit non-zero with a specific diagnostic on stderr. `herdr-amq task --help` (also `-h` and `help`) and `herdr-amq task <subcommand> --help` all print the verb list and exit 0, so the instruction in the unknown-subcommand diagnostic is always followable. A task comment is persisted on the card and shown by `task show`, but does not change the card's `updated` timestamp, claim, or heartbeat fields.

`--text`, `--reason` and `--desc` accept `@path` and read the file, matching `amq send --body` and `amq reply --body`; a path that cannot be read is a non-zero error rather than a stored literal.

`task show` renders every field the CLI can write, including `block_reason`, `proof`, `next_actor`, `depends_on` and the heartbeat author. A field that is written but never displayed is indistinguishable from a dropped write, so the read path and the write path are kept in step deliberately.

## Liveness, triage and metadata

- `task heartbeat <id> --me <handle>` records `last_heartbeat_at` and `last_heartbeat_by` and nothing else. It does not change the stage, `updated`, the claim count, or the notes, so it cannot be used to fake progress; it exists so the stall detector measures liveness instead of claim bookkeeping. The stall detector reads the newest of `last_heartbeat_at` and `updated`. The verb is not restricted to the owner, because a coordinator legitimately needs to signal "I am actively working this", but the author is recorded and a heartbeat from anyone but the owner is surfaced as such in the alert payload.
- `task comment` is evidence of progress and is deliberately **not** liveness: a note never moves `updated`, so commenting cannot keep a stalled card alive. Alerts surface `noteCount`/`lastNoteAt` so a reader can judge, not so a detector can be satisfied.
- A blocked card that carries a `reason` is considered triaged and is excluded from `blocked_cards`/`blocked_age`; only cards with no reason alert, and the message reports the untriaged count and how many triaged cards were excluded. Record the triage in one call so the fields and the prose cannot disagree:
  `herdr-amq task block <id> --reason "Waiting on spotter for the numeric capture" --next-actor spotter --depends-on task_xyz`
- `next_actor` is never inferred from a reason string. Blocking a card without `--next-actor` leaves the field as it was, and a card that has never had one reports none: an absent next actor is better than a confidently wrong one. Pass `--next-actor none` to clear a stale value.
- `task reassign <id> --to <handle>` changes the owner without churning the card id or its claim history.

## Task ownership and execution policy

The complete task-card contract, ownership boundaries, tuning metrics, bridge behavior, and single-workstation runner policy are documented in [Operating model](operating-model.md). The card lifecycle is intentionally small:

```text
backlog -> doing -> done
                 \-> blocked -> doing
```

Always claim before editing, keep one owner per card, and finish with a proof string containing the relevant files, commands, exit codes/check counts, and reviewer evidence. Use the local lock policy for shared Godot resources; do not race imports against the shared `.godot/` cache.

Routine cards may be autonomously prioritized, assigned, claimed, and re-scoped by agents. The human owns game playtesting and product feedback, not routine implementation approval. Escalate only destructive or irreversible actions, resource/safety-limit violations, or unresolved product ambiguity. Keep the board lightweight by showing the next actor, blockers, and `test-needed` items.

## Fleet lifecycle

```bash
herdr-amq fleet status
herdr-amq fleet prepopulate
herdr-amq fleet up --kind opencode --agents coordinator,range,qa
herdr-amq bootstrap --kind opencode
```

Bootstrap discovers supported persona directories and worktrees, provisions Maildirs, delivers first-registration welcomes, prepares isolated worktrees, starts the bridge daemon, and performs an initial doorbell pass.

## Local prompt templates

Optional files customize local policy:

```text
.agent-mail/templates/welcome.md
.agent-mail/templates/doorbell.md
```

Templates support scalar substitutions only. The doorbell always appends the required drain/claim actions and conditional-reply guidance, so a template cannot disable delivery or make an unrequested reply.

Supported doorbell variables:

| Variable | Meaning |
|---|---|
| `agent.handle` | Recipient handle |
| `mail.count` | Unread message count |
| `mail.senders` | Sanitized sender list |
| `board.backlog` | Assigned backlog count |
| `board.blocked` | Assigned blocked count |
| `board.doing` | Assigned in-progress count |
| `board.done` | Assigned completed count |
| `board.total` | Total board cards |

## Agent skill

```bash
herdr-amq --skill
herdr-amq --skill --install .opencode/skills/herdr-amq/SKILL.md
```

The skill teaches an agent to drain first, claim before editing, preserve threads on replies, and include proof when completing a card.
