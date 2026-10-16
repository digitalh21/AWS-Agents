import { and, count, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads, niches, users } from "@/db/schema";
import { audit, fail, handleError, ok } from "@/lib/api";
import { requireStaff } from "@/lib/auth";
import { ASSIGNED_STAGES, UNASSIGNED_STAGES } from "@/lib/rbac";
import { applyToLead, getFieldPolicy } from "@/lib/field-visibility";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

const PER_COLUMN = 12;

const CARD_COLUMNS = {
  id: leads.id,
  businessName: leads.businessName,
  contactName: leads.contactName,
  phone: leads.phone,
  city: leads.city,
  rating: leads.rating,
  reviewsCount: leads.reviewsCount,
  competitorReviews: leads.competitorReviews,
  status: leads.status,
  callStatus: leads.callStatus,
  leadCode: leads.leadCode,
  assignedAgentId: leads.assignedAgentId,
  assignedAt: leads.assignedAt,
  lastTouchedAt: leads.lastTouchedAt,
  unassignReason: leads.unassignReason,
  dealAmount: leads.dealAmount,
  commissionAmount: leads.commissionAmount,
  accessUnlocked: leads.accessUnlocked,
  callCount: leads.callCount,
  updatedAt: leads.updatedAt,
};

/**
 * GET /api/pipeline/board?pipeline=assigned|unassigned
 *
 * Pipeline A (assigned) — 7 stages: New (assigned today), In Process, Call back,
 *   No Response, Reject/Not Interest, Payment Approval, Closed Won (mgmt only).
 *   Every lead here has an agent.
 *
 * Pipeline B (unassigned) — 3 stages, management only: UnAssigned (fresh),
 *   No Response (auto-unassigned), Reject/Not Interest (auto-unassigned).
 *   Every lead here has NO agent.
 */
export async function GET(request: Request) {
  try {
    await ensureSeed();
    const staff = await requireStaff();
    const url = new URL(request.url);
    const which = url.searchParams.get("pipeline") === "unassigned" ? "unassigned" : "assigned";
    const nicheId = Number(url.searchParams.get("nicheId") ?? 0) || 0;
    const agentId = Number(url.searchParams.get("agentId") ?? 0) || 0;
    const q = (url.searchParams.get("q") ?? "").trim();
    const perColumn = Math.min(Number(url.searchParams.get("perColumn") ?? PER_COLUMN), 50);

    const policy = await getFieldPolicy();

    const shared = [
      nicheId ? eq(leads.nicheId, nicheId) : undefined,
      agentId ? eq(leads.assignedAgentId, agentId) : undefined,
      q ? (sql`(${leads.businessName} ilike ${`%${q}%`} or ${leads.phone} ilike ${`%${q}%`} or coalesce(${leads.leadCode}, '') ilike ${`%${q}%`})` as never) : undefined,
    ].filter(Boolean) as never[];

    const stages = which === "unassigned" ? UNASSIGNED_STAGES : ASSIGNED_STAGES;

    /* ---------- per-column counts ---------- */
    const countList = await Promise.all(
      stages.map(async (stage) => {
        const where = and(...(buildStageFilter(stage.key, shared, which) as never[]));
        const [row] = await db.select({ value: count() }).from(leads).where(where);
        return { key: stage.key, count: Number(row?.value ?? 0) };
      }),
    );

    /* ---------- agent roster (avatars) ---------- */
    const roster = await db
      .select({ id: users.id, name: users.name, role: users.role, isOnline: users.isOnline, lastSeenAt: users.lastSeenAt })
      .from(users)
      .orderBy(users.name);

    /* ---------- cards ---------- */
    const columnValues = await Promise.all(
      stages.map(async (stage) => {
        const where = and(...(buildStageFilter(stage.key, shared, which) as never[]));
        const rows = await db
          .select({
            ...CARD_COLUMNS,
            agentName: users.name,
            agentRole: users.role,
            agentOnline: users.isOnline,
            agentSeen: users.lastSeenAt,
            nicheName: niches.name,
          })
          .from(leads)
          .leftJoin(users, eq(users.id, leads.assignedAgentId))
          .innerJoin(niches, eq(niches.id, leads.nicheId))
          .where(where)
          .orderBy(sql`coalesce(${leads.lastTouchedAt}, ${leads.updatedAt}) desc`)
          .limit(perColumn);

        return rows.map((row) => serializeCard(row, policy, staff.role));
      }),
    );

    const columns = stages.map((stage, i) => ({
      key: stage.key,
      label: stage.label,
      staffOnly: stage.staffOnly,
      virtual: Boolean(stage.virtual),
      count: countList.find((c) => c.key === stage.key)?.count ?? 0,
      cards: columnValues[i] ?? [],
    }));

    /* ---------- header totals scoped to this pipeline ---------- */
    const scopeWhere = and(...shared) as never;
    const [totals] = await db
      .select({
        total: sql<number>`count(*)::int`,
        unassigned: sql<number>`count(*) filter (where ${leads.assignedAgentId} is null)::int`,
        won: sql<number>`count(*) filter (where ${leads.status} = 'CLOSED')::int`,
        value: sql<number>`coalesce(sum(${leads.dealAmount}) filter (where ${leads.status} = 'CLOSED'), 0)::float`,
      })
      .from(leads)
      .where(scopeWhere);

    return ok({
      pipeline: which,
      columns,
      roster,
      totals,
      viewerRole: staff.role,
      stages: stages.map((s) => ({ key: s.key, label: s.label, staffOnly: s.staffOnly })),
    });
  } catch (error) {
    return handleError(error);
  }
}

