# 1. A resumable, bounded pipeline

**Status:** accepted

## Context

A district of any size is tens of thousands of roster rows and millions of
enrolments in the largest cases. Fetching, diffing and applying that in one
invocation exceeds any reasonable request budget, and on Workers exceeds a hard
one.

More importantly, a run that dies part-way through should not start again from
the beginning. In the August rollover window, when schedules change nightly and
the sync matters most, restarting costs the window.

## Decision

The run is a state machine that advances in bounded steps, with its position
stored in the database.

    pending → fetching → validating → applying → applied
                            ↓
                       quarantined

`fetch` does one page per step. `apply` does one bounded slice of one collection
per step. Both record their cursor, so any step can be the last one and the next
invocation picks up where it stopped.

## Consequences

The sync survives interruption, deployment, and platform limits. A cron trigger
advances anything in flight; the dashboard can drive a run interactively and
show progress honestly.

The cost is that the pipeline cannot hold state in memory between steps, so
everything meaningful is persisted. That turned out to be a benefit: the run
history and per-stage statistics exist because the design forced them to.
