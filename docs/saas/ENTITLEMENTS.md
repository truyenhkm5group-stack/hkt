# Entitlement — Product → Capability → Feature

Hiệu lực của một tính năng trên một workspace = **ba chiều độc lập, đọc ở ba chỗ đã có, GHÉP ở `lib/saas/entitlements.ts`**:

| Chiều | Câu hỏi | Nguồn |
|---|---|---|
| Thương mại | thuê bao sản phẩm có cho dùng không (`ACTIVE` · `TRIAL` · `PAST_DUE`) | `platform_product_subscriptions` + thu phí (`policy.ts`) |
| Kỹ thuật | module của khả năng có bật không | `platform_organization_modules` (`lib/platform/capabilities.ts`) |
| Gói | gói (+ ghi đè, + giữ từ trước) có tính năng không | `lib/pricing/features.ts` (#612) |

- Hạn mức (quota, kỳ tháng): `checkUsageQuota` (#612) — mặc định không chặn.
- Ghi đè theo khách: `platform_org_pricing` (#612).
- **Cờ tính năng ≠ entitlement**: `platform_flag_overrides` là công tắc kỹ thuật (tung dần, tắt khẩn), không đi qua đây.
- **Không so tên gói** ở mã sản phẩm (#612 quét mã nguồn).
- Huỷ thuê bao thu hồi quyền dùng THẬT: job huỷ tắt module độc quyền của sản phẩm (lõi thương mại mà sản phẩm khác cần thì
  giữ). Tạm dừng chỉ đổi tình trạng — module giữ, năng lực do `productContext().grantsUse` báo.

Đặc biệt còn lại của workspace nhà trong mã cũ (đã kiểm kê, CHƯA gỡ — `PLAN.md` Phase 14): `planKeyOf` (nhà ⇒ gói
`internal`), `resolvePlan` / `checkEntitlement` / `checkAiQuota` (nhà không giới hạn), `featureGranted` nhánh HOME. Kết quả
của chúng TRÙNG với chính sách tài khoản nội bộ hiện tại (gói `internal` không giới hạn, mọi tính năng), nên đợt này không
đổi hành vi; gỡ là đổi sang đọc gói `internal` qua cùng đường với khách ngoài, có bài kiểm so trước/sau.
