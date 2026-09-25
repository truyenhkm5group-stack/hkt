/**
 * ───────────── NGƯỠNG HÀNG BÁN CHẬM / VỐN NẰM CHẾT ─────────────
 *
 * Một chỗ duy nhất. Đây là ngưỡng PHÂN TÍCH, không phải ngưỡng nghiệp vụ về tiền hay kết quả đơn:
 * nó không đổi con số nào trong báo cáo, chỉ quyết định mẫu mã nào được gọi tên ra.
 */
export const SLOW_MOVING_RULES = {
  /** Không bán được cái nào trong ngần này ngày ⇒ hàng chết. */
  deadDays: 60,
  /** Tồn đủ bán quá ngần này ngày ⇒ vốn nằm chết. */
  excessCoverDays: 120,
  /** Tồn đủ bán quá ngần này ngày ⇒ bán chậm. */
  slowCoverDays: 60,
  /**
   * Mức tồn coi là lành mạnh, dùng làm mốc tính PHẦN VỐN VƯỢT MỨC.
   * Giữ hàng đủ bán 45 ngày là bình thường; phần nhiều hơn thế là tiền đáng lẽ không phải nằm đây.
   */
  healthyCoverDays: 45,
} as const;

/** Bộ ngưỡng đang có hiệu lực — cùng hình với `SLOW_MOVING_RULES`, nhưng là số (không phải hằng literal). */
export type SlowMovingRules = { -readonly [K in keyof typeof SLOW_MOVING_RULES]: number };
export type SlowMovingRuleKey = keyof SlowMovingRules;

/** Khoá `settings` giữ GHI ĐÈ của chủ shop. Chỉ ô ĐÃ SỬA mới nằm trong đó (luật 22 · 54). */
export const SLOW_MOVING_KEY = "inventory.slowMoving";

/**
 * MẶC ĐỊNH LẤY LẠI TỪ HẰNG SỐ ĐANG CHẠY — không gõ lại con số nào (AGENTS.md luật 22). Gõ lại là mở
 * đường cho hai nơi nói hai số khác nhau.
 */
export const DEFAULT_SLOW_MOVING_RULES: SlowMovingRules = { ...SLOW_MOVING_RULES };
export const SLOW_MOVING_RULE_KEYS = Object.keys(SLOW_MOVING_RULES) as SlowMovingRuleKey[];

export const SLOW_MOVING_RULE_LABEL: Record<SlowMovingRuleKey, string> = {
  deadDays: "Hàng chết sau (ngày không bán)",
  excessCoverDays: "Vốn nằm chết khi đủ bán quá (ngày)",
  slowCoverDays: "Bán chậm khi đủ bán quá (ngày)",
  healthyCoverDays: "Mức tồn lành mạnh (ngày bán)",
};

/** Dải cho phép: 1 ngày tới 3 năm. Ngoài dải là gõ nhầm đơn vị, không phải một quyết định. */
export const SLOW_MOVING_DAYS_MIN = 1;
export const SLOW_MOVING_DAYS_MAX = 1095;

export type ResolvedSlowMovingRules = {
  rules: SlowMovingRules;
  /** Ô nào đang lấy từ ghi đè (để màn hình in "đã chỉnh"). */
  overridden: SlowMovingRuleKey[];
  /** Ghi đè bị BỎ NGUYÊN BỘ — kèm lý do, để màn hình nói ra chứ không lặng lẽ dùng mặc định. */
  ignored: string | null;
};

/**
 * Kiểm một bộ ngưỡng ĐẦY ĐỦ. Trả `null` khi hợp lệ, hoặc câu lý do.
 *
 * Thứ tự phải giữ: `lành mạnh ≤ bán chậm < vốn nằm chết`. Đảo đi thì một mẫu mã bị gọi "vốn nằm
 * chết" trước khi kịp "bán chậm", và phần "vượt mức" (tính từ mức lành mạnh) lớn hơn chính cái tồn
 * bị coi là chậm.
 */
