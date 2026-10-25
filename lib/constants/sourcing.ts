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
import { APPROVAL_VALID_HOURS } from "@/lib/constants/approval";

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
  /** Phí mua hộ (% GIÁ MUA = giá bậc × tỷ giá). */
  agentFeePercent: number | null;
  /** Thuế / phí nhập — MỘT tỷ lệ gộp, % TRỊ GIÁ TÍNH THUẾ kiểu CIF (giá mua + cước nội địa + cước TQ → VN). Đơn vị vận chuyển
   *  báo giá «bao thuế theo kg» ⇒ khai 0 và cước / kg đã gồm thuế. */
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
  { key: "agentFeePercent", label: "Phí mua hộ", unit: "% giá mua" },
  { key: "dutyVatPercent", label: "Thuế / phí nhập", unit: "% trị giá CIF" },
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
export const SOURCING_DATA_STATUSES = ["MANUAL", "API", "EXTENSION", "UNKNOWN"] as const;
export type SourcingDataStatus = (typeof SOURCING_DATA_STATUSES)[number];
export const SOURCING_DATA_STATUS_LABEL: Record<SourcingDataStatus, string> = {
  MANUAL: "Nhập tay",
  API: "Từ nguồn đã duyệt",
  EXTENSION: "Lưu từ trang 1688 (tiện ích Chrome)",
  UNKNOWN: "Chưa rõ nguồn",
};

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

// ─────────────────────────── TRỌNG SỐ ĐIỂM NHÀ CUNG CẤP (SRC-4) ───────────────────────────

/**
 * Trọng số điểm nhà cung cấp — KHÔNG có bộ mặc định (cùng tinh thần AGENTS 27): chưa khai ⇒ màn hình chỉ hiện TỪNG thành phần kèm
 * độ phủ, không có điểm tổng. Trọng số `null` = thành phần không tính vào tổng. Số năm cần TRẦN (`yearsCap`) để quy về 0–1 — trần
 * cũng là quyết định của chủ shop, không gõ sẵn.
 */
export const SOURCING_SCORE_WEIGHTS_KEY = "sourcing.scoreWeights";
export const SUPPLIER_SCORE_COMPONENTS = ["rating", "responseRate", "verified", "years"] as const;
export type SupplierScoreComponent = (typeof SUPPLIER_SCORE_COMPONENTS)[number];
export const SUPPLIER_SCORE_LABEL: Record<SupplierScoreComponent, string> = { rating: "Điểm đánh giá", responseRate: "Tỷ lệ phản hồi", verified: "Đã xác minh", years: "Số năm trên nền tảng" };

export type SourcingScoreWeights = {
  supplier: Record<SupplierScoreComponent, number | null>;
  /** Số năm coi là «đủ» (điểm thành phần = 1). */
  yearsCap: number | null;
  setByEmail: string | null;
  setAt: string | null;
  reason: string;
};

export const EMPTY_SCORE_WEIGHTS: SourcingScoreWeights = { supplier: { rating: null, responseRate: null, verified: null, years: null }, yearsCap: null, setByEmail: null, setAt: null, reason: "" };

/** Chuẩn hoá cấu hình đã lưu: số hỏng / âm ⇒ `null`. HÀM THUẦN. */
export function parseScoreWeights(raw: unknown): SourcingScoreWeights {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_SCORE_WEIGHTS;
  const r = raw as Record<string, unknown>;
  const w = (r.supplier && typeof r.supplier === "object" && !Array.isArray(r.supplier) ? r.supplier : {}) as Record<string, unknown>;
  const weight = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);
  return {
    supplier: { rating: weight(w.rating), responseRate: weight(w.responseRate), verified: weight(w.verified), years: weight(w.years) },
    yearsCap: typeof r.yearsCap === "number" && Number.isInteger(r.yearsCap) && r.yearsCap >= 1 && r.yearsCap <= 100 ? r.yearsCap : null,
    setByEmail: typeof r.setByEmail === "string" ? r.setByEmail : null,
    setAt: typeof r.setAt === "string" ? r.setAt : null,
    reason: typeof r.reason === "string" ? r.reason.slice(0, 500) : "",
  };
}

/** Có ít nhất một trọng số dương ⇒ chủ shop đã khai cách tính điểm tổng. */
export function scoreWeightsDeclared(w: SourcingScoreWeights): boolean {
  return SUPPLIER_SCORE_COMPONENTS.some((k) => (w.supplier[k] ?? 0) > 0);
}

