import {
  delta,
  directionOf,
  resolveTarget,
  verdict,
  type PeriodKind,
  type ResolvedTarget,
  type TargetRow,
  type TargetVerdict,
} from "@/lib/constants/metric-targets";
import { metricOf, type TargetDirection, type TargetableMetric } from "@/lib/constants/metric-registry";

/**
 * ═══════════ MỘT Ô THẺ ĐIỂM PHẢI TRẢ LỜI CHÍN CÂU, KHÔNG PHẢI MỘT ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * Ba màn hình đang nói về cùng một thứ theo ba cách: `/work/performance` tự gọi `resolveTarget` +
 * `verdict` + `delta` rồi tự quyết màu; trang OKR đọc `okr_key_results.target` — một con số nằm
 * ngoài `metric_targets`, không ai buộc nó bằng đích của thẻ điểm; ô BSC lại có luật riêng.
 *
 * Ba đường tính cho cùng một câu hỏi thì tới ngày chúng nói khác nhau, và cái sai sẽ là cái nói
 * rằng CÓ kết luận.
 *
 * ─── HỢP ĐỒNG ───
 *
 * `evaluateMetric()` là đường DUY NHẤT biến (giá trị đo được + đích + độ tin cậy) thành một ô đọc
 * được. Nó KHÔNG tự đi đo — nơi gọi đưa con số vào. Đó là chủ ý: công thức của từng chỉ số vẫn ở
 * đúng chỗ của nó trong `lib/queries/*`, tệp này không nhân bản một công thức nào.
 *
 * Chín câu mà mỗi ô phải trả lời:
 *
 *   1. chỉ số gì            → `metric.label`
 *   2. hiện tại bao nhiêu   → `value`   (`null` = CHƯA ĐO ĐƯỢC, không phải 0)
 *   3. đích bao nhiêu       → `target`  (`null` = CHƯA AI ĐẶT, không phải 0)
 *   4. đạt bao nhiêu %      → `attainmentPct` (`null` khi thiếu một trong hai, hoặc khi phép chia
 *                             không có nghĩa)
 *   5. lên hay xuống        → `trend`   (`null` = chưa có kỳ trước để so)
 *   6. ai chịu trách nhiệm  → `owner`   (PHÒNG BAN, không bao giờ một cá nhân)
 *   7. kỳ nào               → `periodKind` + `periodLabel`
 *   8. nguồn nào            → `basis`
 *   9. có đáng tin không    → `trust` + `sample`
 *
 * ─── ĐIỀU TỆ NHẤT MỘT THẺ ĐIỂM CÓ THỂ LÀM ───
 *
 * Là in một ô ĐỎ ở chỗ lẽ ra phải in "chưa đủ dữ liệu". Cái đầu nói một con người làm kém; cái sau
 * nói hệ thống chưa đo được. Nên `status` có `UNKNOWN` và `NO_TARGET` tách hẳn khỏi `CRITICAL`, và
 * `canConclude` là cờ một-lần-đọc cho mọi màn hình: sai thì đừng tô màu, đừng xếp hạng, đừng gắn nhãn.
 */

/** Mức đọc được của một ô. `UNKNOWN` / `NO_TARGET` KHÔNG phải "làm kém". */
export type CellStatus = "GOOD" | "WARNING" | "CRITICAL" | "NO_TARGET" | "UNKNOWN";

export const CELL_STATUS_LABEL: Record<CellStatus, string> = {
  GOOD: "Đạt",
  WARNING: "Cần chú ý",
  CRITICAL: "Đang hỏng",
  NO_TARGET: "Chưa đặt mục tiêu",
  UNKNOWN: "Chưa đo được",
};

/** Xu hướng so với kỳ trước, ĐÃ tính theo chiều: `UP` luôn nghĩa là TỐT LÊN. */
export type Trend = "UP" | "DOWN" | "FLAT" | "SOURCE_CHANGED";

export const TREND_LABEL: Record<Trend, string> = {
  UP: "Tốt lên",
  DOWN: "Xấu đi",
  FLAT: "Đi ngang",
  SOURCE_CHANGED: "Đổi nguồn giữa hai kỳ — không so được",
};

export type MetricTrustLevel = "TRUSTED" | "WEAK" | "UNKNOWN" | "UNAVAILABLE";