/** Builds the WHERE clause for a stage within its pipeline. */
function buildStageFilter(stageKey: string, shared: never[], which: "assigned" | "unassigned") {
  const filters: never[] = [...shared];

  if (which === "unassigned") {
    // Pipeline B: nobody owns the lead
    filters.push(isNull(leads.assignedAgentId) as never);
    filters.push(eq(leads.archivedForAgent, false) as never);

    if (stageKey === "UNASSIGNED") {
      // fresh pool: never worked, or manually returned without a status
      filters.push(
        sql`(${leads.unassignReason} is null or ${leads.unassignReason} = 'MANUAL' or ${leads.unassignReason} = 'AGENT_LOST')` as never,
      );
    } else if (stageKey === "UNASSIGNED_NO_RESPONSE") {
      filters.push(eq(leads.status, "NO_RESPONSE") as never);
    } else if (stageKey === "UNASSIGNED_REJECTED") {
      filters.push(eq(leads.status, "REJECTED") as never);
    }
    return filters;
  }

  // Pipeline A: an agent owns the lead
  filters.push(isNotNull(leads.assignedAgentId) as never);

  if (stageKey === "NEW") {
    filters.push(eq(leads.status, "NEW") as never);
    filters.push(sql`${leads.assignedAt}::date = current_date` as never);
  } else {
    filters.push(eq(leads.status, stageKey) as never);
  }
  return filters;
}

/** Maps a joined row into a policy-aware card. */
function serializeCard(row: Record<string, unknown>, policy: ReturnType<typeof getFieldPolicy> extends Promise<infer T> ? T : never, role: string) {
  return {
    ...applyToLead(row, policy, role),
    id: row.id as number,
    assignedAgentId: row.assignedAgentId as number | null,
    accessUnlocked: row.accessUnlocked as boolean,
    callCount: row.callCount as number,
    dealAmount: row.dealAmount as string | null,
    commissionAmount: row.commissionAmount as string | null,
    assignedAt: row.assignedAt as string | null,
    lastTouchedAt: row.lastTouchedAt as string | null,
    unassignReason: row.unassignReason as string | null,
    updatedAt: row.updatedAt as string,
    nicheName: row.nicheName as string | null,
    agent: row.assignedAgentId
      ? {
          id: row.assignedAgentId as number,
          name: (row.agentName as string | null) ?? "Agent",
          role: (row.agentRole as string | null) ?? "AGENT",
          isOnline: Boolean(row.agentOnline),
          lastSeenAt: (row.agentSeen as string | null) ?? null,
        }
      : null,
  };
}

/**
 * PATCH — drag-and-drop move.
 * Dropping into either auto-recycle stage clears the owner while preserving the
 * status label, so the lead lands in the Unassigned Pipeline ready for re-assignment.
 */
export async function PATCH(request: Request) {
  try {
    const staff = await requireStaff();
    const body = (await request.json()) as {
      leadId?: number;
      toStage?: string;
      agentId?: number | null;
      reason?: string;
    };
    const leadId = Number(body.leadId ?? 0);
    const toStage = String(body.toStage ?? "");
    if (!leadId || !toStage) return fail("leadId and toStage are required", 422);

    const patch: Record<string, unknown> = { updatedAt: new Date() };

    // ---- Pipeline B targets: unassign but KEEP the status label ----
    if (toStage === "UNASSIGNED") {
      patch.assignedAgentId = null;
      patch.assignedAt = null;
      patch.lastTouchedAt = null;
      patch.accessUnlocked = false;
      patch.unassignReason = body.reason ? "MANUAL" : "MANUAL";
    } else if (toStage === "UNASSIGNED_NO_RESPONSE") {
      patch.assignedAgentId = null;
      patch.assignedAt = null;
      patch.accessUnlocked = false;
      patch.status = "NO_RESPONSE"; // label preserved, owner cleared
      patch.unassignReason = "AUTO_NO_RESPONSE";
    } else if (toStage === "UNASSIGNED_REJECTED") {
      patch.assignedAgentId = null;
      patch.assignedAt = null;
      patch.accessUnlocked = false;
      patch.status = "REJECTED"; // label preserved, owner cleared
      patch.unassignReason = "AUTO_REJECTED";
    } else if (toStage === "NEW" || toStage === "IN_PROGRESS" || toStage === "CALLBACK" || toStage === "NO_RESPONSE" || toStage === "REJECTED" || toStage === "PAYMENT_APPROVAL" || toStage === "CLOSED" || toStage === "ARCHIVED") {
      // ---- Pipeline A targets ----
      patch.status = toStage;
      patch.unassignReason = null;
      if (toStage === "CLOSED") patch.archivedForAgent = true;
      if (body.agentId) {
        patch.assignedAgentId = Number(body.agentId);
        patch.assignedAt = new Date();
      }
    } else {
      return fail("Invalid stage", 422);
    }

    const [updated] = await db
      .update(leads)
      .set(patch as never)
      .where(eq(leads.id, leadId))
      .returning({ id: leads.id, status: leads.status, assignedAgentId: leads.assignedAgentId, unassignReason: leads.unassignReason });

    await audit({
      actorId: staff.id,
      actorRole: staff.role,
      leadId,
      action: toStage.startsWith("UNASSIGNED") ? "LEAD_UNASSIGNED" : "LEAD_STAGE_CHANGED",
      detail: `→ ${toStage}${body.reason ? ` (${body.reason})` : ""}`,
      meta: { toStage },
    });

    return ok({ lead: updated });
  } catch (error) {
    return handleError(error);
  }
}
