# 11 · Chỉ số kinh tế SaaS của nền tảng

> Kinh tế của **chính VNXcommerce** (bán thuê bao cho nhiều cửa hàng), không phải của một cửa hàng. Mã:
> `lib/platform/saas-metrics.ts` (hàm thuần), `lib/platform/saas-ledger.ts` (đọc / ghi), `lib/platform/saas-cockpit.ts`
> (màn `/platform/saas`). Migration `0203_platform_saas_ledger`. Phiên bản công thức: `SAAS_METRICS_VERSION`.

## 1. Vì sao cần một sổ riêng

Gói (`platform_organizations.plan`) và hạn trả (`platform_subscriptions.paid_through`) là **trạng thái đổi được**.
Đọc chúng hôm nay chỉ trả lời được "MRR bây giờ". "MRR cuối tháng trước", "bao nhiêu MRR mới trong tháng",
"NRR" đều cần biết trạng thái **ở một thời điểm đã qua** — suy ngược từ trạng thái hiện tại là bịa (AGENTS §8.8).

Nên nền tảng chụp ảnh mỗi ngày:

| Bảng | Hạt | Ghi | Bất biến |
|---|---|---|---|
| `platform_saas_daily` | (ngày giờ VN, tổ chức) | `captureSaasSnapshot` — job `alerts` của nhà (≤ 1 lần / 6 giờ) + lượt mở `/platform/saas` (≤ 1 lần / 30 phút) | Dòng hôm nay còn ghi lại được (ảnh chụp cuối ngày thắng). Ngày đã qua: **không có đường mã nào ghi** |
| `platform_org_milestones` | (tổ chức, mốc) | cùng lượt chụp — chỉ mốc còn thiếu | Ghi một lần (`ON CONFLICT DO NOTHING`) |

Không backfill: sổ bắt đầu từ ngày deploy. Kỳ trước đó in "—" kèm câu "sổ bắt đầu từ …".
Không đổi lịch scheduler (AGENTS §7): ké job `alerts` đã chạy 10 phút / lần ở tổ chức nhà.

## 2. MRR — một công thức

`lib/billing/rules.ts::mrrContribution` là công thức DUY NHẤT; bảng thu phí ở `/platform` và ảnh chụp cùng gọi nó
(bài kiểm so hai số trên cùng dữ liệu).

```
MRR(tổ chức) = giá tháng của gói + phần mua thêm có giá
  nếu  không phải tổ chức nhà
   và  status = ACTIVE
   và  tình trạng thu phí ∈ {ACTIVE, DUE_SOON, OVERDUE}   (đang thu phí, chưa khoá)
   và  gói có giá (trial / internal không có giá ⇒ 0, không phải "chưa biết")
ngược lại 0
```

Phần mua thêm mà gói không còn khai giá **không được cộng** và được ghi ở `mrr_note`.
`mrr_vnd = NULL` được lược đồ cho phép (= CHƯA BIẾT) cho tương lai; công thức hôm nay không sinh ra nó.

**ARR** = MRR × 12. **ARPA** = MRR / số tổ chức đang tính MRR (`null` khi 0).

## 3. Biến động MRR của một kỳ

Đầu kỳ = ảnh chụp mới nhất **trước** ngày đầu kỳ; sổ chưa có ⇒ ảnh chụp sớm nhất **trong** kỳ (`partial = true`,
màn hình nói ra). Cuối kỳ = ảnh chụp mới nhất ≤ ngày cuối kỳ. Tổ chức **vắng** trong một ảnh chụp có thật = chưa tồn tại = 0.

| Biến động | Điều kiện (prev → cur) |
|---|---|
| NEW | 0 → > 0, **chưa từng** có MRR > 0 trước đầu kỳ |
| REACTIVATION | 0 → > 0, đã từng có MRR > 0 trước đầu kỳ |
| EXPANSION | cur > prev > 0 (phần tăng) |
| CONTRACTION | 0 < cur < prev (phần giảm) |
| CHURN | prev > 0 → 0 (toàn bộ prev) |
| RETAINED / NONE | bằng nhau / cả hai 0 |
| UNKNOWN | một đầu là `NULL` — **không vào dòng nào**, đếm riêng, in tên |

Cầu nối khép kín (có kiểm thử): `MRR cuối = MRR đầu + New + Expansion + Reactivation − Contraction − Churn`.

| Chỉ số | Công thức | `null` khi |
|---|---|---|
| Net New MRR | New + Expansion + Reactivation − Contraction − Churn | không có ảnh chụp |
| GRR | (MRR đầu − Contraction − Churn) / MRR đầu | MRR đầu = 0 |
| NRR | (MRR đầu + Expansion − Contraction − Churn) / MRR đầu — khách mới / quay lại KHÔNG vào | MRR đầu = 0 |
| Logo churn | số khách rời / số khách tính MRR đầu kỳ | đầu kỳ 0 khách |

GRR / NRR là **theo tháng** trên màn hình; NRR 12 tháng cần 12 tháng sổ — chưa có.

## 4. Vòng đời tổ chức

Đọc từ ảnh chụp + một sự thật bất biến `everPaid` (có hoá đơn `PAID`). Không lưu cột nào.

`INTERNAL` (nhà / gói internal) · `SUSPENDED` · `PAID` (đang tính MRR — kể cả khi người vận hành tự đặt "đã trả tới"
vì tiền về ngoài hệ thống) · `TRIAL` (thu phí bật, chưa tính MRR, chưa từng trả) · `LOCKED` (dùng thử hết hạn, chưa
từng trả) · `CHURNED` (từng trả, nay không tính MRR) · `FREE` (không thu phí — khách pilot).

