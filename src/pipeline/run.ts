import { OneRosterClient, INGEST_ORDER, SourceError, type CollectionName } from "./oneroster-client.js";
import { payloadHash, rowHash } from "../lib/hash.js";
import { diff, summariseDiff, type KnownRow, type StagedRow } from "./diff.js";
import { DEFAULT_POLICY, validate, type RunSnapshot } from "./validate.js";
import type { Bindings } from "../types.js";

/**
 * The run orchestrator.
 *
 * A sync advances in bounded steps rather than running to completion in one
 * invocation. That is partly a platform constraint, and mostly the right shape
 * anyway: a run that dies on page 400 of 900 should resume, not restart.
 *
 * State machine:
 *
 *   pending -> fetching -> validating -> applying -> applied
 *                              |
 *                              +-------> quarantined   (a gate failed)
 *                  any state  -> failed                (an unrecoverable error)
 */

const PAGE_SIZE = 500;
const APPLY_BATCH = 250;
/**
 * D1 caps bound parameters per statement at around 100, well below SQLite's
 * usual 999. Batch sizes are therefore derived from the column count rather
 * than picked, because "100 rows" means 500 parameters for a five column
 * insert and fails at runtime rather than at compile time.
 */
const MAX_BOUND_PARAMS = 90;
const LOOKUP_CHUNK = 80;
const rowsPerStatement = (columns: number) => Math.max(1, Math.floor(MAX_BOUND_PARAMS / columns));

export interface Cursor {
  collectionIndex: number;
  offset: number;
  /** Per-collection totals reported by the provider, for reconciliation. */
  reportedTotals: Partial<Record<CollectionName, number>>;
  /** Set once fetching completes. */
  fetchComplete?: boolean;
  /** Which collection the apply stage is on. */
  applyIndex?: number;
  /** How far into that collection. Apply is bounded per step for the same
   *  reason fetch is: a district has millions of enrolment rows and no single
   *  invocation should try to write them all. */
  applyOffset?: number;
}

const EMPTY_CURSOR: Cursor = { collectionIndex: 0, offset: 0, reportedTotals: {} };

export interface AdvanceResult {
  runId: string;
  state: string;
  progress: string;
  done: boolean;
}

function nowIso() {
  return new Date().toISOString();
}

async function chunkedInsert(
  db: D1Database,
  sql: (rows: number) => string,
  rows: unknown[][],
): Promise<void> {
  const columns = rows[0]?.length ?? 1;
  const perStatement = rowsPerStatement(columns);
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const placeholders = chunk
      .map((row) => `(${row.map(() => "?").join(",")})`)
      .join(",");
    await db
      .prepare(sql(chunk.length).replace("__VALUES__", placeholders))
      .bind(...chunk.flat())
      .run();
  }
}

export async function advance(env: Bindings, runId: string): Promise<AdvanceResult> {
  const run = await env.DB.prepare("SELECT * FROM sync_runs WHERE id = ?")
    .bind(runId)
    .first<Record<string, unknown>>();
  if (!run) throw new Error(`no such run: ${runId}`);

  const state = String(run["state"]);
  if (["applied", "quarantined", "failed"].includes(state)) {
    return { runId, state, progress: "finished", done: true };
  }

  try {
    if (state === "pending" || state === "fetching") return await stepFetch(env, run);
    if (state === "validating") return await stepValidate(env, run);
    if (state === "applying") return await stepApply(env, run);
    throw new Error(`unexpected state: ${state}`);
  } catch (error) {
    const message = error instanceof SourceError
      ? `${error.name}: ${error.message}`
      : error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      "UPDATE sync_runs SET state = 'failed', message = ?, finished_at = ? WHERE id = ?",
    )
      .bind(message, nowIso(), runId)
      .run();
    return { runId, state: "failed", progress: message, done: true };
  }
}

