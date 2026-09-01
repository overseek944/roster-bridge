import { Hono } from "hono";
import { advance } from "../pipeline/run.js";
import type { AppEnv } from "../types.js";

export const adminRoutes = new Hono<AppEnv>();

const iso = () => new Date().toISOString();

adminRoutes.get("/districts", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT d.*, j.name AS jurisdiction_name, j.breach_notify_hours, j.statute
       FROM districts d JOIN jurisdictions j ON j.code = d.jurisdiction_code
      ORDER BY d.name`,
  ).all<Record<string, unknown>>();
  return c.json({ districts: rows.results ?? [] });
});

adminRoutes.post("/districts", async (c) => {
  const body = (await c.req.json()) as { id?: string; name: string; jurisdiction: string; retentionDays?: number };
  const id = body.id ?? `dist_${crypto.randomUUID().slice(0, 8)}`;
  await c.env.DB.prepare(
    "INSERT INTO districts (id, name, jurisdiction_code, retention_days, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, body.name, body.jurisdiction, body.retentionDays ?? 1095, iso())
    .run();
  return c.json({ id }, 201);
});

adminRoutes.get("/districts/:id/sources", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, district_id, kind, label, base_url, token_url, client_id, version, enabled, created_at FROM sources WHERE district_id = ?",
  )
    .bind(c.req.param("id"))
    .all<Record<string, unknown>>();
  return c.json({ sources: rows.results ?? [] });
});

adminRoutes.post("/districts/:id/sources", async (c) => {
  const districtId = c.req.param("id");
  const body = (await c.req.json()) as {
    label: string; baseUrl: string; tokenUrl: string; clientId: string; clientSecret: string; version?: string;
  };
  const id = `src_${crypto.randomUUID().slice(0, 8)}`;
  await c.env.DB.prepare(
    `INSERT INTO sources (id, district_id, kind, label, base_url, token_url, client_id, client_secret, version, created_at)
     VALUES (?, ?, 'oneroster_rest', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, districtId, body.label, body.baseUrl, body.tokenUrl, body.clientId, body.clientSecret, body.version ?? "v1p1", iso())
    .run();
  return c.json({ id }, 201);
});

/** Starts a run. Advancing it is a separate call, which is what makes it resumable. */
adminRoutes.post("/districts/:id/sync", async (c) => {
  const districtId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { sourceId?: string };

  const source = body.sourceId
    ? await c.env.DB.prepare("SELECT id FROM sources WHERE id = ? AND district_id = ?")
        .bind(body.sourceId, districtId).first<{ id: string }>()
    : await c.env.DB.prepare("SELECT id FROM sources WHERE district_id = ? AND enabled = 1 LIMIT 1")
        .bind(districtId).first<{ id: string }>();
  if (!source) return c.json({ error: "no enabled source for this district" }, 400);

  const runId = `run_${crypto.randomUUID().slice(0, 12)}`;
  await c.env.DB.prepare(
    "INSERT INTO sync_runs (id, district_id, source_id, state, trigger, started_at) VALUES (?, ?, ?, 'pending', ?, ?)",
  )
    .bind(runId, districtId, source.id, "manual", iso())
    .run();
  return c.json({ runId, state: "pending" }, 201);
});

adminRoutes.post("/runs/:runId/advance", async (c) => {
  const result = await advance(c.env, c.req.param("runId"));
  return c.json(result);
});

/**
 * Drives a run to completion, bounded by a step budget so one request cannot
 * run away. The dashboard calls this repeatedly.
 */
adminRoutes.post("/runs/:runId/drive", async (c) => {
  const runId = c.req.param("runId");
  const budget = Math.min(Number(c.req.query("steps") ?? 25), 60);
  let last = null;
  for (let i = 0; i < budget; i++) {
    last = await advance(c.env, runId);
    if (last.done) break;
  }
  return c.json({ ...last, stepsUsed: budget });
});

