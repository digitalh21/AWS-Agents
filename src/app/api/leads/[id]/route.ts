import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, callLogs, dealApprovals, leads, niches, uploads, users } from "@/db/schema";
import { audit, fail, handleError, ok } from "@/lib/api";
import { requireStaff } from "@/lib/auth";
import { applyFieldPolicy, getFieldPolicy, modeFor, projectLead } from "@/lib/field-visibility";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const staff = await requireStaff();
    const policy = await getFieldPolicy();
    const id = Number((await params).id);
    const [row] = await db
      .select({ lead: leads, nicheName: niches.name, agentName: users.name, agentPhone: users.phone })
      .from(leads)
      .innerJoin(niches, eq(niches.id, leads.nicheId))
      .leftJoin(users, eq(users.id, leads.assignedAgentId))
      .where(eq(leads.id, id))
      .limit(1);
    if (!row) return fail("Lead not found", 404);

    const [logs, trail, proofs, deals] = await Promise.all([
      db
        .select({
          id: callLogs.id,
          status: callLogs.status,
          notes: callLogs.notes,
          durationSeconds: callLogs.durationSeconds,
          createdAt: callLogs.createdAt,
          whatsappSent: callLogs.whatsappSent,
          agentName: users.name,
          agentRole: users.role,
        })
        .from(callLogs)
        .leftJoin(users, eq(users.id, callLogs.agentId))
        .where(eq(callLogs.leadId, id))
        .orderBy(desc(callLogs.createdAt))
        .limit(40),
      db.select().from(auditLogs).where(eq(auditLogs.leadId, id)).orderBy(desc(auditLogs.createdAt)).limit(40),
      db.select().from(uploads).where(eq(uploads.leadId, id)).orderBy(desc(uploads.createdAt)).limit(20),
      db.select().from(dealApprovals).where(eq(dealApprovals.leadId, id)).orderBy(desc(dealApprovals.createdAt)),
    ]);

    const raw = {
      ...row.lead,
      nicheName: row.nicheName,
      categoryName: row.nicheName,
    } as Record<string, unknown>;

    return ok({
      lead: {
        id: row.lead.id,
        nicheId: row.lead.nicheId,
        accessUnlocked: row.lead.accessUnlocked,
        callCount: row.lead.callCount,
        dealAmount: row.lead.dealAmount,
        contactName: row.lead.contactName,
        archivedForAgent: row.lead.archivedForAgent,
        cycleCount: row.lead.cycleCount,
        batchId: row.lead.batchId,
        assignedAgentId: row.lead.assignedAgentId,
        lastTouchedAt: row.lead.lastTouchedAt,
        createdAt: row.lead.createdAt,
        ...applyFieldPolicy(projectLead(raw), policy, staff.role),
      },
      agentName: row.agentName,
      canDial: modeFor(policy, "phone", staff.role) !== "HIDDEN",
      fieldPolicy: Object.fromEntries(
        Object.keys(policy)
          .filter((k) => modeFor(policy, k, staff.role) !== "VISIBLE")
          .map((k) => [k, modeFor(policy, k, staff.role)]),
      ),
      logs,
      trail,
      proofs,
      deals,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const staff = await requireStaff();
    const id = Number((await params).id);
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "update");

    const [lead] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
    if (!lead) return fail("Lead not found", 404);

    if (action === "unlock" || action === "lock") {
      const unlocked = action === "unlock";
      await db
        .update(leads)
        .set({ accessUnlocked: unlocked, unlockedAt: unlocked ? new Date() : null, updatedAt: new Date() })
        .where(eq(leads.id, id));
      await audit({
        actorId: staff.id,
        actorRole: staff.role,
        leadId: id,
        action: unlocked ? "LEAD_UNLOCKED" : "LEAD_LOCKED",
        detail: `${lead.businessName} details ${unlocked ? "unlocked" : "locked"} for agent`,
      });
      return ok({ accessUnlocked: unlocked });
    }

    if (action === "assign") {
      const agentId = Number(body.agentId ?? 0);
      if (!agentId) {
        await db.update(leads).set({ assignedAgentId: null, assignedAt: null, updatedAt: new Date() }).where(eq(leads.id, id));
        await audit({ actorId: staff.id, actorRole: staff.role, leadId: id, action: "LEAD_UNASSIGNED", detail: lead.businessName });
        return ok({ assignedAgentId: null });
      }
      const [agent] = await db.select().from(users).where(and(eq(users.id, agentId), eq(users.role, "AGENT"))).limit(1);
      if (!agent) return fail("Agent not found", 404);
      await db
        .update(leads)
        .set({
          assignedAgentId: agentId,
          assignedAt: new Date(),
          lastTouchedAt: null,
          accessUnlocked: false,
          status: lead.status === "ARCHIVED" ? "NEW" : lead.status,
          archivedForAgent: false,
          updatedAt: new Date(),
        })
        .where(eq(leads.id, id));
      await audit({
        actorId: staff.id,
        actorRole: staff.role,
        leadId: id,
        action: "LEAD_ASSIGNED",
        detail: `${lead.businessName} → ${agent.name}`,
      });
      return ok({ assignedAgentId: agentId });
    }

    if (action === "status") {
      const status = String(body.status ?? lead.status);
      await db.update(leads).set({ status, updatedAt: new Date() }).where(eq(leads.id, id));
      await audit({ actorId: staff.id, actorRole: staff.role, leadId: id, action: "STATUS_OVERRIDE", detail: `${lead.status} → ${status}` });
      return ok({ status });
    }

    if (action === "update") {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of ["businessName", "contactName", "phone", "email", "city", "address", "website"]) {
        if (typeof body[key] === "string") patch[key] = body[key];
      }
      if (body.reviewsCount !== undefined) patch.reviewsCount = Number(body.reviewsCount);
      if (body.competitorReviews !== undefined) patch.competitorReviews = Number(body.competitorReviews);
      if (body.rating !== undefined) patch.rating = String(body.rating);
      if (body.dealAmount !== undefined) patch.dealAmount = String(body.dealAmount);
      await db.update(leads).set(patch).where(eq(leads.id, id));
      await audit({ actorId: staff.id, actorRole: staff.role, leadId: id, action: "LEAD_EDITED", detail: Object.keys(patch).join(", ") });
      return ok({ updated: true });
    }

    return fail("Unknown action", 400);
  } catch (error) {
    return handleError(error);
  }
}

/** Only ADMIN may delete, and only from the unassigned pool — full audit entry is written. */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const staff = await requireStaff();
    if (staff.role !== "ADMIN") return fail("Only ADMIN can delete leads", 403);
    const id = Number((await params).id);
    const url = new URL(request.url);
    if (url.searchParams.get("confirm") !== "DELETE") {
      return fail("Add ?confirm=DELETE to permanently remove this lead", 428);
    }
    const [lead] = await db.select().from(leads).where(and(eq(leads.id, id), sql`${leads.assignedAgentId} is null`)).limit(1);
    if (!lead) return fail("Only unassigned pool leads can be deleted", 409);
    await db.delete(callLogs).where(eq(callLogs.leadId, id));
    await db.delete(leads).where(eq(leads.id, id));
    await audit({ actorId: staff.id, actorRole: staff.role, action: "LEAD_DELETED", detail: `${lead.businessName} (#${id})` });
    return ok({ deleted: true });
  } catch (error) {
    return handleError(error);
  }
}
