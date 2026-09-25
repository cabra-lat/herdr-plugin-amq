# Operating model: task cards, fleet resources, and local execution

This document defines the Phase 0 operating model for a Herdr/AMQ fleet. It is deliberately a policy and evidence contract, not a second task database. AMQ task cards remain the source of truth; Herdr owns pane lifecycle; the local runner policy protects shared workstation resources.

## Ownership boundaries

| Area | Owner | Boundary |
| --- | --- | --- |
| Prioritization and routing | Any registered agent; `coordinator` coordinates | Routine cards may be autonomously prioritized, assigned, claimed, and re-scoped by the agent best suited to the work. The coordinator resolves cross-lane dependencies and escalates exceptions. |
| Game implementation | Game-development lanes | Owns the assigned game files, focused tests, and implementation evidence. They do not change Herdr/AMQ infrastructure or another lane's file set. |
| Herdr/AMQ infrastructure | `agsuite-dev` / infrastructure lane | Owns the plugin, bridge, fleet lifecycle, identity propagation, mailbox policy, and operational runbooks. Register a dedicated `agsuite-team` handle before making that role permanent. |
| Acceptance and release gates | `qa`, `testkit`, `verifier` | Define and run independent acceptance checks. They report failures rather than silently changing another lane's implementation. |
| Metrics and board health | `meta` | Owns metric definitions, aggregation, and reporting thresholds. It may propose tuning cards but does not rewrite implementation tasks. |
| Numeric/visual verification | `spotter` | Provides an independent measurement or capture when a card requests numeric or visual proof. |

The current game repository and `herdr-plugin-amq` are separate repositories. A lane must commit and push only in the repository named by its card. The shared game repository also keeps `addons/cabra.lat_shooters` as a separate repository; never make a pathless cross-repository commit.

## Autonomous board and human playtest boundary

The board is an autonomous coordination surface, not a human approval queue. Agents may:

- prioritize routine work against dependencies, available capacity, and acceptance criteria;
- assign or claim a routine card within their capability and ownership boundaries;
- re-scope a routine card when evidence shows that the original decomposition is unsafe or wasteful;
- mark a card `blocked` and name the next actor when a dependency or decision is missing.

The coordinator owns cross-lane sequencing, routine approvals, and exception handling. There is no separate human approval gate for coordinator decisions; the only standing exception is remote deletion, which is never performed automatically. The human remains the game tester and product-feedback owner: they play the build, evaluate the player experience, and provide product decisions or ambiguity resolution. Their feedback creates or re-scopes cards; it is not a routine sign-off gate between an agent and `done`.

