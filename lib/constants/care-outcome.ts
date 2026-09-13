/**
 * ═══════════ KẾT QUẢ CỦA MỘT CA CHĂM SÓC — THEO CHỨNG TỪ ĐVVC, KHÔNG THEO SỐ LẦN BẤM ═══════════
 *
 * ─── CÂU HỎI MÀ HỢP ĐỒNG NÀY TRẢ LỜI ───
 *
 * "Đội chăm sóc có CỨU ĐƯỢC đơn đó không?" — và câu trả lời chỉ được lấy từ nơi biết sự thật:
 * hành trình của đơn vị vận chuyển. Không lấy từ việc nhân viên đã bấm "Phát tiếp", không lấy từ
 * việc nhân viên đã bấm "Đã xong", không lấy từ tiền COD.
 *
 * Ba thứ sau đây KHÔNG phải là cứu được đơn:
 *   · gửi lệnh phát tiếp thành công — mới là ĐVVC nhận lệnh, chưa phải hàng tới tay khách;
 *   · duyệt hoàn — đó là quyết định của shop, không phải trạng thái của gói hàng;
 *   · đóng ca trên ERP — đó là thao tác của người, không phải chứng từ.
 *
 * ─── VÌ SAO PENDING PHẢI ĐỨNG RIÊNG ───
 *
 * Ca chưa có kết cục cuối thì CHƯA BIẾT cứu được hay không. Gộp nó vào mẫu số là ép một câu trả
 * lời chưa tồn tại thành "chưa cứu được" — và tỷ lệ tụt xuống chỉ vì hôm nay có nhiều ca mới.
 * Gộp vào tử số thì ngược lại. Nên nó nằm NGOÀI cả hai, và số ca PENDING được in ra cạnh tỷ lệ.
 */
export const CARE_OUTCOMES = ["RESCUED_DIRECT", "RESCUED_EXCHANGE", "RESCUE_FAILED", "PENDING", "UNATTRIBUTED"] as const;
export type CareOutcome = (typeof CARE_OUTCOMES)[number];

export const CARE_OUTCOME_LABEL: Record<CareOutcome, string> = {
  RESCUED_DIRECT: "Cứu được — chính kiện đó tới tay khách",
  RESCUED_EXCHANGE: "Cứu được bằng đơn đổi",
  RESCUE_FAILED: "Không cứu được",
  PENDING: "Chưa có kết quả cuối",
  UNATTRIBUTED: "Không đủ chứng cứ để kết luận",
};

export const CARE_OUTCOME_HINT: Record<CareOutcome, string> = {
  RESCUED_DIRECT: "Chính vận đơn đang gặp sự cố cuối cùng ĐÃ GIAO theo chứng từ ĐVVC, sau khi có người của shop can thiệp.",
  RESCUED_EXCHANGE: "Vận đơn gốc không tới tay khách, nhưng đơn ĐỔI nối với ca này cuối cùng đã giao. Tách riêng khỏi cứu trực tiếp vì hai việc khác nhau về chi phí và về thời gian.",
  RESCUE_FAILED: "Vận đơn cuối cùng quay đầu (đang hoàn / đã hoàn) hoặc kết thúc thất bại, và không có đơn đổi nào thành công.",
  PENDING: "Kiện chưa tới đích và cũng chưa quay đầu. CHƯA BIẾT — nằm ngoài cả tử số lẫn mẫu số của tỷ lệ cứu đơn.",
  UNATTRIBUTED: "Ca lịch sử không nối được về người hoặc về chứng từ. Không đoán, không đếm vào hiệu suất của ai.",
};

/** Ca đã có kết cục CUỐI — chỉ những ca này mới vào mẫu số của tỷ lệ cứu đơn. */
export const OUTCOME_IS_FINAL: Record<CareOutcome, boolean> = {
  RESCUED_DIRECT: true,
  RESCUED_EXCHANGE: true,
  RESCUE_FAILED: true,
  PENDING: false,
  UNATTRIBUTED: false,
};

/** Ca tính là CỨU ĐƯỢC. `RESCUED_EXCHANGE` chỉ vào tỷ lệ "tính cả đơn đổi". */
export const OUTCOME_IS_RESCUE: Record<CareOutcome, boolean> = {
  RESCUED_DIRECT: true,
  RESCUED_EXCHANGE: true,
  RESCUE_FAILED: false,
  PENDING: false,
  UNATTRIBUTED: false,
};

/**
 * ═══════════ HAI TỶ LỆ, KHÔNG PHẢI MỘT ═══════════
 *
 * Cứu TRỰC TIẾP và cứu BẰNG ĐƠN ĐỔI khác nhau về chi phí (đơn đổi tốn thêm một lượt cước và một
 * lần đóng gói), khác nhau về thời gian, và khác nhau về thứ nói lên năng lực của đội. Gộp im
 * lặng vào một con số là giấu mất chênh lệch đó.
 *
 * `null` nghĩa là CHƯA ĐO ĐƯỢC (không ca nào có kết cục cuối) — khác hẳn 0% (có ca kết thúc và
 * không cứu được ca nào).
 */
export type RescueCounts = { direct: number; exchange: number; failed: number; pending: number; unattributed: number };

