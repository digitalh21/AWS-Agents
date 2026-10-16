"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Megaphone } from "lucide-react";
import { toast } from "sonner";
import { SafeImage } from "@/components/shared/safe-image";
import { Button } from "@/components/ui/button";
import { Badge, Input } from "@/components/ui/field";
import { cn, dateTime, timeAgo } from "@/lib/utils";

type Broadcast = {
  id: number;
  title: string;
  body: string;
  imageUrl: string | null;
  kind: string;
  requireAcknowledgment: boolean;
  createdAt: string;
  createdByName: string | null;
  acknowledgedAt: string | null;
  response: string | null;
};

const RESPONSES = ["ACKNOWLEDGED", "UNDERSTOOD", "NOTED"];

/**
 * Renders the management banner strip and, when a mandatory POPUP has not been
 * acknowledged, a full-screen blocking dialog. Nothing else on the dashboard is
 * reachable until the agent responds.
 */
export function BroadcastOverlay({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<Broadcast[]>([]);
  const [pending, setPending] = useState<Broadcast[]>([]);
  const [lock, setLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/broadcasts");
    if (!res.ok) return;
    const json = (await res.json()) as { rows: Broadcast[]; lockScreen: boolean; pending: Broadcast[] };
    setRows(json.rows ?? []);
    setPending(json.pending ?? []);
    setLock(json.lockScreen);

  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function acknowledge(b: Broadcast, response: string) {
    setBusy(true);
    const res = await fetch("/api/broadcasts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: b.id, response }),
    });
    if (res.ok) {
      toast.success(`Response recorded: ${response.toLowerCase()}`);
      setTyping("");
      await load();
      onChanged?.();
    } else toast.error("Could not record your response");
    setBusy(false);
  }

  const banners = rows.filter((r) => r.kind === "BANNER");
  const blocking = pending.find((r) => r.kind === "POPUP") ?? null;

  return (
    <>
      {/* ---------- passive banner strip ---------- */}
      {banners.length ? (
        <div className="space-y-1.5 px-3 pt-3 sm:px-4 lg:px-6">
          {banners.slice(0, 3).map((b) => (
            <div key={b.id} className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-2.5">
              <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-blue-700" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-blue-900">{b.title}</p>
                <p className="text-[11px] text-blue-800">{b.body}</p>
                <p className="mt-0.5 text-[10px] text-blue-600">
                  {b.createdByName ?? "Management"} · {timeAgo(b.createdAt)}
                </p>
              </div>
              {b.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={b.imageUrl} alt="" className="h-12 w-16 shrink-0 rounded object-cover" />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* ---------- mandatory popup: locks the screen ---------- */}
      {blocking ? (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/80 backdrop-blur-sm sm:items-center">
          <div className="max-h-[92dvh] w-full animate-sheet overflow-y-auto rounded-t-2xl border bg-white shadow-2xl thin-scroll sm:max-w-lg sm:rounded-2xl">
            <div className="flex items-center gap-2 border-b bg-blue-700 px-4 py-3 text-white">
              <Megaphone className="h-5 w-5 shrink-0" />
              <div className="flex-1">
                <p className="text-xs font-bold uppercase tracking-wider text-blue-100">Mandatory announcement</p>
                <p className="text-[10px] text-blue-200">Your response is recorded with a timestamp</p>
              </div>
              <Badge variant="danger">action required</Badge>
            </div>

            <div className="space-y-3 p-4">
              <h2 className="text-lg font-bold leading-snug">{blocking.title}</h2>
              <p className="whitespace-pre-wrap text-sm text-slate-700">{blocking.body}</p>
              {blocking.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={blocking.imageUrl} alt="" className="w-full rounded-xl border object-cover" />
              ) : null}
              <p className="text-[10px] text-muted-foreground">
                Sent by {blocking.createdByName ?? "Management"} · {dateTime(blocking.createdAt)}
              </p>

              <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-amber-800">Confirm you have read this</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {RESPONSES.map((r) => (
                    <button
                      key={r}
                      disabled={busy}
                      onClick={() => void acknowledge(blocking, r)}
                      className={cn(
                        "flex items-center justify-center gap-1 rounded-lg border py-2.5 text-[11px] font-bold transition",
                        typing === r
                          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                          : "border-slate-200 bg-white text-slate-600",
                      )}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {r.charAt(0) + r.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={typing}
                    onChange={(e) => setTyping(e.target.value)}
                    placeholder="Optional written response…"
                    className="h-10"
                  />
                  <Button disabled={busy || typing.trim().length < 3} onClick={() => void acknowledge(blocking, typing.trim())}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Send
                  </Button>
                </div>
              </div>

              <p className="text-center text-[10px] text-muted-foreground">
                This popup stays on screen until you acknowledge it.
              </p>
            </div>
          </div>
        </div>
      ) : null}

    </>
  );
}
