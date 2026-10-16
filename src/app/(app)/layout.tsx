import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { db } from "@/db";
import { AppShell } from "@/components/app-shell";
import { getSessionUser } from "@/lib/auth";
import { navForRole } from "@/lib/rbac";
import { nichesForRole } from "@/lib/queries";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await ensureSeed().catch(() => undefined);
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // Agents only see niches marked "Visible to Agents"; staff always see all of them.
  const { visible: nicheRows } = await nichesForRole(user.role);

  const navItems = navForRole(user.role).map((n) => ({ href: n.href, label: n.label, icon: n.icon }));

  return (
    <AppShell
      user={{ id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone }}
      niches={nicheRows}
      navItems={navItems}
    >
      {children}
    </AppShell>
  );
}
