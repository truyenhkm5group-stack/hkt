"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Check, Loader2, Sparkles, Wrench, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { askCopilot, confirmCopilotActions, copilotStatus } from "@/lib/actions/ai";
import type { CopilotContext, CopilotPendingAction, CopilotResult } from "@/lib/ai/contracts";
import { cn } from "@/lib/utils";

/**
 * ═══════════ AI COPILOT — NGĂN KÉO TOÀN CỤC, BIẾT MÌNH ĐANG Ở ĐÂU ═══════════
 *
 * Không phải chatbot chiếm màn hình: một ngăn kéo bên phải, mở bằng nút ✦ hoặc Ctrl+J, và mở được
 * từ bất kỳ nơi nào bằng sự kiện `erp:copilot` (ngăn kéo kiện dùng nó cho "Tóm tắt bằng AI").
 *
 * Bối cảnh tự mang theo: đường dẫn + tham số (kỳ, bộ lọc) và đối tượng đang mở (/shipments/<id>,
 * /orders/<id>, /customers/<id>). Hành động ghi AI đề nghị hiện thành thẻ có nút Xác nhận — không
 * bao giờ tự chạy. Cảnh báo dữ liệu cũ hiện riêng, không trộn vào câu trả lời.
 */

export type CopilotOpenDetail = { message?: string; context?: Partial<CopilotContext>; send?: boolean };

export function openCopilot(detail: CopilotOpenDetail = {}) {
  window.dispatchEvent(new CustomEvent<CopilotOpenDetail>("erp:copilot", { detail }));
}

type Turn = { role: "user" | "assistant"; text: string; result?: CopilotResult; confirmed?: Record<string, { ok: boolean; summary: string }> };

function contextFromPath(pathname: string, search: string): CopilotContext {
  const m = pathname.match(/^\/(shipments|orders|customers)\/([^/]+)$/);
  const entityType: CopilotContext["entityType"] = m ? (m[1] === "shipments" ? "shipment" : m[1] === "orders" ? "order" : "customer") : "";
  return { route: search ? `${pathname}?${search}` : pathname, entityType, entityId: m ? decodeURIComponent(m[2]!) : "" };
}

const SUGGESTIONS: Record<string, string[]> = {
  "/shipments": ["Hôm nay nên xử lý kiện nào trước?", "Tiền nào đang gặp rủi ro trong hàng đợi care?", "Dữ liệu Viettel Post còn mới không?"],
  "/alerts": ["Việc nào đang trễ hạn và vì sao?"],
  "/orders": ["Tóm tắt đơn này", "Khách này đã mua mấy lần, có hay hoàn không?"],
  "/reports": ["Lợi nhuận 30 ngày qua có đáng tin chưa, thiếu chứng từ gì?"],
  "/inventory": ["Mẫu nào sắp hết, mẫu nào đang kẹt vốn?"],
  "/": ["Hôm nay có gì cần chủ shop quyết?"],
};

/** Markdown nhẹ: **đậm**, gạch đầu dòng, xuống dòng — đủ cho câu trả lời ngắn, không kéo thư viện. */
function Lite({ text }: { text: string }) {
  const lines = text.split("\n");
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>));
  return (
    <div className="space-y-1 text-[13px] leading-snug">
      {lines.map((l, i) => {
        const t = l.trim();
        if (!t) return <div key={i} className="h-1" />;
        if (/^[-*•]\s+/.test(t)) return <div key={i} className="flex gap-1.5 pl-1"><span className="text-muted-foreground">•</span><span>{inline(t.replace(/^[-*•]\s+/, ""))}</span></div>;
        if (/^#+\s/.test(t)) return <div key={i} className="font-semibold">{inline(t.replace(/^#+\s/, ""))}</div>;
        return <p key={i}>{inline(t)}</p>;
      })}
    </div>
  );
}

