"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import { successTone } from "@/lib/constants/returns";
import { ADS_ACTION_HINT, ADS_ACTION_LABEL, ADS_ACTION_TONE, ADS_DECISION_RULE, ADS_DIMENSION_LABEL } from "@/lib/constants/ads-decision";
import type { AdsDecisionRow } from "@/lib/queries/ads-decision";
import type { AdsDimension } from "@/lib/constants/ads-decision";
import type { Stability } from "@/lib/marketing/decision-stability";
import { AdsBudgetAction } from "@/app/(dashboard)/ads/budget-action";
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
  if (value >= ADS_DECISION_RULE.scaleAbove) return "text-emerald-600 dark:text-emerald-400";
  if (value >= 1) return "text-sky-600 dark:text-sky-400";
  if (value >= ADS_DECISION_RULE.cutBelow) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

/**
 * ───────────── CHUỖI THỰC HIỆN THEO MÔ HÌNH BÁN TRƯỚC ─────────────
 *
 * Năm mốc, năm chứng từ khác nhau, KHÔNG mốc nào suy ra từ mốc nào:
 *
 *   chốt đơn (POS) → chưa rời kho → đang trên đường → giao thành công → tiền về
 *
 * Cột "chưa rời kho" cố ý KHÔNG mang tên "đang sản xuất": `production_orders` là phiếu gửi xưởng
 * theo mã hàng × màu × size, không gắn với đơn khách nào, nên ERP không đo được "đơn này đang ở
 * xưởng". Cái đo được là ĐÃ CHỐT MÀ CHƯA RỜI KHO — khoảng ấy gồm cả sản xuất lẫn đóng gói, và tên
 * cột phải nói đúng chừng ấy chứ không nói hơn.
 */
