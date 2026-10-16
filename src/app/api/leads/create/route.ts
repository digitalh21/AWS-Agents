import { eq } from "drizzle-orm";
import { db } from "@/db";
import { leads, niches } from "@/db/schema";
import { audit, fail, handleError, ok } from "@/lib/api";
import { requireStaff, requireUser } from "@/lib/auth";
import { ensureTables } from "@/db/bootstrap";

export const dynamic = "force-dynamic";

/** POST /api/leads/create — staff create a real lead. */
export async function POST(request: Request) {
  try {
    await ensureTables();
    const staff = await requireStaff();
    const body = (await request.json()) as Record<string, unknown>;

    const businessName = String(body.businessName ?? "").trim();
    const phone = String(body.phone ?? "").replace(/[^0-9]/g, "");
    if (businessName.length < 2) return fail("Business name is required", 422);
    if (phone.length < 10) return fail("A valid 10-digit phone number is required", 422);

    // niche: explicit id, else the staff member's primary niche, else the first niche
    let nicheId = Number(body.nicheId ?? 0) || staff.primaryNicheId || 0;
    if (!nicheId) {
      const [first] = await db.select({ id: niches.id }).from(niches).limit(1);
      nicheId = first?.id ?? 0;
    }
    if (!nicheId) return fail("Create a niche first", 409);

    const phoneNormalized = `91${phone.slice(-10)}`;
    const leadCode = String(body.leadCode ?? "").trim() || null;

    const [row] = await db
      .insert(leads)
      .values({
        leadCode,
        nicheId,
        businessName,
        contactName: String(body.contactName ?? "").trim() || null,
        phone,
        phoneNormalized,
        gmapLink: String(body.gmapLink ?? "").trim() || null,
        cityKeyword: String(body.city ?? "").trim() || null,
        city: String(body.city ?? "").trim() || null,
        address: String(body.address ?? "").trim() || null,
        email: String(body.email ?? "").trim() || null,
        websiteUrl: String(body.websiteUrl ?? "").trim() || null,
        website: String(body.websiteUrl ?? "").trim() || null,
        opensAt: String(body.opensAt ?? "").trim() || null,
        websiteStatus: String(body.websiteStatus ?? "").trim() || null,
        serviceStatus: String(body.serviceStatus ?? "").trim() || null,
        callStatus: "Not Dialed",
        rating: body.rating !== undefined && body.rating !== "" ? String(body.rating) : "0",
        reviewsCount: Number(body.reviewsCount ?? 0) || 0,
        competitorName: String(body.competitorName ?? "").trim() || null,
        competitorReviews: Number(body.competitorReviews ?? 0) || 0,
        // new leads start in the Pool — assignment is a separate decision
        status: "NEW",
        assignedAgentId: body.assignedAgentId ? Number(body.assignedAgentId) : null,
        assignedAt: body.assignedAgentId ? new Date() : null,
        batchId: "MANUAL",
      })
      .returning();

    await audit({
      actorId: staff.id,
      actorRole: staff.role,
      leadId: row!.id,
      action: "LEAD_CREATED",
      detail: `${businessName} (${phone})`,
      meta: { nicheId },
    });

    return ok({ lead: row }, 201);
  } catch (error) {
    return handleError(error);
  }
}

/** GET /api/leads/create?nicheId=… — helper for the create form (niche list). */
export async function GET() {
  try {
    await ensureTables();
    await requireUser();
    const rows = await db.select({ id: niches.id, name: niches.name }).from(niches);
    return ok({ niches: rows });
  } catch (error) {
    return handleError(error);
  }
}
