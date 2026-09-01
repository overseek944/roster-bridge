/**
 * Diff.
 *
 * The rule that everything else follows from: never replace the world. The
 * naive nightly job (truncate, reload) destroys every internal id, breaks every
 * foreign key from our own domain, and makes it impossible to answer "who was
 * in this class in March".
 *
 * Deletion has two distinct cases that must not be conflated:
 *
 *   Explicit  the row arrived with status `tobedeleted`. Act on it.
 *   Absence   the row simply is not in this payload. That is NOT a deletion.
 *             It may be a delta payload, a partial share, or a failed export.
 *
 * Absence is only ever treated as deletion after a full payload that passed
 * validation, and even then only after a grace period of consecutive runs.
 */

export interface StagedRow {
  externalId: string;
  hash: string;
  status: string;
  payload: Record<string, unknown>;
}

export interface KnownRow {
  externalId: string;
  hash: string;
  status: string;
}

export interface DiffResult {
  created: StagedRow[];
  updated: StagedRow[];
  unchanged: number;
  /** Rows the provider explicitly marked for deletion. */
  explicitlyDeleted: KnownRow[];
  /**
   * Rows we hold that were absent from this payload. Reported, and swept only
   * under the conditions in `sweepEligible`.
   */
  absent: KnownRow[];
  sweepEligible: boolean;
}

export interface DiffOptions {
  /** True when the payload was a complete set rather than a delta. */
  fullPayload: boolean;
  /** True when every validation gate passed. */
  validationPassed: boolean;
}

export function diff(
  staged: StagedRow[],
  known: KnownRow[],
  options: DiffOptions,
): DiffResult {
  const knownByExternal = new Map(known.map((row) => [row.externalId, row]));
  const seen = new Set<string>();

  const created: StagedRow[] = [];
  const updated: StagedRow[] = [];
  const explicitlyDeleted: KnownRow[] = [];
  let unchanged = 0;

  for (const row of staged) {
    seen.add(row.externalId);
    const existing = knownByExternal.get(row.externalId);

    if (row.status === "tobedeleted") {
      // Ending visibility, never destroying history. A section marked
      // tobedeleted in June means the school year ended.
      if (existing) explicitlyDeleted.push(existing);
      continue;
    }

    if (!existing) {
      created.push(row);
    } else if (existing.hash !== row.hash) {
      updated.push(row);
    } else {
      unchanged++;
    }
  }

  const absent = known.filter(
    (row) => !seen.has(row.externalId) && row.status === "active",
  );

  return {
    created,
    updated,
    unchanged,
    explicitlyDeleted,
    absent,
    // Absence only means anything if we asked for everything and believed
    // the answer.
    sweepEligible: options.fullPayload && options.validationPassed,
  };
}

export function summariseDiff(result: DiffResult) {
  return {
    created: result.created.length,
    updated: result.updated.length,
    unchanged: result.unchanged,
    explicitlyDeleted: result.explicitlyDeleted.length,
    absent: result.absent.length,
    absentSwept: result.sweepEligible ? result.absent.length : 0,
  };
}