## 5. Kích hoạt và Time-to-Value

Mỗi mốc = **min thời điểm của chứng từ có thật** trong CSDL của chính tổ chức đó (không phải lúc máy thấy), nên lần
quét đầu sau deploy ra đúng mốc lịch sử mà không phải đoán. Định nghĩa ở `MILESTONE_SPECS`:

| Mốc | Chứng từ |
|---|---|
| SIGNED_UP | `platform_organizations.created_at` |
| CHANNEL_CONNECTED | `org_connections` của khoá kênh bán (`CHANNEL_CONNECTOR_KEYS`) đang ACTIVE — `activated_at` |
| CATALOG_IMPORTED | `products.created_at` đầu tiên |
| FIRST_CONVERSATION | `sales_chat_conversations` kênh ≠ TEST |
| FIRST_AI_REPLY (= **đã kích hoạt**, `ACTIVATED_AT`) | hội thoại kênh ≠ TEST có `ai_calls > 0` — mốc mở hội thoại (cận dưới của lượt trả lời đầu) |
| FIRST_AI_ORDER | `orders.created_at` của đơn gắn `sales_chat_conversations.order_id` (kênh ≠ TEST) |
| FIRST_DELIVERED_AI_ORDER | **UNAVAILABLE** — kết cục giao hàng của tổ chức khách chưa có một định nghĩa chung đọc được từ mặt phẳng điều khiển; mở khi #522 xuất hàm kết cục theo đơn |

Trung vị "từ lúc tạo tới mốc" dưới 3 tổ chức ⇒ `null` (`SAAS_MEDIAN_MIN_SAMPLE`).

## 6. Biên lợi nhuận

| Khoản | Nguồn | Chưa có ⇒ |
|---|---|---|
| Doanh thu | MRR hiện tại | — |
| AI do nền tảng trả | `platform_ai_usage` `billing_source = PLATFORM`, 30 ngày, × tỷ giá nền tảng `FACEBOOK_USD_VND` | lượt chưa định giá ⇒ cờ "số thật lớn hơn" |
| Hạ tầng / tháng | chủ nền tảng khai ở `/platform/saas` (`platform_settings.platform.economics.costs`) | biên gộp `null` |
| Hỗ trợ khách / tháng | như trên | biên đóng góp `null` |

AI **BYOK** là tiền của khách — không phải giá vốn của nền tảng; in riêng. AI của tổ chức nhà là nội bộ; in riêng.

Biên đóng góp **theo tổ chức** = MRR − AI nền tảng trả cho tổ chức đó. Hạ tầng / hỗ trợ **không phân bổ** về từng
tổ chức vì chưa có căn cứ phân bổ (AGENTS §14) — màn hình nói ra.

## 7. Tín hiệu sức khoẻ (không chấm điểm)

Đăng nhập cuối (`platform_identities.last_used_at`), lượt AI 30 ngày, xu hướng 7 ngày so 7 ngày trước (dưới 10 lượt
⇒ "—"), tỷ lệ lỗi AI, mốc kích hoạt, tình trạng thu phí. **Không có điểm tổng**: chưa có dữ liệu churn thật để kiểm
chứng trọng số (yêu cầu §18 "không hardcode scoring formula"). Khi có ≥ 10 tổ chức đã rời, dựng mô hình từ dữ liệu.

## 8. Chưa đo được (khai rõ, không đoán)

| Chỉ số | Thiếu gì |
|---|---|
| CAC, Sales cycle, CAC payback | Chi phí bán hàng / quảng cáo **của nền tảng** chưa tách khỏi chi phí của tổ chức nhà; nguồn lead của đăng ký `/start` chưa ghi |
| Support cost / tenant | Không có sổ yêu cầu hỗ trợ theo tổ chức (chỉ có lượt xem SUPPORT_VIEW) |
| Infrastructure cost / tenant | Chưa có căn cứ phân bổ (CPU / dung lượng CSDL theo tổ chức chưa đo) |
| First delivered AI order | Xem §5 |
| NRR 12 tháng | Cần 12 tháng sổ |

## 9. Lùi

Revert PR: hai bảng ở lại, không ai đọc; bảng thu phí quay về vòng lặp cũ (cùng kết quả). Không dữ liệu nào bị xoá.

## 10. Sổ dùng theo ngày (0204 — `platform_tenant_usage_daily`)

Đơn vị đo "tổ chức dùng AI bán hàng tới đâu" — và là đơn vị cho hạn mức / tính phí theo hội thoại về sau (chưa bật: giá và
hạn mức là quyết định kinh doanh).

| Cột | Đếm | Không đếm |
|---|---|---|
| `conversations_started` | hội thoại khách mới (kênh ≠ THỬ) mở trong ngày | khung thử, phát lại, copilot (đều kênh THỬ) |
| `customer_messages` | tin chữ của khách | kết quả công cụ (vai `user` nhưng không phải khách) |
| `bot_messages` | tin chữ của bot | tin page chép vào lịch sử («[Shop đã nhắn] …») |
| `ai_active_conversations` | hội thoại có ít nhất một tin bot trong ngày | — |
| `ai_orders` | đơn tạo trong ngày gắn với hội thoại bot đã chốt | — |

Mỗi lượt chụp tính lại **hôm qua và hôm nay** (tin tới muộn của hôm qua vẫn vào); ngày cũ hơn đóng băng. Ngày chưa có dòng
là CHƯA ĐO (cockpit in «—» và số ngày đã có trong sổ), không phải 0. Đơn AI **giao thành công** cần kết cục đơn chung
(#522) — thêm cột khi hàm ấy vào main.
