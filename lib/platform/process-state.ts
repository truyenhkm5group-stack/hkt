import { currentOrganization } from "@/lib/platform/context";

/**
 * ═══════════ KHOÁ CỦA TRẠNG THÁI MỨC TIẾN TRÌNH = MÃ TỔ CHỨC ═══════════
 *
 * Audit ISO-12/15/18 · target-architecture P13. Nhịp chống gọi lại ("vừa tính trong 5 phút qua"),
 * khoá "đang có lần chạy khác", hẹn giờ gộp: một giá trị cho cả tiến trình nghĩa là lượt của tổ
 * chức A làm lượt của tổ chức B trả "bỏ qua" — B mất sổ chờ hàng, mất bản tin, mất lượt xử lý giao
 * thất bại mà không một dòng nào nói vì sao. Mỗi holder như thế giữ một `Map<mã tổ chức, …>` và
 * hỏi khoá ở đây.
 *
 * Tổ chức nhà vẫn chỉ có đúng MỘT mục trong mỗi Map — hành vi của nó y như trước nền tảng.
 * Không xác định được tổ chức ⇒ ném (`OrgContextError`), không gộp vào mục của nhà.
 */
export async function organizationStateKey(): Promise<string> {
  return (await currentOrganization()).code;
}
