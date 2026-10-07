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

### 7.1 Hai workload (đo 07/10/2026)

30 ngày qua 100% chi phí AI dùng chung là **ghi đơn từ hội thoại nhân viên** (`order-sync`, shop `qa`, sổ AI
`ref = order-sync:<hội thoại>`) và **0 hội thoại AI Sales với khách** — các shop chat với khách đều dùng khoá riêng. Nên
bảng A/B có hai phần:

- **AI Sales chat**: chốt · SĐT · địa chỉ · handoff · lỗi · p95 · công cụ đúng · upsell · token / chi phí (§7).
- **Ghi đơn từ hội thoại**: hội thoại được đọc · đơn ghi được (`orders.origin = AI_ORDER_SYNC`) · tỷ lệ ra đơn · lead → đơn
  (lead bị lỡ = chuông `sales-order-sync:lead:*` «khách để SĐT mà máy chưa lên đơn») · lỗi · token / chi phí. Luật: lỗi ≤ +1
  điểm, ra đơn và lead → đơn giảm ≤ 5% tương đối, chi phí / hội thoại giảm ≥ 15%, cùng ngưỡng đủ mẫu.

Kết luận chung chỉ xét workload có lưu lượng (đối chứng ≥ 10 hội thoại): một workload trượt ⇒ hoàn tác; lên nấc khi mọi
workload có lưu lượng đều đạt. Ghi đơn băm canary theo TỪNG hội thoại (`salesChatProvider({ ref: order-sync:<id> })`) —
trước 07/10 nó băm theo mã tổ chức nên canary 10% nhận 0% lưu lượng. Các việc nền khác (học hội thoại, sổ tay, nhắc khách)
vẫn băm theo tổ chức.

## 8. Chính sách theo loại việc + quan sát token (07/10/2026)

**Không một model cho mọi việc.** Mỗi loại việc có thể có chính sách RIÊNG ở `platform.ai.policy.<workload>`:

| Loại việc | Nơi gọi | Mặc định nơi gọi |
|---|---|---|
| `sales_chatbot` | bot trả lời khách (engine) | SMART = suy nghĩ medium / 10.000 · FAST = low / 4.000 |
| `order_sync` | ghi đơn từ hội thoại nhân viên | suy nghĩ **low** / 4.000 |
| `quick_extract` | AI chọn câu mẫu | theo bot |
| `vision` | đọc ảnh khách gửi | theo bot |

Chính sách riêng thêm `reasoning` (minimal · low · medium · high) và `maxOutputTokens` — CHỈ đè lời gọi của model chính
(nhánh canary); model dự phòng luôn chạy đúng cấu hình của nơi gọi. Chưa có / đã tắt ⇒ loại việc đi chính sách chung (tương
thích ngược). Hai nhánh phải KHÁC model (A/B phân nhánh theo tên model trong sổ AI); so mức suy nghĩ của CÙNG model dùng
benchmark (§9). Ops: `--apply=10 <model> --workload=order_sync --reasoning=minimal --max-tokens=1024` · `--rollback --workload=order_sync`.

**Quan sát (không đổi tiền) — cột sổ đi ở PR riêng** (nhánh `claude/platform-ai-ledger-telemetry`; số migration 0231 / 0232
đang do hai sứ mệnh khác giữ chỗ). Nơi gọi đã điền `thinkingTokens` / `cachedTokens` / `latencyMs` / `workload`; tới khi có
cột, chỉ benchmark (§9) đọc được chúng. Thiết kế cột: `platform_ai_usage` thêm `thinking_tokens` (⊂ `output_tokens`),
`cached_tokens` (⊂ `input_tokens`), `latency_ms`, `workload`. `output_tokens` / `cost_usd` GIỮ NGUYÊN nghĩa — Gemini tính tiền
token suy nghĩ như token ra. Dòng cũ `NULL` = chưa đo. Bảng A/B có: ra hiện / suy nghĩ / % suy nghĩ / tổng ra mỗi hội thoại,
tiền phần suy nghĩ, độ trễ lời gọi p50/p95 kèm độ phủ. `/platform/saas` có bảng **PLATFORM AI ROUTING** theo loại việc.

**Đắt hơn rõ rệt ⇒ hoàn tác sớm:** canary ≥ 30 hội thoại, chi phí / hội thoại > +20% đối chứng, chỉ số chính (chốt / ra
đơn / lead → đơn) không cao hơn ≥ 5% ⇒ ROLLBACK, không chờ 200.

## 9. Benchmark phát lại offline (ops `platform-ai-bench`)

- `sync <tổ chức> [--cases=120] [--configs=D35l,C31l,E31n,B31m,A35m]` — ghi đơn, CHỈ ĐỌC. Ca dựng từ tin đã lưu tới trước
  mốc có kết quả thật: ORDER (đơn còn sống ⇒ phải ra đơn; chấm SĐT · địa chỉ · tên · món · mẫu · SL), DELETED_ORDER (người xoá
  đơn máy ghi ⇒ không được ra đơn), NO_ORDER_PHONE / NO_ORDER. Đo FP / FN, JSON hợp lệ, token vào / ra hiện / suy nghĩ,
  USD / ca, p50 / p95.
- `sales <tổ chức> [--points=60] [--configs=S35,S31,F31]` — Sales Agent qua `shadowTurn` (kênh THỬ, công cụ mô phỏng,
  hội thoại tạm bị xoá, KHÔNG khoá dự phòng — bộ ngắt mạch không chạm cài đặt thật của shop; lượt AI không vào sổ AI thật).
  Chấm tất định: đúng giá, bịa tồn, đúng công cụ, SĐT / địa chỉ, chốt khi chưa xác nhận, chuyển người, lộ suy nghĩ, mời mua
  thêm, độ dài, tiền / độ trễ.
- Cấu hình: D35l = production hôm nay (3.5 · low · 4.000) · A35m · B31m · C31l · E31n (3.1 · minimal) · F35n · G31l1k · H31n1k;
  Sales: S35 · S31 (SMART) · F31 · F35 (FAST). Mọi lời gọi bằng khoá nền tảng. Chỉ in số tổng hợp. Mỗi lượt ≤ ~10 phút.
