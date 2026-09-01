import { describe, expect, it } from "vitest";
import { diff, type KnownRow, type StagedRow } from "../src/pipeline/diff.js";

const staged = (externalId: string, hash: string, status = "active"): StagedRow => ({
  externalId, hash, status, payload: {},
});
const known = (externalId: string, hash: string, status = "active"): KnownRow => ({
  externalId, hash, status,
});

const FULL = { fullPayload: true, validationPassed: true };
const DELTA = { fullPayload: false, validationPassed: true };

describe("diff", () => {
  it("creates rows it has not seen", () => {
    const r = diff([staged("a", "1")], [], FULL);
    expect(r.created.map((x) => x.externalId)).toEqual(["a"]);
  });

  it("updates on hash change and leaves identical rows alone", () => {
    const r = diff([staged("a", "2"), staged("b", "1")], [known("a", "1"), known("b", "1")], FULL);
    expect(r.updated.map((x) => x.externalId)).toEqual(["a"]);
    expect(r.unchanged).toBe(1);
  });

  it("acts on an explicit tobedeleted", () => {
    const r = diff([staged("a", "1", "tobedeleted")], [known("a", "1")], FULL);
    expect(r.explicitlyDeleted.map((x) => x.externalId)).toEqual(["a"]);
    expect(r.updated).toHaveLength(0);
  });

  // The important one. Absence is not deletion.
  it("does not treat absence as deletion in a delta payload", () => {
    const r = diff([staged("a", "1")], [known("a", "1"), known("b", "1")], DELTA);
    expect(r.absent.map((x) => x.externalId)).toEqual(["b"]);
    expect(r.sweepEligible).toBe(false);
  });

  it("does not sweep absent rows when validation failed", () => {
    const r = diff([staged("a", "1")], [known("a", "1"), known("b", "1")], {
      fullPayload: true,
      validationPassed: false,
    });
    expect(r.absent).toHaveLength(1);
    expect(r.sweepEligible).toBe(false);
  });

  it("only becomes sweep-eligible after a full, validated payload", () => {
    const r = diff([staged("a", "1")], [known("a", "1"), known("b", "1")], FULL);
    expect(r.sweepEligible).toBe(true);
    expect(r.absent.map((x) => x.externalId)).toEqual(["b"]);
  });

  it("reports absence without acting on already-inactive rows", () => {
    const r = diff([], [known("b", "1", "inactive")], FULL);
    expect(r.absent).toHaveLength(0);
  });
});
