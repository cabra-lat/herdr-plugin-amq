# Herdr AMQ Plugin

[![CI](https://github.com/cabra-lat/herdr-plugin-amq/actions/workflows/ci.yml/badge.svg)](https://github.com/cabra-lat/herdr-plugin-amq/actions/workflows/ci.yml)
[![Security](https://github.com/cabra-lat/herdr-plugin-amq/actions/workflows/security.yml/badge.svg)](https://github.com/cabra-lat/herdr-plugin-amq/actions/workflows/security.yml)
[![Tests](https://img.shields.io/badge/tests-95%20passing-brightgreen.svg)](https://github.com/cabra-lat/herdr-plugin-amq)
[![Coverage](https://img.shields.io/badge/coverage-80%25-brightgreen.svg)](https://github.com/cabra-lat/herdr-plugin-amq)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Proudly Vibe Coded - Plasma Mix](https://vibecoded.fyi/badges/flat/main/proudly-vibe-coded-plasma-mix.svg)](https://vibecoded.fyi/)

Autonomous Agent Message Queue (AMQ) bridge daemon, mailbox monitor, decentralized task bus, CAS blobstore, and AGmail dashboard for Herdr & AI coding agents.

## Overview

AMQ provides reliable, durable, asynchronous message queuing between AI agents. Herdr provides terminal workspaces, pane management, and real-time agent status tracking.

This plugin ties them together into a unified workflow:
- **Autonomous Bridge**: Automatically checks agent inboxes and rings doorbells via `herdr agent prompt` whenever an agent is idle or finished with its turn.
- **Agent Presence & Healing**: Auto-reconnects and renames panes if agent session titles get desynced.
- **Blocked State Alerts**: Logs alerts when an agent with unread mail becomes blocked on external user input.
- **Mailbox Status Action**: Inspects unread message counts across all agents directly inside Herdr.
- **AGmail Dashboard**: Opens the full webmail dashboard or an interactive terminal inbox peek in a Herdr pane.

## Requirements

- Node.js >= 18
- Herdr >= 0.7.0 *(optional, only if using Herdr terminal workspaces & panes)*
- **Zero runtime dependencies** — 100% self-contained ESM with native pure-JS Maildir & RFC 5322 engine (external `amq` Go binary is NOT required).

## Installation & Linking

For Herdr plugin integration:

```bash
# Link plugin from local repository clone
herdr plugin link .
```

Verify that the plugin is recognized:

```bash
herdr plugin list
herdr plugin action list --plugin cabra.amq
```

## Available Actions

Invoke any action using the Herdr CLI:

```bash
# Check queue status and unread mail per agent
herdr plugin action invoke cabra.amq.bridge-status

# Start background bridge daemon
herdr plugin action invoke cabra.amq.bridge-start

# Stop background bridge daemon
herdr plugin action invoke cabra.amq.bridge-stop

# Trigger an immediate one-shot doorbell check
herdr plugin action invoke cabra.amq.doorbell-check

# Open AGmail pure JS dashboard in your browser
herdr plugin action invoke cabra.amq.open-dashboard
```

## Panes

Open the inbox peek popup in a modal terminal pane:

```bash
herdr plugin pane open --plugin cabra.amq --entrypoint inbox-popup
```

Open the AGmail dashboard server in a Herdr pane:

```bash
herdr plugin pane open --plugin cabra.amq --entrypoint dashboard
```

## Recommended Herdr Keybindings

Add keybindings to your `~/.config/herdr/config.toml` to control the bridge and peek into your mail quickly:

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "cabra.amq.bridge-status"
description = "Check AMQ mailbox status"

[[keys.command]]
key = "prefix+M"
type = "plugin_action"
command = "cabra.amq.doorbell-check"
description = "Ring AMQ doorbells for idle agents"
```

## File Structure

```text
herdr-plugin-amq/
├── herdr-plugin.toml   # Herdr plugin manifest
├── package.json        # NPM package metadata
├── README.md           # Documentation
├── bin/
│   └── herdr-amq.mjs   # Main executable CLI dispatcher
└── src/
    ├── index.mjs       # Module exports
    ├── config.mjs      # AMQ root discovery & Herdr environment helpers
    ├── store.mjs       # Mailbox reader, writer & parser
    ├── bridge.mjs      # Bridge engine, daemon loop & state management
    ├── server.mjs      # Lightweight HTTP server & Server-Sent Events (SSE)
    ├── actions.mjs     # Herdr action handlers
    ├── panes.mjs       # Herdr pane entrypoint launchers
    └── web/
        ├── index.html  # Authentic Gmail clone frontend
        ├── style.css   # Material 3 & Google style styling
        └── app.js      # Client app, search, compose, smart replies & SSE
```

## Testing & Code Coverage

Zero external testing dependencies — uses Node.js native test runner and experimental test coverage reporting:

```bash
# Run 80 automated unit & integration tests
npm test

# Run tests with experimental coverage and export standard lcov
npm run test:coverage

# Run JavaScript module syntax check
npm run check
```

## Agentic Skill

Introspect or install the machine-readable `SKILL.md` for AI coding agents (Herdr, OpenCode, Antigravity, Claude Code):

```bash
# Print skill to stdout
herdr-amq --skill

# Install into .opencode/skills/herdr-amq/SKILL.md
herdr-amq --skill --install
```

## Security & Threat Model (Local-Only Architecture)

> **IMPORTANT**: The AGmail dashboard is strictly a **local development tool** for inspecting agent communication. **It must never be exposed to public networks or untrusted LANs.**

By default, `herdr-amq` implements strict defense-in-depth protections:

- **Loopback Interface Binding**: The HTTP server explicitly binds only to `127.0.0.1` (never `0.0.0.0`), dropping all non-local incoming TCP connections at the OS network stack.
- **DNS Rebinding Protection**: All incoming HTTP requests validate the `Host` header. Requests claiming external domain names or remote IPs receive immediate `403 Forbidden`.
- **System Path Traversal Defense**: The `/api/file` and `/api/git-file` endpoints strictly enforce jail roots (`isPathSafe`), denying access to `.ssh`, `.env`, `/etc`, credentials, dotfiles, or paths outside the workspace/temp trees.
- **Null-Byte Injection Neutralization**: Any URL or path containing `%00` or `\0` is blocked before file resolution.
- **Strict Browser Headers**: Enforces `X-Frame-Options: DENY` (anti-clickjacking), `X-Content-Type-Options: nosniff`, and restrictive `Content-Security-Policy` with `frame-ancestors 'none'`.
- **Zero Runtime Dependencies**: No npm supply-chain vulnerabilities or third-party tracking scripts.

## License

MIT
