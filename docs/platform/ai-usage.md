# Dùng AI & kiểm soát chi phí AI — hợp đồng

> Một sổ, một phép tính hạn mức, hai công tắc. Nền đã dựng cho CẢ HAI mô hình trả tiền; mô hình B (nền tảng trả) MẶC
> ĐỊNH TẮT cho tới khi chủ nền tảng quyết (launch-gates.md mục D). Mã: `lib/ai-usage/*`.

## 1. Ai trả tiền AI — ba nguồn, không bao giờ lẫn

| Nguồn (`billing_source`) | Khoá | Ai trả | Giới hạn chủ yếu | Trạng thái |
|---|---|---|---|---|
| `BYOK` — mô hình **A** | Kết nối `anthropic-byok` / `openai-byok` của CHÍNH tổ chức (Phase 9, mã hoá theo tổ chức) | Khách | Số lượt (chống lạm dụng máy chủ), trần tiền tuỳ chọn | Đang chạy |
| `PLATFORM` — mô hình **B** | `PLATFORM_AI_API_KEY` — tài khoản AI RIÊNG của nền tảng | Nền tảng | Tiền: `platformCreditUsdPerMonth` | **TẮT** |
| `HOME` | `.env` của tổ chức nhà (VNX) | VNX | Không (gói `internal`); Copilot có trần tiền ngày riêng (`lib/ai/budget.ts`) | Đang chạy, chỉ tổ chức nhà |

Thứ tự chọn ở `getBuilderAi()` (`lib/ai-builder/provider.ts`): công tắc AI → BYOK của chính tổ chức → nhà (chỉ tổ chức
nhà) → PLATFORM (chỉ tổ chức KHÁC nhà, đủ ba điều kiện ở mục 2) → không có AI. Không nhánh nào rơi về khoá của tổ chức
khác hay của nhà.

## 2. Mô hình B — nền tảng trả tiền (nền đã dựng, TẮT)

Nhánh PLATFORM chỉ mở khi ĐỦ BA:

1. `PLATFORM_AI_ENABLED=1` **và** `PLATFORM_AI_API_KEY` khác rỗng (`lib/ai-usage/platform-ai.ts`). Khoá trùng
   `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` của nhà ⇒ TỪ CHỐI (hoá đơn của VNX không gánh khách).
   Model (`PLATFORM_AI_MODEL`, trống = `claude-opus-5`) phải có trong bảng giá — không định giá được thì không trừ được
   credit ⇒ từ chối.
2. Gói của tổ chức có `limits.ai.platformCreditUsdPerMonth > 0` (hoặc ghi đè theo tổ chức).
3. Còn credit tháng này (`checkAiQuota(orgCode, "PLATFORM")`).

Provider của nhánh này là provider BYOK-dạng với khoá TƯỜNG MINH (`baseURL` hằng `api.anthropic.com`, `authToken: null`)
— không đi qua `getAiProvider()` của nhà. Bài kiểm chứng minh header chỉ mang khoá nền tảng.

## 3. Sổ `platform_ai_usage` (migration 0176, CSDL nhà)

Một dòng = một lượt AI: một bản nháp AI Builder (dù bên trong 1–3 lời gọi model), một câu hỏi Copilot. Ghi DUY NHẤT qua
`recordAiUsage()` (`lib/ai-usage/ledger.ts`; bài kiểm quét: không tệp nào khác chèn vào bảng).

| Cột | Nghĩa |
|---|---|
| `org_code`, `feature` (`ai_builder` · `copilot`), `billing_source` | ai dùng, tính năng nào, ai trả |
| `provider`, `model` | nhãn provider, model thật trong phong bì trả về |
| `requests` | số lời gọi model của lượt (0 khi bị chặn) |
| `input_tokens`, `output_tokens` | token (vào gồm cả đệm đọc / ghi); `NULL` = chưa biết (lượt hỏng giữa chừng) |
| `cost_usd` | USD ƯỚC TÍNH theo bảng giá trong mã (`giaCuaModel`); `NULL` = CHƯA BIẾT — không bao giờ 0 (luật 42) |
| `status` | `OK` · `ERROR` · `BLOCKED_QUOTA` (hạn mức chặn TRƯỚC khi gọi model: `requests = 0`, tiền 0 THẬT) |
| `actor_id`, `ref` | khoá tài khoản người bấm (luật 34); id nháp / lượt Copilot để tra ngược |

Không lưu prompt, câu trả lời, khoá. Tổng tiền chỉ cộng lượt đã định giá, số lượt chưa định giá in cạnh ("+n chưa rõ").
Copilot của nhà ghi nguồn `HOME` ngay sau dòng `ai_interactions` sẵn có; ghi sổ hỏng thì nuốt — hành vi Copilot không đổi.
Job AI khác của VNX (creative, video, CSKH) CHƯA ghi vào sổ này — vẫn ở `ai_interactions`.

## 4. Hạn mức — `platform_plans.limits.ai` + ghi đè theo tổ chức

