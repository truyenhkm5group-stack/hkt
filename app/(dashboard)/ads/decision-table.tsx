"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import { successTone } from "@/lib/constants/returns";
import { ADS_ACTION_HINT, ADS_ACTION_LABEL, ADS_ACTION_TONE, ADS_DIMENSION_LABEL } from "@/lib/constants/ads-decision";
import type { AdsDecisionRow } from "@/lib/queries/ads-decision";
import type { AdsDimension } from "@/lib/constants/ads-decision";
import { cn } from "@/lib/utils";

/**
 * ───────────── BẢNG QUYẾT ĐỊNH ─────────────
 *
 * MỘT bảng, không phải mười cái thẻ. Mỗi dòng trả lời đúng một câu: **với dòng này thì nên làm gì,
 * và vì sao**. Các con số phụ (giá vốn, cước, tiền về, CAC, điểm hoà vốn) nằm trong phần mở rộng
 * ngay tại chỗ — bấm vào dòng là thấy, không phải rời trang.
 *
 * Vì sao mở tại chỗ thay vì mở trang mới: người xem đang SO SÁNH các dòng với nhau. Rời trang là
 * mất ngữ cảnh so sánh, và quay lại thì mất cả vị trí cuộn lẫn dòng đang xem.
 */

function Ratio({ value, suffix = "×" }: { value: number | null; suffix?: string }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return <span className="numeric">{`${value.toFixed(2)}${suffix}`}</span>;
}

/**
 * Màu theo KHOẢNG CÁCH TỚI ĐIỂM HOÀ VỐN, không theo một ngưỡng ROAS cố định.
 * Mỗi mã hàng một biên khác nhau: ROAS 2,0 có thể là lãi to ở mã này và lỗ ở mã kia.
 */
