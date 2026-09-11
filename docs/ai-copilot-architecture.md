# AI Copilot — kiến trúc (ERP truth → typed tools → AI)

Ngày 11/09/2026 (cập nhật cùng ngày: OpenAI provider, router, 20 tool, ngăn kéo toàn cục). Không đụng công thức KPI nào.

## 1. Nguyên tắc

1. **ERP là sự thật.** AI không truy vấn DB, không tự tính KPI. Mọi con số AI nói đều là kết quả
   của một tool ĐỌC gọi vào `lib/queries/*` — đúng hàm bàn làm việc đang dùng (`getCareQueue`,
   `getCareCaseDetail`, `getCareReport`, `getLogisticsFreshness`). `tests/ai-copilot.test.ts` chặn
   ở mức mã nguồn: `lib/ai/tools/*` không được `import "@/db"` hay `drizzle-orm`.
2. **Đọc và ghi tách biệt.** `kind: "read"` chạy ngay trong vòng lặp. `kind: "write"` KHÔNG chạy:
   copilot trả về `pendingActions` kèm token; model nhận `CHỜ XÁC NHẬN` và phải kết thúc câu trả
   lời. Người bấm xác nhận ⇒ `confirmCopilotActions` kiểm lại từ đầu rồi mới gọi tool.
3. **Quyền trước, chính sách sau, zod cuối.** Người không có `permission` của tool thì model không
   thấy tool đó (không phải "thấy mà bị từ chối"). `policy: forbidden` là cách khai tường minh "AI
   không được làm việc này" — không bao giờ tới model. Input sai zod ⇒ trả lỗi cho model, không
   chạy nửa chừng.
4. **Sàn rủi ro theo nhóm** (`RISK_FLOOR` ở `lib/ai/tools/registry.ts`): `general` → auto ·
   `care` → confirm · `carrier` / `finance` / `inventory` / `destructive` → forbidden. Tool khai
   lỏng hơn sàn thì `defineTool` ném lỗi lúc khởi động. Mở nhóm nào là quyết định của chủ shop.
5. **Audit mọi lượt.** Bảng `ai_interactions` (migration 0062): ai hỏi, provider/model, màn hình +
   đối tượng, câu hỏi (cắt 4000), câu trả lời (cắt 8000), tool đã gọi (tên, input, đã chạy?, ok?,
   một câu tóm tắt — KHÔNG lưu toàn bộ dữ liệu tool trả), hành động đề nghị, hành động đã chạy,
   token/chi phí ước tính/độ trễ/số vòng, trạng thái. Không lưu khoá API. Hành động AI đã chạy để
   lại dấu ở `care_case_events` với `source = "AI"` và `actor = email người xác nhận` (không phải
   "AI" — người chịu trách nhiệm) + `audit_logs` (`AI_ACTIONS_CONFIRMED`).
6. **Dữ liệu cũ ≠ hỏng.** Tool trả `staleness` khi tin ĐVVC cuối ≥ 24 giờ hoặc chưa có tin; copilot
   đẩy thành `warnings` riêng, và prompt hệ thống bắt AI nói ra đầu câu trả lời.

## 2. Thành phần

| Tệp | Vai trò |
|---|---|
| `lib/ai/provider.ts` | `AiProvider` (text · tool_use · tool_result); `AnthropicProvider` (SDK chính thức, adaptive thinking, system prompt có `cache_control`, strict tools, server-side fallback); `FakeProvider` cho kiểm thử; `estimateCostUsd` (model chưa có giá ⇒ `null`, không phải 0); `getAiProvider(tier)`; `testAiConnection()` cho trang Kết nối dữ liệu. |
| `lib/ai/providers/openai.ts` | `OpenAiProvider` — **Responses API** (`client.responses.create`): system → `instructions`, tool_use ↔ `function_call`, tool_result ↔ `function_call_output`, tools `type: function, strict: true`, `reasoning.effort`, `store: false`; `cached_tokens` → cacheReadTokens. `fetch` tiêm được để kiểm thử không mạng. |
| `lib/ai/router.ts` | MỘT chỗ chọn provider + model: `AI_PROVIDER` = auto (OpenAI nếu có `OPENAI_API_KEY`, không thì Anthropic) · openai · anthropic · off. Ba bậc: `routine` gpt-5.6-luna / claude-haiku-4-5 · `copilot` gpt-5.6-terra / claude-opus-5 · `analysis` gpt-5.6-sol / claude-opus-5 (effort low / medium / high). `AI_MODEL` ghi đè bậc copilot. `aiDisabledReason()` nói đúng secret còn thiếu. Kiểm thử chặn chuỗi model ngoài router/provider. |
| `lib/ai/tools/registry.ts` | `defineTool`, `toolsFor(user)`, `describeTools`, `strictInputSchema` (zod → JSON Schema, `additionalProperties:false`, mọi khoá bắt buộc — khoá tuỳ chọn khai `nullable()`). |
| `lib/ai/tools/care.ts` | 5 đọc: `get_care_case`, `get_care_queue_summary`, `search_care_cases`, `get_care_report`, `get_data_freshness`. 4 ghi (confirm): `add_care_note`, `assign_care_case`, `set_care_status`, `set_care_follow_up` → `lib/care/service.ts` với `actor.source = "AI"`. 1 cấm: `request_carrier_action`. |
| `lib/ai/tools/erp.ts` | 8 đọc toàn ERP, cùng hàm với màn hình: `search_customer` (searchEntities), `get_customer_history` (getCustomerDetail), `get_order_context` (getOrderDetail + getOrderTimeline + kết quả đơn từ bảng vật chất hoá `canonical_order_outcome` — không suy), `get_profit_summary` (getFinancialTruth + getNominalProfitReport), `get_cash_position` (getCashflow), `get_inventory_risks` (getSlowMoving + getReplenishmentPlan), `get_product_performance` (getProductIntelligence + classifyProduct), `get_owner_brief` (getBusinessBrief). 2 ghi (confirm): `resolve_case`, `reopen_case`. Quyền theo trang tương ứng (`orders:read`, `customers:view`, `reports:nominal`, `reports:cash`, `planning:view`, `products:view`, `dashboard:view`). |
| `components/ai-copilot.tsx` | Ngăn kéo toàn cục (nút ✦ trên thanh đầu, Ctrl+J, sự kiện `erp:copilot`): tự mang route + tham số (kỳ, bộ lọc) + đối tượng đang mở; thẻ hành động đề nghị với nút Xác nhận / Bỏ qua; cảnh báo dữ liệu cũ tách riêng; hiện "AI chưa được cấu hình" kèm secret cần thêm. Ngăn kéo kiện có nút "Tóm tắt bằng AI". |
| `lib/ai/policy.ts` | Token xác nhận = HMAC-SHA256(`AUTH_SECRET`, userId · tool · input chuẩn hoá) cắt 32 hex; `COPILOT_LIMITS` (vòng lặp ≤ `AI_MAX_TOOL_ROUNDS`, ≤ 5 hành động/câu, kết quả tool ≤ 12k ký tự). |
| `lib/ai/prompt.ts` | Prompt hệ thống ỔN ĐỊNH (đệm được). Bối cảnh màn hình/người/giờ đi vào tin nhắn user đầu. |
| `lib/ai/copilot.ts` | `runCopilot` (vòng lặp) và `confirmCopilotActions` (thực thi sau xác nhận). |
| `lib/ai/contracts.ts` | Kiểu đã chốt cho UI: `CopilotRequest/Result/PendingAction/ToolCall/ConfirmResult/ToolInfo`. |
| `lib/actions/ai.ts` | Server Action: `askCopilot`, `confirmCopilotActions`, `copilotStatus`. |
| `lib/env.ts::ai` | `AI_PROVIDER` (anthropic/off) · `AI_MODEL` · `AI_EFFORT` · `AI_MAX_TOOL_ROUNDS`; `configured` = có `ANTHROPIC_API_KEY`. |

