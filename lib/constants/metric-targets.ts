/**
 * ═══════════ ĐÍCH LÀ QUYẾT ĐỊNH KINH DOANH, KHÔNG PHẢI HẰNG SỐ TRONG MÃ NGUỒN ═══════════
 *
 * Tệp này CỐ Ý không chứa một con số đích nào. Nó chỉ chứa LUẬT CHỌN đích giữa ba tầng và luật
 * chấm đạt/không đạt. Bản thân các con số nằm ở bảng `metric_targets`, do chủ shop đặt, có ghi
 * người đặt và lý do.
 *
 * Vì sao không đặt sẵn vài đích "hợp lý" cho đỡ trống: một đích mặc định do người viết code nghĩ
 * ra sẽ được đọc như một chuẩn của shop. Rồi ai đó bị chấm là không đạt vì một con số không ai
 * trong shop từng đồng ý.
 */
import type { MetricDirection } from "@/lib/constants/metric-catalog";

export type TargetScope = "COMPANY" | "DEPARTMENT" | "POSITION";

export const TARGET_SCOPE_LABEL: Record<TargetScope, string> = {
  COMPANY: "Toàn công ty",
  DEPARTMENT: "Phòng ban",
  POSITION: "Chức danh",
};

/** Tầng hẹp hơn thắng. Không cộng, không trung bình — hai đích chồng nhau thì cái RIÊNG hơn là cái đúng. */
export const TARGET_PRECEDENCE: Record<TargetScope, number> = { COMPANY: 1, DEPARTMENT: 2, POSITION: 3 };

export type TargetRow = {
  metricKey: string;
  scope: TargetScope;
  scopeRef: string | null;
  target: number;
  note: string;
  effectiveFrom: Date;
};

export type ResolvedTarget = { target: number; scope: TargetScope; scopeRef: string | null; note: string; effectiveFrom: Date };

/**
 * CHỌN ĐÍCH CHO MỘT NGƯỜI TRONG MỘT KỲ.
 *
 * `at` là mốc KẾT THÚC KỲ, không phải "bây giờ": đích đặt hôm nay không được chấm lại một quý đã
 * chốt. Đó là luật "không silent correction kỳ đã chốt" (AGENTS.md mục 8) áp cho đích.
 *
 * `null` = CHƯA ĐẶT ĐÍCH. Nơi gọi PHẢI hiện thực tế mà không kết luận đạt/không đạt.
 */
export function resolveTarget(rows: TargetRow[], input: { metricKey: string; departmentCode: string | null; positionId: string | null; at: Date }): ResolvedTarget | null {
  const hopLe = rows.filter((r) => r.metricKey === input.metricKey && r.effectiveFrom.getTime() <= input.at.getTime());
  let best: TargetRow | null = null;
  for (const r of hopLe) {
    if (r.scope === "DEPARTMENT" && r.scopeRef !== input.departmentCode) continue;
    if (r.scope === "POSITION" && r.scopeRef !== input.positionId) continue;
    if (!best) {
      best = r;
      continue;
    }
    const uuTien = TARGET_PRECEDENCE[r.scope] - TARGET_PRECEDENCE[best.scope];
    // Cùng tầng thì bản MỚI NHẤT còn hiệu lực thắng — đích đặt sau là quyết định sau.
    if (uuTien > 0 || (uuTien === 0 && r.effectiveFrom.getTime() > best.effectiveFrom.getTime())) best = r;
  }
  return best ? { target: best.target, scope: best.scope, scopeRef: best.scopeRef, note: best.note, effectiveFrom: best.effectiveFrom } : null;
}

export type TargetVerdict = "MET" | "MISSED" | "NO_TARGET" | "NOT_MEASURED";

export const VERDICT_LABEL: Record<TargetVerdict, string> = {
  MET: "Đạt",
  MISSED: "Chưa đạt",
  NO_TARGET: "Chưa đặt đích",
  NOT_MEASURED: "Chưa đo được",
};

/**
 * CHẤM ĐẠT / KHÔNG ĐẠT — ba lối ra KHÔNG phải "không đạt".
 *
 *   · chưa đo được kỳ này  → `NOT_MEASURED`
 *   · chưa ai đặt đích     → `NO_TARGET`
 *   · chỉ số chỉ để đọc    → `NO_TARGET` (hướng `CONTEXT`: "nhiều lượt đối soát" không có chiều tốt/xấu)
 *
 * Gộp cả ba vào "không đạt" là cách nhanh nhất để một thẻ điểm toàn màu đỏ và không ai đọc nữa.
 */
export function verdict(input: { value: number | null; target: number | null; direction: MetricDirection }): TargetVerdict {
  if (input.value === null) return "NOT_MEASURED";
  if (input.target === null || input.direction === "CONTEXT") return "NO_TARGET";
  return input.direction === "HIGHER_BETTER" ? (input.value >= input.target ? "MET" : "MISSED") : input.value <= input.target ? "MET" : "MISSED";
}

/** Chênh lệch theo ĐƠN VỊ của chính chỉ số, đã tính dấu theo chiều: dương = tốt hơn đích. */
export function delta(input: { value: number | null; target: number | null; direction: MetricDirection }): number | null {
  if (input.value === null || input.target === null || input.direction === "CONTEXT") return null;
  return input.direction === "HIGHER_BETTER" ? input.value - input.target : input.target - input.value;
}
