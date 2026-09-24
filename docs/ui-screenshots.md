# AGmail visual tour

These captures come from the isolated browser fixture. They contain no live mailbox data and are checked by the desktop/mobile journey suite.

## Threaded mail

The mail view keeps the latest message, sender metadata, thread navigation, and quick-reply actions together.

![AGmail threaded mail with verification evidence](images/agmail-mail-thread.webp)

## Agent activity

The activity sheet combines the live Herdr state, assigned task, unread count, pane ID, and the model reported by the running harness. The model is sourced from Herdr/OpenCode session metadata when available, rather than blindly displaying a placeholder; if no model is available, the sheet shows `Not configured`.

![AGmail agent activity sheet showing live task, pane, and harness model](images/agmail-agent-activity.webp)

## Task dossier

The task drawer keeps the stage controls, owner, linked AMQ thread, transmissions, and dispatch composer together while preserving the board context behind the drawer.

![AGmail task dossier with linked transmissions and dispatch controls](images/agmail-task-drawer.webp)

## Human and agent personas

The persona switcher makes the active identity explicit and scopes mailbox and compose identity to the selected human or agent persona.

![AGmail persona switcher showing human and agent identities](images/agmail-persona-switcher.webp)

## Mobile presence

The mobile layout keeps the inbox, agent presence, and navigation usable on a narrow screen.

![AGmail mobile swarm presence](images/agmail-mobile-presence.webp)

## Compact New Task flow

At 320×568, the owner tip and sticky action row remain visible. The form warns before assigning a card to an owner with claimed or blocked work.

![Compact mobile New Task form with visible Cancel and Create Task actions](images/agmail-mobile-new-task.webp)
