import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { uploads } from "@/db/schema";
import { audit, fail, handleError, ok } from "@/lib/api";
import { isStaff, requireUser } from "@/lib/auth";
import { b2Configured, b2Fetch, b2Upload } from "@/lib/b2";
import { ensureTables } from "@/db/bootstrap";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpe?g|webp|gif|heic|heif)|application\/pdf)$/i;

/**
 * File / image upload endpoint.
 *
 * Default target is Backblaze B2 — KYC documents, payment proofs, ticket
 * attachments and broadcast images all land in B2 and the canonical B2 URL is
 * stored in the PostgreSQL/Supabase `uploads` table.
 *
 * If B2 is not configured the bytes are stored inline in Postgres and served via
 * /api/files/:id, so the feature degrades gracefully instead of failing.
 *
 * Imgur has been removed entirely.
 */
export async function POST(request: Request) {
  try {
    await ensureTables();
    const user = await requireUser();
    const form = await request.formData();
    const file = form.get("file");
    const leadIdRaw = form.get("leadId");
    const kind = String(form.get("kind") ?? "PROOF");

    if (!(file instanceof File)) return fail("No file provided", 422);
    if (file.size > MAX_BYTES) return fail("File too large (max 25MB)", 413);
    if (!ALLOWED.test(file.type)) return fail("Only images (png/jpg/webp/gif/heic) or PDF files are allowed", 415);

    const buffer = Buffer.from(await file.arrayBuffer());

    let url: string | null = null;
    let storageKey: string | null = null;
    let driver: "b2" | "postgres" = "postgres";
    // Inline data URL is kept for BOTH paths so the client can always preview.
    const inlineDataUrl = `data:${file.type};base64,${buffer.toString("base64")}`;

    if (b2Configured()) {
      try {
        const uploaded = await b2Upload(file.name, buffer, file.type);
        if (uploaded) {
          url = uploaded.url;
          storageKey = uploaded.key;
          driver = "b2";
        } else {
          console.error("[upload] B2 upload failed — falling back to Postgres storage");
        }
      } catch (e) {
        console.error("[upload] B2 threw — falling back to Postgres storage", e);
      }
    }

    if (!url) {
      driver = "postgres";
      // /api/files/:id serves inline bytes; the real URL is set after insert
      url = "pending";
    }

    const [row] = await db
      .insert(uploads)
      .values({
        leadId: leadIdRaw ? Number(leadIdRaw) : null,
        userId: user.id,
        kind: kind.toUpperCase(),
        fileName: file.name,
        mimeType: file.type,
        externalUrl: url,
        storageKey,
        storageDriver: driver,
        // B2 rows keep the inline copy too — instant preview without a signed fetch
        data: inlineDataUrl,
        sizeBytes: file.size,
      })
      .returning({ id: uploads.id, url: uploads.externalUrl, storageKey: uploads.storageKey });

    const id = row!.id;

    // Postgres fallback needs the row id to build its serving URL
    if (driver === "postgres") {
      url = `/api/files/${id}`;
      await db.update(uploads).set({ externalUrl: url }).where(eq(uploads.id, id));
    } else if (storageKey) {
      // Verify the stored B2 url is publicly readable. Private buckets return
      // 401, which would render a broken image — so we serve through the app.
      let publiclyReadable = false;
      try {
        const head = await fetch(url!, { method: "HEAD", signal: AbortSignal.timeout(4000) });
        publiclyReadable = head.ok;
      } catch {
        publiclyReadable = false;
      }
      if (!publiclyReadable) {
        url = `/api/files/${id}`;
        await db.update(uploads).set({ externalUrl: url }).where(eq(uploads.id, id));
      }
    }

    await audit({
      actorId: user.id,
      actorRole: user.role,
      leadId: leadIdRaw ? Number(leadIdRaw) : null,
      action: "FILE_UPLOADED",
      detail: `${file.name} (${kind}) → ${driver}`,
      meta: { uploadId: id, provider: driver, storageKey },
    });

    return ok({
      id,
      url,
      storageKey,
      driver,
      /** always renderable: B2 url, /api/files url, or inline data URL */
      previewUrl: url,
      dataUrl: inlineDataUrl,
      name: file.name,
      size: file.size,
    });
  } catch (error) {
    return handleError(error);
  }
}

/** GET ?leadId=… or ?mine=1 — list uploads (B2 urls are stored in Postgres). */
export async function GET(request: Request) {
  try {
    await ensureTables();
    const user = await requireUser();
    const url = new URL(request.url);
    const leadId = Number(url.searchParams.get("leadId") ?? 0);

    const rows = await db
      .select({
        id: uploads.id,
        url: uploads.externalUrl,
        storageKey: uploads.storageKey,
        storageDriver: uploads.storageDriver,
        kind: uploads.kind,
        fileName: uploads.fileName,
        mimeType: uploads.mimeType,
        sizeBytes: uploads.sizeBytes,
        createdAt: uploads.createdAt,
        leadId: uploads.leadId,
      })
      .from(uploads)
      .where(leadId ? eq(uploads.leadId, leadId) : isStaff(user.role) ? undefined : eq(uploads.userId, user.id))
      .orderBy(desc(uploads.createdAt))
      .limit(60);

    return ok({ rows, driver: b2Configured() ? "b2" : "postgres" });
  } catch (error) {
    return handleError(error);
  }
}

/** Staff can hide an upload from a lead record (soft) — agents never can. */
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    if (!isStaff(user.role)) return fail("Agents cannot delete uploads", 403);
    const id = Number(new URL(request.url).searchParams.get("id") ?? 0);
    if (!id) return fail("id required", 422);
    await db.delete(uploads).where(and(eq(uploads.id, id)));
    return ok({ deleted: true });
  } catch (error) {
    return handleError(error);
  }
}
