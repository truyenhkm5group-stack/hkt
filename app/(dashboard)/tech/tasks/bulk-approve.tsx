"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, X } from "lucide-react";
import { decideTechApprovalBulkAction } from "@/lib/actions/tech";
import { Button } from "@/components/ui/button";
import { KY_LOAT_TOI_DA, xetLoatKy } from "@/lib/constants/tech-approval-bulk";
import type { TechTaskListRow } from "@/lib/queries/tech";

/**
 * ═══════════ KÝ DUYỆT TỪ DANH SÁCH, KHÔNG PHẢI MỞ TỪNG VIỆC ═══════════
 *
 * Chín việc `TECH-4…TECH-12` cùng sinh ra từ MỘT bản kế hoạch mà chủ shop đã đọc và duyệt cả bản,
 * rồi vẫn phải mở chín trang để ký chín chữ ký cho đúng quyết định vừa đưa ra. Một cổng bắt người
 * ta lặp lại chính mình chín lần không làm quyết định kỹ hơn — nó làm người ta bấm cho nhanh.
 *
 * ─── THANH NÀY PHẢI NÓI RÕ ĐANG KÝ CÁI GÌ ───
 *
 * Chỗ nguy hiểm của mọi nút hàng loạt là nó biến một quyết định thành một cử chỉ. Nên trước khi
 * ký, thanh này in ra ĐÚNG những mã việc đang được chọn và có bao nhiêu việc mức R2 trong đó — số
 * R2 là thứ đáng nhìn nhất, vì đó chính là những việc chạm tiền và cần chữ ký. Đếm suông "9 việc"
 * thì người bấm không phân biệt được chín việc sửa chính tả với chín việc chạm công thức doanh thu.
 *
 * Việc KHÔNG cần duyệt vẫn chọn được (người dùng quét cả bảng là chuyện thường) nhưng KHÔNG bị ký:
 * máy chủ bỏ qua và nói ra. Lọc sẵn ở đây rồi im lặng thì người dùng tưởng đã ký hết.
 */
export function BulkApprove({ rows, clear }: { rows: TechTaskListRow[]; clear: () => void }) {
  const [dang, batDau] = useTransition();
  const [bao, setBao] = useState<{ ok: boolean; text: string } | null>(null);
  const [note, setNote] = useState("");
  const router = useRouter();

  const ids = rows.map((r) => r.id);
  /*
    ĐẾM BẰNG ĐÚNG HÀM LUẬT MÁY CHỦ DÙNG, KHÔNG CHÉP LẠI ĐIỀU KIỆN.

    Bản đầu ở đây lọc `approvalStatus === "PENDING"`, trong khi luật thật cho ký `APPROVED` cả việc
    đang `REJECTED` (người có quyền đổi ý). Nút sẽ hiện "Duyệt 3 việc" rồi máy chủ ký 4 — màn hình
    nói một đằng, hành động một nẻo, và người bấm không có cách nào biết. Một luật có hai bản thì
    bản sai là bản người dùng đọc.
  */
  const theoMa = new Map(rows.map((r) => [r.code, r]));
  const canKy = xetLoatKy(rows, "APPROVED").ky.map((c) => theoMa.get(c)!);
  const soR2 = canKy.filter((r) => r.risk === "R2").length;
  const quaTran = ids.length > KY_LOAT_TOI_DA;

  const chay = (decision: "APPROVED" | "REJECTED") =>
    batDau(async () => {
      setBao(null);
      const r = await decideTechApprovalBulkAction({ taskIds: ids, decision, note: note || undefined });
      if ("error" in r) setBao({ ok: false, text: r.error });
      else {
        setBao({ ok: true, text: r.cau });
        /* Chỉ bỏ chọn khi THẬT SỰ có chữ ký nào được ghi — nếu không, người dùng mất luôn lựa chọn
           vừa quét mà chưa biết vì sao chẳng có gì xảy ra. */
        if (r.daKy > 0) clear();
      }
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {canKy.length ? (
          <>
            <b>{canKy.length}</b> việc đang chờ ký
            {soR2 ? (
              <>
                {" "}
                (<b className="text-destructive">{soR2} việc mức R2</b> — chạm tiền)
              </>
            ) : null}
            {canKy.length < rows.length ? ` · ${rows.length - canKy.length} dòng khác không cần ký` : ""}
          </>
        ) : (
          "Không dòng nào đang chờ ký"
        )}
      </span>

      {canKy.length ? (
        <>
          <span className="max-w-[320px] truncate font-mono text-[11px] text-muted-foreground" title={canKy.map((r) => r.code).join(", ")}>
            {canKy.map((r) => r.code).join(", ")}
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Lý do (bắt buộc khi từ chối)"
            className="w-56 rounded-lg border bg-background px-3 py-1.5 text-sm"
          />
          <Button size="sm" disabled={dang || quaTran} onClick={() => chay("APPROVED")}>
            {dang ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            Duyệt {canKy.length} việc
          </Button>
          <Button size="sm" variant="outline" disabled={dang || quaTran} onClick={() => chay("REJECTED")}>
            <X className="size-4" />
            Từ chối
          </Button>
        </>
      ) : null}

      {quaTran ? <span className="text-xs text-destructive">Đã chọn {ids.length} dòng — mỗi lượt tối đa {KY_LOAT_TOI_DA}.</span> : null}
      {bao ? <span className={`text-xs ${bao.ok ? "text-success" : "text-destructive"}`}>{bao.text}</span> : null}
    </div>
  );
}