function headroomTone(value: number | null) {
  if (value === null) return "text-muted-foreground";
  if (value >= 1.3) return "text-emerald-600 dark:text-emerald-400";
  if (value >= 1) return "text-sky-600 dark:text-sky-400";
  if (value >= 0.8) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

function Detail({ row }: { row: AdsDecisionRow }) {
  const items: { label: string; value: React.ReactNode; hint?: string }[] = [
    { label: "Doanh thu lên đơn", value: formatVND(row.bookedRevenue) },
    { label: "Doanh thu giao thành công", value: formatVND(row.deliveredRevenue) },
    { label: "Tiền đã về (có chứng từ)", value: formatVND(row.cashReceived), hint: "Thực thu theo bảng kê ĐVVC + khách chuyển trước. Chênh với doanh thu giao thành công là tiền ĐVVC còn giữ." },
    { label: "Giá vốn hàng đã giao", value: formatVND(-row.cogs) },
    { label: "Cước (cả đơn hoàn)", value: formatVND(-row.shippingCost), hint: "Đơn hoàn vẫn tốn cước — bỏ ra ngoài sẽ cho điểm hoà vốn đẹp hơn sự thật." },
    { label: "Lợi nhuận góp trước QC", value: formatVND(row.contributionBeforeAds) },
    { label: "Tiền quảng cáo", value: row.spendKnown ? formatVND(-row.spend) : "—" },
    { label: "Lợi nhuận góp SAU QC", value: <strong>{row.spendKnown ? formatVND(row.profitAfterAds) : "—"}</strong> },
  ];
  const ratios: { label: string; value: React.ReactNode }[] = [
    { label: "ROAS lên đơn", value: <Ratio value={row.bookedRoas} /> },
    { label: "ROAS lên đơn HOÀ VỐN", value: <Ratio value={row.breakEvenBookedRoas} /> },
    { label: "ROAS giao TC", value: <Ratio value={row.deliveredRoas} /> },
    { label: "ROAS giao TC HOÀ VỐN", value: <Ratio value={row.breakEvenDeliveredRoas} /> },
    { label: "ROAS tiền về", value: <Ratio value={row.cashRoas} /> },
    { label: "Biên lợi nhuận góp", value: row.marginRate === null ? <span className="text-muted-foreground">—</span> : formatPercent(row.marginRate * 100) },
    { label: "CAC giao thành công", value: row.cacDelivered === null ? <span className="text-muted-foreground">—</span> : formatVND(row.cacDelivered) },
    { label: "Đơn chưa ngã ngũ", value: `${formatNumber(row.openOrders)} đơn` },
  ];

  return (
    <div className="grid gap-4 bg-muted/40 px-5 py-4 text-xs md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <p className="mb-2 font-medium text-foreground">Đường đi của tiền</p>
        <dl className="space-y-1">
          {items.map((it) => (
            <div key={it.label} className="flex items-baseline justify-between gap-3 border-b border-dashed border-border/60 pb-1 last:border-0">
              <dt className="inline-flex items-center gap-1 text-muted-foreground">
                {it.label}
                {it.hint ? <InfoHint>{it.hint}</InfoHint> : null}
              </dt>
              <dd className="numeric whitespace-nowrap">{it.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <p className="mb-2 font-medium text-foreground">Các mức ROAS và điểm hoà vốn</p>
        <dl className="space-y-1">
          {ratios.map((it) => (
            <div key={it.label} className="flex items-baseline justify-between gap-3 border-b border-dashed border-border/60 pb-1 last:border-0">
              <dt className="text-muted-foreground">{it.label}</dt>
              <dd className="whitespace-nowrap">{it.value}</dd>
            </div>
          ))}
        </dl>
        {/* Chỉ so được khi CẢ HAI cùng tồn tại — thiếu một vế thì im lặng, không bịa kết luận. */}
        {row.deliveredRoas !== null && row.breakEvenDeliveredRoas !== null ? (
          <p className="mt-2 text-muted-foreground">
            Đang ở <strong className={headroomTone(row.headroom)}>{row.deliveredRoas.toFixed(2)}×</strong> so với mức hoà vốn{" "}
            <strong>{row.breakEvenDeliveredRoas.toFixed(2)}×</strong>.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AdsDecisionTable({ rows, dimension }: { rows: AdsDecisionRow[]; dimension: AdsDimension }) {
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <>
      <div className="border-b px-5 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Tìm ${ADS_DIMENSION_LABEL[dimension].toLowerCase()}…`}
          className="h-8 w-full max-w-xs rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>
      <div className="overflow-x-auto">
        <Table className="min-w-[1000px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>{ADS_DIMENSION_LABEL[dimension]}</TableHead>
              <TableHead className="text-right">Chi QC</TableHead>
              <TableHead className="text-right">Đơn (giao/lên)</TableHead>
              <TableHead className="text-right whitespace-nowrap">
                <span className="inline-flex items-center gap-1">
                  GTC
                  <InfoHint>Tỷ lệ giao thành công = giao thành công ÷ (giao thành công + hoàn), tính trên ĐƠN ĐÃ KẾT THÚC. Đơn đang đi không nằm ở mẫu số.</InfoHint>
                </span>
              </TableHead>
              <TableHead className="text-right whitespace-nowrap">
                <span className="inline-flex items-center gap-1">
                  LN sau QC
                  <InfoHint>
                    Lợi nhuận góp SAU quảng cáo = doanh thu giao thành công − giá vốn − cước − tiền quảng cáo. Cố ý KHÔNG trừ chi phí cố định, thuế
                    hay lương: những khoản đó không đổi theo việc tăng/giảm ngân sách một chiến dịch, đưa vào chỉ làm nhiễu phép so sánh.
                  </InfoHint>
                </span>
              </TableHead>
              <TableHead className="text-right whitespace-nowrap">
                <span className="inline-flex items-center gap-1">
                  Hoà vốn
                  <InfoHint>ROAS GIAO THÀNH CÔNG cần đạt để hoà vốn = 1 ÷ biên lợi nhuận góp. Mỗi mã hàng một biên khác nhau, nên một ngưỡng ROAS chung cho cả shop là vô nghĩa.</InfoHint>
                </span>
              </TableHead>
              <TableHead className="text-right whitespace-nowrap">
                <span className="inline-flex items-center gap-1">
                  So với hoà vốn
                  <InfoHint>Lợi nhuận góp trước quảng cáo ÷ tiền quảng cáo. 1,00× là hoà vốn đúng bằng; 1,30× là dư 30%; 0,50× là mất một nửa số tiền đã tiêu.</InfoHint>
                </span>
              </TableHead>
              <TableHead className="whitespace-nowrap">Nên làm gì</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => {
              const isOpen = open === row.key;
              return (
                <Fragment key={row.key}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => setOpen(isOpen ? null : row.key)}
                    aria-expanded={isOpen}
                  >
                    <TableCell className="pr-0">
                      <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate font-medium" title={row.name}>
                      {row.name}
                    </TableCell>
                    <TableCell className="numeric text-right whitespace-nowrap">
                      {row.spendKnown ? (
                        formatVND(row.spend)
                      ) : (
                        <span className="text-muted-foreground" title="Facebook không cung cấp chi tiêu ở cấp này">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="numeric text-right">
                      {formatNumber(row.deliveredOrders)}/{formatNumber(row.bookedOrders)}
                    </TableCell>
                    <TableCell className={cn("numeric text-right", successTone(row.successRate))}>
                      {row.successRate === null ? "—" : `${row.successRate}%`}
                    </TableCell>
                    <TableCell className="numeric text-right whitespace-nowrap">
                      {row.spendKnown ? (
                        <span className={row.profitAfterAds >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                          {formatVND(row.profitAfterAds)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Ratio value={row.breakEvenDeliveredRoas} />
                    </TableCell>
                    <TableCell className={cn("text-right font-medium", headroomTone(row.headroom))}>
                      <Ratio value={row.headroom} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <span className={cn("inline-flex items-center gap-1 font-medium", ADS_ACTION_TONE[row.action])}>
                        {ADS_ACTION_LABEL[row.action]}
                        <InfoHint>{ADS_ACTION_HINT[row.action]}</InfoHint>
                      </span>
                      {/* Cờ "giao kém" hiện ĐỘC LẬP với hành động: một dòng vẫn đáng tăng tiền mà
                          vẫn đang mất hàng ở khâu giao, và bỏ sót nó là bỏ sót tiền. */}
                      {row.lowDelivery && row.action !== "FIX_DELIVERY" ? (
                        <span className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-amber-600 dark:text-amber-400" title="Tỷ lệ giao thành công dưới ngưỡng">
                          <TriangleAlert className="size-3" />
                          giao kém
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                  {isOpen ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={9} className="p-0">
                        <p className="border-y bg-muted/60 px-5 py-2 text-xs">
                          <span className="font-medium">Vì sao: </span>
                          {row.reason}
                        </p>
                        <Detail row={row} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
            {!filtered.length ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                  Không có dòng nào khớp.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
