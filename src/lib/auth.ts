import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

export const SESSION_COOKIE = "tc_session";
const SECRET = process.env.AUTH_SECRET ?? "telecalling-crm-dev-secret";

export type Role = "ADMIN" | "HR" | "MANAGER" | "AGENT";

export type SessionUser = {
  id: number;
  name: string;
  email: string;
  role: Role;
  phone: string | null;
  primaryNicheId: number | null;
};

export function hashPassword(password: string) {
  const salt = "tc-crm-static-salt";
  return scryptSync(password, salt, 32).toString("hex");
}

export function verifyPassword(password: string, hash: string) {
  const candidate = Buffer.from(hashPassword(password), "hex");
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

function sign(payload: string) {
  return createHmac("sha256", SECRET).update(payload).digest("hex").slice(0, 32);
}

export function encodeSession(userId: number) {
  const payload = `${userId}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string | undefined): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, ts, sig] = parts;
  if (sign(`${id}.${ts}`) !== sig) return null;
  const parsed = Number(id);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const userId = decodeSession(store.get(SESSION_COOKIE)?.value);
  if (!userId) return null;
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      phone: users.phone,
      primaryNicheId: users.primaryNicheId,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || !row.isActive) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    phone: row.phone,
    primaryNicheId: row.primaryNicheId,
  };
}

export const STAFF_ROLES: Role[] = ["ADMIN", "HR", "MANAGER"];

export function isStaff(role: Role | string) {
  return STAFF_ROLES.includes(role as Role);
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Not authenticated");
  return user;
}

export async function requireStaff(): Promise<SessionUser> {
  const user = await requireUser();
  if (!isStaff(user.role)) throw new HttpError(403, "Staff access required");
  return user;
}

export async function requireRole(roles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) throw new HttpError(403, "Insufficient permissions");
  return user;
}

export async function setSessionCookie(userId: number) {
  const store = await cookies();
  store.set(SESSION_COOKIE, encodeSession(userId), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Server-component guard: staff-only pages bounce agents back to the agent console. */
export async function requireStaffPage(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isStaff(user.role)) redirect("/agent");
  return user;
}

/** Server-component guard: agent-only pages bounce staff to the pipeline. */
export async function requireAgentPage(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "AGENT") redirect("/pipeline");
  return user;
}
