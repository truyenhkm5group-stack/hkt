import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InfoHint } from "@/components/info-hint";
import { DataWarnings } from "@/components/data-warnings";
import { MARKETING_DIMENSION_NO_SPEND_HINT, MATURITY_LABEL, ratioOf } from "@/lib/constants/marketing-daily";
import { MISSING_TEXT, formatNumber, formatPercent, formatVND } from "@/lib/format";
import type { getMarketingBreakdown } from "@/lib/queries/marketing-daily";
import { cn } from "@/lib/utils";

type Breakdown = Awaited<ReturnType<typeof getMarketingBreakdown>>;

/** Tham số URL để bấm một dòng là LỌC cả trang theo dòng đó — bóc tách lồng nhau không cần màn hình mới. */
const PARAM: Record<Breakdown["dimension"], string> = {
  marketer: "marketer",
  product: "product",
  page: "page",
  campaign: "campaign",
  adset: "adset",
  ad: "ad",
  source: "src",
};

/** Chiều để đi TIẾP sau khi bấm vào một dòng — đúng đường đi tự nhiên: ai → mã gì → chiến dịch nào. */
const NEXT_DIMENSION: Record<Breakdown["dimension"], Breakdown["dimension"]> = {
  marketer: "product",
  product: "campaign",
  page: "product",
  campaign: "adset",
  adset: "ad",
  ad: "product",
  source: "product",
};

export function MarketingBreakdown({ data }: { data: Breakdown }) {
  if (!data.rows.length) return <div className="px-4 py-6 text-sm text-muted-foreground">Chưa có dữ liệu để bóc tách trong kỳ này.</div>;

  return (
    <div className="space-y-2">
      {/* Cảnh báo dữ liệu thu về MỘT nhãn ⚠ — không biến mất (mục 42 / 67), chỉ thôi chiếm chỗ. */}
      {!data.spendGrain || data.spendUnknown.length ? (
        <div className="px-4 pt-3">
          <DataWarnings
            items={[
              !data.spendGrain ? MARKETING_DIMENSION_NO_SPEND_HINT : null,
              data.spendUnknown.length ? (
                <>
                  Chưa khai chiến dịch nào ở bảng chi tiêu cho {data.spendUnknown.length} nhóm ({data.spendUnknown.slice(0, 4).join(" · ")}
                  {data.spendUnknown.length > 4 ? "…" : ""}), nên Chi QC · ROAS · CPQC/đơn · LN góp của họ là <b>CHƯA BIẾT</b> (—), KHÔNG phải 0. Đơn được quy
                  kết bằng ảnh chụp phân công FANPAGE, còn tiền quảng cáo đi bằng ánh xạ CHIẾN DỊCH → marketer — khai ánh xạ ấy ở trang Quảng cáo → Ghép
                  chiến dịch thì cột tiền mới có số.
                </>
              ) : null,
            ]}
          />
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[180px]">Nhóm</TableHead>
              <TableHead className="text-right">Chi QC</TableHead>
              <TableHead className="text-right">Tin nhắn</TableHead>
              <TableHead className="text-right">Đơn</TableHead>
              <TableHead className="text-right">CPQC/đơn</TableHead>
              <TableHead className="text-right">DT thực</TableHead>
              <TableHead className="text-right">Giao TC</TableHead>
              <TableHead className="text-right">
                <span className="inline-flex items-center gap-1">
                  Tỷ lệ giao
                  <InfoHint>Tầng trên: đo · tầng dưới (ƯT): ước tính.</InfoHint>
                </span>
              </TableHead>
              <TableHead className="text-right">ROAS thực</TableHead>
              <TableHead className="text-right">
                <span className="inline-flex items-center gap-1">
                  LN góp
                  <InfoHint>Tầng trên: đo · tầng dưới (ƯT): ước tính.</InfoHint>
                </span>
              </TableHead>
              <TableHead className="text-right">Độ chín</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r) => {
              const rec = r as unknown as Record<string, unknown>;
              const mature = r.maturity === "FINAL" || r.maturity === "PARTIAL";
              const roas = ratioOf("roasDelivered", rec);
              const href = `/ads/daily?${PARAM[data.dimension]}=${encodeURIComponent(r.key)}&dim=${NEXT_DIMENSION[data.dimension]}`;
              return (
                <TableRow key={r.key} className={cn(!mature && "opacity-70")}>
                  <TableCell className="font-medium">
                    <Link href={href} className="hover:underline">
                      {r.label}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.adSpend === null ? MISSING_TEXT : formatVND(r.adSpend)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.messages === null ? MISSING_TEXT : formatNumber(r.messages)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.orders)}</TableCell>
                  <TableCell className="text-right tabular-nums">{(() => { const v = ratioOf("costPerOrder", rec); return v === null ? MISSING_TEXT : formatVND(v); })()}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatVND(r.deliveredRevenue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.deliveredOrders)}</TableCell>
                  {/* HAI TẦNG THAY VÌ HAI CỘT: đo được ở trên, ước tính ở dưới — bảng không phình thêm một cột nào. */}
                  <TableCell className="text-right tabular-nums">
                    <div>{(() => { const v = ratioOf("deliveryRate", rec); return v === null ? MISSING_TEXT : formatPercent(v); })()}</div>
                    <div className="text-[10px] text-muted-foreground">
                      ƯT {(() => { const v = ratioOf("projectedDeliveryRate", rec); return v === null ? MISSING_TEXT : formatPercent(v); })()}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{roas === null ? MISSING_TEXT : Math.round(roas * 100) / 100}</TableCell>
                  {/* Chỉ tô màu dòng ĐÃ NGÃ NGŨ — tô một dòng còn 80% đơn đang đi là khẳng định một điều chưa xảy ra. */}
                  <TableCell className="text-right font-medium tabular-nums">
                    <div className={cn(mature && r.contributionProfit !== null ? (r.contributionProfit < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400") : "")}>
                      {r.contributionProfit === null ? MISSING_TEXT : formatVND(r.contributionProfit)}
                    </div>
                    {/* Ước tính KHÔNG tô màu: phần lớn giá trị của nó là một tỷ lệ chưa xảy ra. */}
                    <div className="text-[10px] font-normal text-muted-foreground">ƯT {r.projectedContributionProfit === null ? MISSING_TEXT : formatVND(r.projectedContributionProfit)}</div>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">{MATURITY_LABEL[r.maturity]}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
