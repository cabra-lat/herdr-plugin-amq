# Herdr AMQ Plugin

[![npm version](https://img.shields.io/npm/v/herdr-plugin-amq.svg)](https://www.npmjs.com/package/herdr-plugin-amq)
[![CI](https://github.com/cabra-lat/herdr-plugin-amq/actions/workflows/ci.yml/badge.svg)](https://github.com/cabra-lat/herdr-plugin-amq/actions/workflows/ci.yml)
[![Security](https://github.com/cabra-lat/herdr-plugin-amq/actions/workflows/security.yml/badge.svg)](https://github.com/cabra-lat/herdr-plugin-amq/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> The asynchronous nervous system for autonomous AI agent swarms in [Herdr](https://herdr.dev/).

Herdr AMQ combines native pure-JS Maildir messaging, lifecycle-aware doorbells, a decentralized task bus, immutable CAS evidence, and the local-first **AGmail** dashboard.

## Why it exists

LLM agents are turn-based: when an agent finishes a response or tool sequence, it goes idle. A persistent inbox is useful, but it needs a doorbell. Herdr AMQ watches agent panes, wakes only idle or done agents with unread mail or assigned backlog work, and leaves working panes alone.

The result is an asynchronous workflow:

1. A coordinator or human sends a message or creates a task.
2. The bridge detects the unread item and checks the Herdr pane state.
3. An idle agent receives a precise drain/claim prompt.
4. The agent works in its isolated worktree and replies on the original thread.
5. AGmail provides a human view of messages, activity, tasks, and evidence.

## Documentation map

- [Architecture and live model reporting](docs/architecture.md)
- [Installation and Herdr setup](docs/installation.md)
- [CLI, fleet lifecycle, and templates](docs/cli-and-workflows.md)
- [Security and testing](docs/security-and-testing.md)
- [AGmail visual tour](docs/ui-screenshots.md)

## Quick start

```bash
npm ci --ignore-scripts
herdr plugin link .
herdr-amq bootstrap --kind opencode
herdr-amq dashboard
```

The dashboard is local-only at `http://127.0.0.1:8505`. The CLI and agent protocol are documented in the [workflow guide](docs/cli-and-workflows.md).

## AGmail preview

![AGmail agent activity sheet](docs/images/agmail-agent-activity.webp)

The activity card reports live harness state and the current model when Herdr/OpenCode exposes it. Profile configuration remains a fallback, with the source exposed in the API.

![AGmail task dossier](docs/images/agmail-task-drawer.webp)

The compact mobile task form keeps its owner warning and action row visible at narrow widths.

![Compact AGmail New Task form](docs/images/agmail-mobile-new-task.webp)

## Requirements

- Node.js >= 18
- Herdr >= 0.7.0
- Chrome/Chromium for browser journeys only
- Zero npm runtime dependencies

## Verification

```bash
npm test
npm run test:e2e
npm run check
npm audit --audit-level=high
```

The browser suite uses an isolated Maildir, board, and fake Herdr socket, so screenshots and tests never touch the live swarm.

## License

MIT © [Cabra](https://cabra.pw)
