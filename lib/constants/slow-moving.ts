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

/**
 * Lớp của một mẫu mã còn hàng. `RETURNED_OUT` (27/09/2026, chủ shop duyệt): CÓ gửi đi trong cửa sổ hàng
 * chết mà KHÔNG giao thành công món nào, và có món đã hoàn — tốc độ gửi đi của Kế hoạch SX thì dương nên
 * phép xếp theo số ngày phủ sẽ gọi nó "Bình thường", đúng thứ không được xảy ra. Đo production (ops
 * `velocity-compare`, run 36306328239): 1/28 mẫu mã đi DEAD → HEALTHY theo đúng đường đó.
 */
export type StockRisk = "DEAD" | "RETURNED_OUT" | "EXCESS" | "SLOW" | "HEALTHY";

/** Thứ tự in cố định (bảng, số đếm, ops). */
export const STOCK_RISKS: readonly StockRisk[] = ["DEAD", "RETURNED_OUT", "EXCESS", "SLOW", "HEALTHY"];

export const STOCK_RISK_LABEL: Record<StockRisk, string> = {
  DEAD: "Hàng chết",
  RETURNED_OUT: "Hoàn gần hết / gửi đi không giao được",
  EXCESS: "Vốn nằm chết",
  SLOW: "Bán chậm",
  HEALTHY: "Bình thường",
};

export const STOCK_RISK_TONE: Record<StockRisk, string> = {
  DEAD: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  RETURNED_OUT: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950/60 dark:text-fuchsia-300",
  EXCESS: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  SLOW: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  HEALTHY: "bg-muted text-muted-foreground",
};

export const STOCK_RISK_ACTION: Record<StockRisk, string> = {
  DEAD: "Xả giá vốn hoặc gộp thành combo — giữ tiếp chỉ tốn thêm chỗ và vốn.",
  RETURNED_OUT: "Khách hoàn gần hết — xem lại chất lượng / mô tả / size trước khi đẩy thêm; KHÔNG đặt thêm, không tăng quảng cáo.",
  EXCESS: "Ngừng đặt thêm, đẩy bán bằng ưu đãi cho tới khi tồn về mức bán được trong một–hai tháng.",
  SLOW: "Chưa cần xả, nhưng KHÔNG đặt thêm cho tới khi nhịp bán tăng lại.",
  HEALTHY: "Không cần làm gì.",
};

/** Câu ⓘ "vì sao" của từng lớp — in cạnh nhãn trên bảng Hàng chậm. */
export const STOCK_RISK_WHY: Record<StockRisk, string> = {
  DEAD: "Không gửi đi món nào trong cửa sổ tốc độ và không giao thành công món nào trong cửa sổ hàng chết.",
  RETURNED_OUT:
    "Có gửi đi trong cửa sổ hàng chết nhưng KHÔNG giao thành công món nào (theo ORDER_OUTCOME, cùng căn cứ luật hàng chết) và đã có món hoàn. Tốc độ gửi đi dương không phải là bán được — hàng đi rồi về.",
  EXCESS: "Tồn đủ bán quá ngưỡng vốn nằm chết theo số ngày còn đủ hàng của Kế hoạch SX, hoặc hàng hoàn về bằng hàng đi nên tồn không vơi.",
  SLOW: "Tồn đủ bán quá ngưỡng bán chậm theo số ngày còn đủ hàng của Kế hoạch SX.",
  HEALTHY: "Số ngày còn đủ hàng trong vùng lành mạnh.",
};

/**
 * Sự kiện của CỬA SỔ HÀNG CHẾT (`deadDays` của `inventory.slowMoving`, không thêm ngưỡng nào) mà phép xếp
 * lớp cần ngoài nhịp hao kho — đọc cùng một câu với "lần cuối giao được" (`lib/queries/slow-moving.ts`).
 * KHÔNG phải một định nghĩa tốc độ: chỉ trả lời "có gửi đi không" và "có món nào đã hoàn không".
 */
