import { listTargets } from "@/lib/queries/metric-targets";
import { evaluateMetric, type CellStatus, type ScorecardCell } from "@/lib/metrics/scorecard";
import { ratioOf } from "@/lib/constants/marketing-daily";
import type { MarketingDailyBase } from "@/lib/queries/marketing-daily";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ ĐÍCH CỦA BÁO CÁO MARKETING — KHÔNG CÓ MỘT NGƯỠNG NÀO TRONG MÃ NGUỒN ═══════════
 *
 * ─── VÌ SAO KHÔNG CÓ "TARGET CPA" TRONG MỘT TỆP CẤU HÌNH RIÊNG ───
 *
 * Yêu cầu ban đầu là một màn hình "Performance Settings" với Target CPA / ROAS / margin theo bốn
 * tầng. Kho mã này ĐÃ CÓ đúng cơ chế ấy, và nó tốt hơn: `metric_targets` giữ đích theo ba tầng
 * (công ty → phòng ban → chức danh), mỗi đích có NGƯỜI ĐẶT, LÝ DO, mốc hiệu lực và số phiên bản.
 * Dựng một bảng đích thứ hai cho riêng marketing sẽ làm đích của một KR và đích của thẻ điểm nói
 * hai con số khác nhau về cùng một chỉ số — đúng vấn đề mà `lib/constants/metric-registry.ts` đã
 * được viết ra để chấm dứt.
 *
 * Nên bốn chỉ số của báo cáo này (`marketing_cpa` · `marketing_roas_delivered` ·
 * `marketing_close_rate` · `marketing_margin`) được khai vào `METRIC_BINDINGS`, và đích đặt ở
 * đúng màn hình đích đang có.
 *
 * ─── CHƯA ĐẶT ĐÍCH THÌ KHÔNG KẾT LUẬN ───
 *
 * Không có bộ ngưỡng mặc định, và không được thêm (AGENTS.md mục 38 & 43). Chưa ai đặt đích thì
 * màn hình hiện THỰC TẾ và im lặng về chuyện đạt hay không — im lặng ở đây là câu trả lời đúng,
 * không phải một chỗ còn thiếu.
 */

/** Khoá chỉ số ↔ khoá ô trong bảng theo ngày. Một bảng, để không nơi nào tự ánh xạ lại. */
export const MARKETING_TARGET_METRICS: { metricKey: string; cellKey: string; label: string }[] = [
  { metricKey: "marketing_cpa", cellKey: "costPerOrder", label: "CPQC / đơn" },
  { metricKey: "marketing_roas_delivered", cellKey: "roasDelivered", label: "ROAS thực" },
  { metricKey: "marketing_close_rate", cellKey: "closeRate", label: "Tỷ lệ chốt" },
  { metricKey: "marketing_margin", cellKey: "margin", label: "Margin" },
];

export type MarketingTargetCell = { cellKey: string; label: string; cell: ScorecardCell; status: CellStatus };

/**
 * Chấm bốn ô của một kỳ theo đích đang hiệu lực.
 *
 * `sample` truyền vào là MẪU SỐ THẬT của từng chỉ số, không phải một con số cho có: `evaluateMetric`
 * dùng nó để từ chối kết luận khi mẫu quá mỏng, và truyền bừa một số lớn là vô hiệu hoá chính lớp
 * bảo vệ ấy.
 *
 * `departmentCode` mặc định `MARKETING` — đích tầng phòng ban đè đích tầng công ty. Đích cho MỘT
 * CÁ NHÂN cố ý KHÔNG dùng ở đây: bảng này đo cả shop hoặc một chiều dữ liệu, không đo một người.
 */
export async function evaluateMarketingTargets(
  totals: MarketingDailyBase,
  period: Period,
  previous?: MarketingDailyBase | null,
): Promise<MarketingTargetCell[]> {
  const targets = await listTargets();
  if (!targets.length) return [];

  const rec = totals as unknown as Record<string, unknown>;
  const prevRec = previous ? (previous as unknown as Record<string, unknown>) : null;
  const endsAt = period.to ?? new Date();
  const out: MarketingTargetCell[] = [];

  for (const m of MARKETING_TARGET_METRICS) {
    const value = ratioOf(m.cellKey, rec);
    const sample = sampleFor(m.cellKey, totals);
    const cell = evaluateMetric({
      metricKey: m.metricKey,
      value,
      sample,
      // MEASURED / WEAK do chính cỡ mẫu quyết định — không tự phong "đáng tin" cho một con số mỏng.
      trust: sample > 0 ? "TRUSTED" : "UNKNOWN",
      previous: prevRec ? ratioOf(m.cellKey, prevRec) : undefined,
      targets,
      subject: { departmentCode: "MARKETING", positionId: null },
      period: { endsAt, kind: "ANY", label: period.label },
    });
    if (!cell) continue;
    out.push({ cellKey: m.cellKey, label: m.label, cell, status: cell.status });
  }
  return out;
}

/**
 * MẪU SỐ THẬT của từng chỉ số.
 *
 * Mỗi tỷ lệ có mẫu số riêng, và dùng nhầm mẫu số là cách âm thầm nhất để một ô mỏng được tô màu:
 * tỷ lệ chốt tính trên TIN NHẮN, margin tính trên ĐƠN GIAO ĐƯỢC, CPA tính trên ĐƠN XÁC NHẬN.
 */
function sampleFor(cellKey: string, t: MarketingDailyBase): number {
  if (cellKey === "closeRate") return t.messages ?? 0;
  if (cellKey === "costPerOrder") return t.orders;
  return t.deliveredOrders;
}
