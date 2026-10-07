# Nền móng giá & thu phí — gói cấu hình được, đồng hồ đo, sổ chi phí AI, Margin Guard, entitlement

> Migration `0223_pricing_billing_foundation`. Mở rộng `0169` (gói) · `0176` (sổ AI) · `0187` / `0192` / `0194` (thu phí,
> bảng giá) · `0203` / `0204` (sổ kinh tế SaaS). Kiểm thử: `tests/pricing-billing.test.ts`. Đọc kèm `billing.md`, `pricing.md`.

## 0. Đã có · mở rộng · mới

| Yêu cầu | Đã có (giữ nguyên) | Mở rộng ở 0222 | Mới |
|---|---|---|---|
| Gói cấu hình từ CSDL | `platform_plans` (giá tháng, tặng tháng khi trả năm, hạn mức kỹ thuật, credit AI, đơn giá mua thêm), sửa giá ở `/platform` | cột `commercial` (jsonb): hiện ở /pricing, «Liên hệ», nổi bật, hạn mức THÁNG (fanpage · hội thoại AI · tin AI · đơn), tính năng, chính sách vượt, grace, mức áp từng ô; sửa tên / mô tả gói; gói `enterprise` «Doanh nghiệp» (không giá ⇒ Liên hệ) | khung sửa ở `/platform` → «Bảng giá» (`PlanCommercialForm`) |
| Giá năm | `yearly_free_months` + `billedMonths` (hoá đơn) | `yearlyPriceVnd()` dùng ĐÚNG `billedMonths` — không có cột giá năm thứ hai | — |
| Số ngày dùng thử | `TRIAL_DAYS` (nằm trong Điều khoản sử dụng) | `trialDaysOf()` đọc chính hằng số đó | — (cố ý KHÔNG có ô CSDL thứ hai) |
| Đồng hồ đo | `platform_ai_usage` (lượt AI), `platform_tenant_usage_daily` + `readOrgUsage` (hội thoại, tin, đơn AI) | `event_key` (chỉ mục duy nhất theo tổ chức), `conversation_id`, `modality`; `fanpages_active` | `lib/pricing/meter.ts` (sổ đồng hồ, kỳ tháng VN), `lib/platform/usage-meter.ts::readPeriodUsage` |
| Sổ chi phí AI | `platform_ai_usage.cost_usd` (định giá lúc ghi theo bảng trong mã, NULL = chưa biết) | `recordAiUsage` nhận khoá sự kiện ⇒ `{ recorded }`; `modelPriceTable()` (bản sao chỉ đọc) | `lib/pricing/unit-prices.ts`: bảng giá ESTIMATED + ghi đè của người vận hành (`platform.ai.unit-prices`) |
| Kinh tế SaaS | `/platform/saas` (MRR, ARR, biến động, NRR/GRR, vòng đời, biên nền tảng, kích hoạt) | — | khung «Kinh tế đơn vị & Margin Guard»: chi phí AI nền tảng tới nay + chiếu, lãi gộp sau AI + hạ tầng, ARPU, AI / tổ chức / đơn / hội thoại, dùng thử → trả tiền, nguy cơ âm biên, chi phí bất thường, đề xuất model |
| Margin Guard | trần tiền AI (`evaluateAiQuota`, chặn ở credit) | — | `lib/pricing/guard.ts` (50/80/100, mềm/cứng/grace/vượt, bất thường, đề xuất model) + `platform.pricing.guard` |
| Entitlement | hạn mức kỹ thuật (`checkEntitlement`), module theo tổ chức | — | `lib/pricing/features.ts` + `hasFeature()`; bảng `platform_org_pricing` (ghi đè, giữ từ trước, mức áp) |
| /pricing | bảng giá trong `/gioi-thieu#bang-gia` | `getPublicPricing()` (`lib/queries/public-pricing.ts`, đọc qua `public-site.ts`) | trang `/pricing` (công tắc Tháng / Năm, so sánh tính năng) |
| /settings/billing | `/settings/plan` (gói, thanh toán VietQR, lịch sử hoá đơn, mua thêm, VAT) | khung «Hạn mức tháng này» (`loadCustomerPlan`) | — (không dựng route thứ hai) |
| Cổng thu tiền | SePay → sổ ngân hàng nhà → `reconcileBillingPayments` | — | `lib/billing/provider.ts`: `BillingProvider` + bộ chuyển `SEPAY_BANK_TRANSFER` bọc đường đã có |