export type ScorecardInput = {
  metricKey: string;
  /** `null` = CHƯA ĐO ĐƯỢC kỳ này. Tuyệt đối không truyền 0 thay cho nó. */
  value: number | null;
  /** Số quan sát đứng sau con số. 0 ⇒ chưa đo được, dù `value` có là gì. */
  sample: number;
  trust: MetricTrustLevel;
  /** Giá trị kỳ TRƯỚC để tính xu hướng. `undefined` = chưa có kỳ trước. */
  previous?: number | null;
  /** Kỳ trước đọc nguồn khác ⇒ KHÔNG vẽ mũi tên, in "đổi nguồn" (AGENTS.md mục 40). */
  sourceChanged?: boolean;
  targets: TargetRow[];
  subject: { departmentCode: string | null; positionId: string | null; userId?: string | null };
  period: { endsAt: Date; kind: PeriodKind; label: string };
};

export type ScorecardCell = {
  metric: TargetableMetric;
  value: number | null;
  sample: number;
  trust: MetricTrustLevel;
  target: ResolvedTarget | null;
  direction: TargetDirection;
  verdict: TargetVerdict;
  status: CellStatus;
  /** Chênh theo ĐƠN VỊ của chỉ số, dấu đã theo chiều: dương = tốt hơn đích. */
  delta: number | null;
  /** Phần trăm đạt đích. `null` khi thiếu số, thiếu đích, hoặc phép chia không có nghĩa. */
  attainmentPct: number | null;
  trend: Trend | null;
  /** PHÒNG BAN chịu trách nhiệm. Không bao giờ là một cá nhân. */
  owner: string | null;
  periodKind: PeriodKind;
  periodLabel: string;
  basis: string;
  /**
   * Có được phép kết luận về chủ thể này không. `false` ⇒ hiện thực tế, KHÔNG tô màu, KHÔNG xếp
   * hạng, KHÔNG gắn nhãn. Một cờ, đọc một lần, cho mọi màn hình.
   */
  canConclude: boolean;
  /** Vì sao chưa kết luận được — hiện thẳng ra màn hình, không giấu đi. */
  reason: string | null;
};

/**
 * PHẦN TRĂM ĐẠT ĐÍCH — phép chia dễ nói dối nhất trong cả thẻ điểm.
 *
 *   · chiều CÀNG CAO CÀNG TỐT: `value / target`. Đích 0 thì phép chia vô nghĩa ⇒ `null`.
 *   · chiều CÀNG THẤP CÀNG TỐT: `target / value`. "80% của đích 5 lỗi" mà đọc là `value/target`
 *     thì 10 lỗi sẽ ra 200% — trông như vượt đích gấp đôi trong khi đang tệ gấp đôi.
 *   · DẢI: trong dải là 100%, ngoài dải KHÔNG quy ra phần trăm — ra ngoài ở hai đầu là hai vấn đề
 *     khác nhau và một con số duy nhất không nói được cái nào.
 *   · BỐI CẢNH: không có đích nên không có phần trăm.
 */
export function attainment(input: { value: number | null; target: number | null; targetMax?: number | null; direction: TargetDirection }): number | null {
  const { value, target, direction } = input;
  if (value === null || target === null || direction === "CONTEXT") return null;
  if (direction === "RANGE") {
    const tren = input.targetMax;
    if (tren === null || tren === undefined) return null;
    return value >= target && value <= tren ? 100 : null;
  }
  if (direction === "HIGHER_BETTER") return target === 0 ? null : (value / target) * 100;
  if (value === 0) return target === 0 ? 100 : null;
  return (target / value) * 100;
}

/** Xu hướng ĐÃ quy theo chiều: `UP` luôn là tốt lên, kể cả với chỉ số càng-thấp-càng-tốt. */
export function trendOf(input: { value: number | null; previous: number | null | undefined; direction: TargetDirection; sourceChanged?: boolean }): Trend | null {
  if (input.sourceChanged) return "SOURCE_CHANGED";
  const { value, previous } = input;
  if (value === null || previous === null || previous === undefined) return null;
  if (value === previous) return "FLAT";
  // `RANGE` và `CONTEXT` không có chiều "tốt", nên chỉ nói là có đổi — không nói đổi theo hướng tốt.
  if (input.direction === "RANGE" || input.direction === "CONTEXT") return "FLAT";
  const totLen = input.direction === "HIGHER_BETTER" ? value > previous : value < previous;
  return totLen ? "UP" : "DOWN";
}

