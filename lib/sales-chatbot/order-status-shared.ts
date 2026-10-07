/**
 * ═══════════ CÂU TRẠNG THÁI ĐƠN CHO KHÁCH — HÀM THUẦN (công cụ `get_order_status`, Master Mission «Commerce Truth») ═══════════
 *
 * Bot trả lời «đơn của em tới đâu rồi» bằng câu dưới đây — KHÔNG phải kết luận kết quả đơn của ERP (`ORDER_OUTCOME`). Thứ tự
 * căn cứ (review độc lập 08/10/2026):
 *  1. TRẠNG THÁI ĐƠN trước: đơn huỷ là huỷ dù vận đơn còn «chờ lấy»; đơn nháp chưa chốt thì nói chưa chốt (khách hỏi «bao giờ
 *     giao» trước khi chốt không được nghe «đang chuẩn bị»).
 *  2. VẬN ĐƠN ĐẠI DIỆN (`vanDonDaiDien` — cùng luật `PRIMARY_ATTEMPT` của mọi báo cáo, bỏ chiều hoàn): chỉ nói «đơn vị vận chuyển
 *     báo …» khi chặng dựng từ CHỨNG TỪ ĐVVC (`vtp_sync_source` ∈ `CARRIER_EVENT_SOURCES`, AGENTS mục 47). Chặng suy từ trạng thái
 *     Pancake không phải lời của ĐVVC ⇒ câu trung tính.
 *  3. Không vận đơn: đơn tạo trong ERP có PHIẾU GIAO ký nhận (chứng từ của shop — ORDER_OUTCOME.md §11) ⇒ «shop đã giao»; giao
 *     hỏng ⇒ chuyển người. Còn lại KHÔNG khẳng định «chưa giao» (đơn Pancake có thể đã gửi ở nơi ERP không thấy).
 * Giao lỗi / đang hoàn / đã hoàn / vận đơn huỷ là việc của NGƯỜI (cứu đơn được hay không — AGENTS mục 66: 505 mới là đề nghị
 * hoàn) ⇒ `needsStaff`: bot nói ĐÚNG lời khai rồi HỎI khách có cần nhân viên hỗ trợ không (khách cần ⇒ `handoff_to_human`) —
 * không tự chuyển người (một đơn hoàn cũ không được khoá mọi câu hỏi sau), không hứa «sẽ giao lại» / «sẽ liên hệ».
 * Không bao giờ suy «đã giao» từ tiền / COD.
 */
import { returnApproved } from "@/lib/constants/care-return-approval";

export type OrderStatusInput = {
  /** `orders.stage`. */
  orderStage: string;
  /** Đơn tạo trong ERP (`erp-…`) — phiếu giao ký nhận của shop là chứng từ giao của đơn ấy. */
  manual: boolean;
  /** Vận đơn ĐẠI DIỆN của đơn (chiều đi); `null` = ERP không có vận đơn nào. */
  shipment: { stage: string; carrierEvidence: boolean; statusCode: number | null; statusName: string | null } | null;
};

export type CustomerOrderStatus = {
  /** Câu nói với khách. */
  text: string;
  /** Câu là LỜI KHAI của đơn vị vận chuyển (bot được trích nguyên văn `carrier_status`). */
  carrierSaid: boolean;
  /** Khác `null` ⇒ đơn cần nhân viên CHĂM SÓC (lý do) — bot nói câu trên rồi hỏi khách có cần nhân viên hỗ trợ không. */
  needsStaff: string | null;
};

const CARRIER_TEXT: Record<string, string> = {
  PENDING: "Đơn vị vận chuyển báo đang chờ tới lấy hàng",
  PICKED_UP: "Đơn vị vận chuyển báo đã lấy hàng, đơn đang trên đường",
  IN_TRANSIT: "Đơn vị vận chuyển báo đơn đang được vận chuyển",
  OUT_FOR_DELIVERY: "Đơn vị vận chuyển báo bưu tá đang giao tới anh/chị",
  DELIVERED: "Đơn vị vận chuyển báo đã giao thành công",
};

export const NO_CARRIER_INFO = "Chưa có thông tin từ đơn vị vận chuyển";

export function customerOrderStatus(i: OrderStatusInput): CustomerOrderStatus {
  const plain = (text: string): CustomerOrderStatus => ({ text, carrierSaid: false, needsStaff: null });
  if (i.orderStage === "CANCELLED") return plain("Đơn đã huỷ");
  if (i.orderStage === "NEW") return plain("Đơn chưa được chốt — shop chưa xác nhận đơn này");
  const s = i.shipment;
  if (s) {
    if (!s.carrierEvidence) return plain(s.stage === "PENDING" ? "Shop đã tạo vận đơn, đang chờ đơn vị vận chuyển tới lấy hàng" : NO_CARRIER_INFO);
    if (CARRIER_TEXT[s.stage]) return { text: CARRIER_TEXT[s.stage], carrierSaid: true, needsStaff: null };
    if (s.stage === "DELIVERY_FAILED") return { text: "Đơn vị vận chuyển báo lần giao vừa rồi chưa thành công", carrierSaid: true, needsStaff: "ĐVVC báo giao chưa thành công" };
    if (s.stage === "RETURNING") {
      // 505 «Yêu cầu chuyển hoàn» mới là ĐỀ NGHỊ — shop còn xin phát tiếp được; chỉ 502 / 515 / chữ «duyệt hoàn» là đã duyệt hoàn.
      const approved = returnApproved({ code: s.statusCode, text: s.statusName });
      return approved
        ? { text: "Đơn vị vận chuyển báo đơn đang chuyển hoàn về shop", carrierSaid: true, needsStaff: "ĐVVC đã duyệt hoàn" }
        : { text: "Đơn vị vận chuyển đang báo khó giao đơn này", carrierSaid: true, needsStaff: "ĐVVC đề nghị hoàn — còn cứu được" };
    }
    if (s.stage === "RETURNED") return { text: "Đơn vị vận chuyển báo đơn đã hoàn về shop", carrierSaid: true, needsStaff: "ĐVVC báo đã hoàn" };
    if (s.stage === "CANCELLED") return { text: "Vận đơn của đơn này đã bị huỷ", carrierSaid: true, needsStaff: "Vận đơn huỷ mà đơn chưa huỷ" };
    return plain(NO_CARRIER_INFO);
  }
  if (i.manual && i.orderStage === "DELIVERED") return plain("Shop đã giao đơn — có phiếu ký nhận");
  if (i.manual && i.orderStage === "RETURNED") return { text: "Lần giao vừa rồi chưa thành công", carrierSaid: false, needsStaff: "Giao không thành công" };
  return plain("Shop đã nhận đơn — chưa có thông tin vận chuyển");
}