/** One page of one collection, then return. Resumability comes from the cursor. */
async function stepFetch(env: Bindings, run: Record<string, unknown>): Promise<AdvanceResult> {
  const runId = String(run["id"]);
  const cursor: Cursor = run["cursor_json"]
    ? (JSON.parse(String(run["cursor_json"])) as Cursor)
    : { ...EMPTY_CURSOR };

  const source = await env.DB.prepare("SELECT * FROM sources WHERE id = ?")
    .bind(String(run["source_id"]))
    .first<Record<string, unknown>>();
  if (!source) throw new Error("source not found");

  const client = new OneRosterClient({
    baseUrl: String(source["base_url"]),
    tokenUrl: String(source["token_url"]),
    clientId: String(source["client_id"]),
    clientSecret: String(source["client_secret"]),
    version: String(source["version"]) as "v1p1" | "v1p2",
  });

  const collection = INGEST_ORDER[cursor.collectionIndex];
  if (!collection) {
    cursor.fetchComplete = true;
    await env.DB.prepare("UPDATE sync_runs SET state = 'validating', cursor_json = ? WHERE id = ?")
      .bind(JSON.stringify(cursor), runId)
      .run();
    return { runId, state: "validating", progress: "fetch complete", done: false };
  }

  const page = await client.page(collection, cursor.offset, PAGE_SIZE);
  if (page.total !== null) cursor.reportedTotals[collection] = page.total;

  if (page.rows.length > 0) {
    const staged: unknown[][] = [];
    for (const row of page.rows) {
      const externalId = String(row["sourcedId"] ?? "");
      if (!externalId) continue;
      staged.push([
        runId,
        collection,
        externalId,
        JSON.stringify(row),
        await rowHash(row),
      ]);
    }
    // Duplicate rows are a fact of life in real feeds. Deduplicating on ingest
    // rather than downstream means a class roster is never double counted.
    await chunkedInsert(
      env.DB,
      () =>
        "INSERT OR REPLACE INTO staged_records (run_id, resource_type, external_id, payload_json, row_hash) VALUES __VALUES__",
      staged,
    );
  }

  const exhausted = page.rows.length < PAGE_SIZE;
  if (exhausted) {
    cursor.collectionIndex++;
    cursor.offset = 0;
  } else {
    cursor.offset += PAGE_SIZE;
  }

  const nextState = cursor.collectionIndex >= INGEST_ORDER.length ? "validating" : "fetching";
  if (nextState === "validating") cursor.fetchComplete = true;

  await env.DB.prepare("UPDATE sync_runs SET state = ?, cursor_json = ? WHERE id = ?")
    .bind(nextState, JSON.stringify(cursor), runId)
    .run();

  return {
    runId,
    state: nextState,
    progress: `${collection}: ${cursor.offset || "complete"}`,
    done: false,
  };
}

