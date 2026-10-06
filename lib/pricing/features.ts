/**
 * ═══════════ SỔ TÍNH NĂNG THEO GÓI (ENTITLEMENT) — THUẦN, CLIENT-SAFE (docs/platform/pricing-billing-foundation.md §4) ═══════════
 *
 * Mã nghiệp vụ CHỈ hỏi `hasFeature("<khoá>")` (máy chủ, `lib/pricing/entitlements.ts`) hoặc `featureGranted(...)` (thuần).
 * KHÔNG BAO GIỜ so tên / khoá gói (`plan === "pro"`): gói là DỮ LIỆU người vận hành sửa ở `/platform`, đổi tên một gói
 * không được làm đổi hành vi. `tests/pricing-billing.test.ts` quét mã nguồn chặn kiểu so sánh đó.
 *
 * Khoá tính năng BẤT BIẾN — chúng nằm trong `platform_plans.commercial.features` và `platform_org_pricing.feature_overrides`;
 * đổi khoá là làm mồ côi cấu hình đã lưu (cùng tinh thần luật 37).
 *
 * TÍNH NĂNG ≠ MODULE. Module (`lib/constants/platform-modules.ts`) là cấu hình người vận hành bật / tắt cho từng tổ chức —
 * "tổ chức này có dùng phân hệ X không". Tính năng ở đây là "gói của tổ chức này có quyền dùng X không". Hai chiều tách rời,
 * không chiều nào suy ra chiều kia.
 */

export const FEATURE_KEYS = [
  "ai_sales",
  "multi_page_inbox",
  "ai_order_creation",
  "upsell",
  "cross_sell",
  "follow_up",
  "analytics",
  "advanced_analytics",
  "human_handoff",
  "custom_ai_training",
  "api",
  "webhook",
  "multi_user",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * `publicClaim` = tính năng MỘT CỬA HÀNG MỚI TỰ ĐĂNG KÝ dùng được ngay hôm nay (đã rà trên main 06/10/2026). `/pricing` chỉ in
 * tính năng có `publicClaim: true` — không hứa thứ khách chưa bấm được (cùng luật của trang giới thiệu). Khoá vẫn gán được vào
 * gói để chuẩn bị, nhưng không xuất hiện trên trang giá cho tới khi có đường bấm thật.
 */
export const FEATURE_SPEC: Record<FeatureKey, { label: string; value: string; publicClaim: boolean }> = {
  ai_sales: { label: "AI chốt đơn 24/7", value: "Trợ lý AI trả lời khách trên fanpage cả ngày lẫn đêm, tư vấn và hỏi chốt.", publicClaim: true },
  multi_page_inbox: { label: "Hộp thư nhiều fanpage", value: "Một màn hình cho tin nhắn của mọi fanpage.", publicClaim: true },
  ai_order_creation: { label: "Tự tạo đơn từ hội thoại", value: "Khách gửi SĐT, địa chỉ là đơn được lên — không gõ lại.", publicClaim: true },
  upsell: { label: "Gợi ý mua thêm (upsell)", value: "AI mời khách lấy gói lớn hơn khi phù hợp.", publicClaim: false },
  cross_sell: { label: "Gợi ý mua kèm (cross-sell)", value: "AI gợi ý sản phẩm đi kèm với món khách đang hỏi.", publicClaim: true },
  follow_up: { label: "Nhắn lại khách", value: "Tự nhắn lại khách đang lưỡng lự trong khung giờ cho phép.", publicClaim: true },
  analytics: { label: "Báo cáo cơ bản", value: "Hội thoại, đơn do AI chốt, tỷ lệ chốt theo ngày.", publicClaim: true },
  advanced_analytics: { label: "Báo cáo nâng cao", value: "Chi phí AI trên mỗi đơn, theo fanpage, theo sản phẩm.", publicClaim: false },
  human_handoff: { label: "Chuyển cho nhân viên", value: "Nhân viên nhắn là AI tự im; bấm một nút để trả lại cho AI.", publicClaim: true },
  custom_ai_training: { label: "Dạy AI theo shop", value: "AI học từ hội thoại cũ và câu trả lời mẫu của shop.", publicClaim: true },
  api: { label: "API", value: "Đọc / ghi dữ liệu từ hệ thống khác.", publicClaim: false },
  webhook: { label: "Webhook", value: "Đẩy sự kiện (đơn mới, hội thoại) sang hệ thống khác.", publicClaim: false },
  multi_user: { label: "Nhiều người dùng", value: "Mời nhân viên, phân quyền theo vai trò.", publicClaim: true },
};

export function isFeatureKey(v: unknown): v is FeatureKey {
  return typeof v === "string" && (FEATURE_KEYS as readonly string[]).includes(v);
}

/** Đọc danh sách tính năng của gói: mảng khoá hợp lệ ⇒ tập; thiếu / sai kiểu ⇒ `null` = CHƯA KHAI. Khoá lạ bị bỏ. */
export function parseFeatureList(raw: unknown): FeatureKey[] | null {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.filter(isFeatureKey))];
}

