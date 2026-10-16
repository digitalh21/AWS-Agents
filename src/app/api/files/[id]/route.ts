import { eq } from "drizzle-orm";
import { db } from "@/db";
import { uploads } from "@/db/schema";
import { b2Configured, b2Fetch } from "@/lib/b2";

export const dynamic = "force-dynamic";

/**
 * Serves an uploaded file.
 *
 * - B2 objects are streamed through this route using the application key, so
 *   images render correctly even when the bucket is private. The client-visible
 *   URL stored in the database remains the canonical B2 URL.
 * - Postgres-fallback objects are decoded from their inline data URL.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) return new Response("Bad request", { status: 400 });

  const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
  if (!row) return new Response("Not found", { status: 404 });

  // B2 object → proxy the bytes (private buckets reject direct anonymous reads)
  if (row.storageDriver === "b2" && row.storageKey) {
    if (!b2Configured()) return new Response("B2 not configured", { status: 503 });
    const obj = await b2Fetch(row.storageKey);
    if (!obj) return new Response("Object not available", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": row.mimeType || obj.contentType,
        "Content-Length": String(obj.body.byteLength),
        "Cache-Control": "private, max-age=86400",
        "X-Content-Driver": "b2",
      },
    });
  }

  // B2 object with no stored key (legacy row) → redirect to the stored url
  if (row.externalUrl?.startsWith("http")) {
    return Response.redirect(row.externalUrl, 302);
  }

  // Postgres fallback
  if (!row.data) return new Response("Not found", { status: 404 });
  const [meta, base64] = row.data.split(",");
  const mime = /data:([^;]+)/.exec(meta ?? "")?.[1] ?? row.mimeType ?? "application/octet-stream";
  const bytes = Buffer.from(base64 ?? "", "base64");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Driver": "postgres",
    },
  });
}
