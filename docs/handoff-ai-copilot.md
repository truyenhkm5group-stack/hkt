# Handoff AI Copilot cho phiên UI (Claude Opus 5)

Backend đã xong và có kiểm thử. UI chỉ cần gọi ba Server Action ở `lib/actions/ai.ts` và dùng kiểu
ở `lib/ai/contracts.ts`. **Không đổi tên / hình dạng kiểu** — chỉ thêm trường optional nếu cần.

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
- Sau khi nối xong: xoá ba dòng `lib/actions/ai.ts::*` trong `CHUA_NOI` ở
  `tests/action-wiring.test.ts`.

## Bật trên máy chủ

`.env` trên VPS: `ANTHROPIC_API_KEY=…` (không commit). Tuỳ chọn `AI_MODEL` (mặc định
`claude-opus-5`), `AI_EFFORT` (medium), `AI_MAX_TOOL_ROUNDS` (6), `AI_PROVIDER=off` để tắt.
Migration `0062_ai_interactions` tự áp khi app khởi động.

## Kiểm thử

`tests/ai-copilot.test.ts` (FakeProvider, không mạng): sổ đăng ký, quyền, đọc chạy / ghi chờ,
token, xác nhận, chống chạy lại, trần vòng lặp, benchmark. Kiến trúc: `docs/ai-copilot-architecture.md`.
