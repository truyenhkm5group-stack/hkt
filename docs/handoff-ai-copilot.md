# Handoff AI Copilot cho phiên UI (Claude Opus 5)

Backend đã xong và có kiểm thử. **Đã có một ngăn kéo copilot toàn cục** (`components/ai-copilot.tsx`,
gắn ở `components/site-header.tsx`, mở bằng nút ✦ / Ctrl+J / `openCopilot()`), và nút "Tóm tắt bằng
AI" trong ngăn kéo kiện (`app/(dashboard)/shipments/care-drawer.tsx`). Redesign thì sửa trình bày
của hai chỗ đó; phần gọi Server Action và kiểu dữ liệu giữ nguyên. Ba Server Action ở
`lib/actions/ai.ts`, kiểu ở `lib/ai/contracts.ts`. **Không đổi tên / hình dạng kiểu** — chỉ thêm
trường optional nếu cần.

## Gọi

```ts
import { askCopilot, confirmCopilotActions, copilotStatus } from "@/lib/actions/ai";
import type { CopilotResult, CopilotPendingAction } from "@/lib/ai/contracts";

const st = await copilotStatus();               // { enabled, model, tools[] } — enabled=false ⇒ ẩn nút
const r: CopilotResult = await askCopilot({
  message: "Tóm tắt kiện này và đề nghị bước tiếp theo",
  context: { route: "/shipments", entityType: "shipment", entityId: shipmentId },
  history: prev,                                // [{ role, text }] ≤ 12 lượt, chỉ văn bản
});
// r.status: OK | NEEDS_CONFIRMATION | REFUSED | ERROR | DISABLED
// r.answer (markdown nhẹ) · r.warnings[] (dữ liệu cũ / tool lỗi — hiện riêng, màu cảnh báo)
// r.toolCalls[] ("AI đã tra: Xem hồ sơ kiện · Tổng quan hàng đợi") · r.pendingActions[]
if (r.pendingActions.length) {
  // Hiện từng hành động: label + summary + riskClass; nút "Xác nhận" cho từng cái hoặc tất cả.
  const c = await confirmCopilotActions({ interactionId: r.interactionId!, tokens: chosen.map((a) => a.token) });
  // c.ok ⇒ c.data.executed[] { name, label, ok, summary } — ok=false có lý do trong summary
  // sau đó router.refresh() để bàn làm việc thấy trạng thái care mới
}
```

## Quy ước UI (đề nghị, không bắt buộc)

- Copilot là **ngăn kéo/hộp thoại toàn cục** (phím tắt), tự mang `context` theo route và đối tượng
  đang mở (ngăn kéo kiện ⇒ `entityType: "shipment"`). Trong bàn làm việc care, thêm nút "Tóm tắt
  bằng AI" ở ngăn kéo kiện gọi thẳng với câu hỏi mặc định.
- Hành động đề nghị **không bao giờ tự chạy**; nút xác nhận ghi rõ `summary`. `riskClass: "care"`
  là xác nhận thường; các nhóm khác hiện chưa có (forbidden).
- `warnings` hiện trên câu trả lời, không trộn vào nó.
- `status === "DISABLED"` ⇒ máy chủ chưa có khoá; ẩn hoặc hiện dòng "chưa bật".
- `copilotStatus()` trả `{ enabled, provider, model, reason, tools }` — `reason` là secret còn thiếu.

## Bật trên máy chủ

`.env` trên VPS: `OPENAI_API_KEY=…` (mặc định dùng OpenAI: gpt-5.6-terra cho copilot, luna cho
việc rẻ, sol cho phân tích) hoặc `ANTHROPIC_API_KEY=…` (claude-opus-5). Không commit. Tuỳ chọn
`AI_PROVIDER` (auto | openai | anthropic | off), `AI_MODEL`, `AI_EFFORT`, `AI_MAX_TOOL_ROUNDS` (6).
Migration `0062_ai_interactions` tự áp khi app khởi động. Trang Kết nối dữ liệu có thẻ "AI Copilot"
với nút thử kết nối.

## Kiểm thử

`tests/ai-copilot.test.ts` (FakeProvider, không mạng): sổ đăng ký, quyền, đọc chạy / ghi chờ,
token, xác nhận, chống chạy lại, trần vòng lặp, benchmark. Kiến trúc: `docs/ai-copilot-architecture.md`.
