# Installation and Herdr setup

## Requirements

- Node.js 18 or newer
- Herdr 0.7.0 or newer
- A repository with a `.agent-mail` queue, or run fleet bootstrap to create one
- Chrome/Chromium only for the optional browser journeys

The runtime has no npm production dependencies. `playwright-core` is a development-only dependency for the browser suite.

## Link the plugin

```bash
git clone https://github.com/cabra-lat/herdr-plugin-amq.git herdr-plugin-amq
cd herdr-plugin-amq
herdr plugin link .
herdr plugin list
herdr plugin action list --plugin cabra.amq
```

The dashboard and queue root are discovered from the current workspace. The web server binds to `127.0.0.1` and refuses foreign `Host` headers.

## Herdr actions

```bash
herdr plugin action invoke cabra.amq.bridge-status
herdr plugin action invoke cabra.amq.bridge-start
herdr plugin action invoke cabra.amq.bridge-stop
herdr plugin action invoke cabra.amq.doorbell-check
herdr plugin action invoke cabra.amq.open-dashboard
herdr plugin action invoke cabra.amq.migrate
```

Example keybindings for `~/.config/herdr/config.toml`:

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

## Panes

```bash
herdr plugin pane open --plugin cabra.amq --entrypoint inbox-popup
herdr plugin pane open --plugin cabra.amq --entrypoint dashboard
```

The dashboard entrypoint is also available as `herdr-amq dashboard` and defaults to `http://127.0.0.1:8505`.

## Browser verification

The browser suite uses an isolated Maildir, board, and fake Herdr socket. It never reads or writes the live swarm.

```bash
npm ci --ignore-scripts
CHROMIUM_BIN="$(command -v chromium)" npm run test:e2e
E2E_ARTIFACT_DIR="$PWD/artifacts/e2e" CHROMIUM_BIN="$(command -v chromium)" npm run test:e2e
```

The suite covers desktop, 390×844 mobile, and 320×568 compact journeys, including the activity sheet, task drawer, sticky message header, pull-to-refresh guard, and New Task action visibility. Screenshots and `report.json` are written under `artifacts/e2e/`.
