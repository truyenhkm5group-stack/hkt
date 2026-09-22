/**
 * ═══════════ MODEL NÀO NHẬN ĐƯỢC THAM SỐ NÀO ═══════════
 *
 * Lớp provider Anthropic của ERP gửi `thinking: { type: "adaptive" }` và
 * `output_config: { effort }` cho MỌI model. Trên bản chạy thử 22/09/2026, lượt gọi đầu tiên tới
 * `claude-haiku-4-5` trả về:
 *
 *   400 invalid_request_error — "adaptive thinking is not supported on this model"
 *
 * Không phải lỗi thoáng qua: Haiku 4.5 KHÔNG hỗ trợ suy luận thích ứng, và cũng KHÔNG nhận
 * `output_config.effort` (nó dùng `thinking.budget_tokens` của thế hệ trước). Gửi tham số một
 * model không nhận là HỎNG HOÀN TOÀN — 400, không có phần nào chạy được.
 *
 * Vì sao chuyện này nằm im tới hôm nay: production chạy `AI_PROVIDER=openai`, nên nhánh Anthropic
 * chưa từng được gọi thật. Nó chỉ lộ ra đúng lúc chuyển nhân sự bán hàng sang Anthropic.
 *
 * ─── MẶC ĐỊNH LÀ KHÔNG GỬI ───
 *
 * Model lạ (chưa khai ở đây) rơi vào nhánh KHÔNG gửi. Bất đối xứng của hai kiểu sai quyết định
 * điều đó: thiếu `thinking` thì model vẫn trả lời, chỉ là không suy luận sâu — mất một chút chất
 * lượng. Thừa `thinking` trên model không nhận thì 400, mất trắng lượt gọi. Rơi về phía HẸP HƠN.
 *
 * Ngày chép năng lực từ tài liệu nhà cung cấp: 24/06/2026. Thêm model mới thì khai ở đây, không
 * rải điều kiện vào nơi gọi.
 */

/** Model nhận `thinking: { type: "adaptive" }` VÀ `output_config: { effort }`. */
const ADAPTIVE_THINKING_MODELS = new Set([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-mythos-5-1",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
]);

/**
 * Model nhận suy luận thích ứng. Chưa khai ⇒ `false`.
 *
 * So khớp TRỌN VẸN, không so tiền tố: `claude-haiku-4-5` không được ăn theo `claude-haiku-4-5-xx`
 * nào đó chưa biết năng lực, và ngược lại.
 */
export function supportsAdaptiveThinking(model: string): boolean {
  return ADAPTIVE_THINKING_MODELS.has(model.trim());
}

/**
 * `output_config.effort` đi CÙNG suy luận thích ứng trên các model hiện hành, nên một cờ là đủ.
 * Tách thành hàm riêng để nơi gọi đọc ra ý định, và để tách được nếu nhà cung cấp tách chúng.
 */
export function supportsEffort(model: string): boolean {
  return supportsAdaptiveThinking(model);
}
