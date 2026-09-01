/**
 * Validation gates.
 *
 * These run after staging and before anything is applied. That ordering is the
 * entire design: a payload that fails here leaves yesterday's data live and
 * raises an alert, rather than being written and discovered by a teacher.
 *
 * The gates exist because of one uncomfortable fact. A truncated export and a
 * genuine mass withdrawal are indistinguishable in the data. You cannot tell
 * them apart by looking harder, so the correct response to a large unexplained
 * drop is to stop and ask a human, not to guess.
 */

export type Outcome = "pass" | "warn" | "fail";

export interface CheckResult {
  check: string;
  outcome: Outcome;
  observed: string;
  threshold: string | null;
  detail: string;
}

/** Counts and characteristics of one run's staged payload. */
export interface RunSnapshot {
  countsByType: Record<string, number>;
  /** Distinct school external ids present in the payload. */
  schoolIds: string[];
  /** How many staged rows have a dateLastModified newer than the previous run. */
  changedCount: number;
  totalCount: number;
  /** Hash over the whole payload, for detecting a byte-identical feed. */
  payloadHash: string;
}

export interface ValidationPolicy {
  /** Fail if the total row count drops by more than this fraction. */
  maxRowCountDrop: number;
  /** Fail if any school present last run is absent now. */
  failOnSchoolDisappearance: boolean;
  /** Plausible band for enrolments per student. */
  enrollmentRatioMin: number;
  enrollmentRatioMax: number;
  /** Warn if this fraction or more of rows claim to have changed. */
  allChangedThreshold: number;
  /** Warn after this many consecutive byte-identical payloads. */
  frozenRunsThreshold: number;
}

export const DEFAULT_POLICY: ValidationPolicy = {
  maxRowCountDrop: 0.15,
  failOnSchoolDisappearance: true,
  enrollmentRatioMin: 0.5,
  enrollmentRatioMax: 15,
  allChangedThreshold: 0.98,
  frozenRunsThreshold: 3,
};

