# 3. Identity resolution through a table, not a primary key

**Status:** accepted

## Context

`sourcedId` is the only identifier a OneRoster feed gives you, and it is the
obvious primary key. It is also reissued when a district migrates its student
information system, which districts do, as a multi-year project they will not
consult a vendor about.

The same human also arrives through other doors with other identifiers: a Clever
id, an LTI subject, a Google subject.

## Decision

An internal `person_id` that never leaves the system, and an `identities` table
of `(district_id, provider, external_id, person_id)`. Every external identifier
resolves through it on ingest.

## Consequences

A SIS migration becomes a mapping exercise: accept a crosswalk, insert new
identity rows pointing at the same people. Without this table, migration day
orphans every piece of student work in the district and no query fixes it,
because the mapping never existed.

It costs a join on ingest, which is why identities are looked up once per slice
rather than once per row.

One rule is deliberately **not** implemented: automatic matching on name plus
date of birth. Two students in a district of forty thousand share a name and a
birthday more often than intuition suggests, and merging two children's records
is a serious incident rather than a data quality issue. Ambiguity belongs in a
review queue.