adminRoutes.get("/districts/:id/runs", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, state, trigger, started_at, finished_at, stats_json, message FROM sync_runs WHERE district_id = ? ORDER BY started_at DESC LIMIT 25",
  )
    .bind(c.req.param("id"))
    .all<Record<string, unknown>>();
  return c.json({
    runs: (rows.results ?? []).map((row) => ({
      id: row["id"], state: row["state"], trigger: row["trigger"],
      startedAt: row["started_at"], finishedAt: row["finished_at"], message: row["message"],
      stats: JSON.parse(String(row["stats_json"] ?? "{}")),
    })),
  });
});

adminRoutes.get("/runs/:runId", async (c) => {
  const runId = c.req.param("runId");
  const run = await c.env.DB.prepare("SELECT * FROM sync_runs WHERE id = ?").bind(runId).first<Record<string, unknown>>();
  if (!run) return c.json({ error: "no such run" }, 404);
  const checks = await c.env.DB.prepare(
    "SELECT check_name, outcome, observed, threshold, detail FROM validation_results WHERE run_id = ? ORDER BY id",
  ).bind(runId).all<Record<string, unknown>>();
  return c.json({
    run: {
      id: run["id"], state: run["state"], startedAt: run["started_at"], finishedAt: run["finished_at"],
      message: run["message"], stats: JSON.parse(String(run["stats_json"] ?? "{}")),
    },
    validation: checks.results ?? [],
  });
});

/** Per-district health. The only question that matters operationally. */
adminRoutes.get("/districts/:id/health", async (c) => {
  const districtId = c.req.param("id");
  const lastGood = await c.env.DB.prepare(
    "SELECT id, finished_at FROM sync_runs WHERE district_id = ? AND state = 'applied' ORDER BY started_at DESC LIMIT 1",
  ).bind(districtId).first<Record<string, unknown>>();
  const lastAny = await c.env.DB.prepare(
    "SELECT id, state, started_at, message FROM sync_runs WHERE district_id = ? ORDER BY started_at DESC LIMIT 1",
  ).bind(districtId).first<Record<string, unknown>>();

  // These three are what support uses every day, because they correspond
  // exactly to what a person notices.
  const [emptyClasses, teacherless, unenrolled, persons] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) n FROM classes c WHERE c.district_id = ? AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.class_id = c.id AND e.role = 'student')").bind(districtId).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) n FROM classes c WHERE c.district_id = ? AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.class_id = c.id AND e.role = 'teacher')").bind(districtId).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) n FROM persons p WHERE p.district_id = ? AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.person_id = p.id)").bind(districtId).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) n FROM persons WHERE district_id = ?").bind(districtId).first<{ n: number }>(),
  ]);

  const staleHours = lastGood?.["finished_at"]
    ? (Date.now() - new Date(String(lastGood["finished_at"])).getTime()) / 3_600_000
    : null;

  return c.json({
    lastSuccessfulRun: lastGood?.["id"] ?? null,
    lastSuccessfulAt: lastGood?.["finished_at"] ?? null,
    hoursSinceSuccess: staleHours === null ? null : Number(staleHours.toFixed(1)),
    latestRun: lastAny ? { id: lastAny["id"], state: lastAny["state"], message: lastAny["message"] } : null,
    counts: {
      people: persons?.n ?? 0,
      classesWithNoStudents: emptyClasses?.n ?? 0,
      classesWithNoTeacher: teacherless?.n ?? 0,
      peopleWithNoEnrollment: unenrolled?.n ?? 0,
    },
  });
});

adminRoutes.get("/districts/:id/people", async (c) => {
  const q = c.req.query("q") ?? "";
  const rows = await c.env.DB.prepare(
    `SELECT id, given_name, family_name, grade_level, email FROM persons
      WHERE district_id = ? AND (given_name LIKE ? OR family_name LIKE ?)
      ORDER BY family_name, given_name LIMIT 40`,
  )
    .bind(c.req.param("id"), `%${q}%`, `%${q}%`)
    .all<Record<string, unknown>>();
  return c.json({ people: rows.results ?? [] });
});

adminRoutes.get("/districts/:id/audit", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT actor, action, subject_type, subject_id, detail_json, at FROM audit_log WHERE district_id = ? ORDER BY id DESC LIMIT 50",
  ).bind(c.req.param("id")).all<Record<string, unknown>>();
  return c.json({ entries: rows.results ?? [] });
});