export interface ValidationContext {
  current: RunSnapshot;
  previous: RunSnapshot | null;
  /** How many previous consecutive runs had the same payload hash. */
  identicalRunStreak: number;
  policy: ValidationPolicy;
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/**
 * Row count collapse.
 *
 * The single most valuable check. A truncated export applied faithfully looks
 * exactly like a district that withdrew two thousand students, and by 08:15
 * every teacher has an empty class list.
 */
function rowCountCollapse(ctx: ValidationContext): CheckResult {
  const { current, previous, policy } = ctx;
  const threshold = `drop <= ${pct(policy.maxRowCountDrop)}`;

  if (!previous) {
    return {
      check: "row_count_collapse",
      outcome: "pass",
      observed: `${current.totalCount} rows`,
      threshold,
      detail: "First run for this source, so there is no baseline to compare against.",
    };
  }
  if (previous.totalCount === 0) {
    return {
      check: "row_count_collapse",
      outcome: "pass",
      observed: `${current.totalCount} rows`,
      threshold,
      detail: "Previous run was empty; nothing to compare.",
    };
  }

  const drop = (previous.totalCount - current.totalCount) / previous.totalCount;
  if (drop > policy.maxRowCountDrop) {
    return {
      check: "row_count_collapse",
      outcome: "fail",
      observed: `${pct(drop)} fewer rows (${previous.totalCount} to ${current.totalCount})`,
      threshold,
      detail:
        "The payload is materially smaller than the last successful run. A truncated export and a real mass withdrawal cannot be told apart from the data, so the run is quarantined rather than applied.",
    };
  }
  return {
    check: "row_count_collapse",
    outcome: "pass",
    observed: drop > 0 ? `${pct(drop)} fewer rows` : `${pct(-drop)} more rows`,
    threshold,
    detail: "Row count is within the expected band.",
  };
}

/**
 * Org disappearance.
 *
 * A school present yesterday and absent today is almost always a sharing change
 * or a partial export. It is almost never a school closing, and it must never
 * be read as its students having been deleted.
 */
function orgDisappearance(ctx: ValidationContext): CheckResult {
  const { current, previous, policy } = ctx;
  if (!previous) {
    return {
      check: "org_disappearance",
      outcome: "pass",
      observed: `${current.schoolIds.length} schools`,
      threshold: "no school disappears",
      detail: "First run for this source.",
    };
  }
  const now = new Set(current.schoolIds);
  const missing = previous.schoolIds.filter((id) => !now.has(id));
  if (missing.length > 0) {
    return {
      check: "org_disappearance",
      outcome: policy.failOnSchoolDisappearance ? "fail" : "warn",
      observed: `${missing.length} missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`,
      threshold: "no school disappears",
      detail:
        "Schools present in the previous run are absent from this one. This is what a sharing change looks like. Applying it would end every enrolment in those schools.",
    };
  }
  return {
    check: "org_disappearance",
    outcome: "pass",
    observed: `${current.schoolIds.length} schools, none missing`,
    threshold: "no school disappears",
    detail: "Every school from the previous run is still present.",
  };
}

/** Enrolments per student outside a plausible band means a join half-completed. */
function enrollmentRatio(ctx: ValidationContext): CheckResult {
  const { current, policy } = ctx;
  const students = current.countsByType["users"] ?? 0;
  const enrolments = current.countsByType["enrollments"] ?? 0;
  const threshold = `${policy.enrollmentRatioMin}–${policy.enrollmentRatioMax} per user`;

  if (students === 0) {
    return {
      check: "enrollment_ratio",
      outcome: enrolments > 0 ? "fail" : "pass",
      observed: `${enrolments} enrolments, ${students} users`,
      threshold,
      detail:
        enrolments > 0
          ? "Enrolments arrived without any users. A referential join has half completed."
          : "No users and no enrolments.",
    };
  }

  const ratio = enrolments / students;
  const inBand = ratio >= policy.enrollmentRatioMin && ratio <= policy.enrollmentRatioMax;
  return {
    check: "enrollment_ratio",
    outcome: inBand ? "pass" : "fail",
    observed: `${ratio.toFixed(2)} enrolments per user`,
    threshold,
    detail: inBand
      ? "Enrolment density looks plausible."
      : "Enrolment density is outside the plausible band, which usually means one collection is incomplete.",
  };
}

/**
 * Everything changed.
 *
 * A meaningful number of providers touch dateLastModified on every row every
 * night. A consumer that trusts it silently turns its delta into a full sync.
 * This is a warning rather than a failure: the data is not wrong, the change
 * tracking is, and the correct response is to fall back to hashing.
 */
function allRowsChanged(ctx: ValidationContext): CheckResult {
  const { current, policy } = ctx;
  const threshold = `< ${pct(policy.allChangedThreshold)} of rows`;
  if (current.totalCount === 0) {
    return {
      check: "all_rows_changed",
      outcome: "pass",
      observed: "0 rows",
      threshold,
      detail: "Empty payload; nothing to assess.",
    };
  }
  const fraction = current.changedCount / current.totalCount;
  if (fraction >= policy.allChangedThreshold) {
    return {
      check: "all_rows_changed",
      outcome: "warn",
      observed: `${pct(fraction)} of rows claim to have changed`,
      threshold,
      detail:
        "The provider is stamping dateLastModified rather than tracking changes. The diff falls back to our own row hash, so this is slow rather than wrong.",
    };
  }
  return {
    check: "all_rows_changed",
    outcome: "pass",
    observed: `${pct(fraction)} of rows changed`,
    threshold,
    detail: "Change tracking from the provider looks meaningful.",
  };
}

/**
 * Frozen feed.
 *
 * A byte-identical payload several days running usually means an upstream
 * export job is failing quietly. It looks like a perfectly healthy sync from
 * the outside, which is exactly why it needs a check of its own.
 */
function frozenFeed(ctx: ValidationContext): CheckResult {
  const { identicalRunStreak, policy } = ctx;
  const threshold = `< ${policy.frozenRunsThreshold} identical runs`;
  if (identicalRunStreak >= policy.frozenRunsThreshold) {
    return {
      check: "frozen_feed",
      outcome: "warn",
      observed: `${identicalRunStreak} consecutive identical payloads`,
      threshold,
      detail:
        "The payload has not changed at all for several runs. In a district of any size that is implausible, and usually means an upstream export is failing without erroring.",
    };
  }
  return {
    check: "frozen_feed",
    outcome: "pass",
    observed: `${identicalRunStreak} consecutive identical payloads`,
    threshold,
    detail: "The payload differs from the previous run, so the upstream export is still producing fresh data.",
  };
}

/** An empty payload raises no exception anywhere, so it needs a gate. */
function emptyPayload(ctx: ValidationContext): CheckResult {
  const { current } = ctx;
  if (current.totalCount === 0) {
    return {
      check: "empty_payload",
      outcome: "fail",
      observed: "0 rows",
      threshold: "> 0 rows",
      detail:
        "The source returned success with no data. A rotated credential and a genuinely empty district look identical, and neither raises an error, so absence is alerted on rather than applied.",
    };
  }
  return {
    check: "empty_payload",
    outcome: "pass",
    observed: `${current.totalCount} rows`,
    threshold: "> 0 rows",
    detail: "The payload contains data.",
  };
}

const CHECKS = [
  emptyPayload,
  rowCountCollapse,
  orgDisappearance,
  enrollmentRatio,
  allRowsChanged,
  frozenFeed,
];

export interface ValidationVerdict {
  results: CheckResult[];
  /** Any failure quarantines the run. Warnings are recorded and applied. */
  verdict: "apply" | "quarantine";
  failed: string[];
  warned: string[];
}

export function validate(ctx: ValidationContext): ValidationVerdict {
  const results = CHECKS.map((check) => check(ctx));
  const failed = results.filter((r) => r.outcome === "fail").map((r) => r.check);
  const warned = results.filter((r) => r.outcome === "warn").map((r) => r.check);
  return {
    results,
    verdict: failed.length > 0 ? "quarantine" : "apply",
    failed,
    warned,
  };
}