export function AiCopilot() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ enabled: boolean; model: string; reason: string | null } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [override, setOverride] = useState<Partial<CopilotContext> | null>(null);
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const search = searchParams.toString();
  const context = useMemo(() => ({ ...contextFromPath(pathname, search), ...(override ?? {}) }), [pathname, search, override]);

  const send = useCallback(
    (message: string, ctx: CopilotContext) => {
      const text = message.trim();
      if (!text) return;
      setInput("");
      setTurns((t) => [...t, { role: "user", text }]);
      start(async () => {
        const history = turns.slice(-8).map((t) => ({ role: t.role, text: t.text }));
        const r = await askCopilot({ message: text, context: ctx, history }).catch((e: unknown) => ({ interactionId: null, status: "ERROR" as const, answer: "", toolCalls: [], pendingActions: [], warnings: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: null, latencyMs: 0, rounds: 0, model: "", error: e instanceof Error ? e.message : String(e) }));
        setTurns((t) => [...t, { role: "assistant", text: r.answer || (r.error ? `Lỗi: ${r.error}` : ""), result: r }]);
      });
    },
    [turns],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<CopilotOpenDetail>).detail ?? {};
      setOverride(d.context ?? null);
      setOpen(true);
      if (d.message) {
        if (d.send) send(d.message, { ...contextFromPath(window.location.pathname, window.location.search.replace(/^\?/, "")), ...(d.context ?? {}) });
        else setInput(d.message);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("erp:copilot", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("erp:copilot", onOpen);
    };
  }, [send]);

  useEffect(() => {
    if (open && !status) void copilotStatus().then((s) => setStatus({ enabled: s.enabled, model: s.model, reason: s.reason })).catch(() => setStatus({ enabled: false, model: "", reason: "Không đọc được trạng thái" }));
  }, [open, status]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, pending]);
  // Rời trang ⇒ bỏ bối cảnh ép từ nơi khác (ngăn kéo kiện đã đóng).
  useEffect(() => setOverride(null), [pathname]);

  const confirm = async (turnIdx: number, a: CopilotPendingAction, interactionId: string) => {
    setConfirming(a.token);
    const r = await confirmCopilotActions({ interactionId, tokens: [a.token] }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    setConfirming(null);
    if ("error" in r) {
      toast.error(r.error);
      return;
    }
    const ex = r.data.executed[0]!;
    setTurns((t) => t.map((turn, i) => (i === turnIdx ? { ...turn, confirmed: { ...(turn.confirmed ?? {}), [a.token]: { ok: ex.ok, summary: ex.summary } } } : turn)));
    if (ex.ok) {
      toast.success(ex.summary);
      router.refresh();
    } else toast.error(ex.summary);
  };

  const suggestions = SUGGESTIONS[`/${pathname.split("/")[1] ?? ""}`] ?? SUGGESTIONS["/"]!;
  const entityLabel = context.entityType ? `${context.entityType === "shipment" ? "kiện" : context.entityType === "order" ? "đơn" : "khách"} ${context.entityId}` : null;

  return (
    <>
      <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={() => setOpen(true)} title="AI Copilot (Ctrl+J)" aria-label="Mở AI Copilot">
        <Sparkles className="size-3.5 text-brand" />
        <span className="hidden sm:inline">AI</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="size-4 text-brand" /> AI Copilot
              {status?.model ? <span className="rounded bg-muted px-1.5 py-px text-[10.5px] font-normal text-muted-foreground">{status.model}</span> : null}
            </SheetTitle>
            <SheetDescription className="text-[11.5px]">
              Đọc số của ERP qua tool, không tự tính. Hành động ghi chỉ chạy khi bạn bấm xác nhận.
              {entityLabel ? <> · Đang xem <b>{entityLabel}</b></> : null}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {status && !status.enabled ? (
              <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <b>AI chưa được cấu hình.</b> {status.reason ?? "Chưa có khoá API trên máy chủ."} Chủ shop thêm <code>OPENAI_API_KEY</code> (hoặc <code>ANTHROPIC_API_KEY</code>) vào <code>.env</code> trên VPS rồi khởi động lại.
              </div>
            ) : null}
            {turns.length === 0 ? (
              <div className="space-y-2">
                <div className="text-[11.5px] uppercase tracking-wide text-muted-foreground">Thử hỏi</div>
                {suggestions.map((s) => (
                  <button key={s} type="button" disabled={pending || status?.enabled === false} className="block w-full rounded-lg border bg-card px-3 py-2 text-left text-[12.5px] hover:bg-accent disabled:opacity-50" onClick={() => send(s, context)}>
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
            {turns.map((t, i) =>
              t.role === "user" ? (
                <div key={i} className="ml-8 rounded-lg bg-primary/10 px-3 py-2 text-[13px]">{t.text}</div>
              ) : (
                <div key={i} className="space-y-2">
                  {t.result?.warnings.length ? (
                    <div className="flex gap-1.5 rounded-lg border border-amber-300/60 bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                      <AlertTriangle className="mt-px size-3.5 shrink-0" />
                      <div>{t.result.warnings.map((w, k) => <div key={k}>{w}</div>)}</div>
                    </div>
                  ) : null}
                  <div className="rounded-lg border bg-card px-3 py-2">
                    <Lite text={t.text} />
                  </div>
                  {t.result?.toolCalls.length ? (
                    <div className="flex flex-wrap gap-1 text-[10.5px] text-muted-foreground">
                      <Wrench className="size-3" />
                      {t.result.toolCalls.map((c, k) => (
                        <span key={k} className={cn("rounded bg-muted px-1.5 py-px", !c.ok && "text-rose-600")} title={c.summary}>
                          {c.label}
                        </span>
                      ))}
                      {t.result.latencyMs ? <span className="numeric">· {(t.result.latencyMs / 1000).toFixed(1)}s</span> : null}
                    </div>
                  ) : null}
                  {t.result?.pendingActions.map((a) => {
                    const done = t.confirmed?.[a.token];
                    return (
                      <div key={a.token} className={cn("rounded-lg border px-3 py-2 text-[12.5px]", done ? (done.ok ? "border-emerald-300/60 bg-emerald-50 dark:bg-emerald-950/30" : "border-rose-300/60 bg-rose-50 dark:bg-rose-950/30") : "border-brand/40 bg-brand/5")}>
                        <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{done ? (done.ok ? "Đã thực hiện" : "Không thực hiện được") : "AI đề nghị — chưa chạy"}</div>
                        <div className="font-medium">{a.summary}</div>
                        {done ? (
                          <div className="mt-1 text-[11.5px] text-muted-foreground">{done.summary}</div>
                        ) : (
                          <div className="mt-1.5 flex gap-1.5">
                            <Button size="sm" className="h-7 gap-1 px-2 text-xs" disabled={confirming === a.token || !t.result?.interactionId} onClick={() => t.result?.interactionId && void confirm(i, a, t.result.interactionId)}>
                              {confirming === a.token ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Xác nhận
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setTurns((ts) => ts.map((turn, k) => (k === i ? { ...turn, confirmed: { ...(turn.confirmed ?? {}), [a.token]: { ok: false, summary: "Bạn đã bỏ qua" } } } : turn)))}>
                              <X className="size-3" /> Bỏ qua
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ),
            )}
            {pending ? (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Đang tra ERP…
              </div>
            ) : null}
            <div ref={bottomRef} />
          </div>

          <form
            className="border-t p-3"
            onSubmit={(e) => {
              e.preventDefault();
              send(input, context);
            }}
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={status?.enabled === false ? "AI chưa được cấu hình" : "Hỏi về đơn, kiện, khách, tiền, kho… (Enter để gửi)"}
              disabled={pending || status?.enabled === false}
              rows={2}
              className="min-h-[56px] text-[13px]"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input, context);
                }
              }}
            />
            <div className="mt-1.5 flex items-center justify-between text-[10.5px] text-muted-foreground">
              <span>{context.route}</span>
              <div className="flex gap-1">
                {turns.length ? (
                  <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => setTurns([])}>
                    Xoá hội thoại
                  </Button>
                ) : null}
                <Button type="submit" size="sm" className="h-6 px-2 text-[11px]" disabled={pending || !input.trim() || status?.enabled === false}>
                  Gửi
                </Button>
              </div>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
