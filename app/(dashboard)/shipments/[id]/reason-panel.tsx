"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { setReturnReason } from "@/lib/actions/return-reason";
import { RETURN_REASON_GROUPS, RETURN_REASON_GROUP_LABEL, RETURN_REASON_GROUP_OF, RETURN_REASON_LABEL, type ReturnReason, type ReturnReasonGroup } from "@/lib/constants/return-reason";
import { REASON_COVERAGE_ACTION, REASON_COVERAGE_LABEL, REASON_SOURCE_LABEL, type ReasonCoverageState, type ReasonSource } from "@/lib/constants/return-reason-source";
import { cn } from "@/lib/utils";

/**
 * ═══════════ "CẦN BỔ SUNG LÝ DO" LÀ MỘT TRẠNG THÁI, KHÔNG PHẢI MỘT Ô TRỐNG ═══════════
 *
 * ─── VÌ SAO KHÔNG CHỈ HIỆN DẤU GẠCH ───
 *
 * Bản trước, kiện hoàn không có lý do hiện ô "Lý do: —". Người mở trang đọc nó như một sự thật đã
 * biết ("ĐVVC không nói") chứ không như một việc của mình. Kết quả đo được: `shipment_return_reasons`
 * có ĐÚNG 0 dòng trong khi hàng trăm kiện hoàn đi qua tay người xử lý mỗi tuần.
 *
 * Nay ô ấy nói ra ba điều: đang ở mức nào, VIỆC PHẢI LÀM là gì, và cái nút để làm ngay tại chỗ.
 *
 * ─── BA MỨC, BA VIỆC KHÁC NHAU ───
 *
 *   ĐÃ XÁC ĐỊNH   — không phải việc; vẫn sửa được nếu thấy sai.
 *   CÓ CHỨNG TỪ   — chữ đã nằm sẵn ngay bên dưới. Đọc rồi chọn, không cần gọi ai.
 *   CHƯA CÓ GÌ    — không có gì để đọc. Phải gọi khách hoặc để kho ghi lại lúc mở kiện.
 *
 * ─── Ô CHỌN, KHÔNG PHẢI Ô GÕ ───
 *
 * Ô gõ tự do cho ra "vải mỏng", "vải hơi mỏng", "mỏng quá" — ba dòng cho một vấn đề, và không phép
 * đếm nào gom chúng lại. Ghi chú tự do VẪN CÓ ngay cạnh, nhưng nó là bối cảnh cho người đọc, không
 * phải đầu vào của phép đếm.
 */
const REASONS_BY_GROUP = (Object.keys(RETURN_REASON_GROUP_OF) as ReturnReason[]).reduce(
  (acc, r) => {
    const g = RETURN_REASON_GROUP_OF[r];
    /* UNKNOWN và OTHER là chỗ TRỐNG, không phải lựa chọn — chọn chúng là ghi lại một cái không biết. */
    if (r !== "UNKNOWN" && r !== "OTHER") (acc[g] ??= []).push(r);
    return acc;
  },
  {} as Record<ReturnReasonGroup, ReturnReason[]>,
);

const MAU: Record<ReasonCoverageState, string> = {
  CLASSIFIED: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200",
  RAW_ONLY: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-200",
  NO_EVIDENCE: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200",
};

export function ReturnReasonPanel({
  shipmentId,
  tracking,
  reason,
  coverage,
  source,
  rawReason,
  evidence,
  actorEmail,
  canEdit,
}: {
  shipmentId: string;
  tracking: string;
  reason: ReturnReason;
  coverage: ReasonCoverageState;
  source: ReasonSource | null;
  rawReason: string;
  evidence: string;
  actorEmail: string;
  canEdit: boolean;
}) {
  const [pending, start] = useTransition();
  const [chon, setChon] = useState<ReturnReason | "">(reason === "UNKNOWN" ? "" : reason);
  const [note, setNote] = useState("");
  /* Phản hồi ngay tại chỗ: `router.refresh()` kéo lại cả trang chi tiết và mất vị trí cuộn. */
  const [vuaGhi, setVuaGhi] = useState<ReturnReason | null>(null);
  const hienTai = vuaGhi ?? (reason === "UNKNOWN" ? null : reason);
  const mucDo: ReasonCoverageState = vuaGhi ? "CLASSIFIED" : coverage;

  const ghi = () => {
    if (!chon) return;
    start(async () => {
      const r = await setReturnReason({ shipmentId, reason: chon, note });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setVuaGhi(chon);
      setNote("");
      toast.success(`${tracking}: ${RETURN_REASON_LABEL[chon]}`);
    });
  };

  return (
    <div className="space-y-3">
      <div className={cn("rounded-md border px-3 py-2", MAU[mucDo])}>
        <div className="text-[11px] font-medium uppercase tracking-wide opacity-80">{REASON_COVERAGE_LABEL[mucDo]}</div>
        <div className="mt-0.5 text-sm font-semibold">{hienTai ? RETURN_REASON_LABEL[hienTai] : "Chưa xác định"}</div>
        <div className="mt-1 text-[11px] leading-snug opacity-90">{REASON_COVERAGE_ACTION[mucDo]}</div>
      </div>

      {/*
        CHỮ GỐC ĐỨNG RIÊNG, NGUYÊN VĂN.

        Đây là thứ người xử lý đọc để QUYẾT. Một ca xếp "khách từ chối" mà chữ gốc nói "không hài
        lòng về sản phẩm" là ca đáng hỏi lại — nhưng chỉ thấy được nếu chữ gốc còn nguyên bên cạnh
        nhãn danh mục, chứ không bị nhãn ấy thay thế.
      */}
      {rawReason ? (
        <div className="rounded-md border bg-muted/40 px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Chữ gốc{source ? ` · ${REASON_SOURCE_LABEL[source]}` : ""}
          </div>
          <p className="mt-0.5 text-sm">“{rawReason}”</p>
        </div>
      ) : null}
      {evidence ? <p className="text-xs text-muted-foreground">Căn cứ: {evidence}{actorEmail ? ` · ${actorEmail}` : ""}</p> : null}

      {canEdit ? (
        <div className="space-y-2">
          <Select value={chon} onValueChange={(v) => setChon(v as ReturnReason)}>
            <SelectTrigger className="w-full" aria-label="Chọn lý do hoàn">
              <SelectValue placeholder="Chọn lý do hoàn…" />
            </SelectTrigger>
            <SelectContent className="max-h-[320px]">
              {RETURN_REASON_GROUPS.filter((g) => g !== "UNKNOWN" && REASONS_BY_GROUP[g]?.length).map((g) => (
                <SelectGroup key={g}>
                  <SelectLabel>{RETURN_REASON_GROUP_LABEL[g]}</SelectLabel>
                  {REASONS_BY_GROUP[g].map((r) => (
                    <SelectItem key={r} value={r}>
                      {RETURN_REASON_LABEL[r]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Ghi chú chi tiết (tuỳ) — bối cảnh cho người đọc sau, không vào phép đếm"
            rows={2}
            maxLength={500}
            className="text-sm"
          />
          <Button size="sm" onClick={ghi} disabled={!chon || pending} className="w-full">
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Ghi lý do hoàn
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Bạn không có quyền ghi lý do hoàn cho kiện này.</p>
      )}
    </div>
  );
}
