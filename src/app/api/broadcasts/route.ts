import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { broadcastAcknowledgments, broadcasts, notifications, users } from "@/db/schema";
import { audit, fail, handleError, ok } from "@/lib/api";
import { isStaff, requireStaff, requireUser } from "@/lib/auth";
import { ensureTables } from "@/db/bootstrap";

export const dynamic = "force-dynamic";

/** GET ?mode=manage (staff) -> all broadcasts + ack stats. Default -> my active feed. */
export async function GET(request: Request) {
  try {
    await ensureTables();
    const user = await requireUser();
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "feed";

    if (mode === "manage") {
      if (!isStaff(user.role)) return fail("Staff only", 403);
      const rows = await db
        .select({
          id: broadcasts.id,
          title: broadcasts.title,
          body: broadcasts.body,
          imageUrl: broadcasts.imageUrl,
          kind: broadcasts.kind,
          audienceRole: broadcasts.audienceRole,
          targetUserId: broadcasts.targetUserId,
          requireAcknowledgment: broadcasts.requireAcknowledgment,
          isActive: broadcasts.isActive,
          createdAt: broadcasts.createdAt,
          expiresAt: broadcasts.expiresAt,
          createdByName: users.name,
          audienceCount: sql<number>`(select count(*)::int from users u
              where (${broadcasts.targetUserId} is null or u.id = ${broadcasts.targetUserId})
              and (${broadcasts.audienceRole} = 'ALL' or u.role = ${broadcasts.audienceRole}))`,
          ackCount: sql<number>`(select count(*)::int from broadcast_acknowledgments ba where ba.broadcast_id = ${broadcasts.id})`,
        })
        .from(broadcasts)
        .leftJoin(users, eq(users.id, broadcasts.createdBy))
        .orderBy(desc(broadcasts.createdAt))
        .limit(100);

      const ackRows = await db
        .select({
          broadcastId: broadcastAcknowledgments.broadcastId,
          userId: broadcastAcknowledgments.userId,
          userName: users.name,
          userRole: users.role,
          response: broadcastAcknowledgments.response,
          acknowledgedAt: broadcastAcknowledgments.acknowledgedAt,
        })
        .from(broadcastAcknowledgments)
        .innerJoin(users, eq(users.id, broadcastAcknowledgments.userId))
        .orderBy(desc(broadcastAcknowledgments.acknowledgedAt))
        .limit(400);

      return ok({ rows, acknowledgments: ackRows });
    }

    /* ---- agent/staff feed: active broadcasts targeted at me, with ack state ---- */
    const rows = await db
      .select({
        id: broadcasts.id,
        title: broadcasts.title,
        body: broadcasts.body,
        imageUrl: broadcasts.imageUrl,
        kind: broadcasts.kind,
        requireAcknowledgment: broadcasts.requireAcknowledgment,
        createdAt: broadcasts.createdAt,
        createdByName: users.name,
        acknowledgedAt: broadcastAcknowledgments.acknowledgedAt,
        response: broadcastAcknowledgments.response,
      })
      .from(broadcasts)
      .leftJoin(users, eq(users.id, broadcasts.createdBy))
      .leftJoin(
        broadcastAcknowledgments,
        and(eq(broadcastAcknowledgments.broadcastId, broadcasts.id), eq(broadcastAcknowledgments.userId, user.id)),
      )
      .where(
        and(
          eq(broadcasts.isActive, true),
          // only live broadcasts (never-expiring ones always qualify)
          sql`(${broadcasts.expiresAt} is null or ${broadcasts.expiresAt} > now())`,
          sql`(${broadcasts.targetUserId} is null or ${broadcasts.targetUserId} = ${user.id})`,
          sql`(${broadcasts.audienceRole} = 'ALL' or ${broadcasts.audienceRole} = ${user.role})`,
        ),
      )
      .orderBy(desc(broadcasts.createdAt))
      .limit(20);

    const pending = rows.filter((r) => r.requireAcknowledgment && !r.acknowledgedAt);
    return ok({
      rows,
      // a mandatory popup that has not been acknowledged yet locks the screen
      lockScreen: pending.some((r) => r.kind === "POPUP"),
      pending,
    });
  } catch (error) {
    return handleError(error);
  }
}