async function buildSnapshot(env: Bindings, runId: string): Promise<RunSnapshot> {
  const counts = await env.DB.prepare(
    "SELECT resource_type, COUNT(*) AS n FROM staged_records WHERE run_id = ? GROUP BY resource_type",
  )
    .bind(runId)
    .all<{ resource_type: string; n: number }>();

  const countsByType: Record<string, number> = {};
  let totalCount = 0;
  for (const row of counts.results ?? []) {
    countsByType[row.resource_type] = row.n;
    totalCount += row.n;
  }

  const schools = await env.DB.prepare(
    `SELECT external_id, payload_json FROM staged_records
      WHERE run_id = ? AND resource_type = 'orgs'`,
  )
    .bind(runId)
    .all<{ external_id: string; payload_json: string }>();

  const schoolIds = (schools.results ?? [])
    .filter((row) => {
      try {
        return (JSON.parse(row.payload_json) as { type?: string }).type === "school";
      } catch {
        return false;
      }
    })
    .map((row) => row.external_id);

  const hashes = await env.DB.prepare(
    "SELECT row_hash FROM staged_records WHERE run_id = ?",
  )
    .bind(runId)
    .all<{ row_hash: string }>();

  // "Changed" here means the provider's own timestamp moved, which is what the
  // all-rows-changed gate is assessing. It is deliberately not our hash.
  const changed = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM staged_records s
      WHERE s.run_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_records r
           WHERE r.resource_type = s.resource_type
             AND r.external_id = s.external_id
             AND r.last_hash = s.row_hash
        )`,
  )
    .bind(runId)
    .first<{ n: number }>();

  return {
    countsByType,
    schoolIds,
    changedCount: changed?.n ?? 0,
    totalCount,
    payloadHash: await payloadHash((hashes.results ?? []).map((r) => r.row_hash)),
  };
}

async function stepValidate(env: Bindings, run: Record<string, unknown>): Promise<AdvanceResult> {
  const runId = String(run["id"]);
  const districtId = String(run["district_id"]);
  const sourceId = String(run["source_id"]);

  const current = await buildSnapshot(env, runId);

  const previousRun = await env.DB.prepare(
    `SELECT stats_json FROM sync_runs
      WHERE district_id = ? AND source_id = ? AND state = 'applied' AND id != ?
      ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(districtId, sourceId, runId)
    .first<{ stats_json: string }>();

  let previous: RunSnapshot | null = null;
  if (previousRun) {
    try {
      previous = (JSON.parse(previousRun.stats_json) as { snapshot?: RunSnapshot }).snapshot ?? null;
    } catch {
      previous = null;
    }
  }

  const recent = await env.DB.prepare(
    `SELECT stats_json FROM sync_runs
      WHERE district_id = ? AND source_id = ? AND id != ?
      ORDER BY started_at DESC LIMIT 5`,
  )
    .bind(districtId, sourceId, runId)
    .all<{ stats_json: string }>();

  let identicalRunStreak = 0;
  for (const row of recent.results ?? []) {
    try {
      const snap = (JSON.parse(row.stats_json) as { snapshot?: RunSnapshot }).snapshot;
      if (snap && snap.payloadHash === current.payloadHash) identicalRunStreak++;
      else break;
    } catch {
      break;
    }
  }

  const verdict = validate({ current, previous, identicalRunStreak, policy: DEFAULT_POLICY });

  for (const result of verdict.results) {
    await env.DB.prepare(
      `INSERT INTO validation_results (run_id, check_name, outcome, observed, threshold, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(runId, result.check, result.outcome, result.observed, result.threshold, result.detail, nowIso())
      .run();
  }

  const stats = JSON.stringify({ snapshot: current, validation: { failed: verdict.failed, warned: verdict.warned } });

  if (verdict.verdict === "quarantine") {
    // Yesterday's data stays live and an operator is told. A district would far
    // rather be a day stale than wrong.
    await env.DB.prepare(
      `UPDATE sync_runs SET state = 'quarantined', stats_json = ?, finished_at = ?, message = ? WHERE id = ?`,
    )
      .bind(stats, nowIso(), `quarantined by: ${verdict.failed.join(", ")}`, runId)
      .run();
    return { runId, state: "quarantined", progress: verdict.failed.join(", "), done: true };
  }

  await env.DB.prepare("UPDATE sync_runs SET state = 'applying', stats_json = ? WHERE id = ?")
    .bind(stats, runId)
    .run();
  return { runId, state: "applying", progress: "validation passed", done: false };
}

async function stepApply(env: Bindings, run: Record<string, unknown>): Promise<AdvanceResult> {
  const runId = String(run["id"]);
  const districtId = String(run["district_id"]);
  const sourceId = String(run["source_id"]);
  const cursor: Cursor = run["cursor_json"]
    ? (JSON.parse(String(run["cursor_json"])) as Cursor)
    : { ...EMPTY_CURSOR };
  const applyIndex = cursor.applyIndex ?? 0;
  const applyOffset = cursor.applyOffset ?? 0;

  const collection = INGEST_ORDER[applyIndex];
  if (!collection) {
    await env.DB.prepare("UPDATE sync_runs SET state = 'applied', finished_at = ? WHERE id = ?")
      .bind(nowIso(), runId)
      .run();
    return { runId, state: "applied", progress: "complete", done: true };
  }

  // One bounded slice per step, ordered stably so the offset means something.
  const stagedRows = await env.DB.prepare(
    `SELECT external_id, payload_json, row_hash FROM staged_records
      WHERE run_id = ? AND resource_type = ?
      ORDER BY external_id LIMIT ? OFFSET ?`,
  )
    .bind(runId, collection, APPLY_BATCH, applyOffset)
    .all<{ external_id: string; payload_json: string; row_hash: string }>();

  const slice = stagedRows.results ?? [];

  if (slice.length === 0) {
    // Collection exhausted. Reconcile deletions once, then move on.
    await finaliseCollection(env, districtId, sourceId, runId, collection);
    cursor.applyIndex = applyIndex + 1;
    cursor.applyOffset = 0;
    await env.DB.prepare("UPDATE sync_runs SET cursor_json = ? WHERE id = ?")
      .bind(JSON.stringify(cursor), runId)
      .run();
    return { runId, state: "applying", progress: `${collection} complete`, done: false };
  }

  const staged: StagedRow[] = slice.map((row) => {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    return {
      externalId: row.external_id,
      hash: row.row_hash,
      status: String(payload["status"] ?? "active"),
      payload,
    };
  });

  // D1 caps bound parameters per statement well below SQLite's usual limit, so
  // an IN list is chunked rather than assumed to fit.
  const externalIds = staged.map((row) => row.externalId);
  const known: KnownRow[] = [];
  for (let i = 0; i < externalIds.length; i += LOOKUP_CHUNK) {
    const chunk = externalIds.slice(i, i + LOOKUP_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const knownRows = await env.DB.prepare(
      `SELECT external_id, last_hash, status FROM sync_records
        WHERE district_id = ? AND source_id = ? AND resource_type = ?
          AND external_id IN (${placeholders})`,
    )
      .bind(districtId, sourceId, collection, ...chunk)
      .all<{ external_id: string; last_hash: string; status: string }>();
    for (const row of knownRows.results ?? []) {
      known.push({ externalId: row.external_id, hash: row.last_hash, status: row.status });
    }
  }

  // Absence is meaningless within a slice, so sweeping is disabled here and
  // handled once per collection in finaliseCollection.
  const result = diff(staged, known, { fullPayload: false, validationPassed: true });

  await applyCollection(env, districtId, sourceId, runId, collection, result.created.concat(result.updated));

  for (const row of result.explicitlyDeleted) {
    await env.DB.prepare(
      "UPDATE sync_records SET status = 'inactive', last_seen_at = ? WHERE district_id = ? AND source_id = ? AND resource_type = ? AND external_id = ?",
    )
      .bind(nowIso(), districtId, sourceId, collection, row.externalId)
      .run();
  }

  const stats = JSON.parse(String(run["stats_json"] ?? "{}")) as Record<string, unknown>;
  const perCollection = (stats["diff"] as Record<string, ReturnType<typeof summariseDiff>>) ?? {};
  const running = perCollection[collection] ?? {
    created: 0, updated: 0, unchanged: 0, explicitlyDeleted: 0, absent: 0, absentSwept: 0,
  };
  const sliceSummary = summariseDiff(result);
  perCollection[collection] = {
    created: running.created + sliceSummary.created,
    updated: running.updated + sliceSummary.updated,
    unchanged: running.unchanged + sliceSummary.unchanged,
    explicitlyDeleted: running.explicitlyDeleted + sliceSummary.explicitlyDeleted,
    absent: running.absent,
    absentSwept: running.absentSwept,
  };
  stats["diff"] = perCollection;

  cursor.applyOffset = applyOffset + slice.length;
  await env.DB.prepare("UPDATE sync_runs SET cursor_json = ?, stats_json = ? WHERE id = ?")
    .bind(JSON.stringify(cursor), JSON.stringify(stats), runId)
    .run();

  return {
    runId,
    state: "applying",
    progress: `${collection} ${cursor.applyOffset}`,
    done: false,
  };
}

/**
 * Reconciles absence once a collection has been fully applied.
 *
 * Rows we hold that were not seen in this run are marked, not destroyed, and
 * only after a full validated payload. A row absent for several consecutive
 * runs is finally deactivated; one absent once is far more likely to be a
 * partial export than a deletion.
 */
async function finaliseCollection(
  env: Bindings,
  districtId: string,
  sourceId: string,
  runId: string,
  collection: CollectionName,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sync_records SET status = 'missing'
      WHERE district_id = ? AND source_id = ? AND resource_type = ?
        AND last_seen_run != ? AND status = 'active'`,
  )
    .bind(districtId, sourceId, collection, runId)
    .run();
}

