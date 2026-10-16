"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Eye, ImagePlus, Loader2, Megaphone, Plus, Power, RefreshCcw, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { SafeImage } from "@/components/shared/safe-image";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Input, Label, NativeSelect, SectionCard, Stat, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/dialog";
import { cn, dateTime, num, timeAgo } from "@/lib/utils";

type Broadcast = {
  id: number;
  title: string;
  body: string;
  imageUrl: string | null;
  kind: string;
  audienceRole: string;
  targetUserId: number | null;
  requireAcknowledgment: boolean;
  isActive: boolean;
  createdAt: string;
  createdByName: string | null;
  audienceCount: number;
  ackCount: number;
};

type Ack = {
  broadcastId: number;
  userId: number;
  userName: string;
  userRole: string;
  response: string;
  acknowledgedAt: string;
};

type Agent = { id: number; name: string; role: string };

export function BroadcastsPanel() {
  const [rows, setRows] = useState<Broadcast[]>([]);
  const [acks, setAcks] = useState<Ack[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Broadcast | null>(null);

  const [form, setForm] = useState({
    title: "",
    body: "",
    kind: "POPUP",
    audienceRole: "AGENT",
    targetUserId: 0,
    requireAcknowledgment: true,
    expiresInHours: "",
  });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [b, a] = await Promise.all([
      fetch("/api/broadcasts?mode=manage").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/agents").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (b) {
      setRows(b.rows ?? []);
      setAcks(b.acknowledgments ?? []);
    }
    if (a) setAgents((a.rows ?? []).filter((x: Agent & { role: string }) => x.role === "AGENT"));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("kind", "BROADCAST");
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const json = (await res.json()) as { url?: string; error?: string };
    if (res.ok && json.url) {
      setImageUrl(json.url);
      toast.success("Image attached");
    } else toast.error(json.error ?? "Upload failed");
  }

  async function create() {
    setBusy(true);
    const res = await fetch("/api/broadcasts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        imageUrl,
        targetUserId: form.targetUserId || undefined,
        requireAcknowledgment: form.requireAcknowledgment,
        expiresInHours: form.expiresInHours ? Number(form.expiresInHours) : undefined,
      }),
    });
    const json = (await res.json()) as { error?: string };
    if (res.ok) {
      toast.success("Broadcast sent");
      setOpen(false);
      setForm({ ...form, title: "", body: "" });
      setImageUrl(null);
      await load();
    } else toast.error(json.error ?? "Could not send");
    setBusy(false);
  }

  async function toggle(id: number, isActive: boolean) {
    const res = await fetch("/api/broadcasts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, isActive }),
    });
    if (res.ok) {
      toast.success(isActive ? "Broadcast activated" : "Broadcast paused");
      await load();
    } else toast.error("Update failed");
  }

  async function remove(id: number) {
    const res = await fetch(`/api/broadcasts?id=${id}`, { method: "DELETE" });
    const json = (await res.json()) as { error?: string };
    if (res.ok) {
      toast.success("Broadcast deleted");
      await load();
    } else toast.error(json.error ?? "Delete failed");
  }

  const acksFor = (id: number) => acks.filter((a) => a.broadcastId === id);
  const mandatoryCount = rows.filter((r) => r.requireAcknowledgment && r.isActive).length;

  return (
    <div className="space-y-3 p-3 sm:p-4 lg:p-6">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Total broadcasts" value={num(rows.length)} hint="all time" />
        <Stat label="Mandatory popups live" value={num(mandatoryCount)} tone="warn" hint="lock the agent screen" />
        <Stat label="Acknowledgments" value={num(acks.length)} tone="success" hint="agent responses" />
        <Stat label="Agents reachable" value={num(agents.length)} tone="info" />
      </div>

      <SectionCard
        title="Banners & Popups"
        icon={<Megaphone className="h-3.5 w-3.5" />}
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setForm({ ...form, title: "", body: "" });
                setOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> New broadcast
            </Button>
          </div>
        }
      >
        {rows.length === 0 && !loading ? (
          <EmptyState title="No broadcasts yet" hint="Send a text or text + image alert to all agents or a single agent." icon="📢" />
        ) : null}

        <div className="space-y-2">
          {rows.map((b) => {
            const acksN = acksFor(b.id).length;
            const pct = b.audienceCount ? Math.round((acksN / b.audienceCount) * 100) : 0;
            return (
              <div key={b.id} className={cn("rounded-xl border bg-white p-3 shadow-sm", !b.isActive && "opacity-60")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-bold">
                      <span className="truncate">{b.title}</span>
                      <Badge variant={b.kind === "POPUP" ? "danger" : "default"}>{b.kind}</Badge>
                      {!b.isActive ? <Badge variant="muted">paused</Badge> : null}
                      {b.requireAcknowledgment ? <Badge variant="warn">ack required</Badge> : null}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{b.body}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {b.createdByName ?? "Management"} · {timeAgo(b.createdAt)} · to{" "}
                      <strong>
                        {b.audienceRole === "ALL" ? "everyone" : b.audienceRole}
                        {b.targetUserId ? ` (agent #${b.targetUserId})` : ""}
                      </strong>
                    </p>
                    {b.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={b.imageUrl} alt="" className="mt-1.5 h-16 w-24 rounded-lg border object-cover" />
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <div className="text-right">
                      <p className="text-[10px] text-muted-foreground">
                        <Eye className="mr-1 inline h-3 w-3" />
                        {acksN}/{b.audienceCount} acknowledged
                      </p>
                      <div className="mt-0.5 h-1.5 w-24 overflow-hidden rounded-full bg-slate-200">
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="mt-0.5 text-[10px] font-bold text-emerald-700">{pct}%</p>
                    </div>
                    <div className="flex gap-1">
                      <Button size="xs" variant="outline" onClick={() => setDetail(b)}>
                        History
                      </Button>
                      <Button size="xs" variant="outline" onClick={() => void toggle(b.id, !b.isActive)}>
                        <Power className="h-3 w-3" />
                      </Button>
                      <Button size="xs" variant="ghost" className="text-rose-600" onClick={() => void remove(b.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>

      {/* ---------- create sheet ---------- */}
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="New Broadcast"
        description="POPUP locks the agent screen until they acknowledge. BANNER shows as a passive strip."
        footer={
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button className="flex-1" disabled={busy || form.title.trim().length < 3 || form.body.trim().length < 3} onClick={() => void create()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />} Send broadcast
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          <div className="space-y-1">
            <Label>Type *</Label>
            <NativeSelect value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="POPUP">Popup — locks screen until acknowledged</option>
              <option value="BANNER">Banner — passive announcement strip</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label>Title *</Label>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Mandatory training at 4 PM" />
          </div>
          <div className="space-y-1">
            <Label>Message *</Label>
            <Textarea
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              placeholder="All agents must join the compliance session. Acknowledge once you have read this."
            />
          </div>
          <div className="space-y-1">
            <Label>Audience *</Label>
            <NativeSelect value={form.audienceRole} onChange={(e) => setForm({ ...form, audienceRole: e.target.value, targetUserId: 0 })}>
              <option value="AGENT">All Agents</option>
              <option value="ALL">Everyone</option>
              <option value="MANAGER">Managers</option>
              <option value="HR">HR</option>
            </NativeSelect>
          </div>
          {form.audienceRole !== "ALL" ? (
            <div className="space-y-1">
              <Label>…or target a single agent</Label>
              <NativeSelect value={form.targetUserId} onChange={(e) => setForm({ ...form, targetUserId: Number(e.target.value) })}>
                <option value={0}>Entire {form.audienceRole.toLowerCase()} audience</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label>Image (optional)</Label>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            <Button variant="outline" className="w-full" onClick={() => fileRef.current?.click()}>
              <ImagePlus className="h-4 w-4" /> {imageUrl ? "Attached — replace" : "Attach image"}
            </Button>
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt="" className="h-24 w-full rounded-lg border object-cover" />
            ) : null}
          </div>
          <div className="space-y-1">
            <Label>Expires after (hours, optional)</Label>
            <Input
              inputMode="numeric"
              value={form.expiresInHours}
              onChange={(e) => setForm({ ...form, expiresInHours: e.target.value.replace(/[^0-9]/g, "") })}
              placeholder="24"
            />
          </div>
          <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-[10px] font-medium text-amber-800">
            Mandatory popups block the agent dashboard until they tap Acknowledge — the response timestamp is recorded.
          </p>
        </div>
      </Sheet>

      {/* ---------- acknowledgment history ---------- */}
      <Sheet
        open={Boolean(detail)}
        onOpenChange={(v) => !v && setDetail(null)}
        title={detail ? `Acknowledgments · ${detail.title}` : "History"}
        description="Complete response history with timestamps"
      >
        {detail ? (
          <div className="space-y-2">
            <div className="rounded-xl border p-2.5 text-xs">
              <p className="font-bold">{detail.body}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Sent {dateTime(detail.createdAt)} · {detail.audienceCount} recipient(s) · {acksFor(detail.id).length} responded
              </p>
            </div>
            {acksFor(detail.id).length === 0 ? (
              <EmptyState title="No acknowledgments yet" hint="Agents appear here as soon as they respond." icon="⏳" />
            ) : null}
            {acksFor(detail.id).map((a) => (
              <div key={`${a.broadcastId}-${a.userId}`} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold">
                    {a.userName} <span className="text-[10px] text-muted-foreground">({a.userRole})</span>
                  </p>
                  <p className="text-[10px] text-muted-foreground">{dateTime(a.acknowledgedAt)}</p>
                </div>
                <Badge variant="success">
                  <CheckCircle2 className="h-2.5 w-2.5" /> {a.response}
                </Badge>
              </div>
            ))}
            <p className="flex items-center gap-1 pt-1 text-[10px] text-muted-foreground">
              <Users className="h-3 w-3" /> Pending: {Math.max(0, detail.audienceCount - acksFor(detail.id).length)} agent(s)
            </p>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
