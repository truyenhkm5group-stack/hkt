/**
 * ═══════════ QUAN SÁT LÝ DO HOÀN: CHỮ GỐC LÀ SỰ THẬT, PHÂN LOẠI LÀ CÁCH ĐỌC ═══════════
 *
 * ─── VẤN ĐỀ ĐÃ ĐO ĐƯỢC ───
 *
 * Trước bản này, lý do hoàn được suy LẠI TỪ ĐẦU ở mỗi lượt mở báo cáo: quét `shipment_events`,
 * đọc chữ trạng thái, chạy bảng luật. Hệ quả:
 *
 *   · Chữ gốc KHÔNG được lưu ở đâu như một quan sát có mốc thời gian và có nguồn. Nó chỉ tồn tại
 *     rải rác trong bảng sự kiện, lẫn với hàng chục nghìn dòng hành trình không phải lý do.
 *   · `shipment_return_reasons` (bảng của NGƯỜI xác nhận) có ĐÚNG 0 dòng, nên báo cáo lý do hoàn
 *     đứng hoàn toàn trên phần máy đọc được từ chữ của ĐVVC.
 *   · Không có chỗ nào để ghi một quan sát KHÔNG PHẢI của ĐVVC: khách nhắn lý do qua chat, nhân
 *     viên gọi điện hỏi, phiếu kiểm hàng hoàn ghi nhận xét. Chúng có thật trong CSDL nhưng không
 *     có đường nào vào báo cáo.
 *
 * ─── HÌNH DẠNG ĐÚNG: MỘT DÒNG CHO MỘT QUAN SÁT ───
 *
 *     chữ gốc  →  lý do chuẩn hoá  →  nhóm lý do
 *      (bất biến)      (sửa được)       (sửa được)
 *
 * Mỗi dòng `return_reason_observations` là MỘT lần ai đó (máy hoặc người) NÓI ra một điều về vì
 * sao kiện hoàn: chữ nguyên văn, nguồn, mốc thời gian, kiện/đơn liên quan. Dòng ấy KHÔNG BAO GIỜ
 * bị sửa — kể cả khi về sau shop đổi cách phân loại.
 *
 * Phân loại (`reason`) và nhóm được suy khi ĐỌC. Đổi cách phân loại là đổi một bảng tra, không
 * phải chạy `UPDATE` lên lịch sử.
 *
 * ─── KHÔNG ĐOÁN, KHÔNG SUY TỪ TRẠNG THÁI CHUNG ───
 *
 * Một quan sát chỉ được sinh ra khi có CHỮ THẬT nói về lý do. "Kiện đang chuyển hoàn" là một BƯỚC
 * ĐI, không phải lý do — nó không sinh quan sát nào. Chữ có thật nhưng không khớp danh mục nào thì
 * `reason = UNKNOWN`: giữ nguyên chữ, thừa nhận chưa xếp được, KHÔNG gán bừa.
 */

/**
 * NGUỒN của một quan sát. Thứ tự trong mảng KHÔNG phải thứ tự ưu tiên — ưu tiên khai riêng ở
 * `SOURCE_RANK` để đọc ra ý định thay vì đọc ra vị trí mảng.
 */
export const REASON_SOURCES = [
  /** Người của shop hỏi khách rồi ghi. Có thẩm quyền cao nhất. */
  "HUMAN_CONFIRMED",
  /** Kho mở kiện hoàn ra xem và ghi nhận xét. */
  "WAREHOUSE_INSPECTION",
  /** Ghi chú của người xử lý ca chăm sóc kiện. */
  "CARE_NOTE",
  /** Ghi chú trên ca CSKH. */
  "CS_NOTE",
  /** Mã lý do có cấu trúc do ĐVVC gửi. */
  "CARRIER_CODE",
  /** Chữ trạng thái / ghi chú do ĐVVC gửi. */
  "CARRIER_TEXT",
  /** Bản ghi đổi trả đồng bộ từ Pancake. */
  "PANCAKE_RETURN",
  /** Ghi chú trên đơn Pancake. */
  "PANCAKE_ORDER_NOTE",
] as const;
export type ReasonSource = (typeof REASON_SOURCES)[number];

export const REASON_SOURCE_LABEL: Record<ReasonSource, string> = {
  HUMAN_CONFIRMED: "Người của shop xác nhận",
  WAREHOUSE_INSPECTION: "Kho kiểm hàng hoàn",
  CARE_NOTE: "Ghi chú chăm sóc kiện",
  CS_NOTE: "Ghi chú ca CSKH",
  CARRIER_CODE: "Mã lý do ĐVVC",
  CARRIER_TEXT: "Chữ trạng thái ĐVVC",
  PANCAKE_RETURN: "Phiếu đổi trả Pancake",
  PANCAKE_ORDER_NOTE: "Ghi chú đơn Pancake",
};

