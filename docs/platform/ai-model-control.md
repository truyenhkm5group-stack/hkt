# Platform AI Model Control — đổi model của AI dùng chung có cổng

> Model của khoá nền tảng (`PLATFORM_AI_API_KEY`, nguồn `PLATFORM`) dùng cho MỌI tổ chức khách chọn «AI dùng chung».
> Trước 06/10/2026 nó chỉ đổi được bằng GitHub Variable `PLATFORM_AI_MODEL` + deploy: không chạy thử được, không hoàn tác
> nhanh, không có vết. Tài liệu này mô tả lớp chính sách nằm TRÊN biến môi trường. Mã: `lib/ai-usage/platform-ai-policy.ts`,
> `lib/ai-usage/platform-model-probe.ts`, `lib/ai-usage/platform-ai-admin.ts`, `lib/ai-builder/platform-fallback.ts`.

## 1. Đường đi của model (audit 06/10/2026)

```
Tổ chức khách (gói có platformCreditUsdPerMonth > 0)
  → cấu hình chatbot ai.salesChatbot, connectorKey = "platform"   (ô Model của shop BỊ BỎ QUA ở nhánh này)
  → engine resolveConnector("platform")                            lib/sales-chatbot/engine.ts
  → platformChatAi(orgCode, { routingKey: hội thoại })             lib/ai-builder/provider.ts
  → platformAiConfig()  — PLATFORM_AI_ENABLED · _API_KEY · _PROVIDER · _MODEL (trống ⇒ gemini-3.5-flash-lite)
  → platformRoute()     — Platform AI Policy (platform_settings · platform.ai.policy), không có ⇒ model của biến môi trường
  → ByokGeminiProvider (name "gemini-platform"), canary có dự phòng ⇒ withPlatformFallback
  → Gemini generateContent (khoá chỉ ở header x-goog-api-key)
  → recordAiUsage: model = modelVersion Google trả về; cost_usd = estimateCostUsd(model thật, usage)
```

- `GEMINI_MODEL` / `VISION_MODEL` của container `chatbot/` là bot fanpage của tổ chức NHÀ — **không liên quan**, không đổi.
- Ảnh khách gửi trên nhánh `platform` đọc bằng CÙNG provider (không có model thị giác riêng).
- AI Builder của tổ chức khách (nhánh PLATFORM của `getBuilderAi`) đi cùng chính sách.

## 2. Bảng giá (USD / 1M token, `lib/ai/provider.ts::PRICE_PER_MTOK`, ESTIMATED)

| Model | Vào | Ra | Ghi chú |
|---|---|---|---|
| `gemini-2.5-flash-lite` | 0,10 | 0,40 | khoá Gemini MỚI có thể bị 404 «no longer available to new users» (HSLC 02/10/2026) |
| `gemini-3.5-flash-lite` | 0,30 | 2,50 | mặc định hiện tại; giá ra gồm token suy nghĩ |

Cùng hỗn hợp token 10 vào : 1 ra, 2.5 rẻ hơn ~79%. Chi phí «nếu đổi» trên màn hình = token 30 ngày của nguồn `PLATFORM` ×
giá ứng viên — ước tính, và 2.5 tắt suy nghĩ ở mức Nhanh nên token ra thật thường còn ít hơn.

## 3. Chính sách

| Ô | Nghĩa |
|---|---|
| `enabled` | tắt ⇒ model của biến môi trường |
| `primaryModel` | model mới (canary) |
| `fallbackModel` | đỡ khi primary hỏng + model của phần lưu lượng ngoài canary; mặc định = model đang chạy |
| `canaryPct` | 1–99 = chạy thử, 100 = áp dụng; băm ổn định theo HỘI THOẠI |
| `effectiveFrom` | chưa tới ⇒ model của biến môi trường |
| `reason` · `changedBy` · `changedAt` | bắt buộc; kèm một dòng `platform_audit_log` |
| `previous` | bản ngay trước — Hoàn tác trả về đúng bản này |

Mọi nhánh lỗi rơi về **model của biến môi trường** (đã chạy thật): chính sách hỏng hình, đọc CSDL lỗi, model không có
giá, khác nhà cung cấp. Đọc qua bộ đệm 30 giây (scheduler thấy thay đổi tối đa 30 giây sau).

**Model mới hỏng** (404, 429, 5xx, hết giờ…) ⇒ CÙNG lượt gọi lại bằng `fallbackModel` trước khi có chữ nào tới khách.
Lượt hỏng ghi một dòng `ERROR` (token / tiền `NULL`); lượt thành công ghi model đã chạy. 404 model ⇒ bỏ qua primary 1 giờ.
Sổ AI của engine tách dòng khi model đổi giữa một lượt (trước đây cả lượt ghi dưới tên model của vòng cuối).

