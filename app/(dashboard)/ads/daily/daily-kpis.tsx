import { deliveryRateCoverageParts } from "@/lib/constants/delivery-rate";
import { Clock } from "lucide-react";
import { StatStrip } from "@/components/stat-tile";
import { InfoHint } from "@/components/info-hint";
import { DataWarnings } from "@/components/data-warnings";
import { MARKETING_AD_GRAIN_SPEND_HINT, MARKETING_METRIC_BY_KEY, MATURITY_HINT, MATURITY_LABEL, ratioOf } from "@/lib/constants/marketing-daily";
import { MISSING_TEXT, formatNumber, formatPercent, formatVND } from "@/lib/format";
import type { MarketingDaily, MarketingDailyBase } from "@/lib/queries/marketing-daily";

/**
 * ───────────── THẺ KPI ─────────────
 *
 * Mỗi thẻ mang một mũi tên SO VỚI KỲ TRƯỚC, và mũi tên ấy tính theo CHIỀU của chỉ số: CPQC/đơn
 * giảm là mũi tên XANH, không phải đỏ. Ghi cứng "tăng = tốt" sẽ làm mọi chỉ số càng-thấp-càng-tốt
 * (chi phí một đơn, tỷ lệ hoàn) hiện ngược — cùng lỗi mà AGENTS.md mục 23 đã ghi lại.
 *
 * Chưa có kỳ trước, hoặc kỳ trước bằng 0, thì KHÔNG có mũi tên. Không bịa một mốc so sánh.
 */

type Tile = { label: string; value: string; note?: string; hint?: string; compareHint?: string; tone?: "default" | "green" | "rose" | "amber" };

/**
 * ═══════════ HAI KỲ CHƯA CHÍN BẰNG NHAU THÌ KHÔNG SO ĐƯỢC TIỀN ═══════════
 *
 * Mũi tên so với kỳ trước là một phép so sánh HỢP LỆ cho phễu (chi, tin nhắn, đơn): chúng đóng
 * sổ ngay trong ngày. Với LỢI NHUẬN và MARGIN thì không: kỳ này mới 2% đơn ngã ngũ còn kỳ trước
 * đã 85%, nên "lợi nhuận giảm 70%" đang đo ĐỘ TRỄ GIAO HÀNG chứ không đo hiệu quả kinh doanh — và
 * nó hiện ra bằng một mũi tên ĐỎ, đúng thứ làm người đọc đi cắt một chiến dịch đang lãi.
 *
 * Nên nhóm tiền chỉ có mũi tên khi CẢ HAI kỳ đã ngã ngũ. Không đủ điều kiện thì không có mũi tên,
 * và TRẠNG THÁI in ngay tại chỗ thay vì để ô trống tự nói; câu lý do nằm trong ⓘ của thẻ.
 */
const PROFIT_KEYS = new Set(["contributionProfit", "netProfit", "margin", "roasDelivered"]);

function changeNote(key: string, now: MarketingDailyBase, prev: MarketingDailyBase | null, matureNow?: boolean, maturePrev?: boolean): { note?: string; compareHint?: string; tone?: Tile["tone"] } {
  if (!prev) return {};
  if (PROFIT_KEYS.has(key) && !(matureNow && maturePrev)) {
    return { note: "chưa so được với kỳ trước", compareHint: "Chưa so được với kỳ trước — hai kỳ chưa ngã ngũ như nhau.", tone: "default" };
  }
  const spec = MARKETING_METRIC_BY_KEY[key];
  const read = (b: MarketingDailyBase) => (spec?.num && spec.den ? ratioOf(key, b as unknown as Record<string, unknown>) : ((b as unknown as Record<string, number | null>)[key] ?? null));
  const a = read(now);
  const b = read(prev);
  if (a === null || b === null || b === 0) return {};
  const pct = ((a - b) / Math.abs(b)) * 100;
  if (!Number.isFinite(pct)) return {};
  const better = spec?.direction === "DOWN" ? pct < 0 : pct > 0;
  const tone: Tile["tone"] = spec?.direction === "CONTEXT" ? "default" : better ? "green" : "rose";
  return { note: `${pct >= 0 ? "↑" : "↓"} ${Math.abs(Math.round(pct * 10) / 10)}% so với kỳ trước`, tone };
}