## 1. Gói

- Hạn mức tháng ở `commercial.quotas`; **người dùng** vẫn là `limits.users` (0169) — không khai hai lần. `undefined` = chưa
  khai (màn hình nói ra), `null` = không giới hạn.
- Giá tháng / tặng tháng vẫn sửa ở «Đổi giá…» (`setPlanPrice`) — không có đường thứ hai đổi giá.
- Seed 0222 (đề xuất ban đầu, sửa ở `/platform`): hội thoại AI / tháng theo credit AI của `pricing.md` (Dùng thử 120 · Cơ bản 180 ·
  Khởi đầu 360 · Tăng trưởng 950 · Chuyên nghiệp 1.800), tin AI ≈ 8 tin / hội thoại, fanpage 1 · 1 · 2 · 5 · 10, đơn không giới
  hạn (Dùng thử 50). Không gieo đơn giá vượt nào (luật 38): gói `BILL_OVERAGE` chưa khai giá ⇒ chỉ nhắc + nói rõ "chưa thu được".

## 2. Đồng hồ đo

Kỳ = **tháng lịch giờ VN**, trùng kỳ credit AI đã có. Hội thoại AI đếm **phân biệt cả kỳ** từ CSDL tổ chức (cộng số theo ngày sẽ
đếm hai lần hội thoại kéo dài hai ngày). Lỗi một nguồn ⇒ các đồng hồ của nguồn đó `null` + câu lỗi, không bao giờ 0.
«Lượt đọc ảnh» và «fanpage nối trước 0220» là `PARTIAL` (xem `METER_SPEC.missingWhat`).

**Khoá sự kiện:** `recordUsageEvent()` = `recordAiUsage()` với khoá bắt buộc. Cùng tổ chức + cùng khoá ⇒ không dòng thứ hai
(gói tin trùng, AI thử lại). Khoá dựng bằng `usageEventKey([...])` từ thành phần ỔN ĐỊNH của lời gọi.

## 3. Chi phí AI

`cost_usd` là chứng từ của lúc gọi (bảng giá trong mã, ESTIMATED). Bảng ghi đè của người vận hành chỉ dùng để ước tính lại
lượt có token mà chưa định giá và cho bộ đề xuất model — không sửa sổ. Khách KHÔNG thấy token / chi phí (`loadCustomerPlan`
không có trường nào như vậy — có kiểm thử).

## 4. Entitlement

`hasFeature(key)` — thứ tự: nhà ⇒ ghi đè ⇒ giữ từ trước ⇒ gói chưa khai (tạm cho dùng, nói ra) ⇒ gói. Mã nghiệp vụ không
bao giờ so tên gói — `tests/pricing-billing.test.ts` quét `lib/ app/ components/ chatbot/`. Tính năng ≠ module (module là cấu
hình người vận hành bật cho tổ chức). `/pricing` chỉ in tính năng `publicClaim: true` (cửa hàng tự đăng ký dùng được hôm nay;
`upsell`, `advanced_analytics`, `api`, `webhook` chưa in).

## 5. Margin Guard

Ngưỡng 50 (nhắc) · 80 (cảnh báo) · 100 (vượt ⇒ tính phí hoặc mời nâng gói tuỳ gói). **Không bao giờ tự ngắt AI ở ngưỡng mềm.**
Chặn chỉ khi đủ bốn điều kiện: công tắc trần cứng của nền tảng BẬT (mặc định tắt) · tổ chức mức `HARD` (mặc định `SOFT`) · ô
hạn mức của gói khai `HARD` · chính sách khác `SOFT_ONLY` — và đã vượt cả grace. Số dùng chưa biết không chặn.
Bất thường: chi phí hôm nay ≥ 3 × trung vị 14 ngày và hơn ≥ 0,5 USD; dưới 5 ngày lịch sử ⇒ CHƯA BIẾT. Đề xuất model: cùng họ,
rẻ hơn ≥ 30% theo token thật — chỉ đề xuất, không đổi cấu hình AI của ai.

