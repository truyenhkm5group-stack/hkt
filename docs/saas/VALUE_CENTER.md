# Trung tâm giá trị SaaS — đặc tả V1

Sứ mệnh `saas-value-core` (mẹ: `saas-value-center`). PR-1 chỉ có **sổ chỉ số + hàm thuần**: không bảng, không màn hình,
không đọc CSDL. Ảnh chụp theo ngày là PR-3, màn hình là PR-4, rủi ro rời bỏ chạy thật trên ảnh chụp từ PR-3/PR-5.

| Tệp | Vai trò |
|---|---|
| `lib/constants/tenant-value-metrics.ts` | Sổ chỉ số grain TỔ CHỨC (`TENANT_VALUE_METRICS`), `OPERATOR_KEYS` / `CUSTOMER_KEYS` dẫn xuất, 12 quyết định mặc định tạm (`TENANT_VALUE_DEFAULT_DECISIONS`), `TENANT_VALUE_VERSION` |
| `lib/constants/churn-risk.ts` | Mã lý do rủi ro rời bỏ + bảng ánh xạ mã → mức ở MỘT chỗ, `CHURN_RULE_VERSION` |
| `lib/saas/tenant-value.ts` | `buildTenantValue(...)` — hàm thuần ghép mọi khoá có số; `snapshotsComparable(...)` |
| `lib/saas/tenant-health-rules.ts` | `healthOf(...)`, `churnRiskOf(...)`, `topIssueOf(...)` — hàm thuần, mức + mã lý do, không điểm |
| `tests/saas-value-center.test.ts` | Khoá các bất biến bên dưới (chạy trong `npm test`) |

Luật đọc kèm: `docs/business-rules/ORDER_OUTCOME.md` (kết cục đơn — KHÔNG viết lại ở đây), AGENTS.md mục 8 · 37–45 · 42.

---

## 1. Tám câu hỏi kinh doanh ↔ khoá chỉ số

| # | Câu hỏi | Khoá trả lời | Ghi chú |
|---|---|---|---|
| 1 | Khách trả ChotDonTuDong bao nhiêu? | `customer_spend_recognized` (ghi nhận) · `customer_spend_cash` (tiền đã thu) · thành phần: `saas_subscription_revenue`, `ai_balance_revenue`, `ai_overage_billed`, `ai_balance_topup_cash`, `ai_balance_promo_used` | Bốn dòng tiền không trộn — §2 |
| 2 | AI tạo / tác động bao nhiêu đơn & doanh thu? | `ai_auto_closed_orders`, `ai_assisted_orders`, `ai_influenced_orders`, `ai_auto_closed_delivered_revenue`, `ai_assisted_delivered_revenue`, `ai_influenced_delivered_revenue`, `ai_credited_delivered_revenue`; chồng: `ai_recovered_orders`, `ai_recovered_delivered_revenue` | «Tác động» ≠ «công» — §3 |
| 3 | Giá trị kinh tế khách nhận? | `ai_credited_gross_profit` + `ai_credited_cogs_coverage`; riêng: `staff_cost_saved`, `staff_hours_saved` | Tiết kiệm nhân sự in RIÊNG (D4) |
| 4 | Khách nhận giá trị tốt hay kém? | `customer_value_multiple`, `customer_roi` (+ chất lượng: `conversion_rate`, `human_intervention_rate`, `response_p50_ms`) | Ước tính; độ phủ giá vốn < 80% ⇒ `null` (D3); chỉ ở cửa sổ 90 ngày (D12) |
| 5 | CDTĐ lãi bao nhiêu trên khách? | `platform_contribution` (đóng góp sau chi phí AI — spec 11 §6), `platform_gross_profit` + `platform_gross_profit_ceiling`, `platform_gross_margin`, `actual_ai_cogs`, `variable_cogs_known` | Chỉ người vận hành. Phí thanh toán chưa khai (D6) ⇒ lãi gộp `null`, in cận trên |
| 6 | Nguy cơ rời bỏ? | `churn_risk` = `churnRiskOf(...)` | Mức + mã lý do, thiếu tín hiệu ⇒ `UNKNOWN` |
| 7 | Vấn đề lớn nhất cần tối ưu hôm nay? | `top_issue` = `topIssueOf(...)` | Mã nặng nhất + lối ra hành động |
| 8 | Sau tối ưu cải thiện bao nhiêu? | `post_optimization_delta` — **UNAVAILABLE tới PR-6** | Cách đo V1: so hai ảnh chụp CÙNG cửa sổ và CÙNG `formulaVersion` (`snapshotsComparable`); khác ⇒ «không so được», không vẽ mũi tên |