export function MarketingKpis({ data }: { data: MarketingDaily }) {
  const t = data.totals;
  const p = data.previousTotals;
  /*
    "ĐÃ GHI NHẬN" ≠ "KẾT QUẢ CUỐI", và nhãn phải đứng NGAY TRÊN con số.

    Dải độ chín ở đầu trang đã nói điều này, nhưng một người lướt xuống thẻ "Lợi nhuận góp" và đọc
    một số âm sẽ kết luận xong trước khi ngước lên. Nhãn ở đây không thêm thông tin mới — nó đặt
    thông tin cũ vào đúng chỗ người ta ra quyết định.
  */
  const chin = t.maturity === "FINAL";
  const chinPrev = p?.maturity === "FINAL";
  const nhanTien = chin ? "kết quả cuối" : `đang ghi nhận · còn ${formatNumber(t.pendingOrders)} đơn đang đi`;
  const vnd = (v: number | null) => (v === null ? MISSING_TEXT : formatVND(v));
  const cnt = (v: number | null) => (v === null ? MISSING_TEXT : formatNumber(v));
  const pct = (v: number | null) => (v === null ? MISSING_TEXT : formatPercent(v));

  const tiles: Tile[] = [
    data.spendCoverage
      ? {
          /*
            CHIỀU NHÓM / MẨU: ĐỘ PHỦ ĐỨNG NGAY TRONG THẺ CHI.
            Có ngày chưa tách được xuống mẩu thì tổng là `—`, và phần đã biết in ở dòng ghi chú — một
            tổng cộng thiếu mà in như tổng kỳ là báo chi nhỏ hơn thật, lợi nhuận lớn hơn thật.
          */
          label: "Chi quảng cáo",
          value: vnd(t.adSpend),
          note:
            data.spendCoverage.unsplitDays > 0
              ? `đã biết ${formatVND(data.spendCoverage.knownSpend)} · ${formatNumber(data.spendCoverage.knownDays)} ngày hạt mẩu · ${formatNumber(data.spendCoverage.unsplitDays)} ngày chưa tách`
              : `${formatNumber(data.spendCoverage.knownDays)} ngày hạt mẩu · đủ cả kỳ`,
          hint: MARKETING_AD_GRAIN_SPEND_HINT,
          tone: data.spendCoverage.unsplitDays > 0 ? "amber" : "default",
        }
      : { label: "Chi quảng cáo", value: vnd(t.adSpend), hint: MARKETING_METRIC_BY_KEY.adSpend.nullRule, ...changeNote("adSpend", t, p) },
    { label: "Đơn xác nhận", value: cnt(t.orders), ...changeNote("orders", t, p) },
    { label: "Sản phẩm", value: cnt(t.units), ...changeNote("units", t, p) },
    { label: "Doanh số POS", value: vnd(t.posRevenue), ...changeNote("posRevenue", t, p) },
    { label: "Doanh thu thực", value: vnd(t.deliveredRevenue), hint: "Giá trị đơn ĐÃ tới tay khách — con số bộ máy lợi nhuận dùng.", ...changeNote("deliveredRevenue", t, p) },
    { label: "Giao thành công", value: cnt(t.deliveredOrders), ...changeNote("deliveredOrders", t, p) },
    { label: "Tỷ lệ giao", value: pct(ratioOf("deliveryRate", t as unknown as Record<string, unknown>)), hint: MARKETING_METRIC_BY_KEY.deliveryRate.nullRule, ...changeNote("deliveryRate", t, p) },
    { label: "Giá vốn", value: vnd(t.cogs), ...changeNote("cogs", t, p) },
    { label: "CPQC / đơn", value: vnd(ratioOf("costPerOrder", t as unknown as Record<string, unknown>)), ...changeNote("costPerOrder", t, p) },
    { label: `ROAS thực — ${nhanTien}`, value: (() => { const v = ratioOf("roasDelivered", t as unknown as Record<string, unknown>); return v === null ? MISSING_TEXT : String(Math.round(v * 100) / 100); })(), ...changeNote("roasDelivered", t, p, chin, chinPrev) },
    {
      label: `Lợi nhuận góp — ${nhanTien}`,
      value: vnd(t.contributionProfit),
      hint: "Doanh thu thực − giá vốn − cước/phí − chi quảng cáo. Lọc được theo mọi chiều.",
      ...changeNote("contributionProfit", t, p, chin, chinPrev),
    },
    /*
      THẺ ƯỚC TÍNH KHÔNG CÓ MŨI TÊN VÀ KHÔNG CÓ MÀU.

      Mũi tên so kỳ trước trên một con số ước tính là so hai lần đoán với nhau: mỗi kỳ có một tỷ lệ
      chín khác nhau nên phần dự phóng chiếm tỷ trọng khác nhau, và chênh lệch đọc ra sẽ nói về độ
      trễ giao hàng chứ không nói về kinh doanh. Tô màu thì làm nó trông như thẻ đã đo bên cạnh.
    */
    {
      label: "Doanh thu thực ước tính",
      value: vnd(t.projectedDeliveredRevenue),
      hint: `${MARKETING_METRIC_BY_KEY.projectedDeliveredRevenue.meaning} Gồm phần đơn đang đi đã cân theo tỷ lệ.`,
    },
    {
      label: "Lợi nhuận góp ước tính",
      value: vnd(t.projectedContributionProfit),
      note: "suy đoán — không phải kết quả",
      hint: MARKETING_METRIC_BY_KEY.projectedContributionProfit.nullRule,
    },
    { label: `Margin — ${nhanTien}`, value: pct(ratioOf("margin", t as unknown as Record<string, unknown>)), ...changeNote("margin", t, p, chin, chinPrev) },
  ];

  return (
    <div className="space-y-3">
      {/*
        ĐỘ CHÍN ĐỨNG TRƯỚC MỌI THẺ TIỀN.
        Đặt nó xuống dưới là để người đọc kết luận trước khi biết rằng kết quả chưa ngã ngũ.
      */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
        <Clock className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{MATURITY_LABEL[t.maturity]}</span>
        <span className="text-muted-foreground">
          {formatNumber(t.finishedOrders)}/{formatNumber(t.maturityBase)} đơn đã ngã ngũ ({pct(ratioOf("maturity", t as unknown as Record<string, unknown>))}) · còn {formatNumber(t.pendingOrders)} đơn đang đi
        </span>
        <InfoHint>{MATURITY_HINT[t.maturity]}</InfoHint>
        {/* Cảnh báo dữ liệu thu về MỘT nhãn ⚠ ngay trên các thẻ tiền — không biến mất, chỉ thôi chiếm chỗ. */}
        <DataWarnings items={data.warnings} className="ml-auto" align="end" />
      </div>

      <StatStrip
        columns={4}
        items={tiles.map((x) => ({
          label: x.label,
          value: x.value,
          note: x.note,
          hint: x.hint && x.compareHint ? `${x.hint} ${x.compareHint}` : (x.hint ?? x.compareHint),
          tone: x.tone ?? "default",
        }))}
      />

      {/*
        CĂN CỨ CỦA CÁC Ô ƯỚC TÍNH ĐỨNG NGAY DƯỚI CHÚNG.

        Một con số ước tính không đi kèm ĐỘ PHỦ thì đọc y hệt một con số đo được. Dòng này trả lời
        "bao nhiêu mã đang dùng số đo thật, bao nhiêu mã đang dùng tỷ lệ khai ở Giả định".
      */}
      {/* Độ phủ là SỐ nên vẫn in (AGENTS.md mục 68); câu giải thích thang bậc vào ⓘ. */}
      {data.rateBasis ? (
        <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          <span className="text-amber-600 dark:text-amber-400">ƯT</span> độ phủ: {deliveryRateCoverageParts(data.rateBasis.coverage).total} mã —{" "}
          {deliveryRateCoverageParts(data.rateBasis.coverage)
            .parts.map((x) => `${x.count} ${x.label.toLowerCase()}`)
            .join(" · ")}
          <InfoHint>
            Ô có nhãn ƯT dùng thang bậc tỷ lệ giao thành công: ghi đè tay → số đo từng đơn của chính mã → lịch sử 90 ngày của mã → tỷ lệ khai ở Giả định (
            {formatPercent(data.rateBasis.fallbackDeliveryRate)}). Độ phủ trong kỳ: {deliveryRateCoverageParts(data.rateBasis.coverage).total} mã —{" "}
            {deliveryRateCoverageParts(data.rateBasis.coverage)
              .parts.map((x) => `${x.count} ${x.label.toLowerCase()}`)
              .join(" · ")}
            .
          </InfoHint>
        </p>
      ) : null}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {data.freshness.map((f) => (
          <span key={f.job} className={f.stale ? "text-amber-600 dark:text-amber-400" : undefined}>
            {f.label}: {f.lastOkAt ? `${f.minutesAgo} phút trước` : "chưa có lượt đồng bộ nào"}
          </span>
        ))}
      </div>
    </div>
  );
}
