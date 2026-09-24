# INFRA-1 QA report — executable job queue

Date: 2026-09-24
Scope: plugin infrastructure only; no Godot/game files changed.

## Delivered

- `src/job-queue.mjs` provides a durable JSON-backed queue with:
  - `queued`, `running`, `succeeded`, `failed`, and `cancelled` states;
  - required idempotency keys and fingerprint conflict detection;
  - lease, heartbeat, expiry recovery, and bounded history/concurrency samples;
  - bounded non-Godot concurrency;
  - a one-job Godot cap;
  - canonical repository `tools/godot-lock.sh` path and lock-contract validation for every Godot job;
  - argv execution without a shell;
  - non-destructive cancellation (a running process is not killed or restarted).
- Godot commands must use `kind: "godot"` and an existing shared lock wrapper. Direct `godot` commands are rejected as non-Godot jobs.
- `src/metrics-history.mjs` records bounded samples for agent states, queue depth, job outcomes, and job concurrency.
- `src/server.mjs` exposes:
  - `GET /api/jobs`;
  - `POST /api/jobs` for idempotent enqueue;
  - `POST /api/jobs/run` for bounded execution;
  - `PATCH /api/jobs/:id` for heartbeat/cancel;
  - `GET /api/jobs/:id` for job detail;
  - `GET /api/coordinator/history`.
- All job mutations require `AGMAIL_JOB_TOKEN` and the `X-AGmail-Job-Token` header. If the environment variable is unset, mutations fail closed with HTTP 503; loopback binding is not treated as authorization.
- The dashboard Metrics view now exposes queue depth, active jobs, outcomes, concurrency, and retained history sample count.
- Existing coordinator alerts remain advisory; no queue operation auto-approves work or destructive actions.

## Compatibility and retention

- Queue state accepts the schema-v1 object format and the legacy top-level job-array format. Legacy arrays are upgraded on the next mutation and reloading them is idempotent.
- Missing/invalid state fails closed as an empty in-memory queue without overwriting the source file, allowing operators to inspect/restore an interrupted migration artifact.
- History and concurrency samples are bounded by the configured limit (default 500; maximum 10,000).
- Godot execution requires the canonical repository `tools/godot-lock.sh`, including the shared-lock contract (`flock` plus `exec "$GODOT_BIN"`); same-basename temporary wrappers are rejected and the queue never invokes Godot directly.

## Verification

- `npm run check` — PASS
- `npm test` — **178 passed, 0 failed**
- `npm run test:e2e` — **2 passed, 0 failed**
- `git diff --check` — PASS
- Focused coverage includes:
  - durable state and idempotency;
  - explicit transitions and terminal outcomes;
  - non-Godot concurrency cap;
  - Godot serialization and wrapper enforcement;
  - non-destructive cancellation;
  - lease expiry fail-closed behavior;
  - legacy migration and bounded retention;
  - API enqueue/list/detail/run/cancel, mutation authorization, and metrics history;
  - canonical-wrapper rejection, durable lease recovery through metrics/list/expired heartbeat, and interrupted/idempotent migration fixtures.

## Review notes

Changes are intentionally uncommitted pending coordinator review. The local dashboard/bridge must be restarted to load the new module. The queue is an execution substrate, not an approval mechanism: callers remain responsible for authorization, scope, and human ownership of destructive or ambiguous product work.