Không có chỉ số nào tên «lợi nhuận tăng thêm do AI» trong V1: `ai_incremental_profit` khai **UNAVAILABLE** — cần nhóm đối
chứng (nhánh người chia ngẫu nhiên, `ai_sales.experiment_conversion_lift`, đủ mẫu, cùng cửa sổ). «Doanh thu AI tác động» chỉ
là doanh thu của đơn có AI tham gia, không phải phần tăng thêm.

---

## 2. Bốn dòng tiền khách — không trộn

| Dòng | Khoá | Nguồn | Là doanh thu? |
|---|---|---|---|
| Tiền đã thu | `customer_spend_cash` | `platform_invoices` PAID theo `paid_at` + TOPUP CASH | Không — là dòng tiền (gồm tiền trả trước) |
| Doanh thu ghi nhận | `customer_spend_recognized` | Σ ngày `mrr_vnd × 12 / 365` + `aiBalanceRevenueVnd` (AI_USAGE CASH − đảo) + dòng vượt bảng kê | **Có** — cơ sở mặc định của biên / bội số (D1) |
| Số dư AI | `ai_balance_topup_cash` · `ai_balance_promo_used` · `ai_balance_revenue` | `platform_ai_ledger_entries` | TOPUP = nợ phải trả; PROMO = không; AI_USAGE từ CASH = có |
| Giá vốn nhà cung cấp | nhóm `COGS` | `platform_ai_usage` (ước tính theo bảng giá) + `platform_cost_entries` | — (chi phí) |

BYOK là tiền khách tự trả nhà cung cấp — không vào cột nào. Hoá đơn ADDON đã nằm trong MRR — không cộng thêm.
Ngày vắng trong `platform_saas_daily` = CHƯA CHỤP: khách trả là cận dưới (`bound = LOWER`) và **không** dùng để chia ra biên /
bội số.

Doanh thu thuần của khách (doanh thu quy cho AI) đi qua `ORDER_OUTCOME` (`loadOrderAttribution` → `orderFactsOf`): đơn huỷ /
hoàn / chưa ngã ngũ không có doanh thu đã giao. Bộ ghép không đọc `stage`, không kết luận «giao thành công» — bài kiểm quét mã.

---

## 3. Quy kết đơn

Bốn nhãn CHÍNH loại trừ nhau (định nghĩa giữ nguyên ở `attributeOrder`, `ATTRIBUTION_VERSION`):

| Nhãn hiển thị | Khoá | Nhãn trong mã |
|---|---|---|
| AI tự chốt (AI_AUTO_CLOSED) | `ai_auto_closed_orders` | `AI_ONLY` |
| AI góp công (AI_ASSISTED) | `ai_assisted_orders` | `AI_ASSISTED` |
| Người bán (HUMAN_ONLY) | `human_only_orders` | `HUMAN_ONLY` |
| Chưa quy kết (UNATTRIBUTED) | `unattributed_orders` | `null` — CHƯA BIẾT, **không phải người** |

**Bất biến kiểm thử:** bốn số cộng = `attributed_orders_total` = số đơn có `order.confirmed` trong kỳ. Lượt chụp truyền thêm
đếm độc lập (`confirmedOrdersInPeriod`) ⇒ `checks.attributionSumMatches` báo lệch thay vì im lặng.

**Thuộc tính chồng** (`overlay: true`) — tập con của bốn nhãn, KHÔNG BAO GIỜ cộng vào tổng: `ai_recovered_orders`,
`ai_recovered_delivered_revenue`, `ai_upsell_orders` (UNAVAILABLE tới PR-2), `incremental_upsell_revenue_delivered`
(UNAVAILABLE tới PR-2 — hiện bộ đọc cộng cả lời nhận của đơn huỷ / hoàn).

**AI tác động ≠ công của AI:**

- `ai_influenced_*` = tự chốt + góp công. Nhãn «AI tác động», KHÔNG phải công.
- `ai_credited_*` = tự chốt + c × góp công, c = D2. Mặc định tạm c = `null` ⇒ chỉ tự chốt, góp công in riêng
  (`ai_assisted_delivered_revenue`), ô mang `provisional = true`.

`ai_influenced_delivered_revenue` bằng đúng `revenue_attributed_to_ai` của 8 KPI giá trị (`lib/pricing/value-kpis.ts`) — bài
kiểm khoá hai số bằng nhau để không thành công thức thứ hai.

---

## 4. Một ô giá trị

`buildTenantValue` trả mỗi khoá có số một ô:

