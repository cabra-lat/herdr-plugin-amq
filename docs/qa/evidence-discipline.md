# Evidence discipline: recorded constructed breaks

The rule in `docs/operating-model.md` requires a check to be seen red against a constructed
break before its green is reported. This file records the breaks that have actually been run, so
the claim "this test covers that defect" is checkable rather than asserted.

Each break was made in a throwaway copy of the repository (`tar` of the tree excluding
`.git` and `node_modules`, unpacked under `/tmp`), never in the shared worktree, and the copy
was deleted afterwards.

## `task reassign` metadata (commit 09a9e09)

Defect under test: `task reassign` wrote the owner and the next actor/dependencies in two
writes and checked only the first, so a failed second write still exited 0 and printed
`Task <id> reassigned to <owner>`.

| break | result |
| --- | --- |
| none (control) | 11 pass, 0 fail |
| delete the `res.ok` check | 10 pass, **1 fail** |
| restore the two-write split with the second result ignored (the original bug) | 9 pass, **2 fail** |
| drop `--depends-on` from the verb's flag set | 9 pass, **2 fail** |

The first attempt at this test asserted that the card file was the independent observable and
was credited with covering the defect. It was not: with the failure check deleted the suite
stayed at 11 pass / 0 fail. Asserting the card catches a write that never happened, not a write
whose result was discarded. The test was rewritten after the structural fix, and the numbers
above are the ones that justify the claim.

## E2E identity resolution (commit afa3955)

The identity control was replaced rather than re-tuned. The current control sets `AM_ROOT` to a
decoy root — a real, existing `.agent-mail` registering zero handles — and asserts that a
title-only agent still resolves from the root injected into the server. A second test asserts
identity resolves with `AM_ROOT` absent entirely, and the original negative control is retained:
an agent reported by Herdr but absent from the queue root must never become an agent row and
never hijack a registered handle.

## First pass over the unverified list: five invariants, two of which were unproven

The list below is a sample, not a census. Each row is a constructed break in a scratch copy
outside the shared worktree, announced and deleted, run against the suite that claims the
invariant.

| invariant claimed | break | result |
| --- | --- | --- |
| `task heartbeat` does not move `updated` | heartbeat also writes `updated` | 3 files red (task-cli 1, task-lifecycle 2) |
| an expired worker lease is reclaimed | expired leases are never reclaimed | job-queue **2 fail** |
| a changed alert condition prompts again | every fingerprinted alert suppressed forever | coordinator-doorbell **3 fail** |
| API routes declare JSON, unknown routes 404 | every JSON response served as `text/plain` | **GREEN — 29 pass, 0 fail** |
| notes are append-only | notes overwritten instead of appended | **GREEN — 18 pass, 0 fail** |

The last two stayed green, and they are the interesting result. Both are properties this project
has been asserting for hours: the 404/content-type pair is written into
`docs/operating-model.md` as the fix for a deploy check that shipped a false green, and
append-only notes were ratified as a design decision. Neither had a single test asserting it, so
a build that served every API response as `text/plain`, or one that silently destroyed note
history, would have passed the entire suite. A rule in a document is not a control; a rule with
no test is a rule that has been tried and not implemented.

Both are now covered and both were re-broken to confirm the new tests are load-bearing:

| new coverage | re-break | result |
| --- | --- | --- |
| `test/server.test.mjs` asserts `application/json` on four API routes and 404 on an unknown one | content type reverted to `text/plain` | **30 pass, 1 fail** |
| `test/task-cli.test.mjs` asserts three notes survive, in order, with author and timestamp | notes overwritten | **12 pass, 1 fail** |

The append-only test reads the notes array out of the card file itself rather than from
`task show`, so it does not depend on the rendering it is meant to constrain.

## What is not yet covered

Everything else in the suite. Five invariants were sampled here and two of them turned out to be
unproven, which is the best available estimate of what an unsampled test is worth: not zero, but
not the number a green suggests. The list that remains is the honest state of the rest of the
suite, and it is the thing that can be worked down.

## Bridge daemon singleton (commit e3df4b1)

**Production incident, 2026-09-25.** Two bridge daemons ran for hours. Both were alive, both
`cwd` in the project root, both running the same script. Measured, not inferred:

- `write_bytes` over a 30 s window: the older, **unregistered** process climbed by 40,960; the
  registered one did not move. So the daemon nobody could stop was the one writing delivery
  state, and the one `herdr-amq stop` could reach was not.
- `/proc/<pid>/cmdline` was used for enumeration. A `pgrep -af amq-herdr-bridge` pattern matches
  nothing, because that is not the argv; a shell running a command whose text contains
  `herdr-amq.mjs bridge-daemon` matches, which is how a *shell* got counted as a second daemon
  during this investigation.

