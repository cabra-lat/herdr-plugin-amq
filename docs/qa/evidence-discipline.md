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

## What is not yet covered

A test that has never been broken is recorded here as *unverified*, not as evidence. Tests added
in this repository before this discipline existed have not each been re-run against a
constructed break; that is the honest state of the rest of the suite, and it is the reason the
rule exists.

## Message-id resolution repair: the live check failed, then passed where it can

Live test on 2026-09-25: a reply addressed to a real message id written in the all-dots
spelling (`2026-09-25T22.14.46.977Z_pid730179_a8c5ea20`) was sent with the standalone
`amq reply` binary. It **failed**: exit `3`, `message not found`, nothing written. The failure
is loud and left no misdelivered message, so the hazard in "the write succeeded and the tool
implies otherwise" is not open in that path — but the normalisation this repository ships is not
in that binary.

This repository's own resolver, verified directly against the real queue root with
`findMessageById`:

| id spelling | resolves | message | sender | reply target |
| --- | --- | --- | --- | --- |
| canonical Maildir | yes | original | coordinator | coordinator |
| all dots | yes | original | coordinator | coordinator |
| colon-separated | yes | original | coordinator | coordinator |
| unknown id | **no** | — | — | — |

The test added for this asserts all three spellings reach the same message, the same sender and
the same reply target, plus a bogus-id control. Two constructed breaks:

| break | result |
| --- | --- |
| none (control) | 7 pass, 0 fail |
| `messageIdsMatch` reduced to exact-id equality (no normalisation) | 5 pass, **2 fail** |
| reply always addressed to the default recipient, original sender ignored | 6 pass, **1 fail** |

The second break is the mirror this document warns about: resolution is perfect and the reply
still goes to the wrong party. The first version of that test did not catch it, because its
fixture sender *was* the default recipient, so the wrong answer and the right answer were
identical. The fixture now uses a sender that is not the default, which is the only reason the
mirror goes red.