```json
"ai": { "requestsPerDay": 10, "requestsPerMonth": 100, "costUsdPerMonth": { "soft": 20, "hard": 50 }, "platformCreditUsdPerMonth": 0 }
```

- `null` = không giới hạn. Lượt = một dòng sổ (không kể lượt bị chặn). Đếm RIÊNG từng tổ chức × từng nguồn: A không
  trừ vào B, BYOK không trừ vào credit PLATFORM.
- `requestsPerDay` / `requestsPerMonth` — trần cứng theo lượt. `costUsdPerMonth.hard` — tới trần ⇒ từ chối. Với
  PLATFORM, trần cứng thật = min(`hard`, credit). `soft` — vượt ⇒ vẫn chạy, câu cảnh báo hiện cho người bấm, và MỘT
  thông báo / ngày / nguồn cho tổ chức (bảng `notifications` của CHÍNH tổ chức, khoá `ai-quota-soft:<nguồn>:<ngày VN>`).
- Trần tiền so với tiền ĐÃ BIẾT trước lượt: một lượt có thể vượt trần tối đa bằng giá của chính nó (~1,1 USD / bản
  nháp AI Builder đo thật trên claude-opus-5). Lượt chưa định giá không được cộng như 0 mà cũng không được đoán giá —
  màn hình nói ra số lượt ấy.
- Gói không khai `ai` ⇒ không giới hạn lượt / tiền theo gói (màn hình nói "chưa khai"), credit nền tảng 0. Vẫn chịu trần
  kỹ thuật `AI_BUILDER_LIMITS.maxDraftsPerDay` và `aiDraftsPerDay` của Phase 10.
- Ghi đè THƯA theo tổ chức: `platform_organizations.settings.ai.limits` (`requestsPerDay`, `requestsPerMonth`,
  `costUsdSoft`, `costUsdHard`, `platformCreditUsdPerMonth`) — ô có mặt thắng gói. Người vận hành đặt ở
  `/platform/org/<mã>` → khung «Dùng AI», bắt buộc lý do, nhật ký `AI_ORG_CONTROL_SET`.
- Tổ chức nhà: không giới hạn, không đếm vào hạn mức.

**Hạn mức mặc định đề xuất (gieo bằng 0176, chỉ khi gói CHƯA có khoá `ai`):**

| Gói | Lượt / ngày | Lượt / tháng | Cảnh báo / trần tiền tháng | Credit nền tảng |
|---|---|---|---|---|
| `trial` | 10 (= `aiDraftsPerDay`) | 100 | 20 / 50 USD | 0 |
| `standard` | 100 | 1.000 | 100 / 300 USD | 0 |
| `internal` | không giới hạn | không giới hạn | — | 0 |

Credit nền tảng 0 ở MỌI gói: bật B là quyết định (mục 6). Đề xuất khi bật: `trial` 5 USD (~4 bản nháp), `standard` 30 USD.

## 5. Công tắc AI (kill switch) — không cần deploy

- **Toàn nền tảng**: `platform_settings['platform.ai.enabled']` (jsonb `true` / `false`); thiếu dòng ⇒ BẬT. `/platform`
  → khung «D · AI». Nhật ký `AI_SWITCH_SET`.
- **Theo tổ chức**: `platform_organizations.settings.ai.disabled`. `/platform/org/<mã>` → «Dùng AI».
- Tắt ⇒ AI Builder trả "AI đang bị tắt bởi người vận hành", chặn TRƯỚC khi chọn provider (kể cả provider ép của kiểm
  thử) — không lời gọi model, không dòng sổ. Chỉ chặn AI Builder; Copilot / job AI của nhà có trần tiền ngày riêng.
- Đọc qua đệm `AI_CONTROL_CACHE_MS` = 10 s (bài kiểm khoá ≤ 30 s). Không đọc được công tắc ⇒ coi như TẮT (không đệm lỗi).
- Chỉ người vận hành nền tảng (tổ chức nhà + `platform:operate`) đổi được; bắt buộc lý do; ghi nhật ký hỏng ⇒ hoàn lại.

## 6. Hiển thị

- `/settings/plan` (tổ chức): hôm nay / tháng này theo nguồn — lượt (lời gọi), token, tiền ước tính, lượt bị chặn; hạn
  mức đang áp cạnh mức dùng. Mã tổ chức lấy từ PHIÊN.
- `/platform/org/<mã>` (người vận hành): như trên + bảng 31 ngày theo ngày × tính năng × nguồn × model + công tắc / ghi đè.
- `/platform`: top 10 tổ chức theo chi phí AI tháng này + công tắc toàn nền tảng + nhánh B "có / chưa có" (không in khoá).

## 7. Bài kiểm

`tests/ai-usage.test.ts` (trong `npm test`, ngay trước `testPlatformUi`): provider giả, hai tổ chức thật `au-a` / `au-b`
+ nhà; môi trường nhánh B đưa vào bằng `env` giả (không đọc / đặt `process.env`). `tests/migration-upgrade-path.test.ts`:
0176 không gieo dòng sổ, gieo `ai` cho ba gói, không gói nào có credit, CHECK chặn nguồn / trạng thái lạ.