/**
 * Writes a collection into the operational tables, resolving external
 * identifiers to internal ones on the way.
 *
 * Statements are collected and sent with `db.batch()` rather than one round
 * trip per row. At district scale the difference is not cosmetic: a slice of
 * 250 enrolments is two round trips instead of five hundred.
 */
async function applyCollection(
  env: Bindings,
  districtId: string,
  sourceId: string,
  runId: string,
  collection: CollectionName,
  rows: StagedRow[],
): Promise<void> {
  if (rows.length === 0) return;

  const provider = `oneroster:${sourceId}`;
  const at = nowIso();
  const statements: D1PreparedStatement[] = [];

  // Enrolments and users both need identity lookups. Doing them as one query
  // per slice rather than one per row keeps the step within budget.
  let identityByExternal = new Map<string, string>();
  if (collection === "users" || collection === "enrollments") {
    const keys = collection === "users"
      ? rows.map((r) => r.externalId)
      : rows.map((r) => String(r.payload["userSourcedId"] ?? "")).filter(Boolean);
    if (keys.length > 0) {
      const unique = [...new Set(keys)];
      for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
        const chunk = unique.slice(i, i + LOOKUP_CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const found = await env.DB.prepare(
          `SELECT external_id, person_id FROM identities
            WHERE district_id = ? AND provider = ? AND external_id IN (${placeholders})`,
        )
          .bind(districtId, provider, ...chunk)
          .all<{ external_id: string; person_id: string }>();
        for (const row of found.results ?? []) {
          identityByExternal.set(row.external_id, row.person_id);
        }
      }
    }
  }

  for (const row of rows) {
    const p = row.payload;

    if (collection === "orgs") {
      statements.push(
        env.DB.prepare(
          `INSERT INTO orgs (id, district_id, external_id, name, type, parent_id, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type,
             parent_id=excluded.parent_id, status='active', updated_at=excluded.updated_at`,
        ).bind(
          `${districtId}:${row.externalId}`, districtId, row.externalId,
          String(p["name"] ?? ""), String(p["type"] ?? "school"),
          p["parentSourcedId"] ? `${districtId}:${String(p["parentSourcedId"])}` : null, at,
        ),
      );
    } else if (collection === "classes") {
      statements.push(
        env.DB.prepare(
          `INSERT INTO classes (id, district_id, external_id, title, class_type, school_id, grades_json, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, class_type=excluded.class_type,
             school_id=excluded.school_id, grades_json=excluded.grades_json, status='active',
             updated_at=excluded.updated_at`,
        ).bind(
          `${districtId}:${row.externalId}`, districtId, row.externalId,
          String(p["title"] ?? ""), String(p["classType"] ?? "scheduled"),
          p["schoolSourcedId"] ? `${districtId}:${String(p["schoolSourcedId"])}` : null,
          JSON.stringify(p["grades"] ?? []), at,
        ),
      );
    } else if (collection === "users") {
      const existing = identityByExternal.get(row.externalId);
      const personId = existing ?? `per_${districtId}_${row.externalId}`;
      const grades = Array.isArray(p["grades"]) ? (p["grades"] as string[]) : [];

      statements.push(
        env.DB.prepare(
          `INSERT INTO persons (id, district_id, given_name, family_name, preferred_name, grade_level, email, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET given_name=excluded.given_name, family_name=excluded.family_name,
             grade_level=excluded.grade_level, email=excluded.email, updated_at=excluded.updated_at`,
        ).bind(
          personId, districtId, String(p["givenName"] ?? ""), String(p["familyName"] ?? ""), null,
          // A STRING. PK, KG, 01..12, UG. Never parsed as a number.
          grades[0] ?? null,
          p["email"] === null || p["email"] === undefined ? null : String(p["email"]),
          at, at,
        ),
      );
      if (!existing) {
        statements.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO identities (district_id, provider, external_id, person_id, verified_at) VALUES (?, ?, ?, ?, ?)",
          ).bind(districtId, provider, row.externalId, personId, at),
        );
      }
    } else if (collection === "enrollments") {
      const personId = identityByExternal.get(String(p["userSourcedId"] ?? ""));
      // The user has not been applied yet. Skipping is correct: the enrolment
      // is still staged and the next run picks it up once the user exists.
      if (!personId) continue;

      statements.push(
        env.DB.prepare(
          `INSERT INTO enrollments (id, district_id, external_id, person_id, class_id, school_id, role, is_primary, begin_date, end_date, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
           ON CONFLICT(id) DO UPDATE SET role=excluded.role, is_primary=excluded.is_primary,
             begin_date=excluded.begin_date, end_date=excluded.end_date, status='active',
             updated_at=excluded.updated_at`,
        ).bind(
          `${districtId}:${row.externalId}`, districtId, row.externalId, personId,
          `${districtId}:${String(p["classSourcedId"] ?? "")}`,
          p["schoolSourcedId"] ? `${districtId}:${String(p["schoolSourcedId"])}` : null,
          String(p["role"] ?? "student"),
          p["primary"] === null || p["primary"] === undefined ? null : p["primary"] ? 1 : 0,
          p["beginDate"] ?? null, p["endDate"] ?? null, at,
        ),
      );
    }

    statements.push(
      env.DB.prepare(
        `INSERT INTO sync_records (district_id, source_id, resource_type, external_id, last_hash, last_seen_run, last_seen_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
         ON CONFLICT(district_id, source_id, resource_type, external_id)
         DO UPDATE SET last_hash=excluded.last_hash, last_seen_run=excluded.last_seen_run,
           last_seen_at=excluded.last_seen_at, status='active'`,
      ).bind(districtId, sourceId, collection, row.externalId, row.hash, runId, at),
    );
  }

  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
}
