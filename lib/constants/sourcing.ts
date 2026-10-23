/**
 * ═══════════ TÌM HÀNG NGUỒN TRUNG QUỐC (module `sourcing`) — HẰNG SỐ + HÀM THUẦN (SRC-1, 23/10/2026) ═══════════
 *
 * Thiết kế: docs/tech/ai-sourcing.md. SRC-1 chỉ dựng KHUNG: khoá module theo tổ chức, quyền, hai khoá cấu hình. Chưa gọi nguồn
 * ngoài nào, chưa gọi AI — nguồn dữ liệu chờ chủ shop gỡ blocker B1 / B2 (§6 của tài liệu).
 *
 * Quyết định của Tech Lead 23/10/2026 (chủ shop giao tự quyết tiểu tiết không dính tiền / tài khoản):
 *  · `sourcing.limits` — trần lượt gọi AI / ngày / tổ chức, mặc định 200; hết trần thì DỪNG và báo, không tự nạp thêm.
 *  · `sourcing.landedCost` — tham số giá về Việt Nam, mặc định RỖNG. Thiếu tham số ⇒ ô giá in «chưa đủ tham số», KHÔNG tính
 *    bừa (AGENTS 38: đích / tham số là quyết định kinh doanh, không phải hằng số trong mã).
 * HÀM THUẦN, client import được.
 */

export const SOURCING_LIMITS_KEY = "sourcing.limits";
export const SOURCING_LANDED_COST_KEY = "sourcing.landedCost";

/** Trần lượt gọi AI mỗi ngày của MỘT tổ chức cho việc tìm hàng. */
export type SourcingLimits = { aiCallsPerDay: number };
export const DEFAULT_SOURCING_LIMITS: SourcingLimits = { aiCallsPerDay: 200 };
export const SOURCING_AI_CALLS_MAX = 10_000;

/** Đọc cấu hình trần đã lưu; giá trị hỏng / ngoài khoảng ⇒ mặc định (không đoán một con số khác). HÀM THUẦN. */
export function parseSourcingLimits(raw: unknown): SourcingLimits {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { aiCallsPerDay?: unknown }).aiCallsPerDay : undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= SOURCING_AI_CALLS_MAX ? { aiCallsPerDay: v } : { ...DEFAULT_SOURCING_LIMITS };
}

/**
 * Tham số giá về Việt Nam. `null` = CHƯA KHAI (khác 0: 0 là khai «không có khoản này»). Công thức ở docs/tech/ai-sourcing.md §3.3
 * — dùng ở SRC-4; SRC-1 chỉ lưu và báo đủ / thiếu.
 */
export type LandedCostConfig = {
  /** Số đồng cho 1 nhân dân tệ. */
  cnyToVnd: number | null;
  /** Ngày áp tỷ giá (YYYY-MM-DD). */
  fxAsOf: string | null;
  /** Nguồn tỷ giá (chữ tự do: ngân hàng, đơn vị mua hộ…). */
  fxSource: string;
  /** Cước nội địa Trung Quốc cho MỘT lượt mua (CNY), chia đều theo số lượng. */
  cnDomesticShipCny: number | null;
  /** Cước Trung Quốc → Việt Nam theo kg (VND). */
  intlFreightVndPerKg: number | null;
  /** Phí mua hộ (% giá hàng quy đổi). */
  agentFeePercent: number | null;
  /** Thuế / phí nhập (% giá khai). */
  dutyVatPercent: number | null;
  /** Khoản khác cho MỘT cái (VND). */
  otherVndPerUnit: number | null;
  setByEmail: string | null;
  setAt: string | null;
  reason: string;
};

export const EMPTY_LANDED_COST: LandedCostConfig = {
  cnyToVnd: null,
  fxAsOf: null,
  fxSource: "",
  cnDomesticShipCny: null,
  intlFreightVndPerKg: null,
  agentFeePercent: null,
  dutyVatPercent: null,
  otherVndPerUnit: null,
  setByEmail: null,
  setAt: null,
  reason: "",
};

export type LandedCostNumberKey = "cnyToVnd" | "cnDomesticShipCny" | "intlFreightVndPerKg" | "agentFeePercent" | "dutyVatPercent" | "otherVndPerUnit";

