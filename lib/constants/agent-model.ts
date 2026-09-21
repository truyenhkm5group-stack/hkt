import type { AiTier } from "@/lib/ai/router";
import type { TechAgentRole } from "@/lib/constants/tech";

/**
 * ═══════════ MỖI VAI AGENT MỘT BẬC MODEL — VÀ MẶC ĐỊNH LÀ BẬC RẺ ═══════════
 *
 * ĐO THẬT 21/09/2026, sau khi chủ shop báo "mới test luồng mà đã hết $25":
 *
 *   · Runner gọi `getAiProvider("copilot")` cho MỌI vai. Bậc `copilot` của Anthropic là
 *     `claude-opus-5` — **$5/M đầu vào, $25/M đầu ra** theo bảng giá đang khai trong kho.
 *   · Việc thật đầu tiên (`TECH-2`) là **viết một tệp Markdown trong `docs/`**, với hàng rào chỉ
 *     cho ghi đúng thư mục ấy.
 *
 * Dùng model đắt nhất cho một việc như thế không mua thêm được gì đáng kể, nhưng trả gấp năm lần.
 *
 * ─── VÌ SAO KHAI THEO VAI, KHÔNG PHẢI MỘT HẰNG SỐ TOÀN CỤC ───
 *
 * "Rẻ" không phải lúc nào cũng đúng. Một vai `BACKEND` sửa mã nghiệp vụ hay một vai `SECURITY` đọc
 * hàng rào thì sai một lần đắt hơn nhiều lần tiền model. Nên bậc là thuộc tính của VAI, khai ở một
 * chỗ, và nâng lên được khi có phép ĐO cho thấy vai ấy cần — không phải khi ai đó thấy lo.
 *
 * Vai chưa khai rơi về `routine`: phía RẺ HƠN, cùng luật với `writeGlobsForRole` rơi về `docs/`
 * (AGENTS.md mục 31 — mọi nhánh lỗi rơi về phía hẹp hơn). Một vai mới lỡ quên khai thì tốn ít tiền
 * và có thể làm kém; quên theo chiều ngược lại thì tốn nhiều tiền một cách âm thầm.
 */
export const TIER_BY_ROLE: Partial<Record<TechAgentRole, AiTier>> = {
  /*
    Viết tài liệu trong `docs/`. Hàng rào đã chặn mọi thứ khác, nên rủi ro của một câu văn dở là
    một câu văn dở — người xem sửa được ở review. Bậc `routine`.
  */
  DOCUMENTATION: "routine",
  /*
    QA ghi `tests/`. Vẫn `routine`, nhưng lý do khác: bài kiểm SAI thì cổng đỏ và không ai gộp
    được — cái giá của model yếu ở đây là một lượt chạy phí, không phải một lỗi lọt lưới.
  */
  QA: "routine",
};

/** Bậc mặc định cho vai chưa khai. Rẻ hơn = phía an toàn hơn về TIỀN, và vai lạ vốn cũng bị hàng rào thu hẹp. */
export const TIER_MAC_DINH: AiTier = "routine";

export function tierForRole(role: string | null | undefined): AiTier {
  if (!role) return TIER_MAC_DINH;
  return TIER_BY_ROLE[role as TechAgentRole] ?? TIER_MAC_DINH;
}
