import { ShieldCheck } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { listPendingApprovals } from "@/lib/actions/approvals";
import { APPROVAL_GROUP_REASON } from "@/lib/constants/approval";
import { formatDateTime, formatTimeAgo, formatVND } from "@/lib/format";
import { ApprovalDecisionButtons } from "@/app/(dashboard)/alerts/approval-actions";

/**
 * ───────────── VIỆC ĐANG CHỜ NGƯỜI THỨ HAI GẬT ─────────────
 *
 * Đặt ở đầu trang Cần xử lý, trên cả hàng đợi thường: đây là việc CÓ NGƯỜI ĐANG CHỜ, khác hẳn cảnh
 * báo do máy quét ra. Để lẫn xuống dưới thì người xin ngồi đợi mà không ai biết.
 *
 * Không có yêu cầu nào thì mục này BIẾN MẤT hẳn, không hiện khung rỗng — trang này vốn đã dài.
 */
export async function ApprovalSection() {
  const list = await listPendingApprovals();
  if (!list.length) return null;
  const cho = list.filter((r) => !r.returned).length;
  const traLai = list.length - cho;

  return (
    <SectionCard
      title={`${cho} việc chờ duyệt${traLai ? ` · ${traLai} lời duyệt bị trả lại` : ""}`}
      description="Những việc một người không được tự làm một mình. Người xin không duyệt được việc của chính mình."
      padded={false}
    >
      <ul className="divide-y">
        {list.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4 shrink-0 text-amber-600" />
                <span className="truncate">{r.summary}</span>
              </div>
              <div className="mt-1 text-[12px] text-muted-foreground">
                {r.groupLabel}
                {r.amount !== null ? ` · ${formatVND(r.amount)}` : " · chưa rõ số tiền"} · {r.requestedByEmail} xin {formatTimeAgo(r.requestedAt)}
              </div>
              {/* Người duyệt phải biết mình đang gật CÁI GÌ và VÌ SAO việc đó cần gật. */}
              <div className="mt-1 text-[11.5px] text-muted-foreground">{APPROVAL_GROUP_REASON[r.group]}</div>
              {/*
                LẦN THỰC THI TRƯỚC KHÔNG HOÀN TẤT (Company OS · Agent N): lời duyệt đã quay về, làm lại ĐÚNG việc
                sẽ dùng nó. Máy không phân biệt được "dừng trước khi ghi" với "ghi xong rồi mới dừng" — nên câu
                này phải hiện TRƯỚC khi ai bấm làm lại, không phải sau.
              */}
              {r.executionNote ? (
                <div className="mt-1.5 rounded-md border border-amber-300/70 bg-amber-50/70 px-2 py-1 text-[12px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                  {r.executionNote}
                  <span className="ml-1 text-amber-800/80 dark:text-amber-300/80">
                    · {r.executionFailedAt ? formatDateTime(r.executionFailedAt) : "chưa rõ lúc nào"}
                  </span>
                </div>
              ) : null}
            </div>
            {r.returned ? (
              <span className="shrink-0 self-center text-[11.5px] text-muted-foreground">
                {r.isRequester ? "Đã duyệt — làm lại ĐÚNG việc này sẽ dùng lời duyệt đã có" : "Đã duyệt — lời duyệt đã trả lại cho người xin"}
              </span>
            ) : r.canDecide ? (
              <ApprovalDecisionButtons id={r.id} />
            ) : (
              <span className="shrink-0 self-center text-[11.5px] text-muted-foreground">
                Bạn là người xin việc này — cần người khác duyệt
              </span>
            )}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
