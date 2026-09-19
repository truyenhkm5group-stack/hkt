import { AlertTriangle, Clock } from "lucide-react";
import { StatStrip } from "@/components/stat-tile";
import { MARKETING_METRIC_BY_KEY, MATURITY_HINT, MATURITY_LABEL, ratioOf } from "@/lib/constants/marketing-daily";
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

type Tile = { label: string; value: string; note?: string; hint?: string; tone?: "default" | "green" | "rose" | "amber" };

/**
 * ═══════════ HAI KỲ CHƯA CHÍN BẰNG NHAU THÌ KHÔNG SO ĐƯỢC TIỀN ═══════════
 *
 * Mũi tên so với kỳ trước là một phép so sánh HỢP LỆ cho phễu (chi, tin nhắn, đơn): chúng đóng
 * sổ ngay trong ngày. Với LỢI NHUẬN và MARGIN thì không: kỳ này mới 2% đơn ngã ngũ còn kỳ trước
 * đã 85%, nên "lợi nhuận giảm 70%" đang đo ĐỘ TRỄ GIAO HÀNG chứ không đo hiệu quả kinh doanh — và
 * nó hiện ra bằng một mũi tên ĐỎ, đúng thứ làm người đọc đi cắt một chiến dịch đang lãi.
 *
 * Nên nhóm tiền chỉ có mũi tên khi CẢ HAI kỳ đã ngã ngũ. Không đủ điều kiện thì không có mũi tên,
 * và lý do in ngay tại chỗ thay vì để ô trống tự nói.
 */
const PROFIT_KEYS = new Set(["contributionProfit", "netProfit", "margin", "roasDelivered"]);

function changeNote(key: string, now: MarketingDailyBase, prev: MarketingDailyBase | null, matureNow?: boolean, maturePrev?: boolean): { note?: string; tone?: Tile["tone"] } {
  if (!prev) return {};
  if (PROFIT_KEYS.has(key) && !(matureNow && maturePrev)) {
    return { note: "chưa so được với kỳ trước — hai kỳ chưa ngã ngũ như nhau", tone: "default" };
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
    { label: "Chi quảng cáo", value: vnd(t.adSpend), hint: MARKETING_METRIC_BY_KEY.adSpend.nullRule, ...changeNote("adSpend", t, p) },
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
        <span className="text-muted-foreground">— {MATURITY_HINT[t.maturity]}</span>
      </div>

      <StatStrip
        columns={4}
        items={tiles.map((x) => ({ label: x.label, value: x.value, note: x.note, hint: x.hint, tone: x.tone ?? "default" }))}
      />

      {data.warnings.length ? (
        <div className="space-y-1 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          {data.warnings.map((w) => (
            <p key={w} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{w}</span>
            </p>
          ))}
        </div>
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
