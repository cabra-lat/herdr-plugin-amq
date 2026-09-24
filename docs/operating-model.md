# Operating model: task cards, fleet resources, and local execution

This document defines the Phase 0 operating model for a Herdr/AMQ fleet. It is deliberately a policy and evidence contract, not a second task database. AMQ task cards remain the source of truth; Herdr owns pane lifecycle; the local runner policy protects shared workstation resources.

## Ownership boundaries

| Area | Owner | Boundary |
| --- | --- | --- |
| Prioritization and routing | `coordinator` | Owns the board, dependencies, assignment, escalation, and final cross-lane handoff. |
| Game implementation | Game-development lanes | Owns the assigned game files, focused tests, and implementation evidence. They do not change Herdr/AMQ infrastructure or another lane's file set. |
| Herdr/AMQ infrastructure | `agsuite-dev` / infrastructure lane | Owns the plugin, bridge, fleet lifecycle, identity propagation, mailbox policy, and operational runbooks. Register a dedicated `agsuite-team` handle before making that role permanent. |
| Acceptance and release gates | `qa`, `testkit`, `verifier` | Define and run independent acceptance checks. They report failures rather than silently changing another lane's implementation. |
| Metrics and board health | `meta` | Owns metric definitions, aggregation, and reporting thresholds. It may propose tuning cards but does not rewrite implementation tasks. |
| Numeric/visual verification | `spotter` | Provides an independent measurement or capture when a card requests numeric or visual proof. |

The current game repository and `herdr-plugin-amq` are separate repositories. A lane must commit and push only in the repository named by its card. The shared game repository also keeps `addons/cabra.lat_shooters` as a separate repository; never make a pathless cross-repository commit.

## Task-card contract

Every actionable request should have one AMQ card. A card contains these fields in its description or linked thread:

- **Title and outcome**: a short statement of what must be true when complete.
- **Owner**: exactly one registered agent handle. The owner claims the card before editing.
- **Priority**: `P0`, `P1`, or `normal`.
- **Scope**: repository, file set, and any explicitly out-of-scope areas.
- **Dependencies**: card IDs or external decisions that must be resolved first.
- **Acceptance criteria**: observable checks, including required evidence.
- **Verification**: the command, harness, reviewer, or measurement that closes the card.
- **Rollout/rollback**: when the change affects panes, queues, locks, or shared resources.

The supported lifecycle is:

```text
backlog -> doing -> done
                 \-> blocked -> doing
```

`done` requires a proof string containing the relevant paths, commands, exit codes/check counts, and reviewer evidence. `blocked` must name the dependency or decision needed and the next actor. A card is not complete merely because code was written or a command was started.

The normal routing sequence is:

```bash
herdr-amq task drain --me <handle>
herdr-amq task next --me <handle>
herdr-amq task claim <task-id> --me <handle>
# execute only within the card's scope
herdr-amq task done <task-id> --me <handle> --proof "<evidence>"
# or
herdr-amq task block <task-id> --me <handle> --reason "<dependency/decision>"
```

Messages that request action or ask a question receive a reply to the sender on the original thread. Informational broadcasts do not require an acknowledgement. The sender's handle and the original message ID remain part of the audit trail.

## Fleet and bridge behavior

A fleet launch must provide the agent identity to the child process:

```text
HERDR_AGENT_HANDLE=<handle>
AMQ_AGENT_HANDLE=<handle>
```

Herdr names and explicit worktree names are identity hints, not a reason to infer a mailbox from inbox contents. An unregistered root pane is not silently assigned to an arbitrary handle. The bridge must never prompt a `working` pane, must deduplicate delivered message/task IDs, and must raise a coordinator alert for a `blocked` pane or lane.

`fleet up` and `fleet down` must protect the pane issuing the command. Replacement matching uses the canonical Herdr agent name; cwd is only a worktree hint. A healthy launch has one canonical Pi pane per registered handle. Replacement is allowed from an external shell when the old canonical pane is stale, but the active operator pane is never closed by its own fleet command.

The bridge is a delivery mechanism, not a scheduler. It watches Maildir/task state and wakes only an actionable pane. It must not run game imports, verification, or arbitrary task code on behalf of an agent.

## Metrics and tuning thresholds

Record the following on every card and retain the raw command/measurement evidence in the thread or CAS attachment:

- queue wait, active time, blocked time, reviewer wait, handoffs, and heartbeat age;
- claim, parse/build, harness, quality-gate, and export outcomes, including exit status and check counts;
- retry count, repeated-failure count, malformed-mail/DLQ count, and action-message reply latency;
- Herdr pane count, pane state, stale-pane age, and duplicate-pane count;
- workstation CPU, RSS/peak RAM, GPU utilization/VRAM, and Godot import/verification duration.

The coordinator creates a tuning card, rather than silently changing a task, when a threshold is crossed:

- any P0 gate failure;
- two or more repeated failures at the same stage;
- a normal task blocked for more than 10 minutes without a heartbeat or dependency update;
- action-required reply latency above 20% of the last 10 tasks;
- more than one stale or duplicate pane for a registered handle;
- sustained resource pressure above the workstation budget, including insufficient RAM/VRAM headroom or a full-verification run that causes import contention.

A tuning card must name the metric, evidence window, suspected bottleneck, proposed change, owner, and expected improvement. `meta` reviews definitions; `qa`/`verifier` review the resulting gate; the coordinator decides whether the change is safe to roll out.

## Local runner policy for one workstation

A single 20 GB RAM, 4-core 3 GHz workstation with one NVIDIA GPU should use the simpler local queue and lock policy, not Slurm. The current topology has one shared machine, and Slurm would add scheduler administration without adding multi-node throughput.

The policy is:

1. Herdr owns panes and canonical identities; AMQ Maildir is the durable queue.
2. Permit one Godot import and one full verification/export job at a time.
3. Permit additional lightweight harnesses only after measuring CPU/RAM headroom; default to one active worker for safety.
4. Run Godot commands through the repository lock wrapper. Never race direct imports against the shared `.godot/` cache.
5. Bound retries with exponential backoff. After the retry limit, mark the card `blocked` with the command, exit code, and log location.
6. Preserve the operator's desktop and Herdr process by reserving memory headroom; reduce concurrency before upgrading the runner.

A future Slurm migration is justified only when the fleet becomes multi-node, multiple users need shared compute, or a central scheduler is required for fairness, quotas, and multi-job resource accounting. It is not a prerequisite for this workstation.

## Safe rollout and rollback

1. **Phase 0 — document and baseline:** adopt the card contract, ownership table, metric definitions, and resource budgets; record current pane and queue state.
2. **Phase 1 — pilot:** run the board and metric collection on two or three low-risk cards. Compare dashboard state with actual Maildir, task-bus, and Herdr state.
3. **Phase 2 — alert:** enable stale-pane, repeated-failure, DLQ, reply-latency, and resource-pressure alerts while retaining coordinator override.
4. **Phase 3 — enforce local limits:** enable the single-import/full-gate policy and measured lightweight-harness allowance.
5. **Rollback:** disable the dashboard/bridge delivery or local runner without deleting AMQ cards or evidence. Revert plugin commits through the infrastructure repository's normal history. Do not roll back the game repository to address an infrastructure failure.

A rollout is successful only when identity, task state, pane state, and evidence agree across the AMQ CLI, bridge, and dashboard. Any disagreement is an infrastructure defect and should be recorded as a blocked card with a reproducible observation.
