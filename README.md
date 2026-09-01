# roster-bridge

District rostering and compliance platform. A **resumable OneRoster sync with
validation gates**, identity resolution that survives a SIS migration, and the
FERPA and state-law operations a district actually asks about.

Dashboard: <https://roster-bridge.pretoni.com/dashboard>
Reads from: <https://oneroster-sandbox.pretoni.com> (a real OneRoster provider,
over real OAuth, not a fixture)

## The argument

A roster sync looks like a nightly ETL job. It is closer to a replication
protocol against a source you cannot lock, cannot query historically and do not
control, whose correctness is judged by a teacher standing in front of thirty
children at 08:15.

Two rules follow, and the whole design falls out of them.

**Never replace the world.** The tempting nightly job (truncate, reload)
destroys every internal id, breaks every foreign key from your own domain, and
makes "who was in this class in March" unanswerable. So: diff.

**Nothing is applied until it passes.** A truncated export and a genuine mass
withdrawal are *indistinguishable in the data*. You cannot tell them apart by
looking harder. So the correct response to a large unexplained drop is to stop
and ask a human, not to guess.

## The pipeline

```
fetch ──► stage ──► validate ──► apply
  │         │          │           │
  │         │          │           └─ the only stage that writes live data
  │         │          └───────────── fails here ⇒ quarantine.
  │         │                         yesterday's data stays live.
  │         └──────────────────────── raw rows, retained briefly, so
  │                                   "what did the district actually send?"
  │                                   is a two-minute lookup
  └────────────────────────────────── one page per step. resumable, because a
                                      run that dies on page 400 of 900 should
                                      resume, not restart
```

Every stage is bounded and resumable. `POST /api/runs/{id}/advance` does one
step; `/drive` does several. A cron trigger advances anything in flight and
starts runs for districts that have not synced recently.

Quarantined runs are **not** retried automatically. A gate fired for a reason
and a person should look at it; retrying on a schedule turns a caught problem
into a silent one.

## The validation gates

| Gate | Fires when | Outcome |
|---|---|---|
| `empty_payload` | The source returned success with zero rows | **fail** |
| `row_count_collapse` | Rows dropped more than 15% against the last good run | **fail** |
| `org_disappearance` | A school present last run is absent now | **fail** |
| `enrollment_ratio` | Enrolments per user outside a plausible band | **fail** |
| `all_rows_changed` | ≥98% of rows claim to have changed | warn |
| `frozen_feed` | Byte-identical payload for 3+ consecutive runs | warn |

Failures quarantine. Warnings are recorded and the run proceeds: a provider
stamping `dateLastModified` on every row makes the sync slow, not wrong, and
the diff falls back to our own row hash.

Each of those gates has a matching switch in the
[sandbox](https://github.com/overseek944/oneroster-sandbox), so the defence can
be **demonstrated firing** rather than described.

## Identity resolution

```
identities (district_id, provider, external_id, person_id)
```

One human arrives as a `sourcedId` in a nightly feed, a Clever id, an LTI
subject and a Google subject. Four strings, one child. The internal `person_id`
never leaves the system and never changes.

This is what makes a SIS migration a mapping exercise rather than a
catastrophe. When a district changes SIS, every external identifier changes; if
that identifier were the primary key, migration day would orphan every piece of
student work in the district.

## Compliance operations

Not paperwork. Product features, because a district cannot meet its obligations
using software that lacks them.

| Endpoint | Why it exists |
|---|---|
| `GET /api/compliance/districts/{d}/persons/{p}/record` | FERPA 34 CFR 99.10. A parent may inspect the education record. Human readable, not a database dump |
| `POST …/persons/{p}/amendments` | FERPA 34 CFR 99.20. Correction, layered over history rather than rewriting it, with an audit trail |
| `POST …/deletion-jobs` | Per-district retention, enumerated across every store, dry run by default, producing a certificate |
| `GET …/incident-clock` | The jurisdiction's breach clock, computed rather than remembered |
| `POST /api/compliance/incident-clock` | Given affected districts, the **shortest** clock and its deadline |

That last one is the point of holding jurisdiction rules as data. At 02:00
during a real incident nobody is looking up New York's deadline. New York gives
seven calendar days from discovery; Illinois gives thirty from determination;
Connecticut gives two. The system already knows which districts are affected and
what the shortest clock among them is. It is a query, and it should be.

## Operational visibility

`GET /api/districts/{id}/health` answers the only question that matters
operationally, which is *is this district okay right now*:

- last successful run and hours since
- classes with no students
- classes with no teacher
- people with no enrolment

Those last three are what support uses every day, because they correspond
exactly to what a person notices.

## Running it

```bash
npm install
npm run typecheck
npm test          # validation gates and diff semantics
npm run dev
npm run deploy
```

## Status and honest limits

- The sync, the gates, identity resolution and the compliance operations are
  implemented and run against a live provider.
- Source credentials are stored in D1 in plaintext. That is **wrong for
  production** and is called out in [ADR 0004](docs/adr/0004-secret-handling.md)
  with the fix; it is acceptable only because every credential here belongs to a
  sandbox holding synthetic data.
- Single-operator auth via a shared admin key. Real deployment needs per-user
  identity and role-scoped access, which the audit log is already shaped for.
- CSV ingest is specified in the schema but only the REST binding is
  implemented.