## 3. Vòng lặp

```
askCopilot(message, context, history?)
  └ runCopilot
      tools = toolsFor(user)                      # quyền + không forbidden
      messages = history + [bối cảnh + câu hỏi]
      lặp ≤ maxRounds:
        res = provider.complete(system, messages, tools)
        text → answer; refusal → REFUSED
        mỗi tool_use:
          không có / không được phép → tool_result lỗi
          zod fail                   → tool_result lỗi (issues)
          write                      → pendingActions += {token…}; tool_result "CHỜ XÁC NHẬN"
          read                       → run(ctx) → tool_result JSON (cắt); staleness → warnings
        stop_reason ≠ tool_use → dừng
      insert ai_interactions
      → CopilotResult { status: OK | NEEDS_CONFIRMATION | REFUSED | ERROR | DISABLED, … }

confirmCopilotActions(interactionId, tokens)
  đúng người → token có trong actionsProposed → chưa chạy → tool còn write & không forbidden →
  còn quyền → HMAC khớp → zod → run(ctx) → append actionsExecuted → audit
```

## 4. Bảo mật & quyền — đã rà

- Khoá API chỉ SDK đọc từ môi trường; không qua `env` getter, không log, không vào DB.
- Token gắn userId: người khác không xác nhận hộ; sửa input ⇒ token khác ⇒ từ chối.
- Chạy rồi không chạy lại (kiểm `actionsExecuted` theo token).
- Tool gọi tên lạ / tool cấm / tool ngoài quyền: không chạy, ghi vào `toolCalls` là không được phép.
- Lịch sử hội thoại client gửi lên chỉ là văn bản (≤ 12 lượt, ≤ 8000 ký tự/lượt); tool_use cũ không
  được phát lại.
- Mọi kết quả tool đưa cho model được cắt ≤ 12k ký tự; hồ sơ kiện ~1k token.
- Prompt injection qua dữ liệu (note khách, tên người nhận…): tool ghi vẫn phải qua xác nhận của
  người, nên tệ nhất AI đề nghị sai — không ghi sai.

## 5. Benchmark (kiểm thử, không mạng)

Vòng lặp copilot + tool + ghi nhật ký: p50 ≈ 19 ms, p95 ≈ 22 ms (PGlite). Độ trễ thực = độ trễ model
(thường 3–8 s cho 2 lượt với Opus 5 ở effort medium). Ước tính chi phí một lượt "tóm tắt kiện":
~2,2k token prompt+tool + ~1k token hồ sơ + 400 token trả lời ≈ **$0,027 lạnh / $0,017 có đệm
prompt** (bảng giá trong `provider.ts`, không phải hoá đơn). 200 lượt/ngày ≈ $3–5/ngày.

## 6. Chưa làm, cố ý

- Không streaming (thêm khi UI cần). Không tool GHI cho tài chính / tồn kho / ĐVVC (sàn `forbidden`).
- Không gọi model trong kiểm thử (FakeProvider + fetch giả cho OpenAI). Chưa benchmark model thật
  trên production vì chưa có khoá trên VPS: bật bằng `OPENAI_API_KEY` (hoặc `ANTHROPIC_API_KEY`)
  trong `.env`, không commit. Thiếu khoá ⇒ app vẫn chạy, giao diện nói "AI chưa được cấu hình".
- Giá gpt-5.6-* chưa có trong bảng ⇒ `costUsd = null` (chưa biết), cập nhật `PRICE_PER_MTOK` khi có
  giá niêm yết.
