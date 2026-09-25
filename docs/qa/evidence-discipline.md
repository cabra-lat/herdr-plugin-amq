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
