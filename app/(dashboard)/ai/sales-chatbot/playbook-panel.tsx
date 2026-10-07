"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import { publishPlaybookAction, rollbackPlaybookAction, savePlaybookDraftAction, startPlaybookLearningAction, unpublishPlaybookAction } from "@/lib/actions/sales-chatbot";
import { formatDateTime } from "@/lib/format";
import { PLAYBOOK_LIMITS, type PlaybookRun, type PlaybookState } from "@/lib/sales-chatbot/playbook-shared";

/**
 * «HỌC TỪ HỘI THOẠI CŨ» — trang Chatbot bán hàng. Chạy học (đọc lịch sử fanpage qua Pancake, làm sạch, AI soạn sổ tay
 * NHÁP) → chủ shop sửa → xuất bản (bot dùng ngay) → quay lại bản trước / gỡ. Không `router.refresh()` sau action
 * (action đã `revalidatePath`); nút «Làm mới» chỉ để xem tiến độ lượt chạy nền.
 */
export function PlaybookPanel({ state, run, fanpageReady }: { state: PlaybookState; run: PlaybookRun; fanpageReady: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [target, setTarget] = useState<number>(100);
  const [days, setDays] = useState<number>(90);
  const [draft, setDraft] = useState(state.draft?.text ?? "");
  const savedDraft = state.draft?.text ?? "";
  const dirty = draft.trim() !== savedDraft.trim();
  const running = run.state === "RUNNING";

  const act = (fn: () => Promise<{ ok: true; message: string } | { error: string }>) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });

  return (
    <SectionCard title="Học từ hội thoại cũ" description="Đọc lịch sử tin nhắn fanpage (qua Pancake), che SĐT · địa chỉ · tên khách · mọi con số, rồi AI của shop chắt thành «Sổ tay bán hàng». Chủ shop sửa và xuất bản — giá và tồn bot vẫn chỉ lấy từ ERP.">
      <div className="space-y-4 text-sm" data-testid="playbook-panel">
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-0.5 text-xs">
            <span className="block text-muted-foreground">Số hội thoại</span>
            <select className="h-8 rounded-md border bg-background px-2 text-xs" value={target} onChange={(e) => setTarget(Number(e.target.value))} disabled={pending || running} aria-label="Số hội thoại">
              {PLAYBOOK_LIMITS.conversationChoices.map((n) => (
                <option key={n} value={n}>
                  {n} gần nhất
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-0.5 text-xs">
            <span className="block text-muted-foreground">Trong</span>
            <select className="h-8 rounded-md border bg-background px-2 text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={pending || running} aria-label="Khoảng ngày">
              {PLAYBOOK_LIMITS.dayChoices.map((n) => (
                <option key={n} value={n}>
                  {n} ngày
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" disabled={pending || running || !fanpageReady} onClick={() => act(() => startPlaybookLearningAction({ conversations: target, days }))} title={fanpageReady ? "Mỗi lượt học dùng AI của shop" : "Bật kết nối «Fanpage qua Pancake» trước"}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Chạy học
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => router.refresh()}>
            Làm mới
          </Button>
        </div>
        {!fanpageReady ? <p className="text-xs text-amber-700 dark:text-amber-400">Cần bật kết nối «Fanpage qua Pancake» (Cài đặt → Kết nối) — máy đọc lịch sử bằng page access token của shop.</p> : null}
        <p className="text-xs text-muted-foreground" data-testid="playbook-run">
          {run.state === "RUNNING"
            ? `Đang chạy (từ ${formatDateTime(run.startedAt)}): ${run.note} · đã đọc ${run.fetched} hội thoại.`
            : run.state === "DONE"
              ? `Lượt gần nhất xong ${formatDateTime(run.finishedAt)}: học từ ${run.stats.conversations} hội thoại${run.stats.closed !== undefined ? ` (${run.stats.closed} chốt được)` : ""}${run.stats.skipped ? ` · bỏ qua ${run.stats.skipped} hội thoại Pancake không trả` : ""} · ${run.stats.aiCalls} lượt AI${run.stats.costUsd !== null ? ` · ~${run.stats.costUsd.toFixed(3)} USD` : ""}${run.stats.pricesRemoved ? ` · gỡ ${run.stats.pricesRemoved} con số dạng giá` : ""}${run.stats.quickReplies ? ` · gợi ý ${run.stats.quickReplies} câu trả lời mẫu (đang tắt — duyệt ở trang Câu trả lời mẫu)` : ""}.`
              : run.state === "FAILED"
                ? `Lượt gần nhất hỏng (${formatDateTime(run.finishedAt)}): ${run.error}`
                : "Chưa chạy lần nào."}
        </p>

        <div className="space-y-1.5">
          <p className="text-xs font-medium">Bản nháp {state.draft ? `(soạn ${formatDateTime(state.draft.createdAt)})` : "— chưa có"}</p>
          <Textarea rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={PLAYBOOK_LIMITS.playbookChars} placeholder="Chạy học để AI soạn sổ tay nháp — hoặc tự viết." aria-label="Sổ tay bán hàng (nháp)" disabled={pending} />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" disabled={pending || !dirty} onClick={() => act(() => savePlaybookDraftAction(draft))}>
              Lưu nháp
            </Button>
            <Button size="sm" disabled={pending || !state.draft || dirty} title={dirty ? "Lưu nháp trước" : undefined} onClick={() => act(() => publishPlaybookAction())}>
              Xuất bản cho bot
            </Button>
          </div>
        </div>

        <div className="space-y-1.5 border-t pt-3">
          <p className="text-xs font-medium" data-testid="playbook-published">
            {state.published ? `Bot đang dùng bản ${state.published.version} (xuất bản ${formatDateTime(state.published.publishedAt)})` : "Bot chưa dùng sổ tay nào."}
          </p>
          {state.published ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Xem bản đang dùng</summary>
              <pre className="mt-1 whitespace-pre-wrap rounded-md bg-muted p-2 text-[11px] leading-5">{state.published.text}</pre>
            </details>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {state.published ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => unpublishPlaybookAction())}>
                Gỡ khỏi bot
              </Button>
            ) : null}
            {state.history.map((h) => (
              <Button key={h.version} size="sm" variant="ghost" disabled={pending} onClick={() => act(() => rollbackPlaybookAction(h.version))}>
                Dùng lại bản {h.version}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
