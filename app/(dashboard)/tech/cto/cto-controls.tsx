"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { approveTechProposalAction, planTechProposalAction, rejectTechProposalAction } from "@/lib/actions/tech";
import { Button } from "@/components/ui/button";

/**
 * Bốn nút — và nút thứ tư KHÔNG phải một lượt duyệt thứ hai.
 *
 * Cố ý vẫn không có "áp tất cả" hay "chạy luôn": mỗi bản kế hoạch phải được một con người đọc rồi
 * bấm duyệt, và phép duyệt đó là đường DUY NHẤT biến đề xuất thành việc thật.
 *
 * ─── VÌ SAO CÓ NÚT "ÁP LẠI" ───
 *
 * `approveProposal()` xưa nay VẪN chạy lại được trên bản đã `APPROVED` — cố ý, cho trường hợp một
 * lượt áp hỏng giữa chừng và mới tạo được vài việc. Nhưng màn hình chỉ hiện nút khi bản còn
 * `READY_FOR_REVIEW`, nên khả năng ấy chưa bao giờ với tới được.
 *
 * Đã cắn thật 22/09/2026: bản vá cho phép lượt áp lại GÁN VAI và PHÂN LOẠI phần còn thiếu (chín
 * việc `TECH-4…TECH-12` tạo trước bản vá nên vô chủ và kẹt ở `NEW`) — rồi chủ shop mở màn hình ra
 * và **không thấy nút nào để bấm**. Một tính năng không có đường chạm tới thì bằng không có.
 *
 * Nút này KHÔNG ký thêm lần nào: bản đã duyệt vẫn là đã duyệt, việc đã tạo KHÔNG tạo lại
 * (`applied_task_id` chặn), và nó chỉ chạm những việc ĐANG VÔ CHỦ hoặc đang `NEW`.
 */
function Bao({ v }: { v: { ok: boolean; text: string } | null }) {
  if (!v) return null;
  return (
    <p className={`text-xs ${v.ok ? "text-success" : "text-destructive"}`}>{v.text}</p>
  );
}

export function PlanButton({ taskId, label }: { taskId: string; label?: string }) {
  const [dang, batDau] = useTransition();
  const [bao, setBao] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  return (
    <div className="space-y-1">
      <Button
        size="sm"
        disabled={dang}
        onClick={() =>
          batDau(async () => {
            setBao(null);
            const r = await planTechProposalAction({ taskId });
            if ("error" in r) setBao({ ok: false, text: r.error });
            else setBao({ ok: true, text: r.status === "READY_FOR_REVIEW" ? `Đã lập kế hoạch: ${r.tasks} việc đề nghị — CHƯA tạo việc thật.` : "Lượt lập kế hoạch KHÔNG đạt — xem lý do bên dưới." });
            router.refresh();
          })
        }
      >
        {dang ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
        {dang ? "AI CTO đang đọc…" : (label ?? "Tạo đề xuất")}
      </Button>
      <Bao v={bao} />
    </div>
  );
}

export function ApproveButton({ proposalId, count, apLai }: { proposalId: string; count: number; apLai?: boolean }) {
  const [dang, batDau] = useTransition();
  const [bao, setBao] = useState<{ ok: boolean; text: string } | null>(null);
  const [note, setNote] = useState("");
  const router = useRouter();
  return (
    <div className="space-y-2">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={apLai ? "Ghi chú khi áp lại (tuỳ chọn)" : "Ghi chú khi duyệt (tuỳ chọn)"}
        className="w-full rounded-lg border bg-background px-3 py-1.5 text-sm"
      />
      <Button
        size="sm"
        disabled={dang}
        onClick={() =>
          batDau(async () => {
            setBao(null);
            const r = await approveTechProposalAction({ proposalId, note: note || undefined });
            if ("error" in r) setBao({ ok: false, text: r.error });
            else
              setBao({
                ok: true,
                text: [
                  `Đã tạo ${r.created} việc thật${r.skipped ? ` · bỏ qua ${r.skipped} việc đã tạo từ lượt trước` : ""}`,
                  `CTO giao được ${r.daGan}/${r.created} việc`,
                  r.ganBu ? `${r.ganBu} việc của lượt áp trước nay mới có chủ` : "",
                  r.khongGan.length ? `CHƯA CÓ CHỦ: ${r.khongGan.join(" | ")}` : "",
                  "Mức rủi ro do MÁY xếp lại.",
                ]
                  .filter(Boolean)
                  .join(" · "),
              });
            router.refresh();
          })
        }
      >
        {dang ? <Loader2 className="size-4 animate-spin" /> : apLai ? <RefreshCw className="size-4" /> : <Check className="size-4" />}
        {apLai ? "Áp lại — gán vai và phân loại phần còn thiếu" : `Phê duyệt kế hoạch (${count} việc)`}
      </Button>
      {apLai ? (
        <p className="text-[11px] text-muted-foreground">
          Không ký thêm lần nào: việc đã tạo KHÔNG tạo lại, và chỉ những việc đang vô chủ hoặc đang
          “Mới” được chạm tới.
        </p>
      ) : null}
      <Bao v={bao} />
    </div>
  );
}

export function RejectButton({ proposalId }: { proposalId: string }) {
  const [dang, batDau] = useTransition();
  const [bao, setBao] = useState<{ ok: boolean; text: string } | null>(null);
  const [reason, setReason] = useState("");
  const router = useRouter();
  return (
    <div className="space-y-2">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Vì sao từ chối (bắt buộc, ít nhất một câu)"
        className="w-full rounded-lg border bg-background px-3 py-1.5 text-sm"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={dang}
        onClick={() =>
          batDau(async () => {
            setBao(null);
            const r = await rejectTechProposalAction({ proposalId, reason });
            if ("error" in r) setBao({ ok: false, text: r.error });
            else setBao({ ok: true, text: "Đã từ chối. Bản này vẫn đọc lại được." });
            router.refresh();
          })
        }
      >
        {dang ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
        Từ chối
      </Button>
      <Bao v={bao} />
    </div>
  );
}