/**
 * ═══ AI ĐƯỢC NÓI GÌ ═══
 *
 * Ranh giới quan trọng nhất của cả lớp này, và nó chỉ lặp lại luật đã có ở
 * `REASON_NEEDS_HUMAN`: Viettel Post biết kiện đi tới đâu và vì sao không phát được. ĐVVC KHÔNG
 * biết vải nóng, không biết khách mặc có vừa không, không biết sale tư vấn sai size.
 *
 * Nguồn khai `canConcludeShopFault: false` thì chữ của nó KHÔNG BAO GIỜ được xếp vào một lý do
 * thuộc nhóm chỉ-người-mới-biết — dù chữ ấy nghe thuyết phục tới đâu. Một bưu tá gõ "khách không
 * hài lòng về sản phẩm" là một QUAN SÁT về điều khách nói, không phải shop đã xác minh vải xấu.
 */
export const SOURCE_CAN_CONCLUDE_SHOP_FAULT: Record<ReasonSource, boolean> = {
  HUMAN_CONFIRMED: true,
  WAREHOUSE_INSPECTION: true,
  CARE_NOTE: true,
  CS_NOTE: true,
  CARRIER_CODE: false,
  CARRIER_TEXT: false,
  PANCAKE_RETURN: false,
  PANCAKE_ORDER_NOTE: false,
};

/**
 * THỨ HẠNG khi một kiện có NHIỀU quan sát. Số lớn thắng.
 *
 * Người đã hỏi khách biết nhiều hơn mọi suy luận từ chữ máy; kho mở kiện ra xem biết nhiều hơn
 * một ghi chú chăm sóc; mã có cấu trúc của ĐVVC chắc chắn hơn chữ tự do của chính họ.
 *
 * Bằng hạng thì lấy quan sát MUỘN HƠN: kiện hẹn lại rồi vẫn hoàn thì lý do cuối mới là lý do nó
 * hoàn — cùng luật mà bản cũ đã dùng khi duyệt sự kiện theo thời gian.
 */
export const SOURCE_RANK: Record<ReasonSource, number> = {
  HUMAN_CONFIRMED: 100,
  WAREHOUSE_INSPECTION: 80,
  CARE_NOTE: 60,
  CS_NOTE: 55,
  CARRIER_CODE: 40,
  CARRIER_TEXT: 30,
  PANCAKE_RETURN: 25,
  PANCAKE_ORDER_NOTE: 10,
};

/** Quan sát do MÁY rút ra, hay do NGƯỜI gõ. Quyết định việc có được hiện là "đã xác nhận" hay không. */
export const SOURCE_IS_HUMAN: Record<ReasonSource, boolean> = {
  HUMAN_CONFIRMED: true,
  WAREHOUSE_INSPECTION: true,
  CARE_NOTE: true,
  CS_NOTE: true,
  CARRIER_CODE: false,
  CARRIER_TEXT: false,
  PANCAKE_RETURN: false,
  PANCAKE_ORDER_NOTE: false,
};

export function isReasonSource(s: string): s is ReasonSource {
  return (REASON_SOURCES as readonly string[]).includes(s);
}

/**
 * ═══ TRẠNG THÁI ĐỘ PHỦ CỦA MỘT KIỆN HOÀN ═══
 *
 * Ba trạng thái, và chúng KHÔNG được gộp:
 *
 *   `CLASSIFIED`   — có quan sát và xếp được vào danh mục.
 *   `RAW_ONLY`     — CÓ chữ thật nhưng chưa xếp được (chữ lạ, hoặc nguồn không đủ thẩm quyền kết
 *                    luận). Đây là việc phải làm: xem chữ rồi bổ sung luật hoặc xác nhận tay.
 *   `NO_EVIDENCE`  — KHÔNG có một chữ nào. Khác hẳn `RAW_ONLY`: chỗ này cần đi HỎI, không phải
 *                    ngồi phân loại.
 *
 * Gộp `RAW_ONLY` với `NO_EVIDENCE` thành "chưa xác định" là xoá mất sự khác nhau giữa "đã có
 * người nói, ta chưa đọc" và "chưa ai nói gì" — hai việc phải làm hoàn toàn khác nhau.
 */
export const REASON_COVERAGE_STATES = ["CLASSIFIED", "RAW_ONLY", "NO_EVIDENCE"] as const;
export type ReasonCoverageState = (typeof REASON_COVERAGE_STATES)[number];

export const REASON_COVERAGE_LABEL: Record<ReasonCoverageState, string> = {
  CLASSIFIED: "Đã xác định lý do",
  RAW_ONLY: "Có chứng từ, chưa xếp được",
  NO_EVIDENCE: "Chưa có chứng từ nào",
};

export const REASON_COVERAGE_ACTION: Record<ReasonCoverageState, string> = {
  CLASSIFIED: "Không phải việc — đã có lý do dùng được.",
  RAW_ONLY: "Mở chữ gốc ra đọc rồi chọn lý do, hoặc bổ sung luật nếu chữ ấy lặp lại nhiều.",
  NO_EVIDENCE: "Phải ĐI HỎI: gọi khách hoặc để kho ghi lại khi mở kiện. Không có chữ nào để đọc.",
};
