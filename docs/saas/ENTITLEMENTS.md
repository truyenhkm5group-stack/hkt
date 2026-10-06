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

## Workspace nhà đi CÙNG đường của khách (Phase 14 — `tests/saas-internal-plan.test.ts`)

Quyết định giá V1 (07/10/2026): VNXCommerce dùng CÙNG gói / entitlement / đồng hồ như khách ngoài; không có gói ẩn vô hạn
trong mã; `billing_mode` vẫn `INTERNAL_CHARGEBACK`.

**Đường resolver nhà đang đi** (giống hệt mọi khách — gán gói khác cho nhà KHÔNG cần sửa mã ở đây):

1. `lib/entitlements/check.ts::planKeyOf(org)` = cột `platform_organizations.plan` — gói đã gán LUÔN thắng. Cột trống ⇒
   `trial`, riêng nhà ⇒ `internal` (nhánh khả dụng, xem bảng GIỮ). 0225 ghi cột của nhà = `internal` — đúng gói mã cũ tự
   gán — và chỉ ghi khi cột còn trống.
2. `effectivePlanRow(plans, key)` — dòng `platform_plans` của khoá đó; vắng ⇒ `trial` + `fellBack` (không khoá nào riêng).
3. Hạn mức kỹ thuật: `resolvePlan` → `checkEntitlement` / `getPlanUsage`.
4. Thương mại: `lib/pricing/entitlements.ts::resolveOrgPricing` (gói → ghi đè `platform_org_pricing` → giữ từ trước) →
   `hasFeature` / `featureDecisions` / `checkUsageQuota`; `featureGranted` không còn bậc HOME.
5. Trang `/settings/plan` (`lib/pricing/customer.ts::planPageFrame`): khung THANH TOÁN hiện khi workspace có thể bị khoá
   thanh toán — `lib/saas/policy.ts::billingLockApplies`, CÙNG vị từ mà cổng ghi `lib/auth/session.ts` dùng để khoá (bị khoá
   ⇒ luôn có mã QR gia hạn, kể cả workspace khách nằm trong tài khoản chargeback); khung «Hạn mức tháng này» hiện khi có
   khung thanh toán HOẶC gói đang gán còn một ô có trần.

Gán gói khác cho nhà = một lượt ghi vào cột `plan` của nhà. HÔM NAY chưa có đường ghi nào làm được việc đó:
`setOrganizationPlan` (`lib/platform/org-plan.ts:31`) và đường khớp tiền gia hạn (`lib/billing/service.ts:492`) đều TỪ CHỐI
đổi gói của nhà. Phase D mở đường ghi (có chạy thử) hoặc ghi qua migration — resolver không phải sửa. Bài so trước / sau so
hành vi mã cũ với gói `internal` ĐANG gán; gán gói khác cho nhà thì bài ấy phải đổi theo (đó là thay đổi hành vi có chủ đích).

Ghi chú (không đổi ở Phase 14, áp cho MỌI workspace như trước): `listPlans()` nuốt lỗi đọc thành `[]` ⇒ `resolvePlan` trả
`null` ⇒ `checkEntitlement` từ chối «Không đọc được gói dịch vụ…».

**Nhánh `isHome` đã gỡ** (thương mại): `planKeyOf` (gói đã gán), `resolvePlan`, `checkEntitlement`, `PlanUsage.isHome`,
`resolveOrgPricing` (dòng ghi đè + hạn mức tháng), `OrgPricing.isHome`, `checkUsageQuota`, `featureGranted` (bậc HOME),
`loadCustomerPlan`, trang `/settings/plan` (ba chỗ). Hệ quả hiển thị duy nhất: nguồn tính năng của nhà in «Theo gói» thay
cho «Tổ chức nhà»; dòng mô tả gói in «không thu phí, không giới hạn» thay cho «tổ chức nhà, không giới hạn».

**Nhánh `isHome` GIỮ** (và vì sao):

| Ở đâu | Vì sao giữ |
|---|---|
| `lib/entitlements/check.ts::planKeyOf` — cột gói TRỐNG ở nhà ⇒ `internal` | AN TOÀN KHẢ DỤNG: `instrumentation.node.ts` gọi `ensureMigrated()` không đợi, nên trong lượt deploy mang 0225 có request tới trước khi cột được ghi; nếu migration khác cùng lô lỗi, drizzle hoàn cả lô. Rơi về `trial` lúc đó là khoá ERP đang vận hành của nền tảng (3 người dùng · 5 trang · 50 MB). Chỉ chạy khi cột trống — gói đã gán luôn thắng. Bài kiểm: nhà với cột trống ra đúng 64 quyết định cũ. |
| `lib/saas/policy.ts::billingLockApplies` (dùng ở `lib/auth/session.ts` VÀ `lib/pricing/customer.ts`) | AN TOÀN / thu phí: nền tảng không thu phí chính nó nên nhà không bị khoá thanh toán. Một vị từ cho cả khoá lẫn khung gia hạn — hai chỗ không thể nói hai điều khác nhau. Không đọc `billing_mode` (khoá đọc thuê bao). |
| `lib/ai-usage/quota.ts:40,84` (`resolveAiLimits`, `checkAiQuota`) + `ai.limits.isHome` ở `/settings/plan` | AN TOÀN credential: đi cùng nguồn AI `HOME` (khoá AI của nhà chỉ dành cho nhà, dòng 85). Đưa nhà qua `evaluateAiQuota` với gói hiện tại (`platformCreditUsdPerMonth = 0`) sẽ chặn AI của nhà. Gỡ cần tách «ai được dùng khoá nhà» khỏi «hạn mức AI» — phase D. |
| `lib/platform/org-plan.ts:31`, `lib/billing/service.ts:245–865` | Ngoài phạm vi (phase D sở hữu `lib/billing/**`): chặn đổi gói / thu phí / mua thêm cho nhà — là cái GIỮ cột gói của nhà ổn định sau 0225. |
| `lib/pricing/admin.ts:95,200,322` | Màn người vận hành: không ghi đè cho nhà; danh sách khách / kinh tế bỏ nhà. Không đổi quyết định nào của nhà. |
| `lib/billing/service.ts:949,956`, `lib/pricing/economics.ts:88` | KPI SaaS: MRR / chuyển đổi dùng thử không tính trung tâm chi phí nội bộ. |
| Credential nhà, kênh cảnh báo ISO-05, `platform:operate`, cô lập tổ chức (`getDb`), module mặc định của nhà, webhook | NỀN TẢNG / AN TOÀN — không thuộc Phase 14. |
