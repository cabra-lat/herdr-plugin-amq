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

## Message-id resolution repair: live send in the previously-broken form

`amq reply --id` previously failed to resolve a p2p sender's id, so a reply could go undelivered
while the tool's behaviour was consistent with a wrong id. The repair normalises the
dot-millisecond wire form against the dashed Maildir filename.

- **Failure case is loud:** `amq reply --id task_NOT_A_REAL_ID --body ...` exits `3`, prints
  `message not found: task_NOT_A_REAL_ID` and writes nothing. Observed live.
- **Broken form, live, to a real recipient:** the reply that recorded this entry was itself sent
  using the dot-millisecond form of a real message id
  (`2026-09-25T22.14.46.977Z_pid730179_a8c5ea20`) and read back from the recipient's outbox, so
  the verification exercises the path that was broken rather than a clean instance of it.
- **Recipient identity, not just delivery:** the check is that the message landed in the
  original sender's outbox, because a resolution repair that finds the right message and sends
  it to the wrong party is a new defect wearing the old fix's clothes.