export function rescueRates(c: RescueCounts): { direct: number | null; withExchange: number | null; finished: number } {
  const finished = c.direct + c.exchange + c.failed;
  const mauSoTrucTiep = c.direct + c.failed;
  return {
    direct: mauSoTrucTiep ? Math.round((c.direct / mauSoTrucTiep) * 1000) / 10 : null,
    withExchange: finished ? Math.round(((c.direct + c.exchange) / finished) * 1000) / 10 : null,
    finished,
  };
}

/* ───────────────────────── QUYẾT ĐỊNH ĐÓNG ĐỢT ───────────────────────── */

/**
 * `shipment_care.resolution` — QUYẾT ĐỊNH, không phải kết cục logistics.
 *
 *   · `RETURN_APPROVED`    — shop duyệt hoàn. Kết cục vẫn do ĐVVC chốt.
 *   · `NOT_CARE_CONDITION` — máy đóng vì kiện KHÔNG (hoặc không còn) trong điều kiện cần care:
 *                            mã 102 trước khi lấy hàng rồi chuyển sang đang đi, huỷ trước khi rời
 *                            kho… Đợt như vậy mang `care_outcome = NULL` — nó không phải cứu được,
 *                            không phải không cứu được, và KHÔNG BAO GIỜ vào tỷ lệ cứu đơn.
 */
export const CARE_RESOLUTIONS = ["RETURN_APPROVED", "NOT_CARE_CONDITION"] as const;
export type CareResolution = (typeof CARE_RESOLUTIONS)[number];

/* ───────────────────────── TRẠNG THÁI XỬ LÝ CỦA SHOP ───────────────────────── */

/**
 * Chiều thứ hai: ĐỘI ĐANG XỬ LÝ TỚI ĐÂU. Hoàn toàn độc lập với chiều ĐVVC.
 *
 * Giữ NGUYÊN tám giá trị đang chạy trên production (`shipment_care.care_status` có ràng buộc CHECK
 * và 70 dòng dữ liệu thật). Đổi tên chúng cho khớp một bản đặc tả mới sẽ làm mồ côi dữ liệu đang
 * có và không thêm được điều gì — nhãn tiếng Việt là chỗ để nói cho đúng.
 */
export const CARE_WORKFLOW_LABEL: Record<string, string> = {
  NEW: "Chưa xử lý",
  ASSIGNED: "Đã giao người",
  IN_PROGRESS: "Đang xử lý",
  WAITING_CUSTOMER: "Chờ khách",
  WAITING_CARRIER: "Chờ ĐVVC",
  WAITING_REDELIVERY: "Theo dõi tiếp",
  RESOLVED: "Đã xong",
  ESCALATED: "Đã leo thang",
  CANCELLED: "Huỷ ca",
};

/* ───────────────────────── HÀNH ĐỘNG NGHIỆP VỤ ───────────────────────── */

/**
 * BỐN việc mà người xử lý QUYẾT ĐỊNH làm — khác hẳn trạng thái xử lý (đang ở đâu) và khác hẳn
 * trạng thái ĐVVC (gói hàng ở đâu). Trước bản này chúng bị trộn chung vào một menu với trạng thái,
 * nên "Duyệt hoàn" nằm cạnh "Đang xử lý" như thể cùng loại.
 */
export const BUSINESS_ACTIONS = ["APPROVE_RETURN", "REQUEST_REDELIVERY", "EXCHANGE", "CONTINUE_MONITORING"] as const;
export type BusinessAction = (typeof BUSINESS_ACTIONS)[number];

export const BUSINESS_ACTION_LABEL: Record<BusinessAction, string> = {
  APPROVE_RETURN: "Duyệt hoàn",
  REQUEST_REDELIVERY: "Phát tiếp",
  EXCHANGE: "Đổi",
  CONTINUE_MONITORING: "Theo dõi tiếp",
};

export const BUSINESS_ACTION_HINT: Record<BusinessAction, string> = {
  APPROVE_RETURN:
    "Shop quyết định thôi không cứu kiện này nữa. Đây là QUYẾT ĐỊNH NỘI BỘ — nó KHÔNG đặt vận đơn thành “đã hoàn”. Hàng chỉ thành hoàn khi ĐVVC báo, và chỉ vào lại tồn khi kho lập phiếu.",
  REQUEST_REDELIVERY:
    "Nhờ ĐVVC đi phát lần nữa. Lệnh được ĐVVC NHẬN không có nghĩa hàng đã tới tay khách — ca vẫn mở cho tới khi hành trình nói kết cục.",
  EXCHANGE: "Gửi hàng khác thay cho kiện đang hỏng. Dùng lại module Đổi/trả hàng đang có; ca gốc nối với đơn thay thế để đo riêng “cứu bằng đơn đổi”.",
  CONTINUE_MONITORING: "Chưa làm gì với ĐVVC, chỉ hẹn xem lại. KHÔNG phải lệnh gửi đi đâu cả — ca vẫn mở và quay lại hàng đợi đúng giờ hẹn.",
};

/** Hành động nào GỬI LỆNH sang ĐVVC. Hai cái còn lại chỉ là quyết định/ghi chú nội bộ. */
export const ACTION_CALLS_CARRIER: Record<BusinessAction, boolean> = {
  APPROVE_RETURN: true,
  REQUEST_REDELIVERY: true,
  EXCHANGE: false,
  CONTINUE_MONITORING: false,
};
