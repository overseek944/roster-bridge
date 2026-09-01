import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  validate,
  type RunSnapshot,
  type ValidationContext,
} from "../src/pipeline/validate.js";

function snapshot(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    countsByType: { orgs: 13, users: 5748, enrollments: 22306, classes: 962 },
    schoolIds: Array.from({ length: 12 }, (_, i) => `org-school-${String(i + 1).padStart(3, "0")}`),
    changedCount: 12,
    totalCount: 29029,
    payloadHash: "baseline",
    ...over,
  };
}

function ctx(over: Partial<ValidationContext> = {}): ValidationContext {
  return {
    current: snapshot(),
    previous: snapshot(),
    identicalRunStreak: 0,
    policy: DEFAULT_POLICY,
    ...over,
  };
}

describe("validation gates", () => {
  it("applies a healthy run", () => {
    const verdict = validate(ctx());
    expect(verdict.verdict).toBe("apply");
    expect(verdict.failed).toEqual([]);
  });

  it("quarantines a truncated export", () => {
    // The sandbox's truncatePercent fault produces exactly this shape.
    const verdict = validate(
      ctx({ current: snapshot({ totalCount: 8700, countsByType: { users: 1724, enrollments: 6690 } }) }),
    );
    expect(verdict.verdict).toBe("quarantine");
    expect(verdict.failed).toContain("row_count_collapse");
  });

  it("does not fire on a modest, plausible decrease", () => {
    const verdict = validate(ctx({ current: snapshot({ totalCount: 28000 }) }));
    expect(verdict.failed).not.toContain("row_count_collapse");
  });

  it("quarantines when a school disappears from the share", () => {
    const fewer = snapshot({ schoolIds: snapshot().schoolIds.slice(0, 10) });
    const verdict = validate(ctx({ current: fewer }));
    expect(verdict.verdict).toBe("quarantine");
    expect(verdict.failed).toContain("org_disappearance");
  });

  it("treats a new school as unremarkable", () => {
    const more = snapshot({ schoolIds: [...snapshot().schoolIds, "org-school-013"] });
    const verdict = validate(ctx({ current: more }));
    expect(verdict.failed).not.toContain("org_disappearance");
  });

  it("quarantines an empty payload served with success", () => {
    const empty = snapshot({ totalCount: 0, countsByType: {}, schoolIds: [] });
    const verdict = validate(ctx({ current: empty }));
    expect(verdict.verdict).toBe("quarantine");
    expect(verdict.failed).toContain("empty_payload");
  });

  it("quarantines enrolments that arrived without users", () => {
    const orphaned = snapshot({ countsByType: { users: 0, enrollments: 22306 } });
    const verdict = validate(ctx({ current: orphaned }));
    expect(verdict.failed).toContain("enrollment_ratio");
  });

  it("warns rather than fails when the provider stamps every row", () => {
    const stamped = snapshot({ changedCount: 29029 });
    const verdict = validate(ctx({ current: stamped }));
    // The data is fine; the change tracking is not. Applying is still correct.
    expect(verdict.verdict).toBe("apply");
    expect(verdict.warned).toContain("all_rows_changed");
  });

  it("warns on a frozen feed", () => {
    const verdict = validate(ctx({ identicalRunStreak: 4 }));
    expect(verdict.verdict).toBe("apply");
    expect(verdict.warned).toContain("frozen_feed");
  });

  it("passes the first run for a source, with no baseline", () => {
    const verdict = validate(ctx({ previous: null }));
    expect(verdict.verdict).toBe("apply");
  });

  it("explains every result, so an operator can act on it", () => {
    for (const result of validate(ctx()).results) {
      expect(result.detail.length).toBeGreaterThan(20);
      expect(result.observed).toBeTruthy();
    }
  });
});
