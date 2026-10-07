"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import { learnLessonsNowAction, rollbackLessonsAction, saveLessonsAction, setLessonsEnabledAction } from "@/lib/actions/sales-chatbot";
import { formatDateTime } from "@/lib/format";
import { LESSON_LIMITS, type LessonsState } from "@/lib/sales-chatbot/lessons-shared";

const RUN_LABEL: Record<string, string> = { RUNNING: "Đang học", OK: "Đã học", SKIPPED: "Bỏ qua", ERROR: "Lỗi" };

/**
 * «BOT TỰ HỌC» — trang Chatbot bán hàng. Bài học do AI rút từ hội thoại thật mỗi 6 giờ, bot dùng NGAY; chủ shop sửa / xoá
 * (mỗi dòng một bài), quay lại bản trước, học ngay, hoặc tắt. Không `router.refresh()` sau action (action đã `revalidatePath`).
 */
export function LessonsPanel({ state }: { state: LessonsState }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const saved = state.lessons.join("\n");
  const [text, setText] = useState(saved);
  const dirty = text.trim() !== saved.trim();
  const running = state.lastRun?.status === "RUNNING";

  const act = (fn: () => Promise<{ ok: true; message: string } | { error: string }>) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });

  return (
    <SectionCard
      title="Bot tự học"
      description={`Cứ 6 giờ một lần, AI của shop đọc các hội thoại fanpage vừa xong (đã che SĐT · tên · link) — nhất là chỗ nhân viên phải vào thay bot hoặc khách bỏ đi — rồi cập nhật tối đa ${LESSON_LIMITS.maxLessons} bài học «Khi … ⇒ …». Bot dùng ngay ở tin kế tiếp; giá và tồn vẫn chỉ lấy từ ERP.`}
    >
      <div className="space-y-3 text-sm" data-testid="lessons-panel">
        <div className="flex flex-wrap items-center gap-2">
          <span className={state.enabled ? "rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" : "rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"}>{state.enabled ? "Đang bật" : "Đang tắt"}</span>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => setLessonsEnabledAction(!state.enabled))}>
            {state.enabled ? "Tắt tự học" : "Bật tự học"}
          </Button>
          <Button size="sm" disabled={pending || running || !state.enabled} title="Mỗi lượt học dùng AI của shop" onClick={() => act(() => learnLessonsNowAction())}>
            {pending || running ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Học ngay
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => router.refresh()}>
            Làm mới
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {state.lastRun ? `Lượt gần nhất ${formatDateTime(state.lastRun.at)} · ${RUN_LABEL[state.lastRun.status] ?? state.lastRun.status} — ${state.lastRun.note}` : "Chưa học lượt nào."}
          {state.updatedAt ? ` · Bản ${state.version} cập nhật ${formatDateTime(state.updatedAt)} bởi ${state.updatedBy ?? "—"}` : ""}
        </p>
        <Textarea rows={Math.min(16, Math.max(5, state.lessons.length + 2))} value={text} onChange={(e) => setText(e.target.value)} placeholder="Chưa có bài học — bấm «Học ngay», hoặc tự viết mỗi dòng một bài: Khi … ⇒ …" aria-label="Bài học của bot (mỗi dòng một bài)" disabled={pending} />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={pending || !dirty} onClick={() => act(() => saveLessonsAction(text))}>
            Lưu bài học
          </Button>
          {dirty ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setText(saved)}>
              Bỏ thay đổi
            </Button>
          ) : null}
          {state.history.length ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => rollbackLessonsAction())} title={`Còn ${state.history.length} bản trước`}>
              Quay lại bản trước
            </Button>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}