/**
 * XẾP MỨC MÀU — chỉ khi chủ shop ĐÃ khai ngưỡng.
 *
 * Không có bộ ngưỡng mặc định và không được thêm: một ngưỡng do người viết code nghĩ ra sẽ được
 * đọc như chuẩn của shop, rồi ai đó bị chấm là "đang hỏng" theo một con số không ai từng đồng ý
 * (AGENTS.md mục 38). Chưa khai ngưỡng thì chỉ có hai mức từ chính đích: đạt hoặc chưa đạt.
 */
function statusOf(input: { value: number | null; target: ResolvedTarget | null; direction: TargetDirection; v: TargetVerdict }): CellStatus {
  if (input.v === "NOT_MEASURED") return "UNKNOWN";
  if (input.v === "NO_TARGET" || !input.target || input.value === null) return "NO_TARGET";
  const { criticalAt, warningAt } = input.target;
  const worse = (nguong: number) => (input.direction === "LOWER_BETTER" ? input.value! >= nguong : input.value! <= nguong);
  if (criticalAt !== null && worse(criticalAt)) return "CRITICAL";
  if (warningAt !== null && worse(warningAt)) return "WARNING";
  return input.v === "MET" ? "GOOD" : "WARNING";
}

export function evaluateMetric(input: ScorecardInput): ScorecardCell | null {
  const metric = metricOf(input.metricKey);
  if (!metric) return null;

  const target = resolveTarget(input.targets, {
    metricKey: input.metricKey,
    departmentCode: input.subject.departmentCode,
    positionId: input.subject.positionId,
    userId: input.subject.userId ?? null,
    at: input.period.endsAt,
    periodKind: input.period.kind,
  });

  const direction = directionOf(metric, target);
  // Mẫu bằng 0 nghĩa là KHÔNG CÓ QUAN SÁT NÀO. Một con số dựng trên 0 quan sát không phải một con
  // số — nên nó về `null` ngay tại đây, trước khi bất kỳ phép so sánh nào chạm vào.
  const value = input.sample > 0 ? input.value : null;

  const v = verdict({ value, target: target?.target ?? null, targetMax: target?.targetMax ?? null, direction });
  const status = statusOf({ value, target, direction, v });

  const reason =
    metric.targetable === false
      ? (metric.missingWhat ?? "Chỉ số chưa có nguồn đo")
      : input.trust === "UNAVAILABLE"
        ? "Chưa có nguồn đo cho chỉ số này"
        : value === null
          ? "Kỳ này không có quan sát nào — chưa đo được, KHÔNG phải bằng 0"
          : input.trust === "WEAK"
            ? "Mẫu dưới ngưỡng hoặc nối người bằng ô chữ — đọc làm bối cảnh, không kết luận về một con người"
            : target === null
              ? "Chưa ai đặt mục tiêu cho chỉ số này ở phạm vi đang xem"
              : null;

  return {
    metric,
    value,
    sample: input.sample,
    trust: input.trust,
    target,
    direction,
    verdict: v,
    status,
    delta: delta({ value, target: target?.target ?? null, targetMax: target?.targetMax ?? null, direction }),
    attainmentPct: attainment({ value, target: target?.target ?? null, targetMax: target?.targetMax ?? null, direction }),
    trend: trendOf({ value, previous: input.previous, direction, sourceChanged: input.sourceChanged }),
    // Đích khai phòng chịu trách nhiệm thì lấy; không thì lấy phòng của chính chỉ số. Không bao
    // giờ rơi về một cá nhân.
    owner: target?.ownerDepartment ?? metric.department,
    periodKind: input.period.kind,
    periodLabel: input.period.label,
    basis: metric.basis,
    // Chỉ kết luận khi: đo được, đủ tin, và có đích để so. Thiếu một trong ba thì màn hình hiện
    // thực tế và im lặng về chuyện đạt hay không.
    canConclude: value !== null && input.trust === "TRUSTED" && target !== null && direction !== "CONTEXT",
    reason,
  };
}