export type DeadWindowFacts = {
  /** Số món của đơn KHÔNG HUỶ lên trong cửa sổ — cùng căn cứ "gộp" với tốc độ gửi đi của Kế hoạch SX. */
  shippedInDeadWindow: number;
  /** Số món của đơn lên trong cửa sổ đã kết luận HOÀN (`RETURNED` / `RETURNED_BY_RULE`). */
  returnedInDeadWindow: number;
};

/**
 * XẾP LOẠI MỘT MẪU MÃ còn hàng — hàm THUẦN, một chỗ cho trang Hàng chậm và cho mọi phép đo trước/sau.
 *
 * `velocity` và `daysOfCover` PHẢI là của Kế hoạch SX (`paceOfPlanRow` + `coverDaysOf`, đã làm tròn
 * bằng `roundCoverDays`) — quyết định chủ shop giao Tech Lead chốt 27/09/2026: một mẫu mã chỉ có MỘT
 * số ngày còn đủ hàng trên mọi màn hình. Ngưỡng giữ nguyên (`inventory.slowMoving`).
 *
 * Xếp trên số ĐÃ LÀM TRÒN — đúng con số in trong câu lý do, để "đủ bán 60 ngày" không bị gọi là bán chậm
 * khi ngưỡng là quá 60 ngày.
 */
export function classifyStockRisk(
  i: { velocity: number; daysOfCover: number | null; daysSinceLastSale: number | null } & DeadWindowFacts,
  rules: SlowMovingRules,
): { risk: StockRisk; reason: string } {
  const { velocity, daysOfCover, daysSinceLastSale } = i;
  /*
    HOÀN GẦN HẾT — xét TRƯỚC mọi nhánh khác. "Không giao được món nào trong cửa sổ hàng chết" đọc ĐÚNG
    căn cứ của luật hàng chết cũ (`daysSinceLastSale`, ORDER_OUTCOME = DELIVERED). Cần CẢ gửi đi > 0 (nếu
    không thì là hàng chết như cũ) LẪN hoàn > 0: hàng còn đang đi là CHƯA BIẾT (luật 3), không phải thất
    bại — một mẫu mới toàn đơn đang giao không được gắn nhãn "hoàn gần hết".
  */
  const noDelivery = daysSinceLastSale === null || daysSinceLastSale >= rules.deadDays;
  if (noDelivery && i.shippedInDeadWindow > 0 && i.returnedInDeadWindow > 0) {
    const dangDi = Math.max(0, i.shippedInDeadWindow - i.returnedInDeadWindow);
    return {
      risk: "RETURNED_OUT",
      reason: `Gửi đi ${i.shippedInDeadWindow} món trong ${rules.deadDays} ngày, hoàn ${i.returnedInDeadWindow}, chưa giao thành công món nào${dangDi > 0 ? ` (${dangDi} món chưa kết luận)` : ""} — khách hoàn gần hết`,
    };
  }
  if (velocity <= 0 && (daysSinceLastSale === null || daysSinceLastSale >= rules.deadDays)) {
    return { risk: "DEAD", reason: daysSinceLastSale === null ? "Chưa bán được cái nào" : `Không bán được cái nào trong ${daysSinceLastSale} ngày` };
  }
  // Có gửi đi nhưng sau độ trễ hoàn hàng về bằng hàng đi: tồn KHÔNG vơi — số ngày phủ không tồn tại
  // (in "—", không in vô cực) nhưng kết luận thì có: tiền nằm yên trong kho.
  if (velocity > 0 && daysOfCover === null) {
    return { risk: "EXCESS", reason: "Gửi đi bao nhiêu hoàn về bấy nhiêu — theo nhịp hiện tại tồn không vơi" };
  }
  if (daysOfCover !== null && daysOfCover > rules.excessCoverDays) return { risk: "EXCESS", reason: `Tồn đủ bán ${daysOfCover} ngày — vượt xa mức cần thiết` };
  if (daysOfCover !== null && daysOfCover > rules.slowCoverDays) return { risk: "SLOW", reason: `Tồn đủ bán ${daysOfCover} ngày — bán chậm hơn mức lành mạnh` };
  return { risk: "HEALTHY", reason: daysOfCover === null ? "Chưa đủ căn cứ" : `Tồn đủ bán ${daysOfCover} ngày` };
}