/** Đọc ghi đè `{ khoá: boolean }` của một tổ chức — chỉ giữ ô hợp lệ. */
export function parseFeatureOverrides(raw: unknown): Partial<Record<FeatureKey, boolean>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<Record<FeatureKey, boolean>> = {};
  for (const [k, v] of Object.entries(raw)) if (isFeatureKey(k) && typeof v === "boolean") out[k] = v;
  return out;
}

export type FeatureSource = "HOME" | "GRANDFATHERED" | "OVERRIDE" | "PLAN" | "PLAN_UNDECLARED";

export type FeatureDecision = { key: FeatureKey; granted: boolean; source: FeatureSource };

/**
 * QUYẾT ĐỊNH DUY NHẤT "tổ chức này có tính năng X không" — thuần. Thứ tự:
 *  1. Tổ chức nhà ⇒ có (gói `internal`, không giới hạn — như mọi cổng gói khác).
 *  2. Ghi đè của người vận hành (`feature_overrides`) ⇒ thắng, kể cả TẮT một tính năng của tổ chức grandfathered.
 *  3. Tổ chức có từ trước 0222 (`grandfathered`) ⇒ có: một lần deploy không được làm khách mất tính năng đang dùng.
 *  4. Gói CHƯA KHAI danh sách tính năng ⇒ có, nguồn `PLAN_UNDECLARED` (màn hình nói ra): chưa khai không phải "không có" —
 *     đóng một tính năng chỉ vì người vận hành chưa điền là chặn khách bằng một ô trống.
 *  5. Gói khai ⇒ có khi khoá nằm trong danh sách.
 */
export function featureGranted(input: { key: FeatureKey; isHome: boolean; grandfathered: boolean; overrides: Partial<Record<FeatureKey, boolean>>; planFeatures: readonly FeatureKey[] | null }): FeatureDecision {
  const { key } = input;
  if (input.isHome) return { key, granted: true, source: "HOME" };
  const o = input.overrides[key];
  if (typeof o === "boolean") return { key, granted: o, source: "OVERRIDE" };
  if (input.grandfathered) return { key, granted: true, source: "GRANDFATHERED" };
  if (input.planFeatures === null) return { key, granted: true, source: "PLAN_UNDECLARED" };
  return { key, granted: input.planFeatures.includes(key), source: "PLAN" };
}

export const FEATURE_SOURCE_LABEL: Record<FeatureSource, string> = {
  HOME: "Tổ chức nhà",
  GRANDFATHERED: "Giữ từ trước bảng giá mới",
  OVERRIDE: "Người vận hành ghi đè",
  PLAN: "Theo gói",
  PLAN_UNDECLARED: "Gói chưa khai — tạm cho dùng",
};