| Trường | Nghĩa |
|---|---|
| `value` | `null` = CHƯA BIẾT (luật 42). Không bao giờ thay bằng 0. |
| `state` | `VALUE` · `UNKNOWN` · `NOT_APPLICABLE` (in N/A — vd chargeback nội bộ, khách chưa trả tiền, cửa sổ không phải cửa sổ bội số) |
| `availability` | `MEASURED` · `ESTIMATED` (chi phí AI theo bảng giá, bội số) · `UNAVAILABLE` (luôn `null`, `note` = missingWhat) |
| `bound` | `EXACT` · `LOWER` (số thật có thể lớn hơn — chi phí có lượt chưa định giá) · `UPPER` (số thật có thể nhỏ hơn — cận trên lãi gộp, tỷ số trên chi phí cận dưới) |
| `provisional` | Đang chạy theo một quyết định CHƯA chốt |
| `numerator` / `denominator` / `coverage` / `note` | Tử, mẫu, độ phủ, câu cho tooltip |

Ô PERCENT lưu dạng tỷ lệ 0..1. `platform_gross_margin` = `customerEconomicsCore.marginPct / 100`.

**Lãi gộp nền tảng** gọi thẳng `customerEconomicsCore` (lib/saas/policy.ts): chi phí còn khoản chưa biết (lượt AI chưa định giá,
chi phí khác chưa có số, phí thanh toán chưa khai) ⇒ `platform_gross_profit = null`, `platform_gross_profit_ceiling` in cận
trên. `platform_contribution` là cùng hàm với phạm vi chi phí của spec 11 §6 (chỉ AI nền tảng trả).

**Thiếu giá vốn hàng:** `ai_credited_gross_profit = null` khi độ phủ (`costedRevenue ÷ deliveredRevenue`) dưới ngưỡng D3;
độ phủ luôn in cạnh. Không suy lợi nhuận.

---

## 5. Chất lượng đứng cạnh chi phí

`conversion_rate`, `human_intervention_rate`, `ai_error_rate`, `lead_capture_rate`, `response_p50_ms` / `response_p90_ms`,
`model_latency_p50_ms` nằm trong cùng ảnh chụp với `cost_per_*`. **Mọi khuyến nghị giảm chi phí (đổi model, rút prompt, bớt
công cụ…) phải kèm điều kiện không giảm tỷ lệ chốt** — đo trước / sau trên cùng cửa sổ và cùng phiên bản công thức; con đường
đổi model vẫn đi DUY NHẤT qua Platform AI Model Control + `AB_RULES` (chốt / SĐT / địa chỉ không được giảm quá 5% tương đối).
Không tối ưu chi phí token bằng cách hy sinh tỷ lệ chốt.

Hai đồng hồ độ trễ không gộp: `response_*` (tin khách → câu trả lời, gồm công cụ) khác `model_latency_p50_ms` (một lời gọi model).

---

## 6. Sức khoẻ V1 · rủi ro rời bỏ · vấn đề lớn nhất

**Không điểm /100** (spec 11 §7, D9). Mức là thứ bậc; mỗi mức ≥ 1 mã lý do; mỗi mã có câu giải thích tiếng Việt.

`healthOf({ base, value, usage })` — dùng lại `CUSTOMER_HEALTH_LEVELS` / `HEALTH_REASONS` / `HEALTH_GAPS` của `classifyCustomer`
(đưa vào bằng `baseHealthFrom`), chồng thêm lý do giá trị:

| Mã | Mức | Khi nào |
|---|---|---|
| `VALUE_BELOW_SPEND` | Cần chú ý | bội số < 1 (đủ độ phủ D3) |
| `USAGE_TREND_DOWN` | Cần chú ý | hội thoại giảm ≥ ngưỡng D8 so cửa sổ trước (cửa sổ trước ≥ mẫu tối thiểu) |
| `NO_AI_ORDERS` | Cần chú ý | ≥ mẫu tối thiểu hội thoại mà 0 đơn AI tự chốt / góp công |
| `ALL_SIGNALS_OK` · `SIGNALS_MISSING` · `INACTIVE` | Khoẻ · Chưa đủ dữ liệu · Đã dừng | mã kết luận |

Tín hiệu bắt buộc (thiếu ⇒ `UNKNOWN`, không bao giờ «Khoẻ»): phân loại vận hành, ảnh giá trị, xu hướng dùng. Tín hiệu tuỳ chọn
(chỉ in chỗ chưa đo): bội số giá trị — đa số khách chưa đủ giá vốn, chặn «Khoẻ» vì nó là phạt khách vì thiếu dữ liệu của chính họ.

