"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { submitFeedbackAction } from "@/lib/actions/sales-inbox";
import { formatDateTime } from "@/lib/format";
import type { InboxCustomerHistory, InboxFeedback } from "@/lib/sales-chatbot/inbox-shared";
import { CUSTOMER_LEVEL_CLASS, CUSTOMER_LEVEL_LABEL, type CustomerLevel } from "@/lib/sales-chatbot/levels-shared";
import { cn } from "@/lib/utils";

/**
 * LỊCH SỬ MUA & GIAO của khách (đơn ERP cùng khách / cùng SĐT theo `ORDER_OUTCOME`) + level khách. Số Pancake ghi nhận (nếu có)
 * đứng riêng, không cộng lẫn. Rủi ro dùng chung luật với trang Đơn hàng. `null` = chưa biết khách là ai ⇒ nói thẳng, không in 0.
 */
export function CustomerHistoryCard({ history, level }: { history: InboxCustomerHistory | null; level: CustomerLevel | null }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-foreground/15 bg-background p-3" data-testid="inbox-history">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-foreground/70">Lịch sử mua & giao</p>
        {level ? <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", CUSTOMER_LEVEL_CLASS[level])}>{CUSTOMER_LEVEL_LABEL[level]}</span> : null}
      </div>
      {!history ? (
        <p className="text-foreground/60">Chưa biết khách là ai (chưa có SĐT / hồ sơ) — chưa đối chiếu được lịch sử.</p>
      ) : (
        <>
          {history.risk ? (
            <p className={cn("rounded px-2 py-1 text-[12px] font-semibold", history.risk.severity === "critical" ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200")}>
              ⚠ Rủi ro: {history.risk.reasons.join(" · ")} — xin cọc / xác nhận kỹ trước khi gửi
            </p>
          ) : null}
          <div className="grid grid-cols-3 gap-1 text-center">
            <Stat label="Giao thành công" value={history.delivered} tone="text-emerald-700 dark:text-emerald-300" />
            <Stat label="Hoàn / không thành" value={history.returned} tone={history.returned ? "text-red-700 dark:text-red-300" : "text-foreground"} />
            <Stat label="Đang giao" value={history.inTransit} tone="text-sky-700 dark:text-sky-300" />
            <Stat label="Chưa gửi" value={history.notShipped} tone="text-foreground" />
            <Stat label="Huỷ" value={history.cancelled} tone="text-foreground/70" />
            <Stat label="Tổng đơn" value={history.total} tone="text-foreground" />
          </div>
          {history.pancakeSucceed || history.pancakeReturned || history.blocked ? (
            <p className="text-[11.5px] text-foreground/65">
              Pancake ghi nhận: giao {history.pancakeSucceed} · hoàn {history.pancakeReturned}
              {history.blocked ? " · ĐANG BỊ CHẶN" : ""}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded border border-foreground/10 px-1 py-1">
      <p className={cn("text-[15px] font-bold leading-tight", tone)}>{value}</p>
      <p className="text-xs leading-tight text-foreground/60">{label}</p>
    </div>
  );
}

/**
 * GÓP Ý CHO AI: nhân viên viết bot sai ở đâu / nên làm gì ⇒ AI của shop rút 1–3 bài học «Khi … ⇒ …» đưa ngay vào bộ bài học của
 * bot (bản trước quay lại được ở trang Chatbot). Góp ý luôn được lưu; AI lỗi thì gửi lại.
 */
export function FeedbackPanel({ conversationId, feedback, canWrite }: { conversationId: string; feedback: InboxFeedback[]; canWrite: boolean }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);

  const send = async () => {
    const body = text.trim();
    if (body.length < 5) {
      toast.error("Viết rõ bot sai ở đâu, lần sau nên làm gì.");
      return;
    }
    setPending(true);
    try {
      const r = await submitFeedbackAction(conversationId, body);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message);
      setText("");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-1.5 rounded-lg border border-violet-300 bg-violet-50/60 p-3 dark:border-violet-800 dark:bg-violet-950/30" data-testid="inbox-feedback">
      <p className="flex items-center gap-1 font-semibold">
        <Sparkles className="size-4 text-violet-600" /> Góp ý cho AI <span className="text-[11px] font-normal text-foreground/60">— bot học ngay</span>
      </p>
      {canWrite ? (
        <>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} rows={3} placeholder="Vd: Khách đã cho địa chỉ rồi mà bot hỏi lại — lần sau đọc lại tin trước khi hỏi." className="bg-background text-[13px]" aria-label="Góp ý cho AI" />
          <Button size="sm" className="h-8 w-full bg-violet-600 text-white hover:bg-violet-700" disabled={pending} onClick={() => void send()}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Gửi cho AI học
          </Button>
        </>
      ) : (
        <p className="text-foreground/60">Cần quyền trả lời khách để góp ý.</p>
      )}
      {feedback.length ? (
        <ul className="space-y-1.5 pt-1">
          {feedback.slice(0, 5).map((f) => (
            <li key={f.id} className="rounded border border-foreground/10 bg-background p-2 text-[12px]">
              <p className="text-foreground/60">
                {f.userName} · {formatDateTime(f.createdAt)}
                {f.status === "FAILED" ? <span className="ml-1 font-semibold text-red-600">· chưa học được</span> : null}
              </p>
              <p>{f.text}</p>
              {f.lessons.length ? (
                <ul className="mt-1 list-disc pl-4 text-violet-800 dark:text-violet-300">
                  {f.lessons.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              ) : f.error ? (
                <p className="mt-1 text-red-600">{f.error}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