**Mechanism, from the source.** `startDaemonLoop`'s cleanup handler unlinked the pid file
unconditionally, so stopping a superseded daemon deleted the *live* daemon's registration. With
the pid file gone, `startDaemonBackground`'s only guard (`isDaemonRunning()`) returned null and it
spawned a second daemon. Nothing held a lock, and the second daemon could never be reached by
`herdr-amq stop`. Killing a pid therefore fixes the symptom for one cycle and leaves the cause.

**Reproduction** (production condition, not synthetic): delete `bridge.pid` while a daemon is
alive, then `herdr-amq start`. Before the fix: two daemons. After: refused, exit 1,
`another bridge daemon holds the singleton lock (PID …)`.

**Fix.** The daemon runs under `flock -n` on `bridge.lock` for its whole lifetime, so the kernel
releases the lock even on SIGKILL and it cannot go stale. Its contents are the holder's pid, so
the daemon stays discoverable when the pid file is lost. Cleanup removes only registrations that
still name its own pid, and truncates rather than unlinks the lock file, because flock is held on
the inode. `herdr-amq start` waits 400 ms and verifies the child is alive, so a refused lock can
never be reported as "Started". `herdr-amq status` prints a warning when the lock holder and the
registered pid differ.

| break | result |
| --- | --- |
| none (control) | 8 pass, 0 fail |
| remove the lock-holder refusal (pid-file-only guard) | 7 pass, **1 fail** |
| revert cleanup to an unconditional unlink | 7 pass, **1 fail** |
| unlink the lock file instead of truncating it | 7 pass, **1 fail** |

The first version of the incident test deleted the pid file itself and so never exercised
`cleanup()`; it stayed green against a reverted cleanup. The ownership rule was then extracted
into `clearOwnedDaemonRegistration()` and tested directly with a foreign pid, which is the only
way to assert "a foreign cleanup leaves the live registration alone" while a singleton lock makes
two daemons impossible to construct through the CLI.

## retry_failure_trend windowing (commit 2ef917f)

The alert could never clear. `retryCount` was the sum of `(attempts - 1)` over every delivery
entry ever recorded, and `retryDelayMaxMs` was `max(now - firstAttemptAt)` — for a fixed first
attempt that grows at exactly one second per second, permanently, against a static threshold. The
observed signature matched: retry count held at 232 while the age climbed by precisely the elapsed
wall clock.

Both measurements are now windowed on the entry's most recent attempt (`at`, which the bridge has
always written): an entry whose last attempt is older than `retryWindowMs` (default 900 s) is a
closed incident and stops counting. The age is taken over entries still inside the window and
measures the duration of the *current* incident, so it grows while the incident is open and drops
to zero when the window empties. Lifetime totals are still reported, as
`retries.lifetime`, and are never compared to a threshold.

| break | result |
| --- | --- |
| none (control) | 8 pass, 0 fail |
| remove the window (count every retried entry ever) | 7 pass, **1 fail** |
| measure the age from the last attempt instead of the incident start | 5 pass, **3 fail** |

The second break is the tempting wrong fix: ageing from the last attempt makes the number decay
immediately, which looks like the alert clearing, but it inverts the meaning — a large value then
means "delivery has stopped failing", which is the good case. It is the reason the age is filtered
to open incidents before it is measured.

## Unattributed heartbeats (commit f2370d7)

128 of the 138 live cards carried a `last_heartbeat_at` with `last_heartbeat_by: null`, so
the field that makes a card look alive had no accountable source. The finding was reported as
"a heartbeat whose ACTOR FIELD WAS NOT WRITTEN", and the mechanism is narrower and more
interesting than the `heartbeat` verb: **the claim path** advanced the clock and never wrote
the author. Two more paths did the same thing.

- `heartbeatBoardTask` fell back `String(actor || owner || "unknown")`. `"unknown"` is
  truthy, so it survived the metrics projection `last_heartbeat_by || null` and was displayed
  as if it were a name.
- `updateBoardTask` set `last_heartbeat_at: enteringProgress ? now : (existing || now)` — the
  trailing `|| now` invented a clock for any in-progress update to a card that had none,
  attributing liveness to nobody.

The `task heartbeat` CLI was worse than the fallback: `me` defaults to `"coordinator"`
(actions.mjs:299), so a heartbeat with no `--me` attributed liveness to a handle that never
sent it. That default is correct for the other verbs and is now bypassed for `heartbeat`,
where an absent actor is an error.

An unattributed heartbeat is not cosmetic, because the stall detector honours the clock
regardless of author. Fixing it means refusing unnamed heartbeats, recording the claimer on a
claim, and not inventing a clock at all when there is no author. Legacy cards are **not**
backfilled: 128 null authors are an honest record of what was not known.

