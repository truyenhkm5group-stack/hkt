/**
 * ═══════════ CHÍNH SÁCH THƯƠNG MẠI — THUẦN, CLIENT-SAFE (docs/saas/README.md §5) ═══════════
 *
 * Khách nội bộ và khách ngoài đi CÙNG một lõi. Khác biệt duy nhất là DỮ LIỆU trên tài khoản (`account_type`,
 * `billing_mode`), và mọi chỗ khác biệt đó đổi hành vi đều nằm ở tệp này — không chỗ nào trong mã sản phẩm hỏi
 * "có phải khách nội bộ không" (`tests/saas-platform.test.ts` quét mã nguồn).
 *
 * Ba điều KHÔNG phụ thuộc loại tài khoản (cố ý):
 *  · ĐO DÙNG: không tài khoản nào được miễn đo — sổ dùng, sổ AI, sổ chi phí ghi như nhau.
 *  · QUYỀN: `INTERNAL` không cấp quyền gì. Vận hành nền tảng là quyền `platform:operate` tường minh (lib/auth/permissions.ts).
 *  · ENTITLEMENT: đi theo gói + ghi đè, không theo loại tài khoản.
 */
import type { BillingStandingKind } from "@/lib/billing/rules";

export const ACCOUNT_TYPES = ["INTERNAL", "EXTERNAL"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const BILLING_MODES = ["INTERNAL_CHARGEBACK", "EXTERNAL_INVOICE"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
export const ACCOUNT_STATUSES = ["ACTIVE", "SUSPENDED", "CLOSED"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = { INTERNAL: "Nội bộ", EXTERNAL: "Khách ngoài" };
export const BILLING_MODE_LABEL: Record<BillingMode, string> = { INTERNAL_CHARGEBACK: "Chargeback nội bộ", EXTERNAL_INVOICE: "Hoá đơn khách" };
/** Sắc thái nhãn loại tài khoản trên màn hình (cùng component cho cả hai loại — chỉ khác màu nhãn). */
export const ACCOUNT_TYPE_TONE: Record<AccountType, "info" | "muted"> = { INTERNAL: "info", EXTERNAL: "muted" };
export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = { ACTIVE: "Đang hoạt động", SUSPENDED: "Tạm dừng", CLOSED: "Đã đóng" };

/** Loại tài khoản ⇒ cách lập chứng từ mặc định khi tạo. Đổi được sau (một khách nội bộ vẫn có thể bị lập hoá đơn). */
export function defaultBillingMode(type: AccountType): BillingMode {
  return type === "INTERNAL" ? "INTERNAL_CHARGEBACK" : "EXTERNAL_INVOICE";
}

export type SubscriptionState = "ACTIVE" | "PAUSED" | "CANCELED";
export type EffectiveSubscriptionStatus = "TRIAL" | "ACTIVE" | "PAST_DUE" | "EXPIRED" | "PAUSED" | "CANCELED";

export const SUBSCRIPTION_STATUS_LABEL: Record<EffectiveSubscriptionStatus, string> = {
  TRIAL: "Dùng thử",
  ACTIVE: "Đang dùng",
  PAST_DUE: "Quá hạn — đang ân hạn",
  EXPIRED: "Hết hạn — chỉ xem",
  PAUSED: "Tạm dừng",
  CANCELED: "Đã huỷ",
};

/**
 * Tình trạng HIỆU LỰC của một thuê bao — hàm thuần của lựa chọn người vận hành (`state`) và thu phí của workspace, tính lúc
 * đọc nên đúng tới từng ngày mà không cần job (cùng tinh thần luật 26):
 *  · `CANCELED` / `PAUSED` do người quyết — thắng mọi thứ;
 *  · chargeback nội bộ không có hạn trả tiền ⇒ `ACTIVE` (quyền dùng không phụ thuộc thu tiền);
 *  · thu phí bật mà CHƯA có hoá đơn trả nào ⇒ `TRIAL` khi còn hạn (hạn dùng thử chính là `paid_through` — 0187);
 *  · `OVERDUE` ⇒ `PAST_DUE`; `LOCKED` ⇒ `EXPIRED`.
 */
export function effectiveSubscriptionStatus(input: { state: SubscriptionState; billingMode: BillingMode; standing: BillingStandingKind; hasPaidInvoice: boolean }): EffectiveSubscriptionStatus {
  if (input.state === "CANCELED") return "CANCELED";
  if (input.state === "PAUSED") return "PAUSED";
  if (input.billingMode === "INTERNAL_CHARGEBACK") return "ACTIVE";
  if (input.standing === "LOCKED") return "EXPIRED";
  if (input.standing === "OVERDUE") return "PAST_DUE";
  if (input.standing !== "NOT_BILLED" && !input.hasPaidInvoice) return "TRIAL";
  return "ACTIVE";
}

/**
 * «Đang lỗ gộp» chỉ có nghĩa với khách TRẢ TIỀN trong kỳ (doanh thu > 0): dùng thử / miễn phí có doanh thu 0 nên lượt AI nào cũng
 * thành «lỗ» — đúng thiết kế, không phải việc cần xem. MỘT vị từ cho cờ của bảng kê (`lib/saas/customers.ts`, đầu trang một khách)
 * và lý do sức khoẻ (`lib/saas/customer-health.ts`) — hai chỗ không được nói hai điều.
 */
export function losingMoneyApplies(revenueVnd: number | null, grossProfitVnd: number | null): boolean {
  return revenueVnd !== null && revenueVnd > 0 && grossProfitVnd !== null && grossProfitVnd < 0;
}

export type CustomerEconomicsCore = {
  /** Chi phí ĐÃ BIẾT số (AI nền tảng đã định giá + phân bổ có số). Khi `costComplete = false` đây là CẬN DƯỚI. */
  costVnd: number;
  /** Mọi lượt AI đã định giá VÀ mọi khoản phân bổ (workspace lẫn cấp tài khoản) đều có số. */
  costComplete: boolean;
  /** Lãi gộp — `null` khi chưa biết doanh thu HOẶC chi phí còn khoản chưa biết (AGENTS.md mục 42: chưa biết không phải 0). */
  grossProfitVnd: number | null;
  /** Biên gộp (%) — `null` theo cùng luật với lãi gộp. */
  marginPct: number | null;
  /**
   * Lãi gộp dùng cho phán quyết «Đang lỗ gộp»: số thật khi đủ chi phí; thiếu chi phí thì CHỈ khi phần đã biết đã vượt
   * doanh thu (chi phí chỉ có thể lớn thêm ⇒ lỗ là chắc chắn, số này là mức lỗ TỐI THIỂU). Còn lại `null`.
   */
  lossCheckGrossProfitVnd: number | null;
};

/**
 * Kinh tế gộp của MỘT tài khoản khách trong kỳ — hàm THUẦN. Bản cũ (`lib/saas/customers.ts`) cộng khoản phân bổ chưa biết
 * số bằng `?? 0` rồi trừ ra lãi gộp và biên như thể đủ chi phí: màn vận hành in một biên đẹp hơn thật, đúng hướng dễ chịu.
 */
export function customerEconomicsCore(input: {
  revenueVnd: number | null;
  aiCostVnd: number;
  unpricedAiCalls: number;
  allocated: readonly { amountVnd: number | null }[];
}): CustomerEconomicsCore {
  const allocKnown = input.allocated.reduce((a, l) => a + (l.amountVnd ?? 0), 0);
  const costVnd = input.aiCostVnd + allocKnown;
  const costComplete = input.unpricedAiCalls === 0 && input.allocated.every((l) => l.amountVnd !== null);
  const ceiling = input.revenueVnd === null ? null : input.revenueVnd - costVnd;
  const grossProfitVnd = costComplete ? ceiling : null;
  const marginPct = input.revenueVnd && grossProfitVnd !== null ? Math.round((grossProfitVnd / input.revenueVnd) * 1000) / 10 : null;
  const lossCheckGrossProfitVnd = costComplete ? grossProfitVnd : ceiling !== null && ceiling < 0 ? ceiling : null;
  return { costVnd, costComplete, grossProfitVnd, marginPct, lossCheckGrossProfitVnd };
}

/** Thuê bao ở tình trạng này có mở năng lực của sản phẩm không. Quá hạn vẫn dùng (đang ân hạn); hết hạn chỉ xem. */
export function subscriptionGrantsUse(status: EffectiveSubscriptionStatus): boolean {
  return status === "ACTIVE" || status === "TRIAL" || status === "PAST_DUE";
}

/**
 * Biên lãi gộp có ÁP DỤNG cho tài khoản không. Chargeback nội bộ không phải doanh thu thị trường — in biên của một trung tâm
 * chi phí là bịa một con số; màn hình in `N/A` (KHÔNG ÁP DỤNG, luật 42) và vẫn in đủ chi phí.
 */
export function marginApplicable(mode: BillingMode): boolean {
  return mode === "EXTERNAL_INVOICE";
}

/**
 * Workspace này có thể bị KHOÁ THANH TOÁN không (quá hạn + hết ân hạn ⇒ chỉ xem). MỘT vị từ cho HAI chỗ phải nói cùng một
 * điều: cổng ghi `lib/auth/session.ts` (khoá) và trang `/settings/plan` (khung gia hạn bằng QR). Hai chỗ đọc hai điều kiện
 * khác nhau là đường cụt: bị khoá → «Gia hạn ngay» → trang không có mã QR (review PR #622: workspace khách nằm trong tài
 * khoản chargeback). Nền tảng không thu phí của chính nó, nên workspace nhà không bị khoá — nhánh AN TOÀN / thu phí, giữ
 * (docs/saas/ENTITLEMENTS.md «Nhánh GIỮ»). Loại tài khoản KHÔNG tham gia: khoá đọc thuê bao, không đọc `billing_mode`.
 */
export function billingLockApplies(org: { isHome: boolean }): boolean {
  return !org.isHome;
}

/** Tài khoản loại này có được GỢI Ý gộp theo tên không — chỉ khách ngoài (khách nội bộ do người vận hành tự quản). */
/**
 * Job cấp phát có được HUỶ thuê bao (thu hồi module độc quyền) của tài khoản loại này không. Nội bộ thì KHÔNG: huỷ ERP của
 * VNXCommerce tắt module đang vận hành của chính nền tảng (review tích hợp 06/10/2026) — đổi có chủ đích ở trang module.
 */
export function cancelByJobAllowed(type: AccountType): boolean {
  return type !== "INTERNAL";
}

/**
 * Workspace MỚI («Tạo khách», job cấp phát) được đặt vào một gói CHỈ CÒN ở giá cũ (có trong `platform_plans` nhưng không có
 * trong bảng giá đang niêm yết — basic · pro · standard) không. Chỉ tài khoản NỘI BỘ (chargeback): giữ luật đang có cho khách
 * nội bộ — gán họ vào gói V1 là việc có chạy thử của người vận hành (docs/saas/PRICING_V1.md §II.4). Khách NGOÀI thì KHÔNG
 * (kiểm khởi chạy 08/10/2026): gói cũ đọc giá legacy, không có dùng thử theo phiên bản, trần AI theo dòng cũ của `platform_plans`
 * — gói credit 0 làm bot im ngay ngày đầu. Loại lạ / thiếu ⇒ KHÔNG (mọi nhánh lỗi rơi về phía hẹp hơn). Gói `internal` không
 * thuộc câu hỏi này: nó chỉ dành cho workspace nhà (`lib/saas/create-customer-rules.ts`).
 */
export function legacyPlanOnCreateAllowed(type: string | null | undefined): boolean {
  return type === "INTERNAL";
}

export function mergeSuggestible(type: AccountType): boolean {
  return type === "EXTERNAL";
}

/**
 * Tài khoản loại này có được XOÁ cùng workspace tự đăng ký không (ops `org-offboard`, lib/platform/offboard.ts). Chỉ khách ngoài:
 * tài khoản nội bộ là của chính nền tảng. Nhận chuỗi thô từ CSDL — loại lạ / thiếu ⇒ KHÔNG (mọi nhánh lỗi rơi về phía hẹp hơn).
 */
export function offboardDeletableAccountType(type: string | null | undefined): boolean {
  return type === "EXTERNAL";
}

/** Chứng từ kỳ của tài khoản tên là gì. */
export function statementLabel(mode: BillingMode): string {
  return mode === "INTERNAL_CHARGEBACK" ? "Bảng kê chargeback nội bộ" : "Bảng kê hoá đơn";
}
