import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { adminRoutes } from "./api/admin.js";
import { complianceRoutes } from "./api/compliance.js";
import { advance } from "./pipeline/run.js";
import { DASHBOARD_HTML } from "./ui/dashboard.js";
import type { AppEnv, Bindings } from "./types.js";

const app = new Hono<AppEnv>();

app.use("*", cors({ origin: "*", allowHeaders: ["content-type", "x-admin-key", "x-actor"] }));

app.get("/health", (c) => c.json({ status: "ok", service: "roster-bridge" }));
app.get("/", (c) => c.redirect("/dashboard"));
app.get("/dashboard", (c) => c.html(DASHBOARD_HTML));

async function requireAdmin(c: Context<AppEnv>, next: Next) {
  if (c.req.header("x-admin-key") !== c.env.ADMIN_KEY) {
    return c.json({ error: "unauthorised" }, 401);
  }
  await next();
}

app.use("/api/*", requireAdmin);
app.route("/api", adminRoutes);
app.route("/api/compliance", complianceRoutes);

app.onError((error, c) => {
  console.error("unhandled", error);
  return c.json({ error: error instanceof Error ? error.message : "internal error" }, 500);
});

export default {
  fetch: app.fetch,

  /**
   * Scheduled sync.
   *
   * Two jobs. Advance any run that is mid-flight, because a run is deliberately
   * resumable and something has to resume it. Then start a new run for each
   * district that has not had a successful one recently.
   *
   * Runs that quarantined are NOT retried automatically. A gate fired for a
   * reason and a human should look at it; retrying on a schedule would turn a
   * caught problem into a silent one.
   */
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const active = await env.DB.prepare(
          "SELECT id FROM sync_runs WHERE state IN ('pending','fetching','validating','applying') ORDER BY started_at LIMIT 5",
        ).all<{ id: string }>();

        for (const run of active.results ?? []) {
          for (let step = 0; step < 40; step++) {
            const result = await advance(env, run.id);
            if (result.done) break;
          }
        }

        if ((active.results ?? []).length > 0) return;

        const districts = await env.DB.prepare(
          `SELECT d.id FROM districts d
            WHERE d.status = 'active'
              AND EXISTS (SELECT 1 FROM sources s WHERE s.district_id = d.id AND s.enabled = 1)
              AND NOT EXISTS (
                SELECT 1 FROM sync_runs r
                 WHERE r.district_id = d.id AND r.state = 'applied'
                   AND r.finished_at > datetime('now', '-12 hours')
              )`,
        ).all<{ id: string }>();

        for (const district of districts.results ?? []) {
          const source = await env.DB.prepare(
            "SELECT id FROM sources WHERE district_id = ? AND enabled = 1 LIMIT 1",
          ).bind(district.id).first<{ id: string }>();
          if (!source) continue;
          const runId = `run_${crypto.randomUUID().slice(0, 12)}`;
          await env.DB.prepare(
            "INSERT INTO sync_runs (id, district_id, source_id, state, trigger, started_at) VALUES (?, ?, ?, 'pending', 'scheduled', ?)",
          ).bind(runId, district.id, source.id, new Date().toISOString()).run();
        }
      })(),
    );
  },
};