/** POST: create a broadcast (staff). */
export async function POST(request: Request) {
  try {
    const staff = await requireStaff();
    const body = (await request.json()) as {
      title?: string;
      body?: string;
      imageUrl?: string;
      kind?: string;
      audienceRole?: string;
      targetUserId?: number;
      requireAcknowledgment?: boolean;
      expiresInHours?: number;
    };
    const title = (body.title ?? "").trim();
    const text = (body.body ?? "").trim();
    if (title.length < 3) return fail("Title must be at least 3 characters", 422);
    if (text.length < 3) return fail("Message must be at least 3 characters", 422);

    const kind = body.kind === "BANNER" ? "BANNER" : "POPUP";
    const audienceRole = (body.audienceRole ?? "AGENT").toUpperCase();
    if (!["ALL", "AGENT", "MANAGER", "HR", "ADMIN"].includes(audienceRole)) return fail("Invalid audience", 422);
    const targetUserId = body.targetUserId ? Number(body.targetUserId) : null;
    if (audienceRole !== "ALL" && targetUserId && !body.targetUserId) return fail("Pick a valid agent", 422);

    const [row] = await db
      .insert(broadcasts)
      .values({
        title,
        body: text,
        imageUrl: body.imageUrl ?? null,
        kind,
        audienceRole,
        targetUserId,
        requireAcknowledgment: kind === "POPUP" ? body.requireAcknowledgment !== false : Boolean(body.requireAcknowledgment),
        createdBy: staff.id,
        expiresAt: body.expiresInHours ? new Date(Date.now() + body.expiresInHours * 3600_000) : null,
      })
      .returning();

    await db.insert(notifications).values({
      title: `📢 ${title}`,
      body: text.slice(0, 200),
      audienceRole,
      targetUserId,
      sentBy: staff.id,
    });

    await audit({
      actorId: staff.id,
      actorRole: staff.role,
      action: "BROADCAST_CREATED",
      detail: `${kind} → ${audienceRole}${targetUserId ? ` (user #${targetUserId})` : ""}: ${title}`,
      meta: { broadcastId: row!.id },
    });

    return ok({ broadcast: row }, 201);
  } catch (error) {
    return handleError(error);
  }
}

/** PATCH: activate/deactivate a broadcast (staff). */
export async function PATCH(request: Request) {
  try {
    const staff = await requireStaff();
    const body = (await request.json()) as { id?: number; isActive?: boolean };
    const id = Number(body.id ?? 0);
    if (!id) return fail("id required", 422);

    const [row] = await db
      .update(broadcasts)
      .set({ isActive: Boolean(body.isActive) })
      .where(eq(broadcasts.id, id))
      .returning();
    if (!row) return fail("Broadcast not found", 404);

    await audit({
      actorId: staff.id,
      actorRole: staff.role,
      action: "BROADCAST_UPDATED",
      detail: `#${id} active=${body.isActive}`,
    });
    return ok({ broadcast: row });
  } catch (error) {
    return handleError(error);
  }
}

/** PUT: acknowledge a mandatory broadcast (the agent's only way past the lock). */
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { id?: number; response?: string };
    const id = Number(body.id ?? 0);
    if (!id) return fail("id required", 422);

    const [broadcast] = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).limit(1);
    if (!broadcast) return fail("Broadcast not found", 404);

    await db
      .insert(broadcastAcknowledgments)
      .values({
        broadcastId: id,
        userId: user.id,
        response: (body.response ?? "ACKNOWLEDGED").toUpperCase().slice(0, 40),
      })
      .onConflictDoNothing();

    await audit({
      actorId: user.id,
      actorRole: user.role,
      action: "BROADCAST_ACKNOWLEDGED",
      detail: `${broadcast.title}`,
      meta: { broadcastId: id },
    });

    return ok({ ok: true, acknowledgedAt: new Date().toISOString() });
  } catch (error) {
    return handleError(error);
  }
}

/** DELETE: remove a broadcast (Admin only). */
export async function DELETE(request: Request) {
  try {
    const staff = await requireStaff();
    if (staff.role !== "ADMIN") return fail("Only ADMIN can delete broadcasts", 403);
    const id = Number(new URL(request.url).searchParams.get("id") ?? 0);
    if (!id) return fail("id required", 422);

    await db.delete(broadcastAcknowledgments).where(eq(broadcastAcknowledgments.broadcastId, id));
    await db.delete(broadcasts).where(eq(broadcasts.id, id));
    await audit({ actorId: staff.id, actorRole: staff.role, action: "BROADCAST_DELETED", detail: `#${id}` });
    return ok({ deleted: true });
  } catch (error) {
    return handleError(error);
  }
}
