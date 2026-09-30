import Link from "next/link";
import { Package } from "lucide-react";
import { EmptyState } from "@/components/ui-bits";
import { LIVE_BOARD_PARAMS, LIVE_VIEW_PARAM, type LiveProductGroup } from "@/lib/constants/creative-live-board";
import { formatNumber, formatVND } from "@/lib/format";
import { hrefWith, type SearchParams } from "@/lib/search-params";

/**
 * GÓC NHÌN "THEO SẢN PHẨM" của tab ④ — mỗi dòng một mã, cộng các camp ĐANG LỌC của mã ấy (cùng kỳ, cùng bộ lọc với bảng
 * camp). Bấm một mã ⇒ về góc nhìn từng camp, lọc sẵn mã đó. Tỷ số là tỷ số của hai tổng (`groupLiveByProduct`). Không tô
 * màu: đây là số đo, chưa phải kết luận (mục 44).
 */
export function LiveProducts({ groups, raw }: { groups: LiveProductGroup[]; raw: SearchParams }) {
  if (groups.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-5">
        <EmptyState icon={Package} title="Không có camp nào khớp bộ lọc" description="Đổi kỳ hoặc xoá bớt bộ lọc." />
      </div>
    );
  }
  const vaoMa = (id: string) => hrefWith({ ...raw, [LIVE_VIEW_PARAM]: undefined, page: undefined }, LIVE_BOARD_PARAMS.product, id);
  return (
    <div className="overflow-x-auto rounded-xl border bg-card shadow-[var(--shadow-card)]">
      <table className="w-full min-w-[860px] text-[12.5px]">
        <thead className="border-b bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Sản phẩm</th>
            <th className="px-2 py-2 text-right">Camp</th>
            <th className="px-2 py-2 text-right">Chi</th>
            <th className="px-2 py-2 text-right">Tin · chi/tin</th>
            <th className="px-2 py-2 text-right">Đơn · chi/đơn</th>
            <th className="px-2 py-2 text-right">DT lên đơn</th>
            <th className="px-3 py-2 text-right">Hứa hẹn · thắng · tắt sớm</th>
          </tr>
        </thead>
        <tbody className="numeric">
          {groups.map((g) => {
            const s = g.summary;
            return (
              <tr key={g.productId ?? "__none"} className="border-b border-hairline last:border-b-0 hover:bg-row-hover">
                <td className="max-w-[320px] px-3 py-2">
                  {g.productId ? (
                    <Link href={vaoMa(g.productId)} className="block truncate font-semibold hover:text-primary" title={`${g.label} — bấm để xem từng camp của mã này`}>
                      {g.label}
                    </Link>
                  ) : (
                    <span className="italic text-muted-foreground">{g.label}</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right leading-tight">
                  <div className="font-medium">{formatNumber(s.total)}</div>
                  <div className="text-[11px] text-muted-foreground">{formatNumber(s.running)} đang chạy</div>
                </td>
                <td className="px-2 py-2 text-right font-medium">{formatVND(s.spendVnd)}</td>
                <td className="px-2 py-2 text-right leading-tight">
                  <div className="font-medium">{formatNumber(s.messages)}</div>
                  <div className="text-[11px] text-muted-foreground">{formatVND(s.costPerMessage)}</div>
                </td>
                <td className="px-2 py-2 text-right leading-tight">
                  <div className="font-medium">{formatNumber(s.bookedOrders)}</div>
                  <div className="text-[11px] text-muted-foreground">{formatVND(s.costPerOrder)}</div>
                </td>
                <td className="px-2 py-2 text-right">{formatVND(s.bookedRevenueVnd)}</td>
                <td className="px-3 py-2 text-right">
                  {formatNumber(s.promising)} · {formatNumber(s.win)} · {formatNumber(s.killed)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
