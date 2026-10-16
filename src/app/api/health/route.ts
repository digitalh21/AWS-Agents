import { sql } from "drizzle-orm";
import { db } from "@/db";
import { authorize, b2Configured } from "@/lib/b2";

export const dynamic = "force-dynamic";

/** Parses the database host out of DATABASE_URL so the active driver is visible. */
function dbTarget() {
  const raw = process.env.DATABASE_URL ?? "";
  try {
    const u = new URL(raw);
    const host = u.hostname;
    const isSupabase = /supabase\.(co|com|net)$/i.test(host) || /pooler.*supabase/i.test(host);
    return { host, isSupabase, database: u.pathname.replace(/^\//, "") };
  } catch {
    return { host: "unconfigured", isSupabase: false, database: "" };
  }
}

export async function GET() {
  const target = dbTarget();
  let dbStatus = "down";
  let latencyMs: number | null = null;
  try {
    const t0 = Date.now();
    await db.execute(sql`select 1`);
    latencyMs = Date.now() - t0;
    dbStatus = "up";
  } catch {
    dbStatus = "down";
  }

  return Response.json({
    ok: dbStatus === "up",
    service: "auto-growth-systems",
    brand: "Auto Growth Systems",
    database: {
      status: dbStatus,
      latencyMs,
      host: target.host,
      database: target.database,
      /** true only when DATABASE_URL points at a Supabase host */
      driver: target.isSupabase ? "supabase-postgres" : "postgres",
      isSupabase: target.isSupabase,
    },
    storage: {
      driver: b2Configured() ? "backblaze-b2" : "postgres-fallback",
      bucket: process.env.B2_BUCKET ?? null,
      region: (await authorize())?.s3Host.replace("s3.", "").replace(".backblazeb2.com", "") ?? null,
      configured: b2Configured(),
      imgur: "removed",
    },
  });
}
