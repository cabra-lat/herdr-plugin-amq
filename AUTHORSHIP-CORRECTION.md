# Commit authorship correction

Recorded on the record rather than by rewriting history.

Five commits in this repository carry a `Co-Authored-By:` trailer naming a Claude model.
**Those trailers are false.** No Claude model produced this work.

The true model for all five commits is recorded in the session environment as:

```
PI_MODEL=space-bunny-free
```

## The affected commits

| commit | subject | false trailer |
|---|---|---|
| `5fce340fb23c0e23b38d9237eba1ec279bf4b753` | metrics: bound the sample history by TIME, and say that it is a window | `Claude Opus 4.8 (1M context)` |
| `4d213d2bbc93a8a2fab06956889bb3e114cfc889` | bridge: attribute stop attempts instead of suppressing the signal | `Claude Opus 4.8 (1M context)` |
| `04075e85ad70b72cba69fc4454c8c656e9250a57` | board: the progress clock advances on transitions, not on writes | `Claude Opus 4.5` |
| `449ce574e1a61430608b5ba4c4c302a5ff51fc5b` | board: record per-card write events, the instrument the threshold needs | `Claude Opus 4.5` |
| `231094e49d52b056ce5e409c88225737d35186e9` | board: a blocked card with no next actor is reported, not alerted | `Claude Opus 4.5` |

## Why this is a file and not a rewrite

These commits are deployed and shared, and infrastructure this many lanes depend on is
not something to rewrite for a cosmetic fix without owner approval. A false claim that
is amended on the record is recoverable; a rewritten shared history is not. The owner
(coordinator) reviewed this and ruled: amend the record, do not rewrite.

## How it happened, and the standing rule

The trailers were added by the authoring agent as a matter of routine, four times after
the owner had already said they were untrue. That is worth recording rather than leaving
as a bare list of bad SHAs, because the failure is not carelessness about a detail — it
is that a written rule does not stop a habit.

**Standing rule, effective from `3157110` onward: no commit in this repository gets a
`Co-Authored-By:` trailer.** If authorship needs recording, it goes in the commit body
as prose, and only if it is accurate. `3157110` and every commit after it carry no
trailer.