`churnRiskOf({ health, subscription, usage, value })` — bảng `CHURN_REASONS` (lib/constants/churn-risk.ts):

| Mã | Mức |
|---|---|
| `PRODUCT_DOWN` (sức khoẻ Nguy cấp) | CRITICAL |
| `PAID_THEN_EXPIRED` | CRITICAL |
| `PAST_DUE_AND_USAGE_DOWN` | HIGH |
| `NO_LOGIN_AND_INBOUND_DROP` | HIGH |
| `USAGE_TREND_DOWN` | MEDIUM |
| `VALUE_BELOW_SPEND` | MEDIUM |
| `NOT_ACTIVATED_AFTER_GRACE` | MEDIUM |
| `NO_RISK_SIGNAL` | LOW — chỉ khi MỌI tín hiệu bắt buộc đọc được |
| `REQUIRED_SIGNAL_MISSING` · `INACTIVE` | UNKNOWN |

Mức = mức nặng nhất của các mã đã bật; một mã đã bật vẫn quyết định dù tín hiệu khác thiếu. Tín hiệu bắt buộc: sức khoẻ,
tình trạng thuê bao, xu hướng dùng; bội số là tuỳ chọn. Đổi bảng / ngưỡng ⇒ tăng `CHURN_RULE_VERSION`.

`topIssueOf({ orgCode, accountCode, health, churn })` — xếp: Nguy cấp / CRITICAL → HIGH → Cần chú ý / MEDIUM → chỗ chưa đo bắt
buộc → tuỳ chọn; cùng hạng thì lý do sức khoẻ (cụ thể) trước mã rủi ro (dẫn xuất). Lối ra: `/platform/org/<mã tổ chức>` cho
việc kỹ thuật, `/platform/customers/<mã tài khoản>` cho thu phí / giá trị. Không vấn đề có chứng cứ ⇒ `null`.

---

## 7. Mười hai quyết định của chủ shop

Mặc định tạm đang chạy khai ở `TENANT_VALUE_DEFAULT_DECISIONS` (`provisional: true`); mọi chỗ dùng đọc từ đó
(`DEFAULT_TENANT_VALUE_DECISIONS`), không gõ lại số — bài kiểm quét hai tệp hàm thuần.

| # | Câu hỏi | MẶC ĐỊNH TẠM đang chạy | Ảnh hưởng | Hạn quyết | Hệ quả nếu đổi |
|---|---|---|---|---|---|
| D1 | «Khách trả» cho biên / bội số theo ghi nhận hay tiền về? | Ghi nhận (MRR theo ngày + Số dư đã dùng + vượt); tiền về in cạnh | CAO | 13/10/2026 (trước PR-4 lên production) | Tiền về: biên / bội số nhảy theo ngày khách trả; tăng `TENANT_VALUE_VERSION` |
| D2 | AI được bao nhiêu phần công trong đơn góp công? | c = null — chỉ tự chốt, góp công in riêng | CAO | 13/10/2026 | Đặt c: doanh thu / lãi gộp quy công và bội số tăng c × góp công; ảnh chụp khác phiên bản |
| D3 | Thiếu giá vốn hàng thì sao? | Để riêng; độ phủ ≥ 80% mới in lãi gộp cho bội số / tỷ số | CAO | 13/10/2026 | Hạ ngưỡng: nhiều bội số hơn nhưng lãi gộp thiếu phần lớn hơn; ước tính bằng biên khai phải nhãn ESTIMATED + nguồn khai |
| D4 | Tử số giá trị khách nhận? | Lãi gộp quy công cho AI; tiết kiệm nhân sự in RIÊNG | CAO | 13/10/2026 | Cộng nhân sự: bội số chỉ có ở tổ chức đã khai chi phí người |
| D5 | Phút người / hội thoại cho giờ công? | Không mặc định nền tảng (null ⇒ `staff_hours_saved` chưa tính) | TB | 20/10/2026 | Mặc định nền tảng: mọi tổ chức có số giờ nhưng là ước tính chung |
| D6 | Phí thanh toán? | UNAVAILABLE — không đoán; lãi gộp nền tảng null + cận trên | TB | 20/10/2026 | Khai % / 0 có căn cứ: lãi gộp nền tảng có số khi chi phí AI đủ |
| D7 | Lead đủ điều kiện? | Hội thoại khách đã để lại SĐT (tầng `identified`) | TB | 20/10/2026 | SĐT + địa chỉ / đã báo giá: lead giảm, chi phí / lead tăng; cần cột phễu mới |
| D8 | Ngưỡng rủi ro rời bỏ? | Bảng ánh xạ §6; giảm dùng = giảm ≥ 50% hội thoại so cửa sổ trước, cửa sổ trước ≥ 10 (`AI_SALES_MIN_SAMPLE`) | TB | 20/10/2026 | Tăng `CHURN_RULE_VERSION`; mức hai bên mốc không so trực tiếp |
| D9 | Điểm /100? | KHÔNG — mức + mã lý do | THẤP | 31/10/2026 | Chỉ khi có trọng số chủ shop khai + độ phủ in cạnh; ≥ 10 tổ chức đã rời mới kiểm chứng được |
| D10 | Phân bổ hạ tầng / hỗ trợ về tổ chức? | Không phân bổ trong V1 (spec 11 §6), in ở cấp nền tảng | TB | 31/10/2026 | Xem mâu thuẫn bên dưới — phải sửa cùng lúc nơi còn lại |
| D11 | Tỷ giá USD→VND cho chi phí AI? | Đọc nguồn sẵn có (`FACEBOOK_USD_VND`), in nhãn `fxSource` | THẤP | 31/10/2026 | Tỷ giá riêng: chi phí AI quy ₫ đổi — là đổi NGUỒN, ghi vào `formulaVersion` |
| D12 | Cửa sổ mặc định? | 30 ngày; bội số 90 ngày | THẤP | 31/10/2026 | Cửa sổ ngắn: nhiều đơn chưa ngã ngũ, bội số dao động |