// ─────────────────────────── VIỆC MUA THỬ TRÊN /work (SRC-5b) ───────────────────────────

/**
 * Hai loại việc của nguồn `SOURCING_TRIAL` — phép CHIẾU lên `sourcing_trial_requests` (luật 19): rời hàng đợi khi người bấm đúng
 * hành động của miền («đã đặt» / «đã về» ở /sourcing/trials/[id]). Chờ DUYỆT không ở đây — nó đã là việc của nguồn `APPROVAL`.
 */
export const SOURCING_TRIAL_WORK_KINDS = ["ORDER", "RECEIVE"] as const;
export type SourcingTrialWorkKind = (typeof SOURCING_TRIAL_WORK_KINDS)[number];
export const SOURCING_TRIAL_WORK_LABEL: Record<SourcingTrialWorkKind, string> = {
  ORDER: "Mua thử đã duyệt, chưa đặt",
  RECEIVE: "Mua thử đã đặt, chưa về",
};

/**
 * Hạn mặc định (giờ) — NGUỒN DUY NHẤT; `lib/constants/work-sla.ts` lấy lại từ đây, không gõ lại (luật 22). Chủ shop đổi ở `work.sla`.
 *  · ORDER = hạn hiệu lực lời duyệt (`APPROVAL_VALID_HOURS`, hằng đang chạy của lõi duyệt): quá hạn ấy lời duyệt mất và phải xin lại,
 *    nên «đã duyệt mà chưa đặt» vỡ hạn đúng lúc đó — không phải một con số mới.
 *  · RECEIVE = `null` CỐ Ý: không có hằng đang chạy nào nói hàng mua thử được về chậm bao lâu; gõ số mới là bịa (luật 22, 38).
 */
export const SOURCING_TRIAL_SLA_HOURS: Record<SourcingTrialWorkKind, number | null> = { ORDER: APPROVAL_VALID_HOURS, RECEIVE: null };
export const SOURCING_TRIAL_SLA_WHY: Record<SourcingTrialWorkKind, string> = {
  ORDER: "Lấy lại hạn hiệu lực của lời duyệt: quá hạn ấy lời duyệt hết, người xin phải xin lại — nên đây là lúc việc thật sự vỡ hạn.",
  RECEIVE:
    "CỐ Ý bỏ trống: chưa có hằng số đang chạy nào nói hàng mua thử được phép về chậm bao lâu, và gõ một con số mới ở đây là bịa " +
    "(AGENTS.md mục 22, 38). Chủ shop đặt được — nó đo «đã đặt bao lâu mà chưa về», tính từ lúc người bấm «đã đặt».",
};

// ─────────────────────────── LƯU MẪU TỪ TRANG 1688 (SRC-6, chủ shop chốt 25/10/2026) ───────────────────────────

/**
 * Đường một lần chụp đi vào — danh sách ĐÓNG, có CHECK (0260). `EXTENSION` = người bấm «Lưu mẫu vào ERP» trên trang chi tiết
 * 1688 (tiện ích Chrome, `extensions/sourcing-1688/`); `API` = lời gọi chính thức (keywordQuery / chi tiết) khi chủ shop đã đăng ký
 * 采购服务商 và uỷ quyền ứng dụng — cùng bảng, cùng bộ đọc chuẩn hoá, khác nhãn nguồn.
 */
export const SOURCING_CAPTURE_SOURCES = ["EXTENSION", "API"] as const;
export type SourcingCaptureSource = (typeof SOURCING_CAPTURE_SOURCES)[number];

/** Đường DUY NHẤT tiện ích gửi tới — middleware mở đúng chữ này (không tiền tố), route tự gác bằng token. */
export const SOURCING_CAPTURE_PATH = "/api/sourcing/capture";

/** Phạm vi DUY NHẤT của token tiện ích — token không mở được trang, không đọc được gì, chỉ gửi được một lần chụp. */
export const SOURCING_CAPTURE_SCOPE = "sourcing:capture";

/**
 * Hình dạng token: `vnxs1.<mã tổ chức>.<bí mật>`. Mã tổ chức chọn CSDL (như lịch .ics — `lib/stays/feed.ts`), bí mật chỉ lưu dạng
 * BĂM trong CSDL của chính tổ chức đó ⇒ token của tổ chức A gắn nhãn tổ chức B không khớp dòng nào. HÀM THUẦN.
 */
