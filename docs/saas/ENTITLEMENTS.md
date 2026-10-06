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

**Đường resolver nhà đang đi** (giống hệt mọi khách — đổi gói của nhà KHÔNG cần sửa mã):

1. `lib/entitlements/check.ts::planKeyOf(org)` = cột `platform_organizations.plan` (trống ⇒ `trial`). 0225 ghi cột này cho
   nhà = `internal` — đúng gói mã cũ tự gán — và chỉ ghi khi cột còn trống.
2. `effectivePlanRow(plans, key)` — dòng `platform_plans` của khoá đó; vắng ⇒ `trial` + `fellBack` (không khoá nào riêng).
3. Hạn mức kỹ thuật: `resolvePlan` → `checkEntitlement` / `getPlanUsage`.
4. Thương mại: `lib/pricing/entitlements.ts::resolveOrgPricing` (gói → ghi đè `platform_org_pricing` → giữ từ trước) →
   `hasFeature` / `featureDecisions` / `checkUsageQuota`; `featureGranted` không còn bậc HOME.
5. Trang `/settings/plan`: khung tự thanh toán + «Hạn mức tháng này» theo `lib/pricing/customer.ts::loadPlanPageFrame`
   (= `policy.ts::selfServeBilling(billing_mode)` — chargeback nội bộ không trả tiền cho chính nền tảng).

Gán gói V1 cho nhà = ghi `platform_organizations.plan` của nhà (lưu ý: `setOrganizationPlan` và đường khớp tiền gia hạn
hiện TỪ CHỐI đổi gói của nhà — `lib/platform/org-plan.ts:31`, `lib/billing/service.ts:492`; phase D gỡ hoặc ghi qua
migration). Bài so trước / sau dựng từ dữ liệu, nên vẫn đúng khi gói đổi: nó so hành vi mã cũ với gói `internal` ĐANG gán.

**Nhánh `isHome` đã gỡ** (thương mại): `planKeyOf`, `resolvePlan`, `checkEntitlement`, `PlanUsage.isHome`,
`resolveOrgPricing` (dòng ghi đè + hạn mức tháng), `OrgPricing.isHome`, `checkUsageQuota`, `featureGranted` (bậc HOME),
`loadCustomerPlan`, trang `/settings/plan` (ba chỗ). Hệ quả hiển thị duy nhất: nguồn tính năng của nhà in «Theo gói» thay
cho «Tổ chức nhà»; dòng mô tả gói in «khách nội bộ, không giới hạn» thay cho «tổ chức nhà, không giới hạn».

**Nhánh `isHome` GIỮ** (và vì sao):

| Ở đâu | Vì sao giữ |
|---|---|
| `lib/ai-usage/quota.ts:40,84` (`resolveAiLimits`, `checkAiQuota`) + `ai.limits.isHome` ở `/settings/plan` | AN TOÀN credential: đi cùng nguồn AI `HOME` (khoá AI của nhà chỉ dành cho nhà, dòng 85). Đưa nhà qua `evaluateAiQuota` với gói hiện tại (`platformCreditUsdPerMonth = 0`) sẽ chặn AI của nhà. Gỡ cần tách «ai được dùng khoá nhà» khỏi «hạn mức AI» — phase D. |
| `lib/platform/org-plan.ts:31`, `lib/billing/service.ts:245–865` | Ngoài phạm vi (phase D sở hữu `lib/billing/**`): chặn đổi gói / thu phí / mua thêm cho nhà — là cái GIỮ cột gói của nhà ổn định sau 0225. |
| `lib/pricing/admin.ts:95,200,322` | Màn người vận hành: không ghi đè cho nhà; danh sách khách / kinh tế bỏ nhà. Không đổi quyết định nào của nhà. |
| `lib/billing/service.ts:949,956`, `lib/pricing/economics.ts:88` | KPI SaaS: MRR / chuyển đổi dùng thử không tính trung tâm chi phí nội bộ. |
| Credential nhà, kênh cảnh báo ISO-05, `platform:operate`, cô lập tổ chức (`getDb`), module mặc định của nhà, webhook | NỀN TẢNG / AN TOÀN — không thuộc Phase 14. |
