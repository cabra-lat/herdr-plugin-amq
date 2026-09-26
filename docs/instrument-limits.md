# Limits of the liveness instrument

Written before any option is built on top of it, so that a later reader inherits the
constraint rather than rediscovering it.

## A heartbeat is a lease, not progress

`herdr-amq task heartbeat` records that an owner is present. It does not move the card, and
it is not evidence that any work happened. The board treats it as a lease: it expires, and
an expired lease is a real signal.

## The consequence, which no threshold can fix

A lane that heartbeats on a timer **while doing nothing** holds a valid lease forever. No
threshold on any clock will page it, because the lease keeps renewing from something that
is not progress.

This is true of every keying option considered on 2026-09-26:

- keying the alert on the card's state clock: pages healthy long work (measured 8 of 10
  active cards, all inside a normal working block);
- keying it on liveness, and suppressing a card with a fresh heartbeat: the same hole,
  moved;
- keying it on liveness alone: a lane that heartbeats and idles is never paged.

**Presence and progress are different facts. This instrument measures presence.** Catching
a lane that heartbeats and idles requires a card-scoped work signal, not another clock.
`src/card-writes.mjs` records real per-card field changes and is the candidate instrument;
nothing has established a threshold from it yet, and it is bounded to 200 events per card.

## Related limits recorded the same evening

- **An absent key must never read as a value.** A consumer that wrote
  `card.heartbeat || card.heartbeatAt || 0` turned a missing heartbeat into `0`, and
  `Date.parse(0)` into 946692000000, reported as an age of 14062699 minutes. A wrong value
  is checkable; an absent key wearing a zero is indistinguishable from data. The board
  export now carries `heartbeatAgeMs`, and it is `null` when there is no heartbeat.
- **Notes are evidence, not liveness.** An append-only note records that someone wrote
  something. Six coordinator notes once made the instrument measure the coordinator.
- **A green signal that does not depend on the thing it reports is the most expensive
  failure shape in this fleet.** Four instances on 2026-09-26: a lock that printed "lock
  acquired" after a timeout, a harness that passed printing "? checks", an `--attach` flag
  that exited 0 having dropped four of five files, and an alert reporting healthy work as
  stalled.