export function slowMovingRulesProblem(r: SlowMovingRules): string | null {
  for (const k of SLOW_MOVING_RULE_KEYS) {
    const v = r[k];
    if (!Number.isInteger(v) || v < SLOW_MOVING_DAYS_MIN || v > SLOW_MOVING_DAYS_MAX) return `${SLOW_MOVING_RULE_LABEL[k]} phải là số ngày nguyên từ ${SLOW_MOVING_DAYS_MIN} tới ${SLOW_MOVING_DAYS_MAX}`;
  }
  if (!(r.healthyCoverDays <= r.slowCoverDays)) return "Mức tồn lành mạnh phải ≤ ngưỡng bán chậm";
  if (!(r.slowCoverDays < r.excessCoverDays)) return "Ngưỡng bán chậm phải nhỏ hơn ngưỡng vốn nằm chết";
  return null;
}

/**
 * Ngưỡng ĐANG CÓ HIỆU LỰC = mặc định trong mã + ghi đè THƯA của chủ shop. Hàm THUẦN.
 *
 * ĐỌC PHẢI LUÔN THÀNH CÔNG: dòng rác trong `settings` không được làm sập trang Kế hoạch. Nhưng bộ ghi
 * đè sai (một ô không phải số, sai thứ tự) bị BỎ NGUYÊN BỘ, không sửa hộ ô nào — sửa hộ là đoán ý
 * người nhập, và con số đoán ra sẽ đứng trên màn hình như thể có ai đó đã chọn nó (luật 54).
 * Khoá lạ bị lờ đi (gõ nhầm tên, không phải một ngưỡng mới).
 */
export function resolveSlowMovingRules(raw: unknown): ResolvedSlowMovingRules {
  const base: ResolvedSlowMovingRules = { rules: { ...DEFAULT_SLOW_MOVING_RULES }, overridden: [], ignored: null };
  if (raw === null || raw === undefined) return base;
  if (typeof raw !== "object" || Array.isArray(raw)) return { ...base, ignored: "Ghi đè không phải một bảng ngưỡng" };
  const o = raw as Record<string, unknown>;
  const merged: SlowMovingRules = { ...DEFAULT_SLOW_MOVING_RULES };
  const overridden: SlowMovingRuleKey[] = [];
  for (const k of SLOW_MOVING_RULE_KEYS) {
    if (!(k in o) || o[k] === null || o[k] === undefined) continue;
    const n = typeof o[k] === "number" ? (o[k] as number) : Number.NaN;
    merged[k] = n;
    overridden.push(k);
  }
  const problem = slowMovingRulesProblem(merged);
  if (problem) return { ...base, ignored: problem };
  return { rules: merged, overridden, ignored: null };
}

/** Bản ghi THƯA để lưu: chỉ ô khác mặc định. Lưu cả bảng thì sửa mặc định trong mã không bao giờ tới production. */
export function sparseSlowMovingOverride(rules: SlowMovingRules): Partial<SlowMovingRules> {
  const out: Partial<SlowMovingRules> = {};
  for (const k of SLOW_MOVING_RULE_KEYS) if (rules[k] !== DEFAULT_SLOW_MOVING_RULES[k]) out[k] = rules[k];
  return out;
}

export type StockRisk = "DEAD" | "EXCESS" | "SLOW" | "HEALTHY";

export const STOCK_RISK_LABEL: Record<StockRisk, string> = {
  DEAD: "Hàng chết",
  EXCESS: "Vốn nằm chết",
  SLOW: "Bán chậm",
  HEALTHY: "Bình thường",
};

export const STOCK_RISK_TONE: Record<StockRisk, string> = {
  DEAD: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  EXCESS: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  SLOW: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  HEALTHY: "bg-muted text-muted-foreground",
};

export const STOCK_RISK_ACTION: Record<StockRisk, string> = {
  DEAD: "Xả giá vốn hoặc gộp thành combo — giữ tiếp chỉ tốn thêm chỗ và vốn.",
  EXCESS: "Ngừng đặt thêm, đẩy bán bằng ưu đãi cho tới khi tồn về mức bán được trong một–hai tháng.",
  SLOW: "Chưa cần xả, nhưng KHÔNG đặt thêm cho tới khi nhịp bán tăng lại.",
  HEALTHY: "Không cần làm gì.",
};