function Chain({ row }: { row: AdsDecisionRow }) {
  const steps: { label: string; orders: number; money: number; tone: string; hint: string }[] = [
    {
      label: "Chốt đơn (POS)",
      orders: row.bookedOrders,
      money: row.bookedRevenue,
      tone: "text-foreground",
      hint: "Doanh số POS — khách đã chốt, CHƯA trừ hoàn và huỷ. Đây là con số marketer nhìn thấy trước nhất, và là con số dễ bị tưởng nhầm là doanh thu nhất.",
    },
    {
      label: "Chưa rời kho",
      orders: row.notShippedOrders,
      money: row.notShippedRevenue,
      tone: "text-amber-600 dark:text-amber-400",
      hint: "Đã chốt nhưng ĐVVC chưa lấy hàng — gồm cả SẢN XUẤT lẫn đóng gói. Mốc đi bằng chứng từ ĐVVC (SHIPMENT_LEFT_WAREHOUSE), không bằng trạng thái Pancake. ERP không đo được riêng khâu xưởng vì phiếu gửi xưởng theo mã hàng chứ không theo đơn.",
    },
    {
      label: "Đang trên đường",
      orders: row.inTransitOrders,
      money: row.inTransitRevenue,
      tone: "text-sky-600 dark:text-sky-400",
      hint: "Đã rời kho, chưa ngã ngũ. Tiền của nhóm này CHƯA nằm trong lợi nhuận — kết quả còn treo.",
    },
    {
      label: "Giao thành công",
      orders: row.deliveredOrders,
      money: row.deliveredRevenue,
      tone: "text-emerald-600 dark:text-emerald-400",
      hint: "Theo ORDER_OUTCOME: chứng từ ĐVVC trước, rồi mới tới tiền thực thu. KHÔNG suy ra từ trạng thái Pancake.",
    },
    {
      label: "Hoàn",
      orders: row.returnedOrders,
      money: 0,
      tone: "text-rose-600 dark:text-rose-400",
      hint: "Gồm cả đơn hoàn theo chứng từ ĐVVC lẫn đơn hoàn theo luật doanh thu thực thu. Đơn hoàn vẫn tốn cước.",
    },
  ];
  return (
    <div>
      <p className="mb-2 font-medium text-foreground">Chuỗi thực hiện — bán trước, thu tiền sau</p>
      <dl className="space-y-1">
        {steps.map((st) => (
          <div key={st.label} className="flex items-baseline justify-between gap-3">
            <dt className="inline-flex items-center gap-1 text-muted-foreground">
              {st.label}
              <InfoHint>{st.hint}</InfoHint>
            </dt>
            <dd className={cn("numeric whitespace-nowrap", st.tone)}>
              {formatNumber(st.orders)} đơn{st.money > 0 ? ` · ${formatVND(st.money)}` : ""}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 border-t pt-1">
          <dt className="inline-flex items-center gap-1 text-muted-foreground">
            Tiền đã về
            <InfoHint>Thực thu có CHỨNG TỪ: bảng kê ĐVVC + khách chuyển trước. Chênh với doanh thu giao thành công là tiền ĐVVC còn đang giữ.</InfoHint>
          </dt>
          <dd className="numeric whitespace-nowrap font-medium">{formatVND(row.cashReceived)}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * ───────────── Ô HAI TẦNG ─────────────
 *
 * Bảng này phải vừa MỘT MÀN HÌNH. Thêm cột thứ mười là đẩy nó qua bề rộng và người đọc phải cuộn
 * ngang để thấy đúng cột quan trọng nhất — nên chỉ số phụ đi xuống tầng dưới của chính ô nó thuộc
 * về, thay vì chiếm một cột riêng.
 */
function Cell({ top, bottom, tone }: { top: React.ReactNode; bottom?: React.ReactNode; tone?: string }) {
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className={cn("numeric whitespace-nowrap", tone)}>{top}</span>
      {bottom !== undefined ? <span className="numeric whitespace-nowrap text-[11px] text-muted-foreground">{bottom}</span> : null}
    </div>
  );
}

const DASH = <span className="text-muted-foreground">—</span>;

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
    { label: "Hiển thị", value: row.impressions === null ? <span className="text-muted-foreground">—</span> : formatNumber(row.impressions) },
    { label: "Click", value: row.clicks === null ? <span className="text-muted-foreground">—</span> : formatNumber(row.clicks) },
    { label: "CPM (1.000 hiển thị)", value: row.cpm === null ? <span className="text-muted-foreground">—</span> : formatVND(row.cpm) },
    { label: "CPC (một click)", value: row.cpc === null ? <span className="text-muted-foreground">—</span> : formatVND(row.cpc) },
    { label: "%CPQC / doanh số POS", value: row.adsPctOverPos === null ? <span className="text-muted-foreground">—</span> : formatPercent(row.adsPctOverPos) },
    { label: "%CPQC / doanh thu giao TC", value: row.adsPctOverDelivered === null ? <span className="text-muted-foreground">—</span> : formatPercent(row.adsPctOverDelivered) },
  ];

  return (
    <div className="grid gap-4 bg-muted/40 px-5 py-4 text-xs md:grid-cols-2 lg:grid-cols-3">
      <Chain row={row} />
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


/**
 * ───────────── ĐỘ BỀN: TẦNG THỨ HAI CỦA Ô "NÊN LÀM GÌ", KHÔNG PHẢI MỘT CỘT MỚI ─────────────
 *
 * Bảng này đã chín cột. Cột thứ mười đẩy nó qua bề rộng màn hình và người đọc phải cuộn ngang để
 * thấy đúng cái cột quan trọng nhất — nên độ bền đi vào ngay dưới khuyến nghị, chỗ nó thuộc về.
 *
 * ─── VÀ NÓ NÓI VỀ MỘT KỲ KHÁC VỚI PHẦN CÒN LẠI CỦA DÒNG ───
 *
 * Mọi con số bên trái tính trên kỳ NGƯỜI DÙNG đang chọn. Độ bền đọc từ sổ, và sổ chỉ tồn tại trên
 * KỲ CHUẨN (14 ngày, kết thúc hôm qua). Hai kỳ khác nhau đứng cạnh nhau thì phải nói ra, nếu không
 * người đọc sẽ tin "giữ 4 ngày" là nói về tháng họ đang xem.
 */
function Stable({ s }: { s: Stability }) {
  if (s.heldDays === 0) return null;
  const mau = s.ready ? "text-emerald-600 dark:text-emerald-400" : s.blocker === "STALE" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
  const chu = s.blocker === "NOT_ACTIONABLE" ? `giữ ${s.heldDays} ngày` : s.ready ? `đã chín · giữ ${s.heldDays} ngày` : `chưa chín · giữ ${s.heldDays} ngày`;
  return (
    <span className={cn("mt-0.5 flex items-center gap-1 text-[11px]", mau)}>
      {chu}
      <InfoHint>
        {`${s.reason} Đọc từ SỔ QUYẾT ĐỊNH, chạy trên kỳ chuẩn 14 ngày kết thúc hôm qua — không phải kỳ đang chọn ở trên. `}
        {s.missingDays > 0 ? `Sổ thiếu ${s.missingDays} ngày trong cửa sổ: ngày thiếu là CHƯA ĐO, không phải "không đổi", nên nó cắt chuỗi. ` : ""}
        {`Đổi khuyến nghị ${s.flips} lần trong cửa sổ nhịp.`}
      </InfoHint>
    </span>
  );
}

export function AdsDecisionTable({ rows, dimension, stability }: { rows: AdsDecisionRow[]; dimension: AdsDimension; stability?: Record<string, Stability> }) {
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
              <TableHead className="text-right whitespace-nowrap">
                <span className="inline-flex items-center gap-1">
                  Chi QC · %CPQC
                  <InfoHint>
                    Tầng dưới là %CPQC trên DOANH SỐ POS (đơn đã chốt, chưa trừ hoàn) — mẫu số marketer nhìn hằng ngày. %CPQC trên doanh thu GIAO THÀNH
                    CÔNG nằm trong phần mở rộng, và nó luôn cao hơn: phần hoàn không mang về đồng nào nhưng tiền quảng cáo đã tiêu rồi.
                  </InfoHint>
                </span>
              </TableHead>
              <TableHead className="text-right whitespace-nowrap">
                <span className="inline-flex items-center gap-1">
                  Tin nhắn · giá/tin
                  <InfoHint>Số tin nhắn Facebook ghi nhận cho dòng này, và chi phí cho một tin. Đây là chỉ số ĐẦU PHỄU — nó hỏng trước khi doanh thu hỏng.</InfoHint>
                </span>
              </TableHead>
              <TableHead className="text-right whitespace-nowrap">
                <span className="inline-flex items-center gap-1">
                  Đơn chốt · giá/đơn
                  <InfoHint>
                    Số đơn khách đã chốt (doanh số POS, CHƯA trừ hoàn) và chi phí quảng cáo cho một đơn chốt. Khác hẳn CAC giao thành công trong phần mở
                    rộng — cái sau chia cho số đơn thật sự tới tay khách, nên luôn đắt hơn.
                  </InfoHint>
                </span>
              </TableHead>
              <TableHead className="text-right whitespace-nowrap">
                <span className="inline-flex items-center gap-1">
                  Chuỗi giao · GTC
                  <InfoHint>
                    Bốn mốc của mô hình bán trước: chưa rời kho (gồm sản xuất và đóng gói) · đang trên đường · giao thành công · hoàn. Mỗi mốc một chứng
                    từ riêng, không mốc nào suy ra từ mốc nào. Tầng dưới là tỷ lệ giao thành công, tính trên ĐƠN ĐÃ KẾT THÚC — đơn đang đi không nằm ở
                    mẫu số. Bấm vào dòng để xem cả tiền của từng mốc.
                  </InfoHint>
                </span>
              </TableHead>
              <TableHead className="text-right whitespace-nowrap">
                <span className="inline-flex items-center gap-1">
                  LN sau QC · biên
                  <InfoHint>
                    Lợi nhuận góp SAU quảng cáo = doanh thu giao thành công − giá vốn − cước − tiền quảng cáo. Cố ý KHÔNG trừ chi phí cố định, thuế
                    hay lương: những khoản đó không đổi theo việc tăng/giảm ngân sách một chiến dịch, đưa vào chỉ làm nhiễu phép so sánh. Tầng dưới là
                    biên lợi nhuận góp trên doanh thu giao thành công.
                  </InfoHint>
                </span>
              </TableHead>
              <TableHead className="text-right whitespace-nowrap">
                <span className="inline-flex items-center gap-1">
                  So hoà vốn · mốc
                  <InfoHint>
                    Lợi nhuận góp trước quảng cáo ÷ tiền quảng cáo. 1,00× là hoà vốn đúng bằng; 1,30× là dư 30%; 0,50× là mất một nửa số tiền đã tiêu.
                    Tầng dưới là ROAS GIAO THÀNH CÔNG cần đạt để hoà vốn = 1 ÷ biên lợi nhuận góp — mỗi mã hàng một biên khác nhau, nên một ngưỡng ROAS
                    chung cho cả shop là vô nghĩa.
                  </InfoHint>
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
                    <TableCell className="text-right">
                      <Cell
                        top={
                          row.spendKnown ? (
                            formatVND(row.spend)
                          ) : (
                            <span className="text-muted-foreground" title="Facebook không cung cấp chi tiêu ở cấp này">
                              —
                            </span>
                          )
                        }
                        bottom={row.adsPctOverPos === null ? "—" : `${formatPercent(row.adsPctOverPos)} POS`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Cell
                        top={row.messages === null ? DASH : formatNumber(row.messages)}
                        bottom={row.costPerMessage === null ? "—" : formatVND(row.costPerMessage)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Cell top={formatNumber(row.bookedOrders)} bottom={row.costPerOrder === null ? "—" : formatVND(row.costPerOrder)} />
                    </TableCell>
                    <TableCell className="text-right">
                      {/*
                        BỐN MỐC TRÊN MỘT DÒNG, và thứ tự là thứ tự đơn hàng đi qua — không phải thứ tự
                        độ lớn. Đọc từ trái sang là đọc đúng đường đi của một đơn.
                      */}
                      <Cell
                        top={
                          <span className="inline-flex items-center gap-1" title="chưa rời kho · đang trên đường · giao thành công · hoàn">
                            <span className="text-amber-600 dark:text-amber-400">{formatNumber(row.notShippedOrders)}</span>
                            <span className="text-muted-foreground/50">›</span>
                            <span className="text-sky-600 dark:text-sky-400">{formatNumber(row.inTransitOrders)}</span>
                            <span className="text-muted-foreground/50">›</span>
                            <span className="text-emerald-600 dark:text-emerald-400">{formatNumber(row.deliveredOrders)}</span>
                            <span className="text-muted-foreground/50">·</span>
                            <span className="text-rose-600 dark:text-rose-400">{formatNumber(row.returnedOrders)}</span>
                          </span>
                        }
                        bottom={<span className={successTone(row.successRate)}>{row.successRate === null ? "—" : `GTC ${row.successRate}%`}</span>}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Cell
                        top={
                          row.spendKnown ? (
                            <span className={row.profitAfterAds >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                              {formatVND(row.profitAfterAds)}
                            </span>
                          ) : (
                            DASH
                          )
                        }
                        bottom={row.marginRate === null ? "—" : `biên ${formatPercent(row.marginRate * 100)}`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Cell
                        top={<span className={cn("font-medium", headroomTone(row.headroom))}><Ratio value={row.headroom} /></span>}
                        bottom={row.breakEvenDeliveredRoas === null ? "—" : `mốc ${row.breakEvenDeliveredRoas.toFixed(2)}×`}
                      />
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
                      {stability?.[row.key] ? <Stable s={stability[row.key]} /> : null}
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
                        {/*
                          BÀN TAY chỉ hiện ở cấp CHIẾN DỊCH và chỉ khi khuyến nghị đã chín.
                          Cấp mã hàng không có thực thể nào trên Facebook để đổi — một nút ở đó sẽ
                          là nút giả, đúng thứ `work-sources.ts` đã cảnh báo.
                        */}
                        {dimension === "campaign" ? (
                          <AdsBudgetAction campaignId={row.key} decision={row.action} ready={Boolean(stability?.[row.key]?.ready)} />
                        ) : null}
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
