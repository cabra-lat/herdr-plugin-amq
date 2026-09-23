# Herdr AMQ Plugin

Autonomous Agent Message Queue (AMQ) bridge daemon, mailbox monitor, and AGmail dashboard for Herdr.

## Overview

AMQ provides reliable, durable, asynchronous message queuing between AI agents. Herdr provides terminal workspaces, pane management, and real-time agent status tracking.

This plugin ties them together into a unified workflow:
- **Autonomous Bridge**: Automatically checks agent inboxes and rings doorbells via `herdr agent prompt` whenever an agent is idle or finished with its turn.
- **Agent Presence & Healing**: Auto-reconnects and renames panes if agent session titles get desynced.
- **Blocked State Alerts**: Logs alerts when an agent with unread mail becomes blocked on external user input.
- **Mailbox Status Action**: Inspects unread message counts across all agents directly inside Herdr.
- **AGmail Dashboard**: Opens the full webmail dashboard or an interactive terminal inbox peek in a Herdr pane.

## Requirements

- Herdr >= 0.7.0
- Node.js >= 18
- `amq` CLI installed and available on PATH (or in `~/.local/bin/amq`)

## Installation & Linking

For local development, link this repository to your Herdr installation:

```bash
herdr plugin link /home/cabra.lat/documents/coding/herdr-plugin-amq
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

## License

MIT
