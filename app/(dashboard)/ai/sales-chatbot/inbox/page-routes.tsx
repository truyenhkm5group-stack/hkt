"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setHumanCooldownMinutesAction, setPageConnectionModeAction } from "@/lib/actions/sales-inbox";
import { HUMAN_COOLDOWN_MAX_MINUTES, HUMAN_COOLDOWN_MIN_MINUTES, HUMAN_COOLDOWN_MINUTES } from "@/lib/sales-chatbot/ai-hold-shared";
import { CONNECTION_MODE_LABEL, MODE_SOURCE_LABEL, TRANSPORT_MODE, type ConnectionMode, type PageRouteView } from "@/lib/sales-chatbot/channel-ownership-shared";
import { cn } from "@/lib/utils";

/**
 * «ĐƯỜNG NHẬN TIN & AI NHƯỜNG» (0233) — cho người quản lý: mỗi page một dòng (đường chính · đường nào đang chạy · cảnh báo), nút
 * chuyển đường TƯỜNG MINH (bắt buộc lý do, vào nhật ký), và số phút AI tự trả lời lại sau câu tay của nhân viên (theo workspace).
 * Không có gì tự đổi: máy không bao giờ chuyển đường hộ người.
 */
export function PageRoutesPanel({ routes, pageNames, cooldownMinutes, canManage }: { routes: PageRouteView[]; pageNames: Record<string, string>; cooldownMinutes: number; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [minutes, setMinutes] = useState(String(cooldownMinutes));
  const warn = routes.filter((r) => r.warning).length;

  const switchMode = (pageId: string, to: ConnectionMode) => {
    const reason = window.prompt(`Chuyển page ${pageNames[pageId] ?? pageId} sang nhận tin qua ${CONNECTION_MODE_LABEL[to]}? Ghi lý do (vào nhật ký):`, "");
    if (reason === null) return;
    start(async () => {
      const r = await setPageConnectionModeAction(pageId, to, reason);
      setMsg("error" in r ? { ok: false, text: r.error } : { ok: true, text: r.changed ? `Đã chuyển sang ${CONNECTION_MODE_LABEL[to]}.` : "Page đã ở đường này." });
      router.refresh();
    });
  };
  const saveMinutes = () =>
    start(async () => {
      const r = await setHumanCooldownMinutesAction(Number(minutes));
      setMsg("error" in r ? { ok: false, text: r.error } : { ok: true, text: r.changed ? `AI sẽ tự trả lời lại sau ${r.minutes} phút kể từ câu tay mới nhất.` : "Không đổi." });
      router.refresh();
    });

  return (
    <details className="rounded-md border border-foreground/15 bg-background px-2 py-1 text-[12px]" data-testid="inbox-routes">
      <summary className="cursor-pointer select-none font-medium">
        Đường nhận tin & AI nhường{warn ? <span className="ml-1 rounded bg-amber-500 px-1 text-white">{warn} cần xem</span> : null}
      </summary>
      <div className="mt-1.5 space-y-2 pb-1">
        {routes.length === 0 ? <p className="text-muted-foreground">Chưa page nào nối qua Pancake hay Meta trực tiếp.</p> : null}
        <ul className="space-y-1.5">
          {routes.map((r) => {
            const current: ConnectionMode | null = r.mode ?? (r.owner ? TRANSPORT_MODE[r.owner] : null);
            const other: ConnectionMode | null = current === "META_DIRECT" ? "PANCAKE_WEBHOOK" : current === "PANCAKE_WEBHOOK" ? "META_DIRECT" : null;
            const otherLive = other === "META_DIRECT" ? r.live.MESSENGER : other === "PANCAKE_WEBHOOK" ? r.live.PANCAKE : false;
            return (
              <li key={r.pageId} className="rounded border border-foreground/10 p-1.5" data-route-page={r.pageId}>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="max-w-[12rem] truncate font-medium">{pageNames[r.pageId] ?? r.pageId}</span>
                  <span className={cn("rounded px-1.5 font-semibold", r.owner ? "bg-emerald-600 text-white" : "bg-zinc-300 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100")}>
                    {r.mode ? CONNECTION_MODE_LABEL[r.mode] : r.owner ? `${CONNECTION_MODE_LABEL[TRANSPORT_MODE[r.owner]]} (luật cũ)` : "—"}
                  </span>
                  <span className="text-muted-foreground">
                    Pancake {r.live.PANCAKE ? "đang nối" : "—"} · Meta {r.live.MESSENGER ? "đang nối" : "—"}
                  </span>
                </div>
                {r.source ? (
                  <p className="text-muted-foreground">
                    Nguồn: {MODE_SOURCE_LABEL[r.source]}
                    {r.reason ? ` — ${r.reason}` : ""}
                  </p>
                ) : null}
                {r.warning ? <p className="text-amber-700 dark:text-amber-300">{r.warning}</p> : null}
                {canManage && other && otherLive ? (
                  <button type="button" disabled={pending} onClick={() => switchMode(r.pageId, other)} className="mt-1 rounded border px-2 py-0.5 hover:bg-muted disabled:opacity-50">
                    Chuyển sang {CONNECTION_MODE_LABEL[other]}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-1 border-t pt-2">
          <label htmlFor="inbox-cooldown" className="font-medium">
            Nhân viên trả lời tay ⇒ AI nhường
          </label>
          <input id="inbox-cooldown" type="number" min={HUMAN_COOLDOWN_MIN_MINUTES} max={HUMAN_COOLDOWN_MAX_MINUTES} value={minutes} disabled={!canManage || pending} onChange={(e) => setMinutes(e.target.value)} className="h-7 w-16 rounded border bg-background px-1" />
          <span>phút (mặc định {HUMAN_COOLDOWN_MINUTES})</span>
          {canManage ? (
            <button type="button" disabled={pending} onClick={saveMinutes} className="rounded bg-foreground px-2 py-0.5 font-medium text-background disabled:opacity-50">
              Lưu
            </button>
          ) : null}
        </div>
        {msg ? <p className={msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}>{msg.text}</p> : null}
      </div>
    </details>
  );
}