## 4. Quy trình (màn `/platform/saas` · khung «Platform AI Model Control»)

1. **Kiểm tra khả dụng** — MỘT `generateContent` một chữ, `maxOutputTokens` 8, bằng chính `PLATFORM_AI_API_KEY`. Năm kết
   luận: `AVAILABLE` · `MODEL_UNAVAILABLE` (404) · `KEY_REJECTED` (401/403) · `QUOTA` (429 / hết credit) · `OTHER`.
2. **Chạy thử** — chỉ khi bước 1 `AVAILABLE` trong 24 giờ.
3. **Áp dụng** — canary 100%, cùng điều kiện.
4. **Hoàn tác** — về bản trước; không có ⇒ tắt chính sách.

Chỉ người vận hành nền tảng (`platform:operate` + tổ chức nhà). Tổ chức khách không có action nào đổi được model dùng chung.

## 5. Ops (không cần đăng nhập)

`ops-vps.yml` → `platform-ai-model-probe`:

- arg trống ⇒ kiểm `gemini-2.5-flash-lite gemini-3.5-flash-lite`, in `[ops:tom-tat]`, KHÔNG ghi gì.
- `--apply=<1-100> <model>` ⇒ kiểm lại model ngay trước khi ghi; không `AVAILABLE` ⇒ không đổi gì.
- `--rollback` ⇒ hoàn tác. Nhật ký nguồn `SCRIPT`, người làm = máy.

## 6. Đo sau khi đổi (db-query, chỉ đọc)

```sql
select model, status, count(*) as dong, sum(requests) as luot, sum(input_tokens) as vao, sum(output_tokens) as ra, round(sum(cost_usd)::numeric, 4) as usd from platform_ai_usage where billing_source = 'PLATFORM' and at > now() - interval '24 hours' group by model, status order by luot desc
```

## 7. Canary có đo — A/B model (07/10/2026)

**Ghim theo hội thoại.** Hội thoại đã chạy model nào (sổ AI nguồn `PLATFORM`, kể cả dòng `ERROR`) thì giữ nhánh đó:
tăng nấc 10 → 30 → 50 → 100% không kéo hội thoại đang dở của nhóm đối chứng sang model mới, và hội thoại mở trước khi bật
canary không đổi model giữa chừng. Chỉ hội thoại MỚI được băm theo `canaryPct`. Hoàn tác thắng ghim: về model ổn định ngay.
Đường nóng chỉ đọc sổ AI khi chính sách đang chạy (`livePolicy`).

**Cohort.** Hội thoại `sales_chatbot` nguồn `PLATFORM` có lượt đầu ≥ `cohortSince` (tăng nấc với cùng cặp model giữ mốc;
đổi cặp ⇒ mốc mới), trừ khung thử. Nhánh theo ý định điều trị: có dòng mang tên model canary ⇒ canary (kể cả lượt dự phòng
đỡ — chi phí của lượt đỡ tính cho canary).

**Chỉ số** (`lib/ai-usage/platform-ai-ab.ts`, cùng định nghĩa màn «Hiệu quả»): hội thoại · đơn chốt (không mô phỏng) · tỷ lệ
chốt · SĐT · địa chỉ (`customer.identified`) · handoff · lỗi AI (lượt) · p50/p95 thời gian phản hồi khách · công cụ đúng
(`tool_result` không lỗi) · upsell mời / nhận · token / hội thoại · chi phí / hội thoại · chi phí / đơn. Dưới 10 hội thoại
⇒ «—».

**Luật quyết định** (`AB_RULES`, chủ nền tảng chốt 07/10/2026 — máy chỉ ĐỀ XUẤT, người bấm):

| Điều kiện | Ngưỡng |
|---|---|
| Đủ mẫu | canary ≥ 200 hội thoại **hoặc** ≥ 50 đơn chốt |
| Lỗi AI | tăng ≤ 1 điểm % |
| Chốt · SĐT · địa chỉ | giảm ≤ 5% tương đối |
| Công cụ đúng | giảm ≤ 2 điểm % |
| Chi phí / hội thoại | giảm ≥ 15% |
| Mỗi nấc | chạy ≥ 24 giờ |
| Hồi quy nặng | lỗi tăng > 5 điểm % khi canary ≥ 30 hội thoại ⇒ hoàn tác ngay |

Đạt hết ⇒ lên nấc kế (10 → 30 → 50 → 100, luôn giữ dự phòng); trượt một điều ⇒ hoàn tác; một điều chưa đo được ⇒ giữ.

**Đo không cần đăng nhập:** ops `platform-ai-model-probe` arg `--report`. **Đổi nấc:** `--apply=30 gemini-3.1-flash-lite`.
**Hoàn tác:** `--rollback` hoặc nút ở `/platform/saas` — không cần deploy.
