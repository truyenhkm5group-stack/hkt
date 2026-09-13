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
import { TARGET_PRECEDENCE, type TargetDirection, type TargetScope } from "@/lib/constants/metric-registry";

export { TARGET_PRECEDENCE, TARGET_SCOPE_LABEL, TARGET_SCOPES, type TargetDirection, type TargetScope } from "@/lib/constants/metric-registry";

/**
 * Hình dạng kỳ mà một đích áp vào. `ANY` = chưa khai, áp cho mọi kỳ — KHÔNG phải "mỗi tháng".
 * Một đích "500 đơn" không nói lên điều gì nếu thiếu vế "một tuần" hay "một tháng", nhưng đoán hộ
 * một kỳ cho người dùng thì tệ hơn là để trống và nói rõ là đang để trống.
 */
export const PERIOD_KINDS = ["ANY", "WEEK", "MONTH", "QUARTER", "YEAR"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export const PERIOD_KIND_LABEL: Record<PeriodKind, string> = {
  ANY: "Mọi kỳ (chưa khai)",
  WEEK: "Mỗi tuần",
  MONTH: "Mỗi tháng",
  QUARTER: "Mỗi quý",
  YEAR: "Mỗi năm",
};

export type TargetRow = {
  metricKey: string;
  scope: TargetScope;
  scopeRef: string | null;
  target: number;
  /** Cận trên của đích dạng DẢI. Có giá trị ⇒ chiều là `RANGE`. */
  targetMax: number | null;
  warningAt: number | null;
  criticalAt: number | null;
  periodKind: PeriodKind;
  note: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  version: number;
  ownerDepartment: string | null;
};

export type ResolvedTarget = Omit<TargetRow, "metricKey">;

/**
 * CHỌN ĐÍCH CHO MỘT CHỦ THỂ TRONG MỘT KỲ.
 *
 * `at` là mốc KẾT THÚC KỲ, không phải "bây giờ": đích đặt hôm nay không được chấm lại một quý đã
 * chốt. Đó là luật "không silent correction kỳ đã chốt" (AGENTS.md mục 8) áp cho đích.
 *
 * `periodKind` là hình dạng kỳ đang xem. Đích khai `ANY` áp cho mọi kỳ; đích khai một hình dạng
 * cụ thể CHỈ áp cho đúng hình dạng đó — một đích "500 đơn mỗi tháng" đem chấm một tuần là chấm
 * sai gấp bốn lần, và nó sẽ trông hoàn toàn bình thường trên màn hình.
 *
 * `null` = CHƯA ĐẶT ĐÍCH. Nơi gọi PHẢI hiện thực tế mà không kết luận đạt/không đạt.
 */
export function resolveTarget(
  rows: TargetRow[],
  input: { metricKey: string; departmentCode: string | null; positionId: string | null; userId?: string | null; at: Date; periodKind?: PeriodKind },
): ResolvedTarget | null {
  const kyDangXem = input.periodKind ?? "ANY";
  const hopLe = rows.filter(
    (r) =>
      r.metricKey === input.metricKey &&
      r.effectiveFrom.getTime() <= input.at.getTime() &&
      // Hết hiệu lực TRƯỚC khi kỳ kết thúc thì đích này không nói gì về kỳ đó.
      (r.effectiveTo === null || r.effectiveTo.getTime() >= input.at.getTime()) &&
      (r.periodKind === "ANY" || kyDangXem === "ANY" || r.periodKind === kyDangXem),
  );

  let best: TargetRow | null = null;
  for (const r of hopLe) {
    if (r.scope === "DEPARTMENT" && r.scopeRef !== input.departmentCode) continue;
    if (r.scope === "POSITION" && r.scopeRef !== input.positionId) continue;
    if (r.scope === "USER" && r.scopeRef !== (input.userId ?? null)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const uuTien = TARGET_PRECEDENCE[r.scope] - TARGET_PRECEDENCE[best.scope];
    // Cùng tầng thì bản MỚI NHẤT còn hiệu lực thắng — đích đặt sau là quyết định sau.
    if (uuTien > 0 || (uuTien === 0 && r.effectiveFrom.getTime() > best.effectiveFrom.getTime())) best = r;
  }
  if (!best) return null;
  return {
    scope: best.scope,
    scopeRef: best.scopeRef,
    target: best.target,
    targetMax: best.targetMax,
    warningAt: best.warningAt,
    criticalAt: best.criticalAt,
    periodKind: best.periodKind,
    note: best.note,
    effectiveFrom: best.effectiveFrom,
    effectiveTo: best.effectiveTo,
    version: best.version,
    ownerDepartment: best.ownerDepartment,
  };
}

export type TargetVerdict = "MET" | "MISSED" | "NO_TARGET" | "NOT_MEASURED";

export const VERDICT_LABEL: Record<TargetVerdict, string> = {
  MET: "Đạt",
  MISSED: "Chưa đạt",
  NO_TARGET: "Chưa đặt đích",
  NOT_MEASURED: "Chưa đo được",
};

/** Chiều thực tế của một đích: có cận trên ⇒ là một DẢI, dù sổ khai chỉ số theo một chiều. */
export function directionOf(spec: { direction: TargetDirection }, target: { targetMax: number | null } | null): TargetDirection {
  if (target?.targetMax !== null && target?.targetMax !== undefined) return "RANGE";
  return spec.direction;
}

/**
 * CHẤM ĐẠT / KHÔNG ĐẠT — ba lối ra KHÔNG phải "không đạt".
 *
 *   · chưa đo được kỳ này  → `NOT_MEASURED`
 *   · chưa ai đặt đích     → `NO_TARGET`
 *   · chỉ số chỉ để đọc    → `NO_TARGET` (hướng `CONTEXT`: "nhiều lượt đối soát" không có chiều tốt/xấu)
 *
 * Gộp cả ba vào "không đạt" là cách nhanh nhất để một thẻ điểm toàn màu đỏ và không ai đọc nữa.
 */
export function verdict(input: { value: number | null; target: number | null; targetMax?: number | null; direction: TargetDirection }): TargetVerdict {
  if (input.value === null) return "NOT_MEASURED";
  if (input.target === null || input.direction === "CONTEXT") return "NO_TARGET";
  // DẢI: đạt khi nằm TRONG dải. Ra ngoài ở đầu nào cũng là chưa đạt — tồn quá ít và tồn quá nhiều
  // đều là hỏng, chỉ hỏng theo hai kiểu khác nhau.
  if (input.direction === "RANGE") {
    const tren = input.targetMax;
    if (tren === null || tren === undefined) return "NO_TARGET";
    return input.value >= input.target && input.value <= tren ? "MET" : "MISSED";
  }
  return input.direction === "HIGHER_BETTER" ? (input.value >= input.target ? "MET" : "MISSED") : input.value <= input.target ? "MET" : "MISSED";
}

/** Chênh lệch theo ĐƠN VỊ của chính chỉ số, đã tính dấu theo chiều: dương = tốt hơn đích. */
export function delta(input: { value: number | null; target: number | null; targetMax?: number | null; direction: TargetDirection }): number | null {
  if (input.value === null || input.target === null || input.direction === "CONTEXT") return null;
  if (input.direction === "RANGE") {
    const tren = input.targetMax;
    if (tren === null || tren === undefined) return null;
    // Trong dải ⇒ 0 (đang ở đúng chỗ). Ngoài dải ⇒ khoảng cách tới cạnh gần nhất, mang dấu âm.
    if (input.value < input.target) return input.value - input.target;
    if (input.value > tren) return tren - input.value;
    return 0;
  }
  return input.direction === "HIGHER_BETTER" ? input.value - input.target : input.target - input.value;
}