| break | result |
| --- | --- |
| none (control) | 9 pass, 0 fail |
| restore the original claim path (clock set, author left null) | 6 pass, **3 fail** |
| restore the original `actor \|\| owner \|\| "unknown"` fallback | 5 pass, **4 fail** |

The first break is the production defect reproduced exactly; the tests fail on the claim
assertion, on the invented clock, and on the untouched-after-refusal assertion, which is the
combination the original code could not satisfy.

## Unattributable liveness: three states, not two (commit 59b9ce4)

An unattributed liveness clock is a **missing fact**, and the two obvious readings are
both wrong in opposite directions. Reading it as *live* lets an untouched card look alive;
reading it as *stalled* is a flood. `cardLivenessState()` therefore returns one of three
states — `live`, `stale`, `unknown` — and `unknown` cards are excluded from
`stalledWork` while remaining visible under `unattributedLiveness`. No author is ever
invented to resolve one, which is why the 128 legacy nulls are still nulls.

The distinction that keeps this honest: a card with **no** heartbeat falls back to its own
state clock (`livenessVia: "activity"`) and can still go stale, because nobody fabricated
an author for it. Only a clock that exists and names nobody is `unknown`.

| break | result |
| --- | --- |
| none (control) | 10 pass, 0 fail |
| treat an unattributed clock as stale (the flood) | 9 pass, **1 fail** |
| treat an unattributed clock as live (quiet but wrong) | 9 pass, **1 fail** |

Both breaks fail the *same* assertion, which is the point: the two bad readings are
indistinguishable from each other by inspection and only the third state separates them.

**Correction to the magnitude of the risk.** The flood was forecast as imminent and it is
not, at least today: all 128 legacy null-author clocks sit in `done` and `blocked`
columns, and the stall detector only ever considered `backlog`/`doing`/`review`. On the
real board the change moves 0 alerts. The design is still correct — a single claim in an
active column would have flooded — but the number worth remembering is 0, not 128.

## Two health metrics, two different questions (commit 175957f)

`queue_age` read `ageMs(task.updated || task.created)` while `stalled_work` — directly above it,
under the comment "Previously this read only `updated`, so an actively worked card was
indistinguishable from an ignored one" — read the liveness clock. A card heartbeated every
minute and never edited therefore read as **live to one metric and ancient to the other, at
the same instant**. Fixing one and not the other is the regression, so both now call
`cardLivenessState`.

The second half was worse than a disagreement. `blocked_cards` only fires on cards with **no**
triage reason, and `queue_age` never scanned the blocked column, so a card blocked for five
hours *with* a reason was covered by no age signal at all. On the real board all 17 blocked
cards are triaged, so the entire blocked column was invisible to every age alert. A third
metric, `blocked_oldest`, now covers every blocked card regardless of triage, reusing the
existing `blockedWarnMs`/`blockedCriticalMs` thresholds.

A third defect surfaced while building it: `blocked_ms` is a **snapshot** written at the moment
of blocking, so preferring it understated the oldest blocker by hours (6.89M ms stored vs
17.7M ms actual). `blockedWork` now prefers the live age from `blocked_at`.

| break | result |
| --- | --- |
| none (control) | 13 pass, 0 fail |
| restore the original `queue_age` (`updated` only) | 12 pass, **1 fail** |
| gate `blocked_oldest` on being untriaged | 12 pass, **1 fail** |
| restore the stale `blocked_ms` snapshot | 12 pass, **1 fail** |

Each break fails the test that names its own claim, which is the property that matters: no
break here is caught by an unrelated assertion, and no test here passes for a reason other
than the one it states.

**A near-miss worth recording.** `node --check` passed on a version that threw
`ReferenceError: Cannot access 'blockedWork' before initialization` at runtime. A syntax check
cannot see a temporal dead zone; only calling the function did. Three relocations were needed
before the ordering was right. Anything that runs at import time or on a real board must be
executed, not just parsed.

## The stall detector was a timer, and heartbeating was its own remedy (commit 3a714a6)

On every flagged card the alert reported `age` exactly equal to `heartbeat age`, on all six
cards, all three owners. That is not six findings: it is one statement about the detector. The
newest event on each card was its own heartbeat, and staleness was defined as time since the
newest event — so the alert was a timer that would reach every card and hold at 100%. It was
also unsatisfiable: the recommended action was to heartbeat, which is the event being aged, so
obeying reset the clock and guaranteed the same alert one window later. No threshold fixes an
event being both the remedy and the trigger.

**The fix separates the two signals rather than tuning either.** `cardProgressClock()` — the
card's own state clock — is now what `stalled_work` and `queue_age` age. A heartbeat is an
assertion that an owner is present; it is reported as `livenessLease` in the payload and is
never alerted on, because alerting on a lease whose remedy is renewal recreates the same loop.
Both progress signals read the same clock, deliberately: moving `stalled_work` to the state
clock while leaving `queue_age` on the heartbeat would have re-created the
two-metrics-disagree defect fixed an hour earlier, which the first version of this change did.

