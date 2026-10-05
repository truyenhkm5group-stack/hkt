"use client";

import { useMemo, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { disconnectMessengerAction, pickMessengerPagesAction, setMessengerPagesAiAction } from "@/lib/actions/messenger";
import type { MessengerPageView } from "@/lib/sales-chatbot/messenger";
import { cn } from "@/lib/utils";

/**
 * Chọn NHIỀU page trong danh sách vừa cấp quyền (danh sách + token niêm phong ở máy chủ; client chỉ gửi mã page). Tìm theo tên /
 * mã, chọn tất cả / bỏ chọn — shop 50 page không phải bấm từng page.
 */
export function PagePicker({ pages, connected }: { pages: { id: string; name: string }[]; connected: string[] }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(pages.filter((p) => !connected.includes(p.id)).map((p) => p.id)));
  const [pending, start] = useTransition();
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? pages.filter((p) => p.name.toLowerCase().includes(k) || p.id.includes(k)) : pages;
  }, [pages, q]);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const submit = () =>
    start(async () => {
      const r = await pickMessengerPagesAction([...picked]);
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });
  return (
    <div className="mt-4 space-y-2" data-testid="messenger-page-picker">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Chọn các page cho bot ({picked.size}/{pages.length}):</p>
        <Input className="h-8 min-w-0 flex-1 basis-40" placeholder="Tìm page theo tên / mã" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm page" />
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => setPicked(new Set(pages.map((p) => p.id)))}>
          Chọn tất cả
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => setPicked(new Set())}>
          Bỏ chọn
        </Button>
      </div>
      <ul className="max-h-96 divide-y overflow-y-auto rounded-md border">
        {shown.map((p) => (
          <li key={p.id}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
              <input type="checkbox" className="size-4" checked={picked.has(p.id)} onChange={() => toggle(p.id)} data-testid="messenger-pick" />
              <span className="min-w-0 flex-1 text-sm">
                {p.name} <span className="text-xs text-muted-foreground">(Page ID {p.id})</span>
                {connected.includes(p.id) ? <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-400">đã nối — chọn để nối lại</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <Button type="button" onClick={submit} disabled={pending || picked.size === 0} data-testid="messenger-connect-selected">
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Nối {picked.size} page đã chọn
      </Button>
    </div>
  );
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

/** Sức khoẻ một page, đọc từ mốc MÁY ghi: lỗi gần nhất mới hơn tin gần nhất ⇒ đang lỗi. */
function health(p: MessengerPageView): { label: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (p.status !== "ACTIVE") return { label: "Đã gỡ", tone: "muted" };
  if (p.mutedByPancake) return { label: "Đang nhường Pancake", tone: "warn" };
  if (p.lastErrorAt && (!p.lastEventAt || p.lastErrorAt > p.lastEventAt)) return { label: `Lỗi: ${p.lastError ?? "không rõ"}`, tone: "bad" };
  if (p.lastEventAt) return { label: `Tin gần nhất ${fmt(p.lastEventAt)}`, tone: "ok" };
  return { label: "Chưa nhận tin nào", tone: "muted" };
}

/** Quản lý các page đã nối: chọn nhiều ⇒ bật / tạm dừng AI; gỡ TỪNG page (các page khác chạy tiếp). */
export function PageManager({ pages, manage }: { pages: MessengerPageView[]; manage: boolean }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const active = pages.filter((p) => p.status === "ACTIVE" && p.kind === "PAGE");
  const run = (fn: () => Promise<{ ok: true; message: string } | { error: string }>) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.message);
        setSel(new Set());
      }
    });
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div className="space-y-2" data-testid="messenger-pages">
      {manage && active.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => setSel(sel.size === active.length ? new Set() : new Set(active.map((p) => p.id)))}>
            {sel.size === active.length ? "Bỏ chọn" : "Chọn tất cả"}
          </Button>
          <Button type="button" size="sm" className="h-8" disabled={pending || sel.size === 0} onClick={() => run(() => setMessengerPagesAiAction([...sel], true))}>
            Bật AI ({sel.size})
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={pending || sel.size === 0} onClick={() => run(() => setMessengerPagesAiAction([...sel], false))}>
            Tạm dừng AI ({sel.size})
          </Button>
        </div>
      ) : null}
      <ul className="divide-y rounded-md border">
        {pages.map((p) => {
          const h = health(p);
          return (
            <li key={p.id} className={cn("flex flex-wrap items-center gap-3 px-3 py-2", p.kind === "INSTAGRAM" && "pl-9")} data-testid="messenger-page-row" data-page={p.id}>
              {manage && p.kind === "PAGE" && p.status === "ACTIVE" && active.length > 1 ? <input type="checkbox" className="size-4" checked={sel.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Chọn ${p.name}`} /> : null}
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-semibold">{p.name}</span> <span className="text-xs text-muted-foreground">({p.kind === "INSTAGRAM" ? "Instagram" : "Page ID"} {p.id})</span>
                </p>
                <p className={cn("text-xs", h.tone === "bad" ? "text-destructive" : h.tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                  {h.label}
                  {p.status === "ACTIVE" ? ` · AI ${p.aiEnabled ? "đang bật" : "tạm dừng — nhân viên trả lời"}` : ""}
                </p>
              </div>
              {manage && p.status === "ACTIVE" && p.kind === "PAGE" ? (
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" variant="outline" className="h-8" disabled={pending} onClick={() => run(() => setMessengerPagesAiAction([p.id], !p.aiEnabled))}>
                    {p.aiEnabled ? "Tạm dừng AI" : "Bật AI"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Gỡ page «${p.name}»? Bot thôi nhận tin của page này; các page khác chạy tiếp.`)) run(() => disconnectMessengerAction(p.id));
                    }}
                  >
                    Gỡ
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DisconnectButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          if (!window.confirm("Gỡ Messenger trực tiếp cho MỌI page? Bot sẽ thôi trả lời tin nhắn của các page qua đường này.")) return;
          const r = await disconnectMessengerAction();
          if ("error" in r) toast.error(r.error);
          else toast.success(r.message);
        })
      }
    >
      Gỡ tất cả
    </Button>
  );
}