**Mâu thuẫn D10 (chưa sửa ở PR này):** `lib/saas/allocation.ts` chia hạ tầng / hỗ trợ nền theo `EQUAL_ACTIVE_WORKSPACES` (dùng
ở `customerEconomicsCore` của `/platform/customers`), trong khi spec 11 §6 và tooltip `/platform/saas` nói «không phân bổ về
từng tổ chức». Trung tâm giá trị theo spec (`infra_allocated_cogs` UNAVAILABLE) ⇒ biên trên `/platform/customers` và biên ở
đây có thể khác nhau cho cùng khách cho tới khi chủ shop chọn một luật và PR-8 hợp nhất.

**Đề xuất D11:** khai `platform_settings['platform.economics.fx']` = `{ usdToVnd, setBy, reason, at }` riêng cho chi phí AI,
thay cho biến của quảng cáo; tới lúc đó mọi số chi phí AI in kèm «tỷ giá: ENV_FACEBOOK_USD_VND».

---

## 8. Gọi `buildTenantValue` từ lượt chụp (PR-3)

```ts
buildTenantValue({
  window: 7 | 30 | 90,
  marginApplicable: marginApplicable(account.billingMode),
  fx: { rateVndPerUsd: env.facebook.usdToVnd, source: "ENV_FACEBOOK_USD_VND" },
  spend: { mrrAccrualVnd, mrrDaysMissing, aiBalanceRevenueVnd, overageBilledVnd, cashInvoicesVnd, cashTopupVnd, promoUsedVnd } | null,
  cogs: { aiPlatformVnd, aiUnpricedCalls, aiVisionVnd, otherVariableVnd, paymentFeeVnd } | null,
  attribution: await loadOrderAttribution({ days, now }) | null,        // trong withOrganization(code, …)
  confirmedOrdersInPeriod,                                               // đếm độc lập order.confirmed trong kỳ (tuỳ chọn)
  perf: await loadAiSalesPerformance(code, { days, now, withMoney: true }) | null,
  aiCalls: { total, errors, modelLatencyP50Ms } | null,
  decisions: undefined,                                                  // mặc định tạm; truyền khi chủ shop đã chốt
});
```

- Nguồn nào lỗi thì truyền `null` cho nguồn đó (và ghi `source_errors`) — chỉ các ô của nguồn ấy thành `null`.
- `aiPlatformVnd` là MỌI workload billing_source PLATFORM (trừ BLOCKED_QUOTA); phần bán hàng đọc từ `perf.cost`.
- `otherVariableVnd` = Σ khoản khai DIRECT; không khoản nào ⇒ 0; có khoản chưa biết số ⇒ `null`.
- `overageBilledVnd`: bảng kê theo tháng lịch — cửa sổ 7/30 không cắt được thì truyền `null` (khách trả ghi nhận `null`), khách
  trả trước ⇒ 0 thật.
- Lưu `formulaVersion` (`tv<n>.attr<n>`) và `CHURN_RULE_VERSION` vào ảnh chụp; hai ảnh khác phiên bản không so (luật 40).
- Ảnh giá trị là số CHÍN DẦN — không dùng làm số của kỳ đã chốt (luật 21).
