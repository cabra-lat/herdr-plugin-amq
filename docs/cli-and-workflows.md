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
herdr-amq task claim <task-id> --me <handle>
herdr-amq task done <task-id> --proof "Verification evidence"
herdr-amq task block <task-id> --reason "Waiting on an external dependency"

herdr-amq migrate [--dry-run] [--verbose]
herdr-amq --skill
herdr-amq --skill --install .opencode/skills/herdr-amq/SKILL.md
```

Mail messages use Maildir delivery and RFC 5322 threading headers. Attachments are stored through the CAS blobstore or pinned to a Git object when migrating historical files.

## Task ownership and execution policy

The complete task-card contract, ownership boundaries, tuning metrics, bridge behavior, and single-workstation runner policy are documented in [Operating model](operating-model.md). The card lifecycle is intentionally small:

```text
backlog -> doing -> done
                 \-> blocked -> doing
```

Always claim before editing, keep one owner per card, and finish with a proof string containing the relevant files, commands, exit codes/check counts, and reviewer evidence. Use the local lock policy for shared Godot resources; do not race imports against the shared `.godot/` cache.

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