| break | result |
| --- | --- |
| none (control) | 14 pass, 0 fail |
| restore the self-perpetuating clock (age the heartbeat again) | 11 pass, **2 fail** |
| drop the `reason` projection | 13 pass, **1 fail** |
| leave `queue_age` on the heartbeat clock | 12 pass, **1 fail** |

**The second break was green on the first attempt, and that is the part worth keeping.** I
"fixed" a read failure — the coordinator prompt renders `reason=${card.reason || "unspecified"}`
and the projection omitted `reason` entirely, so it printed `unspecified` on 8 of 8 cards —
and no test noticed, because no test existed. I only found it because I re-broke the fix I had
just made and expected red. A fix verified only by the suite passing is not a fix.

**A false inference, corrected rather than implemented.** The claim that the "two cards naming no
author" figure was a hardcoded artifact does not hold. They are `task_1790366734903_8d1fe8` and
`task_1790367326671_ae199e`, both owned by testkit, and both are in the **backlog** column.
`activeCards` spans backlog/doing/review, so they are counted; a search restricted to the
in_progress set cannot find them. The count is stable because the *set* is stable: two legacy
cards with null-author heartbeats that nobody has touched. Nothing needed fixing, and a
"fixed artifact" patch would have been fabricated.

**Unresolved observation, recorded rather than diagnosed.** Across this restart the on-disk
delivery map went from 68 entries (32 with `attempts > 1`) to 1 entry. Two daemons interleaving on
one file is a plausible cause and the retry metric's own windowing defect is a separate matter;
neither was investigated here, because the retry-trend diagnosis belongs to the coordinator and
this document does not claim a fix for it.

## Gate reliability is per gate, and contention is classified from a loadavg PAIR

Measured on the 4-core host: the full gate ran 366s (exit 0, PASS), the quick gate 33s, the
slowest Godot harness 16s against a 600s budget, and the other thirteen Godot harnesses 7–14s —
37× to 80× headroom. `qa_audit` (`node tools/qa/audit.mjs --check`, **not** Godot) ran 211.8s wall
against a 900s budget: 204.5s user, 5.8s system, ~99.3% CPU-bound and single-threaded. Under 12 CPU
burners on 4 cores it exceeded 900s, exiting 124 having used only 3m24s of CPU — starved to roughly
23% of a core. A timeout there is `WARN`, not a hard fail.

So a blanket "a timeout on the contended host is not evidence" rule protects gates that cannot
plausibly time out, and invalidates sound results to defend an unsound one. It narrowed to
`qa_audit` alone. For the fourteen Godot gates a timeout is a hang — stale `.godot`, a scene that
never boots — which is environment evidence and needs no code change. No Godot serialisation was
implemented: it would defend the wrong gate, since `qa_audit` is Node and never takes the Godot
lock, and it would cost every lane its throughput.

**The one change to the proposal, and it is the right one.** Recording loadavg *at start* would
have been wrong: loadavg is a damped 1/5/15-minute average, so it describes the box *before* the
work. A host that was quiet at start and loaded by the gate itself would be recorded healthy —
precisely the case the rule exists to catch. `readLoadavg()` therefore samples at start **and** at
exit, including on the timeout path, and `classifyContention()` reads the pair:

| start | exit | classification | meaning |
| --- | --- | --- | --- |
| low | low | `uncontended` | a timeout is a hang, and a hang is a finding |
| high | high | `contention-limited` | the host is a fact about the host, not the job |
| low | high | `contention-limited` | the job loaded the box; invisible to a start-only reading |
| high | low | `started-contended` | reported, never quietly read as clean |

Read per-core, because a 1.0 one-minute average is a saturated 4-core box and an idle 64-core one.
The classification is recorded on the failure reason and on success; it never sets a pass/fail
field, which is the whole point of the rule that superseded the blanket one.

| break | result |
| --- | --- |
| none (control) | 8 pass, 0 fail |
| genuinely start-only (exit reading discarded) | 6 pass, **2 fail** |
| raw 1-minute loadavg instead of per-core | 7 pass, **1 fail** |
| let contention carry a verdict field | 6 pass, **2 fail** |

The first attempt at the start-only break was **green**: the sabotage only covered the *missing*
exit case, so a start-only implementation still passed. A break that does not reproduce the defect
is worse than no break, because it reports safety. It was redone to discard the exit reading
outright, which is what a first implementation would actually have done.

No further contention test was run on the shared host. Breaking other lanes to produce a number is
a bad trade, and the arithmetic above is labelled as arithmetic rather than as a measurement.
