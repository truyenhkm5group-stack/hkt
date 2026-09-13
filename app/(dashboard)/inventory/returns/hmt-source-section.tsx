import Link from "next/link";
import { FileSpreadsheet } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { HMT_MATCH, HMT_SHEETS } from "@/lib/constants/hmt-returns";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { HmtRunSummary } from "@/lib/returns/hmt-provenance";
import { cn } from "@/lib/utils";

/**
 * ═══════════ KIỆN NÀY ĐẾN TỪ ĐÂU — SỔ GIẤY LÀ MỘT NGUỒN, KHÔNG PHẢI MỘT BÍ MẬT ═══════════
 *
 * Bàn nhận hàng hoàn có bốn nguồn nói về cùng một kiện: chứng từ Viettel Post · vòng đời trong ERP
 * · **sổ hàng hoàn viết tay của kho** · thao tác tay của người. Ba nguồn đầu đã có chỗ trên màn
 * hình. Nguồn thứ ba thì chưa — nên một kiện được ghi nhận từ sổ giấy trông y hệt một kiện người
 * kho tự bấm, và sáu tháng sau không ai truy được nó đến từ đâu.
 *
 * Khối này hiện lượt đối soát gần nhất và, quan trọng hơn, **phần KHÔNG khớp**: đó mới là chỗ hai
 * sổ nói khác nhau, và là việc còn phải làm.
 *
 * Chưa chạy lượt nào ⇒ khối KHÔNG hiện. Một khối rỗng in toàn số 0 dạy người dùng bỏ qua nó.
 */
export function HmtSourceSection({ run }: { run: HmtRunSummary | null }) {
  if (!run) return null;
  const ghi = run.byStatus.filter((r) => r.writes);
  const giuNguyen = run.byStatus.filter((r) => !r.writes);
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-1.5">
          <FileSpreadsheet className="size-4" /> Đối soát sổ hàng hoàn viết tay
        </span>
      }
      description={`${run.workbook} · lượt gần nhất ${run.lastRunAt ? formatDateTime(run.lastRunAt) : "—"} · ${formatNumber(run.totalRows)} dòng nguồn`}
      hint={`Đây là một lượt đối soát MỘT LẦN, không phải một đường đồng bộ định kỳ. Nó chỉ ghi nhận kiện ĐÃ VỀ KHO — tồn kho không đổi một món nào cho tới khi người kho đếm thật. Ba sheet nguồn: ${HMT_SHEETS.TRACKING_INDEX.name} (chỉ đối chiếu độ phủ) · ${HMT_SHEETS.FULL_RETURN_ITEMS.name} · ${HMT_SHEETS.PARTIAL_RETURN_ITEMS.name}.`}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">
            Đã ghi nhận · {formatNumber(run.shipmentsReceived)} kiện vào hàng đợi đếm
          </div>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {ghi.length ? (
              ghi.map((r) => (
                <li key={r.status}>
                  <b className="numeric text-foreground">{formatNumber(r.count)}</b> · {r.label}
                </li>
              ))
            ) : (
              <li>Không dòng nào khớp đủ hai định danh.</li>
            )}
          </ul>
          <p className="mt-1 text-[11px] text-muted-foreground">Tồn kho CHƯA đổi: kiện chỉ chuyển sang “đã về, chờ đếm”.</p>
        </div>
        <div>
          <div className="text-xs font-semibold text-amber-800 dark:text-amber-300">Giữ nguyên · {formatNumber(run.untouchedRows)} dòng</div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {giuNguyen.length ? (
              giuNguyen.map((r) => (
                <li key={r.status} title={HMT_MATCH[r.status].hint}>
                  <b className="numeric">{formatNumber(r.count)}</b> · <span className={cn("text-muted-foreground")}>{r.label}</span>
                </li>
              ))
            ) : (
              <li className="text-muted-foreground">Mọi dòng đều khớp.</li>
            )}
          </ul>
          <Link href="/data-quality" className="mt-1 inline-block text-[11px] text-primary hover:underline">
            Xem việc phải làm cho từng nhóm →
          </Link>
        </div>
      </div>
    </SectionCard>
  );
}