## 6. Kinh tế đơn vị

Doanh thu = MRR danh nghĩa (ảnh chụp 0203). Chi phí = AI do nền tảng trả (BYOK là tiền của khách). Lãi gộp = MRR − AI chiếu cuối
tháng − hạ tầng đã khai; hỗ trợ khách chưa phân bổ về tổ chức. Nguy cơ âm biên = AI chiếu > MRR của chính tổ chức. Dùng thử →
trả tiền đọc từ sổ ảnh chụp, mẫu < 5 không in phần trăm. **AI / đơn giao thành công: CHƯA ĐO** (cần nối `ORDER_OUTCOME` trong
CSDL từng tổ chức lúc chụp sổ).

## 7. Cổng thu tiền

`BillingProvider { createSubscription, changePlan, cancelSubscription, recordPayment, handleWebhook }`. Một bộ chuyển:
`SEPAY_BANK_TRANSFER`. Mô hình "trả tới ngày" không tự trừ tiền: huỷ = huỷ hoá đơn đang mở, quyền dùng giữ tới hết kỳ + ân hạn.

## 8. Chuyển đổi

Mọi tổ chức khách có từ trước 0222 ⇒ một dòng `platform_org_pricing` `grandfathered = true`, `enforcement = 'SOFT'`: đủ tính năng,
không trần cứng. Gói, giá, `paid_through` không đổi. Tổ chức tạo sau đó đi theo gói.

## 9. Việc của phiên khác / còn lại

- **Nối đồng hồ vào đường gọi AI bán hàng** (`lib/sales-chatbot/*`, sứ mệnh `ai-sales-reliability`): truyền `eventKey`
  (`usageEventKey([conv.id, messageId, bước])`), `conversationId`, `modality` (`VISION` khi có ảnh) vào `recordAiUsage`; hỏi
  `checkUsageQuota("aiConversations")` / `hasFeature("ai_order_creation")` ở đúng điểm — mặc định không chặn.
- Thông báo chủ động (Lark / Telegram / in-app) khi qua 80% / 100% / bất thường — hôm nay chỉ hiện trên màn hình.
- Thu tiền phần vượt: chưa có hoá đơn `OVERAGE`; cần chủ nền tảng chốt đơn giá + kỳ thu.
- Cổng thẻ (VNPay / PayOS / Stripe) — dịch vụ ngoài, phải hỏi chủ nền tảng (AGENTS.md §7).

## 10. Bảng giá V1 có phiên bản (0228 · `docs/saas/PRICING_V1.md`)

- GIÁ không còn đọc thẳng từ `platform_plans` để lập hoá đơn: `platform_price_versions` + `platform_plan_prices` +
  `platform_price_pins`, resolver `lib/pricing/price-book.ts`. `platform_plans` giữ danh tính gói, hạn mức kỹ thuật
  (`checkEntitlement`, trần AI) và phần thương mại của gói CŨ.
- Tổ chức có từ trước 0228 ghim `legacy` (ảnh chụp đúng `platform_plans` lúc migrate) ⇒ số tiền không đổi. Tổ chức mới / đổi gói
  đi V1. Sửa giá = phiên bản mới (§«Đổi giá» ở trên giờ phát hành phiên bản, không sửa dòng).
- Đồng hồ thu chính: khách AI (`chotdon.ai_customers`, `lib/pricing/ai-customer.ts`). Hội thoại / tin AI ở §1–2 trở thành
  fair-use (không sinh phí). Ngưỡng cảnh báo khách AI 80 / 100 / 120 / 150 theo phiên bản; ngưỡng 50 / 80 / 100 của Margin
  Guard (§5) vẫn áp cho các ô hạn mức cũ.
- Mục «Thu tiền phần vượt» ở §9: đơn giá đã chốt (V1); phần vượt là ƯỚC TÍNH + dòng bảng kê truy vết được, chưa có hoá đơn
  `OVERAGE` tự động.
