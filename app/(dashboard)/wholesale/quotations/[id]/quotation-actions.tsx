"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { approveQuotationAction, markQuotationSentAction, recordQuotationDecisionAction, returnQuotationAction, submitQuotationAction } from "@/lib/actions/wholesale-quotations";
import type { QuotationStatus } from "@/lib/wholesale/quotation-engine";

type Panel = null | "return" | "ACCEPTED" | "REJECTED";

/**
 * Nút theo trạng thái. Máy chủ kiểm lại MỌI điều kiện (quyền, phạm vi, người lập không tự duyệt, hết hạn, còn chặn) — nút ẩn ở đây
 * chỉ để màn hình gọn, không phải hàng rào.
 */
export function QuotationActions(props: { id: string; status: QuotationStatus; blockers: number; requiresApproval: boolean; canWork: boolean; canApprove: boolean; isCreator: boolean; revisable: boolean }) {
  const { id, status } = props;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [reason, setReason] = useState("");

  const run = (fn: () => Promise<{ error: string } | { ok: true; status: string; replayed: boolean }>, done: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.replayed ? "Đã ở trạng thái này từ trước." : done);
        setPanel(null);
        setReason("");
        router.refresh();
      }
    });

  const canSubmit = props.canWork && status === "DRAFT" && props.requiresApproval && props.blockers === 0;
  const canSend = props.canWork && props.blockers === 0 && (status === "APPROVED" || (status === "DRAFT" && !props.requiresApproval));
  const canApprove = props.canApprove && status === "PENDING_APPROVAL" && !props.isCreator && props.blockers === 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href={`/wholesale/quotations/${id}/print`} target="_blank" rel="noreferrer">
            Bản in gửi khách
          </Link>
        </Button>
        {props.canWork && props.revisable ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/wholesale/quotations/${id}/edit`}>Sửa (tạo phiên bản mới)</Link>
          </Button>
        ) : null}
        {canSubmit ? (
          <Button size="sm" disabled={pending} onClick={() => run(() => submitQuotationAction(id), "Đã gửi duyệt.")}>
            Gửi duyệt
          </Button>
        ) : null}
        {canApprove ? (
          <Button size="sm" disabled={pending} onClick={() => run(() => approveQuotationAction(id), "Đã duyệt.")}>
            Duyệt
          </Button>
        ) : null}
        {props.canApprove && status === "PENDING_APPROVAL" ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setPanel(panel === "return" ? null : "return")}>
            Trả lại
          </Button>
        ) : null}
        {canSend ? (
          <Button size="sm" disabled={pending} onClick={() => run(() => markQuotationSentAction(id), "Đã đánh dấu gửi khách.")}>
            Đánh dấu đã gửi khách
          </Button>
        ) : null}
        {props.canWork && status === "SENT" ? (
          <>
            <Button size="sm" disabled={pending} onClick={() => setPanel(panel === "ACCEPTED" ? null : "ACCEPTED")}>
              Khách chấp nhận
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setPanel(panel === "REJECTED" ? null : "REJECTED")}>
              Khách từ chối
            </Button>
          </>
        ) : null}
      </div>
      {props.canApprove && status === "PENDING_APPROVAL" && props.isCreator ? <p className="text-xs text-muted-foreground">Bạn là người lập báo giá này — người khác có quyền duyệt phải duyệt.</p> : null}
      {panel ? (
        <div className="space-y-2 rounded-md border p-3">
          <div className="text-xs font-semibold text-muted-foreground">{panel === "return" ? "Lý do trả lại" : panel === "ACCEPTED" ? "Khách chấp nhận qua kênh nào / ghi chú" : "Lý do khách từ chối"}</div>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
          <Button
            size="sm"
            disabled={pending}
            onClick={() => (panel === "return" ? run(() => returnQuotationAction(id, reason), "Đã trả lại về nháp.") : run(() => recordQuotationDecisionAction(id, { decision: panel, reason }), panel === "ACCEPTED" ? "Đã ghi khách chấp nhận." : "Đã ghi khách từ chối."))}
          >
            Lưu
          </Button>
        </div>
      ) : null}
    </div>
  );
}