Escalate to the coordinator when the action is destructive or irreversible (for example, deleting data, changing a shared cache contract, force-pushing, or stopping another lane's work), when a safety/resource budget would be exceeded, or when product ambiguity changes the intended outcome. The coordinator decides and records the next action. A safe local re-scope, failed test, or normal blocker stays on the board with its evidence and next actor.

Keep the board lightweight. Each card should make these fields immediately visible: `next actor`, current stage, blocker/dependency, and whether a human playtest or product decision is `test-needed`. Do not add a second approval workflow or a separate database merely to record routine status.

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

The v1 card projection persists `schema_version`, `priority`, `claimed_at`, `blocked_at`, `done_at`, `last_heartbeat_at`, `claims`, `blocked_ms`, `block_reason`, `proof`, `depends_on`, and `next_actor` in the card itself. Claim/block/done transitions update these fields atomically with the stage move; proof and block reason are retained across later transitions. Older cards without these fields remain readable and are upgraded on their next write.

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

Any agent may create a tuning card, rather than silently changing a task, when a threshold is crossed. The coordinator sequences the resulting work and escalates only the exceptions described above:

- any P0 gate failure;
- two or more repeated failures at the same stage;
- a normal task blocked for more than 10 minutes without a heartbeat or dependency update;
- action-required reply latency above 20% of the last 10 tasks;
- more than one stale or duplicate pane for a registered handle;
- sustained resource pressure above the workstation budget, including insufficient RAM/VRAM headroom or a full-verification run that causes import contention.

A tuning card must name the metric, evidence window, suspected bottleneck, proposed change, owner, and expected improvement. `meta` reviews definitions; `qa`/`verifier` review the resulting gate; the coordinator decides whether the change is safe to roll out.

The coordinator view is read-only, while the coordinator agent owns the resulting decisions. `GET /api/board` includes the same `coordinator` metrics object as the doorbell pass, while `herdr-amq doorbell` prints any current alerts. Alerts provide the recommended next actor/action for coordinator triage and approval. The coordinator may approve and execute any action except remote deletion; remote branches, tags, and other remote refs are never deleted automatically. The Metrics view includes a toggle for the coordinator re-evaluation doorbell, a bounded cooldown (five minutes by default), and the recent coordinator-doorbell log. When enabled, an idle/done coordinator receives one deduplicated prompt for critical, backlog-idle, or retry/failure alerts so it can delegate, approve, or re-scope stalled work. The runtime currently derives retry counts from doorbell delivery attempts and failure/blocker counts from blocked cards; richer gate-level failure telemetry can be added without changing the board contract.

## Local runner policy for one workstation

A single 20 GB RAM, 4-core 3 GHz workstation with one NVIDIA GPU should use the simpler local queue and lock policy, not Slurm. The current topology has one shared machine, and Slurm would add scheduler administration without adding multi-node throughput.

The policy is:

1. Herdr owns panes and canonical identities; AMQ Maildir is the durable queue.
2. Permit one Godot import and one full verification/export job at a time.
3. The one-heavy-job-per-host cap is enforced by the shared repository lock: every heavy Godot invocation must acquire the same fail-closed lock before starting. A second job waits for the bounded lease and exits with a lock error if it cannot acquire; it never runs merely because the dashboard reports a breach.
4. Permit additional lightweight harnesses only after measuring CPU/RAM headroom; default to one active worker for safety.
5. Run Godot commands through the repository lock wrapper. Never race direct imports against the shared `.godot/` cache.
6. Bound retries with exponential backoff. After the retry limit, mark the card `blocked` with the command, exit code, and log location.
7. Preserve the operator's desktop and Herdr process by reserving memory headroom; reduce concurrency before upgrading the runner.

The coordinator alert thresholds are queue age 300/900/1800 seconds (warning/critical/page), blocked age 600/1800 seconds, retries 2/3 with delivery age over 300 seconds, import age 120/300 seconds, CPU 75% sustained for 60 seconds, RSS 1/1.5 GiB, GPU VRAM 80%, and pane staleness 30/120 seconds. The dashboard reports these values and recommended actions; it does not bypass the lock, and destructive actions require an explicit coordinator decision and evidence.

A future Slurm migration is justified only when the fleet becomes multi-node, multiple users need shared compute, or a central scheduler is required for fairness, quotas, and multi-job resource accounting. It is not a prerequisite for this workstation.

## Safe rollout and rollback

1. **Phase 0 — document and baseline:** adopt the card contract, autonomous routing boundary, ownership table, metric definitions, and resource budgets; record current pane and queue state.
2. **Phase 1 — pilot:** run the board and metric collection on two or three low-risk cards. Compare dashboard state with actual Maildir, task-bus, and Herdr state.
3. **Phase 2 — alert:** enable stale-pane, repeated-failure, DLQ, reply-latency, and resource-pressure alerts while retaining coordinator override.
4. **Phase 3 — enforce local limits:** enable the single-import/full-gate policy and measured lightweight-harness allowance.
5. **Rollback:** disable the dashboard/bridge delivery or local runner without deleting AMQ cards or evidence. Revert plugin commits through the infrastructure repository's normal history. Do not roll back the game repository to address an infrastructure failure.

A rollout is successful only when identity, task state, pane state, and evidence agree across the AMQ CLI, bridge, and dashboard. Any disagreement is an infrastructure defect and should be recorded as a blocked card with a reproducible observation. Human playtest feedback is attached to the relevant card and drives the next test or implementation decision; it is not a hidden approval stage.
