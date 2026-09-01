# 2. Validation before apply, quarantine on failure

**Status:** accepted

## Context

The expensive incidents in rostering all share a shape: the provider sent
something wrong, the consumer applied it faithfully, and a teacher discovered it.

A truncated export and a genuine mass withdrawal are indistinguishable in the
data. So are a sharing change and a school closing. So are a rotated credential
returning an empty success and a district with no students.

## Decision

Validation runs after staging and before anything is applied. A failed gate
quarantines the run: nothing is written, yesterday's data stays live, and an
operator is told.

Warnings do not block. A provider stamping `dateLastModified` on every row makes
the sync slow rather than wrong.

Quarantined runs are not retried automatically.

## Consequences

A district can be a day stale. It cannot be silently wrong. That trade is the
right way round: staleness is visible and recoverable, and wrongness is neither.

Each gate reports what it observed, what the threshold was, and what it means in
plain language, because the person reading it at 07:00 needs to decide whether
to release the run, not to interpret a boolean.
