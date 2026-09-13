/**
 * ═══════════ LÝ DO HOÀN: PHÂN LOẠI THEO CHỨNG TỪ, KHÔNG THEO TIỀN ═══════════
 *
 * ─── ĐO TRƯỚC KHI ĐẶT LUẬT (production, 13/09/2026) ───
 *
 *   956 vận đơn hoàn
 *     · `shipments.vtp_reason_code` NULL ở **cả 956** — cột mã lý do chưa từng được ghi
 *     · 208 (21,8%) có sự kiện `Tồn - …` mang lý do thật
 *     · 7 có ghi chú care
 *     · 0 có phiếu kiểm hàng hoàn
 *
 * Nghĩa là: **gần 4/5 vận đơn hoàn không có chứng từ nào nói vì sao.** Đó là một sự thật về dữ
 * liệu, không phải một lỗ hổng cần lấp bằng suy đoán. `UNKNOWN` là một câu trả lời hợp lệ và sẽ
 * là câu trả lời phổ biến nhất cho tới khi ĐVVC gửi mã lý do hoặc người xử lý tự ghi lại.
 *
 * ─── VÌ SAO KHÔNG SUY LÝ DO TỪ TIỀN ───
 *
 * Cám dỗ lớn nhất: đơn `RETURNED` do doanh thu dưới ngưỡng thì gán "khách từ chối". Sai hai lần.
 * Thứ nhất, tiền là chiều ĐỘC LẬP với logistics (`docs/business-rules/ORDER_OUTCOME.md`) — suy
 * chiều này từ chiều kia là đúng thứ đặc tả cấm. Thứ hai, "doanh thu thấp" có ít nhất bốn nguyên
 * nhân khác nhau (giao một phần, nhập sai, khách trả bớt món, chưa đối soát) và gộp cả bốn vào
 * một nhãn sẽ tạo ra một cột số trông đầy đủ mà không nói được điều gì.
 *
 * Với những đơn đó, `reason = UNKNOWN` và `outcomeBasis` ghi rõ kết quả đến từ luật doanh thu —
 * hai thông tin khác nhau, để cạnh nhau, không trộn.
 */

