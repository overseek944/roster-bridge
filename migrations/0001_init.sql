-- roster-bridge schema.
--
-- The shape here follows the argument in the pipeline: nothing the provider
-- sends is written straight into the operational tables. It lands in staging,
-- is validated against the previous run, is diffed, and only then applied.
-- Those are four different lifetimes of data and they get four sets of tables.

-- ---------------------------------------------------------------------------
-- Tenancy and configuration
-- ---------------------------------------------------------------------------

-- Jurisdiction rules held as data. A breach clock, a named security framework
-- and the rights a parent can exercise vary by state; the code does not.
CREATE TABLE jurisdictions (
  code                   TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  breach_notify_hours    INTEGER NOT NULL,
  breach_trigger         TEXT NOT NULL,
  breach_unit            TEXT NOT NULL,
  security_framework     TEXT,
  parent_rights_json     TEXT NOT NULL,
  publication_required   INTEGER NOT NULL DEFAULT 0,
  statute                TEXT,
  notes                  TEXT
);

CREATE TABLE districts (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  jurisdiction_code TEXT NOT NULL REFERENCES jurisdictions(code),
  -- Retention is per district because it is contractual, not global.
  retention_days    INTEGER NOT NULL DEFAULT 1095,
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TEXT NOT NULL
);

CREATE TABLE sources (
  id             TEXT PRIMARY KEY,
  district_id    TEXT NOT NULL REFERENCES districts(id),
  kind           TEXT NOT NULL,          -- oneroster_rest | oneroster_csv
  label          TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  token_url      TEXT,
  client_id      TEXT,
  client_secret  TEXT,                   -- see ADR 0004 on secret handling
  version        TEXT NOT NULL DEFAULT 'v1p1',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_sources_district ON sources (district_id);

-- ---------------------------------------------------------------------------
-- Pipeline state
-- ---------------------------------------------------------------------------

CREATE TABLE sync_runs (
  id            TEXT PRIMARY KEY,
  district_id   TEXT NOT NULL REFERENCES districts(id),
  source_id     TEXT NOT NULL REFERENCES sources(id),
  -- pending | fetching | validating | diffing | applying | applied
  -- | quarantined | failed
  state         TEXT NOT NULL,
  trigger       TEXT NOT NULL,           -- manual | scheduled
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  cursor_json   TEXT,                    -- resumable fetch position
  stats_json    TEXT NOT NULL DEFAULT '{}',
  message       TEXT
);
CREATE INDEX idx_runs_district ON sync_runs (district_id, started_at DESC);
CREATE INDEX idx_runs_state ON sync_runs (state);

-- Raw rows exactly as the provider sent them. Retained for a bounded window so
-- that "my class is wrong" can be answered with what the district actually
-- sent, rather than with a guess.
CREATE TABLE staged_records (
  run_id        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  row_hash      TEXT NOT NULL,
  PRIMARY KEY (run_id, resource_type, external_id)
);
CREATE INDEX idx_staged_run ON staged_records (run_id, resource_type);

CREATE TABLE validation_results (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  check_name TEXT NOT NULL,
  outcome    TEXT NOT NULL,              -- pass | warn | fail
  observed   TEXT NOT NULL,
  threshold  TEXT,
  detail     TEXT NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX idx_validation_run ON validation_results (run_id);

-- What we believe the provider currently holds. The hash is ours, computed
-- over the meaningful fields and deliberately excluding dateLastModified,
-- because a provider that stamps every row would otherwise defeat the diff.
CREATE TABLE sync_records (
  district_id   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  last_hash     TEXT NOT NULL,
  last_seen_run TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (district_id, source_id, resource_type, external_id)
);
CREATE INDEX idx_syncrec_seen ON sync_records (district_id, resource_type, last_seen_at);

-- ---------------------------------------------------------------------------
-- Operational data (the applied result)
-- ---------------------------------------------------------------------------

-- One row per human. The internal id never leaves the system and never changes,
-- which is what lets a district migrate its SIS without orphaning student work.
CREATE TABLE persons (
  id             TEXT PRIMARY KEY,
  district_id    TEXT NOT NULL REFERENCES districts(id),
  given_name     TEXT NOT NULL,
  family_name    TEXT NOT NULL,
  preferred_name TEXT,
  grade_level    TEXT,                   -- a STRING: PK, KG, 01..12, UG
  email          TEXT,                   -- frequently null, by district policy
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX idx_persons_district ON persons (district_id);

-- Several external identifiers resolve to one person. This table is the whole
-- reason a SIS migration is a mapping exercise rather than a catastrophe.
CREATE TABLE identities (
  district_id  TEXT NOT NULL,
  provider     TEXT NOT NULL,            -- oneroster:<source> | clever | lti:<iss>:<deployment>
  external_id  TEXT NOT NULL,
  person_id    TEXT NOT NULL REFERENCES persons(id),
  verified_at  TEXT NOT NULL,
  PRIMARY KEY (district_id, provider, external_id)
);
CREATE INDEX idx_identities_person ON identities (person_id);

CREATE TABLE orgs (
  id          TEXT PRIMARY KEY,
  district_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  parent_id   TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_orgs_district ON orgs (district_id);

CREATE TABLE classes (
  id           TEXT PRIMARY KEY,
  district_id  TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  title        TEXT NOT NULL,
  class_type   TEXT NOT NULL,
  school_id    TEXT,
  grades_json  TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'active',
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_classes_district ON classes (district_id);

-- An enrolment has a beginning and an end. Modelling it as a row rather than as
-- an array on a class is what makes "who was in this room in March" answerable.
CREATE TABLE enrollments (
  id          TEXT PRIMARY KEY,
  district_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  person_id   TEXT NOT NULL,
  class_id    TEXT NOT NULL,
  school_id   TEXT,
  role        TEXT NOT NULL,
  is_primary  INTEGER,
  begin_date  TEXT,
  end_date    TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_enr_district ON enrollments (district_id);
CREATE INDEX idx_enr_person ON enrollments (person_id);
CREATE INDEX idx_enr_class ON enrollments (class_id);

-- ---------------------------------------------------------------------------
-- Compliance
-- ---------------------------------------------------------------------------

-- Every read or write of a person's record by a human, and every compliance
-- operation. FERPA's school official exception is difficult to argue when
-- nobody can say who looked at what.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  district_id TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id  TEXT,
  detail_json TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX idx_audit_district ON audit_log (district_id, at DESC);
CREATE INDEX idx_audit_subject ON audit_log (subject_type, subject_id);

-- A parent may ask for a record to be corrected. The correction is layered on
-- top rather than rewriting history, so the audit trail stays intact.
CREATE TABLE amendments (
  id           TEXT PRIMARY KEY,
  district_id  TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  field        TEXT NOT NULL,
  previous     TEXT,
  corrected    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  applied_at   TEXT NOT NULL
);
CREATE INDEX idx_amend_person ON amendments (person_id);

CREATE TABLE deletion_jobs (
  id           TEXT PRIMARY KEY,
  district_id  TEXT NOT NULL,
  scope        TEXT NOT NULL,            -- retention | district | person
  subject_id   TEXT,
  state        TEXT NOT NULL,            -- pending | running | complete | failed
  counts_json  TEXT NOT NULL DEFAULT '{}',
  requested_by TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX idx_deletion_district ON deletion_jobs (district_id, started_at DESC);