/** Tham số BẮT BUỘC của công thức — thiếu một ô là chưa tính được (không mặc định ngầm). */
export const LANDED_COST_FIELDS: readonly { key: LandedCostNumberKey | "fxAsOf"; label: string; unit: string }[] = [
  { key: "cnyToVnd", label: "Tỷ giá CNY → VND", unit: "₫ / 1 CNY" },
  { key: "fxAsOf", label: "Ngày áp tỷ giá", unit: "ngày" },
  { key: "cnDomesticShipCny", label: "Cước nội địa Trung Quốc mỗi lượt mua", unit: "CNY" },
  { key: "intlFreightVndPerKg", label: "Cước Trung Quốc → Việt Nam", unit: "₫ / kg" },
  { key: "agentFeePercent", label: "Phí mua hộ", unit: "%" },
  { key: "dutyVatPercent", label: "Thuế / phí nhập", unit: "%" },
  { key: "otherVndPerUnit", label: "Khoản khác mỗi cái", unit: "₫" },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Chuẩn hoá cấu hình đã lưu: số hỏng / âm ⇒ `null` (CHƯA KHAI), không bao giờ thành 0. HÀM THUẦN. */
export function parseLandedCost(raw: unknown): LandedCostConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_LANDED_COST };
  const r = raw as Record<string, unknown>;
  return {
    cnyToVnd: num(r.cnyToVnd),
    fxAsOf: typeof r.fxAsOf === "string" && DATE_RE.test(r.fxAsOf) ? r.fxAsOf : null,
    fxSource: typeof r.fxSource === "string" ? r.fxSource.slice(0, 200) : "",
    cnDomesticShipCny: num(r.cnDomesticShipCny),
    intlFreightVndPerKg: num(r.intlFreightVndPerKg),
    agentFeePercent: num(r.agentFeePercent),
    dutyVatPercent: num(r.dutyVatPercent),
    otherVndPerUnit: num(r.otherVndPerUnit),
    setByEmail: typeof r.setByEmail === "string" ? r.setByEmail : null,
    setAt: typeof r.setAt === "string" ? r.setAt : null,
    reason: typeof r.reason === "string" ? r.reason.slice(0, 500) : "",
  };
}

/** Nhãn các tham số BẮT BUỘC còn thiếu. Rỗng ⇒ tính được. HÀM THUẦN. */
export function landedCostMissing(cfg: LandedCostConfig): string[] {
  return LANDED_COST_FIELDS.filter((f) => (f.key === "fxAsOf" ? cfg.fxAsOf === null : cfg[f.key] === null)).map((f) => f.label);
}

/** Tỷ giá quá số ngày này ⇒ cảnh báo «tỷ giá cũ» (vẫn tính, nhưng nói ra). */
export const SOURCING_FX_STALE_DAYS = 7;

/** Tỷ giá đã cũ chưa — `null` khi chưa khai ngày. HÀM THUẦN, `now` là tham số (AGENTS 50). */
export function fxStale(cfg: Pick<LandedCostConfig, "fxAsOf">, now: Date): boolean | null {
  if (!cfg.fxAsOf) return null;
  const days = (now.getTime() - Date.parse(`${cfg.fxAsOf}T00:00:00+07:00`)) / 86_400_000;
  return days > SOURCING_FX_STALE_DAYS;
}

// ─────────────────────────── KHO MẪU NHẬP TAY (SRC-3) ───────────────────────────

/** Nền tảng nguồn — danh sách ĐÓNG, có CHECK ở CSDL (0256). Tmall đi chung TAOBAO (cùng hệ, cùng mã `id=`). */
export const SOURCING_PLATFORMS = ["1688", "ALIBABA", "TAOBAO", "OTHER"] as const;
export type SourcingPlatform = (typeof SOURCING_PLATFORMS)[number];
export const SOURCING_PLATFORM_LABEL: Record<SourcingPlatform, string> = { "1688": "1688", ALIBABA: "Alibaba", TAOBAO: "Taobao / Tmall", OTHER: "Khác" };

/**
 * Nguồn của con số — danh sách ĐÓNG, có CHECK. KHÔNG có «cũ»: cũ là hàm của THỜI GIAN, tính lúc đọc từ mốc chụp
 * (`staleness`), không lưu — lưu thì nó sai ngay ngày hôm sau (cùng lý do với leo thang SLA, AGENTS 26).
 */
export const SOURCING_DATA_STATUSES = ["MANUAL", "API", "UNKNOWN"] as const;
export type SourcingDataStatus = (typeof SOURCING_DATA_STATUSES)[number];
export const SOURCING_DATA_STATUS_LABEL: Record<SourcingDataStatus, string> = { MANUAL: "Nhập tay", API: "Từ nguồn đã duyệt", UNKNOWN: "Chưa rõ nguồn" };

/** Ngưỡng «cũ» DUY NHẤT cho số liệu nguồn (giá đã chụp, thông tin nhà cung cấp): quá số ngày này ⇒ in «cũ» cạnh số. */
export const SOURCING_DATA_STALE_DAYS = 30;

/** Số liệu chụp lúc `asOf` đã cũ chưa — `null` khi không có mốc (CHƯA BIẾT). HÀM THUẦN, `now` là tham số (AGENTS 50). */
export function staleness(asOf: Date | string | null, now: Date): { stale: boolean; days: number } | null {
  if (asOf === null) return null;
  const t = typeof asOf === "string" ? Date.parse(asOf) : asOf.getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  return { stale: days > SOURCING_DATA_STALE_DAYS, days: Math.max(0, days) };
}

/** Mốc SỐ LƯỢNG của bảng so sánh — chỉ để HIỂN THỊ (giá áp dụng khi mua đúng số đó), không phải ngưỡng nghiệp vụ. */
export const SOURCING_COMPARE_QUANTITIES = [10, 50, 100, 300] as const;
/** Số mẫu tối đa đặt cạnh nhau trên màn so sánh. */
export const SOURCING_COMPARE_MAX = 4;
/** Số bậc giá tối đa của một lần chụp. */
export const SOURCING_PRICE_TIERS_MAX = 8;