export const SOURCING_CAPTURE_TOKEN_RE = /^vnxs1\.([a-z0-9][a-z0-9-]{0,62})\.([A-Za-z0-9_-]{43})$/;

export function parseCaptureToken(raw: string): { orgCode: string; secret: string } | null {
  const m = SOURCING_CAPTURE_TOKEN_RE.exec(raw.trim());
  return m ? { orgCode: m[1], secret: m[2] } : null;
}

/** Số token còn hiệu lực tối đa của MỘT người (mỗi máy / trình duyệt một token, thu hồi riêng được). */
export const SOURCING_CAPTURE_TOKENS_PER_USER = 5;
/** Trần thân yêu cầu của một lần chụp — nhánh dữ liệu sản phẩm của một trang, không phải cả trang. */
export const SOURCING_CAPTURE_MAX_BYTES = 1_500_000;
/**
 * Trần tần suất của MỘT token (xô GCRA, `lib/rate-limit.ts`): bắn liền tối đa 30 lượt, sau đó 1 lượt / 2 giây (≈ 30 / phút).
 * Người bấm tay không bao giờ chạm trần; một token lộ thì không đổ rác vào kho mẫu nhanh hơn thế. Lượt bị chặn ⇒ 429 + Retry-After.
 */
export const SOURCING_CAPTURE_RATE = { burst: 30, refillMs: 2_000, maxKeys: 5_000 } as const;
/** Phiên bản bộ đọc trang chi tiết — đổi bộ đọc thì tăng, dòng cũ giữ số cũ (không đọc lại ngầm, AGENTS 8.8). */
export const SOURCING_CAPTURE_PARSER_VERSION = 1;

/**
 * Cờ của MỘT lần chụp — danh sách ĐÓNG. Mỗi cờ là một chỗ bộ đọc KHÔNG kết luận được và đã để trống (CHƯA BIẾT), không phải lỗi:
 * lần chụp vẫn được lưu, con số tương ứng là `null`.
 */
export const SOURCING_CAPTURE_FLAGS = ["NO_DETAIL_PRICE", "SKU_PRICES_DIFFER", "TIERS_INVALID", "PROMO_PRICE_IGNORED", "TRANSLATED_BY_1688", "SIZE_CHART_MISSING", "SIZE_CHART_UNPARSED", "WEIGHT_UNKNOWN", "DROPSHIP_UNREAD"] as const;
export type SourcingCaptureFlag = (typeof SOURCING_CAPTURE_FLAGS)[number];
export const SOURCING_CAPTURE_FLAG_LABEL: Record<SourcingCaptureFlag, string> = {
  NO_DETAIL_PRICE: "Không đọc được giá ở trang chi tiết — giá về CHƯA BIẾT (giá thẻ tìm kiếm / giá khách mới không phải giá mua).",
  SKU_PRICES_DIFFER: "Mỗi màu × size một giá, trang không có bậc giá chung — xem giá từng SKU; giá về CHƯA BIẾT cho tới khi chọn SKU.",
  TIERS_INVALID: "Bậc giá trên trang không hợp lệ (số lượng không tăng dần / giá ≤ 0) — không ghi bậc nào.",
  PROMO_PRICE_IGNORED: "Trang có giá khuyến mãi / giá khách mới — đã BỎ QUA, không dùng làm giá mua.",
  TRANSLATED_BY_1688:
    "1688 trả dữ liệu ĐÃ DỊCH (tài khoản đặt Global / tiếng Việt) — giá vẫn lưu, nhưng tiêu đề và bảng size không phải chữ gốc nên KHÔNG đọc cân nặng. Đặt 1688 về 简体中文 rồi bấm lại.",
  SIZE_CHART_MISSING: "Không thấy bảng size trong dữ liệu trang.",
  SIZE_CHART_UNPARSED: "Có chữ bảng size nhưng không đọc được dòng nào — để trống, xem chữ gốc.",
  WEIGHT_UNKNOWN: "Trang không ghi khối lượng — cước Trung Quốc → Việt Nam CHƯA BIẾT.",
  DROPSHIP_UNREAD: "Trang có giá dropship (一件代发) nhưng con số nằm ở phần tải riêng, bộ đọc chưa đọc được — xem trên trang.",
};
