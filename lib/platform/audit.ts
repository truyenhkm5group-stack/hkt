import { getPlatformDb, schema } from "@/db";

/**
 * NHẬT KÝ NỀN TẢNG (`platform_audit_log`, CSDL nhà) — hợp đồng mục 10.
 *
 * Mọi lượt đổi module / feature / cờ / tổ chức ghi ở đây: ai (tổ chức + tài khoản), tổ chức đích,
 * khoá, trước → sau, lý do, nguồn. `actor = null` nghĩa là MÁY (migration, script, kiểm thử) — khác
 * hẳn "không biết ai" (AGENTS.md luật 34).
 *
 * Hàm này NÉM khi ghi hỏng, và bên gọi phải ghi nhật ký TRƯỚC khi coi lượt đổi cấu hình là xong:
 * một cấu hình đổi mà không có vết thì không ai trả lời được "vì sao hôm qua tổ chức X mất module Y".
 */
export type PlatformAuditAction = "MODULE_ENABLE" | "MODULE_DISABLE" | "FEATURE_SET" | "FLAG_SET" | "ORG_CREATE" | "ORG_STATUS" | "ORG_SETUP" | "INVITE_CREATE" | "INVITE_REVOKE" | "SIGNUP_MODE_SET" | "SECRETS_SELF_TEST" | "AI_SWITCH_SET" | "AI_ORG_CONTROL_SET"
  // Vận hành khách pilot (docs/platform/pilot-operations.md): lượt MỞ trang sức khoẻ một tổ chức (hỗ trợ có vết), đổi
  // giai đoạn / xác nhận UAT, tắt kết nối của tổ chức. Đình chỉ ⇒ `ORG_STATUS`; tạm dừng luật ⇒ `FLAG_SET`.
  | "SUPPORT_VIEW"
  | "PILOT_STAGE"
  | "PILOT_UAT"
  | "CONNECTION_DISABLE"
  // Người vận hành đổi gói của một tổ chức sau lúc tạo (`lib/platform/org-plan.ts`).
  | "ORG_PLAN_SET"
  // Người vận hành đặt thương hiệu (vnx · chotdon) cho tổ chức có từ trước 0215 (`lib/platform/org-brand.ts`).
  | "ORG_BRAND_SET"
  // Hành trình tự phục vụ (0180, `lib/platform/publish.ts`): khách chọn tên miền con, khách bấm Xuất bản.
  | "ORG_DOMAIN_SET"
  | "ORG_PUBLISH"
  // Thu phí thuê bao (0187, `lib/billing/service.ts`): bật / tắt / sửa hạn thu phí của một tổ chức, sửa giá gói, khai tài
  // khoản nhận tiền, hoá đơn được trả (tự khớp ngân hàng hoặc xác nhận tay), huỷ hoá đơn, xử lý một khoản tiền không khớp.
  | "BILLING_SET"
  | "PLAN_PRICE_SET"
  | "BILLING_RECEIVER_SET"
  | "INVOICE_PAID"
  | "INVOICE_VOID"
  | "BILLING_PAYMENT_RESOLVE"
  // Mua thêm hạn mức + hoá đơn VAT (0192): đơn giá mua thêm của gói, sửa phần đã mua của một tổ chức, khách khai thông tin
  // xuất hoá đơn, người vận hành ghi số hoá đơn VAT đã xuất.
  | "ADDON_PRICE_SET"
  | "ORG_ADDONS_SET"
  | "INVOICE_INFO_SET"
  | "INVOICE_VAT_ISSUED"
  // Số dư AI (0235, `lib/billing/ai-balance.ts`): người vận hành điều chỉnh / tặng / hoàn số dư của một tổ chức — bắt buộc lý do.
  | "AI_BALANCE_ADJUST"
  // Người vận hành tạo liên kết đặt lại mật khẩu cho tài khoản của tổ chức khách (0191, lib/users/password-reset.ts).
  | "PASSWORD_RESET_LINK"
  // Chủ nền tảng khai chi phí hạ tầng / hỗ trợ khách theo tháng (0203, lib/platform/saas-ledger.ts) — mẫu số biên lợi nhuận.
  | "PLATFORM_COSTS_SET"
  // Nền móng giá & thu phí (0222, lib/pricing/admin.ts): sửa phần thương mại của gói (tên · hạn mức tháng · tính năng ·
  // chính sách vượt), ghi đè giá / tính năng / mức áp của một tổ chức, ngưỡng Margin Guard, bảng giá đơn vị AI ghi đè.
  | "PLAN_COMMERCIAL_SET"
  | "ORG_PRICING_SET"
  | "PRICING_GUARD_SET"
  | "AI_UNIT_PRICES_SET"
  // SaaS Control Plane (0224, lib/saas/*): tài khoản khách, gắn workspace vào tài khoản, thuê bao sản phẩm (thuê · tạm dừng ·
  // tiếp tục · huỷ · hẹn đổi gói), sổ chi phí ngoài AI, chốt bảng kê kỳ, job cấp phát (chạy / chạy lại).
  | "ACCOUNT_CREATE"
  | "ACCOUNT_UPDATE"
  | "WORKSPACE_ACCOUNT_SET"
  | "PRODUCT_SUBSCRIBE"
  | "PRODUCT_SUBSCRIPTION_SET"
  | "COST_ENTRY_ADD"
  | "COST_ENTRY_VOID"
  | "STATEMENT_FINALIZE"
  | "PROVISIONING_RUN"
  // Bảng giá có phiên bản (0228, lib/pricing/price-book.ts): phát hành một phiên bản giá mới (sửa giá = phiên bản mới, không
  // sửa dòng cũ) và ghim / chuyển một tổ chức sang một phiên bản giá.
  | "PRICE_VERSION_PUBLISH"
  | "PRICE_VERSION_PIN"
  // Platform AI Model Control (06/10/2026, lib/ai-usage/platform-ai-admin.ts): kiểm khả dụng một model bằng khoá nền tảng,
  // đặt chính sách model của AI dùng chung (chạy thử canary · áp dụng), hoàn tác về bản trước.
  | "PLATFORM_AI_MODEL_PROBE"
  | "PLATFORM_AI_POLICY_SET"
  | "PLATFORM_AI_POLICY_ROLLBACK";
export type PlatformAuditSource = "UI" | "SCRIPT" | "MIGRATION" | "TEST";
export type PlatformActor = { orgCode: string; userId: string; email: string } | null;

export async function platformAudit(entry: {
  action: PlatformAuditAction;
  targetOrgCode: string;
  /** Thao tác ở cấp tài khoản (0224). */
  targetAccountId?: string | null;
  subject: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  source: PlatformAuditSource;
  actor: PlatformActor;
}): Promise<void> {
  const db = await getPlatformDb();
  await db.insert(schema.platformAuditLog).values({
    actorOrgCode: entry.actor?.orgCode ?? null,
    actorUserId: entry.actor?.userId ?? null,
    actorEmail: entry.actor?.email ?? null,
    targetOrgCode: entry.targetOrgCode,
    targetAccountId: entry.targetAccountId ?? null,
    action: entry.action,
    subject: entry.subject,
    before: entry.before === undefined ? null : entry.before,
    after: entry.after === undefined ? null : entry.after,
    reason: entry.reason ?? null,
    source: entry.source,
  });
}