export const RETURN_REASONS = [
  "CUSTOMER_REFUSED",
  "CUSTOMER_UNREACHABLE",
  "WRONG_PHONE",
  "WRONG_ADDRESS",
  "CUSTOMER_RESCHEDULE_FAILED",
  "CUSTOMER_CHANGED_MIND",
  "DELIVERY_ATTEMPTS_EXHAUSTED",
  "SHOP_REQUESTED_RETURN",
  "DAMAGED",
  "WRONG_ITEM",
  "CARRIER_EXCEPTION",
  "OTHER",
  "UNKNOWN",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_REASON_LABEL: Record<ReturnReason, string> = {
  CUSTOMER_REFUSED: "Khách từ chối nhận",
  CUSTOMER_UNREACHABLE: "Không liên lạc được khách",
  WRONG_PHONE: "Sai số điện thoại",
  WRONG_ADDRESS: "Sai địa chỉ",
  CUSTOMER_RESCHEDULE_FAILED: "Hẹn lại rồi vẫn không giao được",
  CUSTOMER_CHANGED_MIND: "Khách đổi ý, không còn nhu cầu",
  DELIVERY_ATTEMPTS_EXHAUSTED: "Phát nhiều lần không thành",
  SHOP_REQUESTED_RETURN: "Shop yêu cầu chuyển hoàn",
  DAMAGED: "Hàng hỏng / bể vỡ",
  WRONG_ITEM: "Giao sai hàng",
  CARRIER_EXCEPTION: "Sự cố phía đơn vị vận chuyển",
  OTHER: "Lý do khác (có ghi chú)",
  UNKNOWN: "Chưa xác định được",
};

/** Ai chịu trách nhiệm chính — để báo cáo nói được "sửa ở đâu", không chỉ "hỏng ở đâu". */
export const RETURN_REASON_OWNER: Record<ReturnReason, "SALES" | "LOGISTICS" | "WAREHOUSE" | "CUSTOMER" | "CARRIER" | "UNKNOWN"> = {
  CUSTOMER_REFUSED: "CUSTOMER",
  CUSTOMER_UNREACHABLE: "SALES",
  WRONG_PHONE: "SALES",
  WRONG_ADDRESS: "SALES",
  CUSTOMER_RESCHEDULE_FAILED: "CUSTOMER",
  CUSTOMER_CHANGED_MIND: "CUSTOMER",
  DELIVERY_ATTEMPTS_EXHAUSTED: "CARRIER",
  SHOP_REQUESTED_RETURN: "SALES",
  DAMAGED: "WAREHOUSE",
  WRONG_ITEM: "WAREHOUSE",
  CARRIER_EXCEPTION: "CARRIER",
  OTHER: "UNKNOWN",
  UNKNOWN: "UNKNOWN",
};

/**
 * MÃ LÝ DO CỦA ĐVVC → phân loại của shop.
 *
 * Dải 20–47 là bảng webhook chính thức, dải 1–17 là bảng đối tác V2 cũ (xem
 * `lib/constants/viettelpost.ts::VTP_REASON_CODES`). Cả hai được khai ở đây vì vận đơn lịch sử
 * dùng bảng cũ.
 *
 * LƯU Ý QUAN TRỌNG: tính tới 13/09/2026, `shipments.vtp_reason_code` NULL trên toàn bộ dữ liệu
 * production — bảng này **chưa từng khớp một dòng nào**. Nó được khai sẵn và đúng, để ngày ĐVVC
 * bắt đầu gửi mã thì độ phủ tự tăng mà không phải sửa gì. Đừng nhầm "đã khai" với "đang chạy".
 */
export const VTP_REASON_TO_RETURN_REASON: Record<number, ReturnReason> = {
  20: "WRONG_ITEM",
  21: "WRONG_ITEM",
  22: "WRONG_ITEM",
  23: "DAMAGED",
  24: "CUSTOMER_REFUSED",
  25: "WRONG_ITEM",
  26: "CUSTOMER_REFUSED",
  27: "WRONG_PHONE",
  30: "CUSTOMER_CHANGED_MIND",
  31: "CUSTOMER_CHANGED_MIND",
  32: "WRONG_ADDRESS",
  35: "CUSTOMER_RESCHEDULE_FAILED",
  36: "CUSTOMER_UNREACHABLE",
  37: "CARRIER_EXCEPTION",
  38: "CUSTOMER_RESCHEDULE_FAILED",
  43: "SHOP_REQUESTED_RETURN",
  46: "CUSTOMER_RESCHEDULE_FAILED",
  47: "CUSTOMER_UNREACHABLE",
  1: "CUSTOMER_RESCHEDULE_FAILED",
  2: "CUSTOMER_UNREACHABLE",
  3: "CUSTOMER_RESCHEDULE_FAILED",
  4: "CUSTOMER_REFUSED",
  5: "WRONG_ITEM",
  6: "WRONG_ITEM",
  7: "WRONG_ITEM",
  8: "WRONG_ITEM",
  9: "CUSTOMER_REFUSED",
  10: "WRONG_ADDRESS",
  11: "DAMAGED",
  12: "CUSTOMER_REFUSED",
  13: "CUSTOMER_CHANGED_MIND",
  14: "CUSTOMER_CHANGED_MIND",
  15: "WRONG_PHONE",
  16: "DELIVERY_ATTEMPTS_EXHAUSTED",
  17: "SHOP_REQUESTED_RETURN",
};

/**
 * CHUỖI TRẠNG THÁI "Tồn - …" → phân loại.
 *
 * Đây là nguồn lý do DUY NHẤT đang thật sự chạy (208/956 vận đơn hoàn). Viettel Post đẩy lý do
 * vào phần tên trạng thái chứ không vào mã, nên phải đọc chữ.
 *
 * So khớp trên chuỗi ĐÃ BỎ DẤU và hạ chữ, vì cùng một lý do xuất hiện với vài cách viết dấu khác
 * nhau giữa webhook và bản nhập Excel. Thứ tự trong mảng là thứ tự ưu tiên: mẫu cụ thể đứng trước
 * mẫu chung, để "khách hàng nghỉ, không có nhà" không bị nuốt bởi một mẫu "khách hàng" rộng hơn.
 */
export const RETURN_REASON_TEXT_RULES: { match: string; reason: ReturnReason }[] = [
  { match: "khach hang nghi, khong co nha", reason: "CUSTOMER_UNREACHABLE" },
  { match: "khong co nha", reason: "CUSTOMER_UNREACHABLE" },
  { match: "khong lien lac", reason: "CUSTOMER_UNREACHABLE" },
  { match: "khach hang den buu cuc nhan", reason: "CUSTOMER_RESCHEDULE_FAILED" },
  { match: "hen phat lai", reason: "CUSTOMER_RESCHEDULE_FAILED" },
  { match: "tu choi", reason: "CUSTOMER_REFUSED" },
  { match: "khong cho xem hang", reason: "CUSTOMER_REFUSED" },
  { match: "khong co nhu cau", reason: "CUSTOMER_CHANGED_MIND" },
  { match: "khong dat don", reason: "CUSTOMER_CHANGED_MIND" },
  { match: "sai dia chi", reason: "WRONG_ADDRESS" },
  { match: "sai so dien thoai", reason: "WRONG_PHONE" },
  { match: "sai dinh dang so dien thoai", reason: "WRONG_PHONE" },
  { match: "chat luong kem", reason: "DAMAGED" },
  { match: "hu hong", reason: "DAMAGED" },
  { match: "sai mau", reason: "WRONG_ITEM" },
  { match: "sai kich thuoc", reason: "WRONG_ITEM" },
  { match: "sai kieu dang", reason: "WRONG_ITEM" },
  { match: "sai so luong", reason: "WRONG_ITEM" },
  { match: "phat that bai nhieu lan", reason: "DELIVERY_ATTEMPTS_EXHAUSTED" },
  { match: "nguoi gui yeu cau chuyen hoan", reason: "SHOP_REQUESTED_RETURN" },
  { match: "shop yeu cau", reason: "SHOP_REQUESTED_RETURN" },
];

/**
 * Chuỗi trạng thái là BƯỚC ĐI, không phải LÝ DO.
 *
 * "Tồn - Thông báo chuyển hoàn bưu cục gốc" (178 vận đơn) trông như một lý do vì nó bắt đầu bằng
 * "Tồn -", nhưng nó chỉ nói kiện đang trên đường về — chưa nói vì sao. Nhận nhầm nhóm này thành
 * lý do sẽ tạo ra một nhãn chiếm 18% báo cáo mà không hành động được gì với nó.
 */
export const RETURN_STEP_NOT_REASON = ["thong bao chuyen hoan", "chuyen hoan buu cuc goc", "chuyen tra nguoi gui"];

/** Bỏ dấu tiếng Việt + hạ chữ, để so khớp không phụ thuộc cách gõ dấu. */
export function boDau(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/** Độ tin cậy của một lần phân loại — đi kèm từng dòng, không phải một ghi chú ở cuối trang. */
export type ReasonConfidence = "CONFIRMED" | "CARRIER_CODE" | "CARRIER_TEXT" | "NONE";

export const REASON_CONFIDENCE_LABEL: Record<ReasonConfidence, string> = {
  CONFIRMED: "Người xác nhận",
  CARRIER_CODE: "Mã lý do ĐVVC",
  CARRIER_TEXT: "Suy từ trạng thái ĐVVC",
  NONE: "Không có chứng từ",
};
