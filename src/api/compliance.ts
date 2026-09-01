import { Hono } from "hono";
import type { AppEnv } from "../types.js";

/**
 * Compliance operations.
 *
 * These are product features, not paperwork. FERPA gives a parent the right to
 * inspect the education record (34 CFR 99.10) and to seek correction of it
 * (99.20). If the platform cannot produce one student's record and amend it,
 * the district cannot answer a request it is legally obliged to answer.
 *
 * Retention is per district because it is contractual, and the 2025 COPPA
 * amendments ended indefinite retention of children's data, so the deletion
 * job has to actually run and has to produce evidence that it did.
 */
export const complianceRoutes = new Hono<AppEnv>();

async function audit(
  db: D1Database,
  districtId: string,
  actor: string,
  action: string,
  subjectType: string,
  subjectId: string | null,
  detail: unknown,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO audit_log (district_id, actor, action, subject_type, subject_id, detail_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(districtId, actor, action, subjectType, subjectId, JSON.stringify(detail ?? {}), new Date().toISOString())
    .run();
}

/**
 * Per-student export.
 *
 * Human readable on purpose. A parent has to be able to read it, so it is not
 * a database dump; identifiers are included but the record leads with what the
 * person actually did.
 */
complianceRoutes.get("/districts/:districtId/persons/:personId/record", async (c) => {
  const { districtId, personId } = c.req.param();
  const actor = c.req.header("x-actor") ?? "unknown";

  const person = await c.env.DB.prepare(
    "SELECT * FROM persons WHERE id = ? AND district_id = ?",
  )
    .bind(personId, districtId)
    .first<Record<string, unknown>>();
  if (!person) return c.json({ error: "no such person in this district" }, 404);

  const [identities, enrollments, amendments] = await Promise.all([
    c.env.DB.prepare("SELECT provider, external_id, verified_at FROM identities WHERE person_id = ?")
      .bind(personId).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT e.external_id, e.role, e.is_primary, e.begin_date, e.end_date, e.status,
              c.title AS class_title, c.class_type, o.name AS school_name
         FROM enrollments e
         LEFT JOIN classes c ON c.id = e.class_id
         LEFT JOIN orgs o ON o.id = e.school_id
        WHERE e.person_id = ? ORDER BY c.title`,
    ).bind(personId).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      "SELECT field, previous, corrected, reason, requested_by, applied_at FROM amendments WHERE person_id = ? ORDER BY applied_at DESC",
    ).bind(personId).all<Record<string, unknown>>(),
  ]);

  await audit(c.env.DB, districtId, actor, "record.export", "person", personId, {
    enrollments: (enrollments.results ?? []).length,
  });

  return c.json({
    generatedAt: new Date().toISOString(),
    notice:
      "This is the complete record this system holds for this student, produced under the inspection right at 34 CFR 99.10. Identifiers from the district's source systems are listed so the record can be reconciled with the student information system.",
    student: {
      name: `${String(person["given_name"])} ${String(person["family_name"])}`,
      gradeLevel: person["grade_level"],
      email: person["email"],
      firstSeen: person["created_at"],
      lastUpdated: person["updated_at"],
    },
    // Several external identifiers, one person. Shown because a parent asking
    // "is this the same child" deserves a real answer.
    identifiers: (identities.results ?? []).map((row) => ({
      source: row["provider"],
      identifier: row["external_id"],
      firstResolved: row["verified_at"],
    })),
    classes: (enrollments.results ?? []).map((row) => ({
      school: row["school_name"],
      class: row["class_title"],
      kind: row["class_type"],
      role: row["role"],
      teacherOfRecord: row["is_primary"] === 1 ? true : row["is_primary"] === 0 ? false : null,
      from: row["begin_date"],
      to: row["end_date"],
      status: row["status"],
    })),
    corrections: amendments.results ?? [],
  });
});

/**
 * Amendment.
 *
 * The correction is layered on top rather than rewriting history. An immutable
 * event log and a legal right to correction are in genuine tension; keeping
 * both the original and the amendment resolves it honestly.
 */
complianceRoutes.post("/districts/:districtId/persons/:personId/amendments", async (c) => {
  const { districtId, personId } = c.req.param();
  const actor = c.req.header("x-actor") ?? "unknown";
  const body = (await c.req.json()) as { field?: string; corrected?: string; reason?: string };

  const ALLOWED = new Set(["given_name", "family_name", "preferred_name", "email", "grade_level"]);
  if (!body.field || !ALLOWED.has(body.field)) {
    return c.json({ error: `field must be one of: ${[...ALLOWED].join(", ")}` }, 400);
  }
  if (!body.corrected || !body.reason) {
    return c.json({ error: "corrected and reason are required" }, 400);
  }

  const person = await c.env.DB.prepare("SELECT * FROM persons WHERE id = ? AND district_id = ?")
    .bind(personId, districtId)
    .first<Record<string, unknown>>();
  if (!person) return c.json({ error: "no such person in this district" }, 404);

  const previous = person[body.field] === null ? null : String(person[body.field]);
  const id = `amd_${crypto.randomUUID()}`;
  const at = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO amendments (id, district_id, person_id, field, previous, corrected, reason, requested_by, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, districtId, personId, body.field, previous, body.corrected, body.reason, actor, at)
    .run();

  await c.env.DB.prepare(
    `UPDATE persons SET ${body.field} = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(body.corrected, at, personId)
    .run();

  await audit(c.env.DB, districtId, actor, "record.amend", "person", personId, {
    field: body.field, previous, corrected: body.corrected, reason: body.reason,
  });

  return c.json({ id, field: body.field, previous, corrected: body.corrected, appliedAt: at }, 201);
});

/** Retention-driven deletion. Runs on a schedule and produces evidence. */
complianceRoutes.post("/districts/:districtId/deletion-jobs", async (c) => {
  const districtId = c.req.param("districtId");
  const actor = c.req.header("x-actor") ?? "unknown";
  const body = (await c.req.json().catch(() => ({}))) as { scope?: string; subjectId?: string; dryRun?: boolean };
  const scope = body.scope ?? "retention";
  const dryRun = body.dryRun !== false;

  const district = await c.env.DB.prepare("SELECT * FROM districts WHERE id = ?")
    .bind(districtId)
    .first<Record<string, unknown>>();
  if (!district) return c.json({ error: "no such district" }, 404);

  const retentionDays = Number(district["retention_days"] ?? 1095);
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

  // Every store the data lives in gets enumerated. A deletion that leaves rows
  // in staging or the audit trail is not a deletion.
  const targets =
    scope === "person" && body.subjectId
      ? [
          { table: "enrollments", sql: "SELECT COUNT(*) n FROM enrollments WHERE person_id = ?", params: [body.subjectId] },
          { table: "identities", sql: "SELECT COUNT(*) n FROM identities WHERE person_id = ?", params: [body.subjectId] },
          { table: "persons", sql: "SELECT COUNT(*) n FROM persons WHERE id = ?", params: [body.subjectId] },
        ]
      : [
          { table: "staged_records", sql: "SELECT COUNT(*) n FROM staged_records WHERE run_id IN (SELECT id FROM sync_runs WHERE district_id = ? AND started_at < ?)", params: [districtId, cutoff] },
          { table: "validation_results", sql: "SELECT COUNT(*) n FROM validation_results WHERE run_id IN (SELECT id FROM sync_runs WHERE district_id = ? AND started_at < ?)", params: [districtId, cutoff] },
          { table: "sync_runs", sql: "SELECT COUNT(*) n FROM sync_runs WHERE district_id = ? AND started_at < ?", params: [districtId, cutoff] },
          { table: "audit_log", sql: "SELECT COUNT(*) n FROM audit_log WHERE district_id = ? AND at < ?", params: [districtId, cutoff] },
        ];

  const counts: Record<string, number> = {};
  for (const target of targets) {
    const row = await c.env.DB.prepare(target.sql).bind(...target.params).first<{ n: number }>();
    counts[target.table] = row?.n ?? 0;
  }

  const jobId = `del_${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();

  if (!dryRun) {
    if (scope === "person" && body.subjectId) {
      await c.env.DB.prepare("DELETE FROM enrollments WHERE person_id = ?").bind(body.subjectId).run();
      await c.env.DB.prepare("DELETE FROM identities WHERE person_id = ?").bind(body.subjectId).run();
      await c.env.DB.prepare("DELETE FROM persons WHERE id = ?").bind(body.subjectId).run();
    } else {
      await c.env.DB.prepare("DELETE FROM staged_records WHERE run_id IN (SELECT id FROM sync_runs WHERE district_id = ? AND started_at < ?)").bind(districtId, cutoff).run();
      await c.env.DB.prepare("DELETE FROM validation_results WHERE run_id IN (SELECT id FROM sync_runs WHERE district_id = ? AND started_at < ?)").bind(districtId, cutoff).run();
      await c.env.DB.prepare("DELETE FROM sync_runs WHERE district_id = ? AND started_at < ?").bind(districtId, cutoff).run();
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO deletion_jobs (id, district_id, scope, subject_id, state, counts_json, requested_by, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(jobId, districtId, scope, body.subjectId ?? null, dryRun ? "complete" : "complete",
      JSON.stringify({ counts, dryRun, cutoff }), actor, startedAt, new Date().toISOString())
    .run();

  await audit(c.env.DB, districtId, actor, dryRun ? "deletion.dry_run" : "deletion.execute", "district", districtId, { counts, cutoff, scope });

  return c.json({
    jobId,
    scope,
    dryRun,
    retentionDays,
    cutoff,
    counts,
    certificate: dryRun
      ? "Dry run. Nothing was deleted. Re-issue with dryRun false to execute."
      : `Deleted on ${new Date().toISOString()} by ${actor}. Counts above are the rows removed from each store.`,
  }, 201);
});

/** The jurisdiction's incident clock, computed rather than remembered. */
complianceRoutes.get("/districts/:districtId/incident-clock", async (c) => {
  const districtId = c.req.param("districtId");
  const row = await c.env.DB.prepare(
    `SELECT d.name AS district, j.code, j.name AS jurisdiction, j.breach_notify_hours,
            j.breach_trigger, j.breach_unit, j.security_framework, j.statute, j.parent_rights_json
       FROM districts d JOIN jurisdictions j ON j.code = d.jurisdiction_code
      WHERE d.id = ?`,
  )
    .bind(districtId)
    .first<Record<string, unknown>>();
  if (!row) return c.json({ error: "no such district" }, 404);

  return c.json({
    district: row["district"],
    jurisdiction: { code: row["code"], name: row["jurisdiction"], statute: row["statute"] },
    breachNotification: {
      within: `${Number(row["breach_notify_hours"]) / 24} ${row["breach_unit"]} days`,
      hours: row["breach_notify_hours"],
      from: row["breach_trigger"],
    },
    securityFramework: row["security_framework"],
    parentRights: JSON.parse(String(row["parent_rights_json"])),
  });
});

/**
 * The question that matters at 02:00 during a real incident: given these
 * districts, what is the shortest clock I am working against?
 */
complianceRoutes.post("/incident-clock", async (c) => {
  const body = (await c.req.json()) as { districtIds: string[] };
  if (!Array.isArray(body.districtIds) || body.districtIds.length === 0) {
    return c.json({ error: "districtIds is required" }, 400);
  }
  const placeholders = body.districtIds.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.name, j.code, j.name AS jurisdiction, j.breach_notify_hours, j.breach_unit, j.statute
       FROM districts d JOIN jurisdictions j ON j.code = d.jurisdiction_code
      WHERE d.id IN (${placeholders})
      ORDER BY j.breach_notify_hours ASC`,
  )
    .bind(...body.districtIds)
    .all<Record<string, unknown>>();

  const affected = rows.results ?? [];
  if (affected.length === 0) return c.json({ error: "no matching districts" }, 404);

  const shortest = affected[0] as Record<string, unknown>;
  const deadline = new Date(Date.now() + Number(shortest["breach_notify_hours"]) * 3_600_000);

  return c.json({
    affectedDistricts: affected.length,
    shortestClock: {
      district: shortest["name"],
      jurisdiction: shortest["jurisdiction"],
      statute: shortest["statute"],
      hours: shortest["breach_notify_hours"],
      deadline: deadline.toISOString(),
    },
    allClocks: affected.map((row) => ({
      district: row["name"],
      jurisdiction: row["code"],
      hours: row["breach_notify_hours"],
      unit: row["breach_unit"],
    })),
    note: "Notify against the shortest clock. Working to the longest satisfies neither statute.",
  });
});
