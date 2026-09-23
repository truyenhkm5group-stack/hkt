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

/**
 * ═══════════ TRẦN CHỜ MỘT LƯỢT GỌI TRONG VÒNG LẶP AGENT ═══════════
 *
 * Tách khỏi `TIMEOUT_BY_TIER` có chủ đích. Bậc model trả lời "việc này đáng bao nhiêu tiền";
 * hằng số này trả lời "chờ MỘT lượt gọi bao lâu thì bỏ". Buộc hai câu ấy vào một núm là thứ đã
 * giết hai lượt chạy: chọn model rẻ (đúng) kéo theo trần chờ 60 giây (sai cho hình dạng này).
 *
 * ĐO THẬT (TECH-6, lượt chạy #41, 23/09/2026):
 *
 *     vòng 1–3  xong bình thường
 *     vòng 4    đệm đọc 98.734 · đệm ghi 58.039  ⇒  Request timed out
 *     kết quả   $0,0891 · 4 vòng · 0 tệp giao về
 *
 * Ngữ cảnh của một vòng lặp agent PHÌNH THEO SỐ TỆP ĐÃ ĐỌC, nên lượt gọi cuối luôn là lượt nặng
 * nhất — đúng lượt mà trần 60 giây cắt. Đó là lý do lỗi TÁI LẬP ĐƯỢC chứ không ngẫu nhiên, và là
 * lý do nó luôn xảy ra SAU khi đã tiêu tiền cho ba vòng trước.
 *
 * 5 phút, KHÔNG phải 10: `RETRIES_BY_TIER.routine = 2` nên SDK còn thử lại, và job Actions có
 * trần 60 phút. Ba lượt × 5 phút vẫn nằm gọn trong `MAX_ROUNDS` mà không biến một lượt chạy hỏng
 * thành một giờ chờ.
 *
 * KHÔNG nâng `TIMEOUT_BY_TIER.routine`: bậc ấy còn phục vụ phân loại và tóm tắt trong ERP, nơi
 * chờ 5 phút cho một câu trả lời hai chữ là một màn hình treo trước mắt người dùng.
 */
export const AGENT_LOOP_TIMEOUT_MS = 300_000;
