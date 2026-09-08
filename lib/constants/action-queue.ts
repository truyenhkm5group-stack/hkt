/**
 * ───────────── HÀNG ĐỢI VIỆC CẦN XỬ LÝ ─────────────
 *
 * "Cần xử lý" cũ là một danh sách đọc rồi bỏ: không nói việc nào gấp hơn việc nào, không ai cầm
 * việc, và không phân biệt ĐÃ ĐỌC với ĐÃ TIẾP NHẬN với ĐÃ XONG.
 *
 * Ở đây mỗi việc có: loại · đối tượng · MỨC ƯU TIÊN tính được · lý do · thời điểm phát hiện ·
 * tuổi · người nhận · trạng thái · việc nên làm.
 *
 * MỨC ƯU TIÊN LÀ QUY TẮC, KHÔNG PHẢI CẢM TÍNH. Bốn yếu tố, cộng lại:
 *   mức nghiêm trọng + tuổi việc + giá trị tiền liên quan + khả năng cứu được
 * "Khả năng cứu được" là điểm mấu chốt: đơn giao thất bại còn gọi lại được thì phải xử lý trước
 * đơn đã hoàn xong — việc đã không cứu được nữa thì gấp cũng vô ích.
 */

export type CaseType =
  | "NEW_ORDER_UNPROCESSED"
  /**
   * Đơn ĐÃ xác nhận nhưng nằm im chưa ra vận đơn. Tách khỏi "đơn mới chưa xử lý" vì hai việc này
   * do hai người khác nhau làm: đơn mới là việc của CSKH, đơn đã chốt mà chưa gửi là việc của kho.
   */
  | "ORDER_CONFIRMATION_STALE"
  | "DELIVERY_FAILED"
  | "DELIVERY_STALE"
  | "RETURNING"
  | "COD_OVERDUE"
  | "DATA_ERROR"
  | "LOW_STOCK_RISK"
  | "CS_CASE"
  | "ORDER_INCOMPLETE"
  | "RISKY_ORDER"
  | "ADS_BILLING"
  /**
   * ĐVVC báo hàng đã hoàn về nhưng kho CHƯA lập phiếu tái nhập. Đây là khoảng trống giữa "hàng về
   * tới nơi" và "hàng có mặt trong tồn" — theo luật kho, hàng hoàn KHÔNG tự vào tồn, nên mỗi việc
   * còn mở ở đây là một khoản hàng đang không ai đếm.
   */
  | "RETURN_RECEIVED_PENDING_INSPECTION"
  /** Dự báo sắp cháy hàng theo tốc độ bán thực tế — khác "sắp hết hàng" tính theo ngưỡng tĩnh. */
  | "STOCKOUT_RISK"
  /** Chi quảng cáo bất thường so với doanh thu giao thành công. */
  | "ADS_ANOMALY"
  /** Lợi nhuận / đóng góp tụt dưới ngưỡng — cảnh báo mức kinh doanh, không phải mức vận hành. */
  | "PROFITABILITY_ALERT"
  /** Không biết vận đơn nào thuộc đơn nào — người phải quyết, máy cố ý không đoán. */
  | "AMBIGUOUS_ORDER_SHIPMENT_MAPPING"
  /** Vận đơn có thật nhưng chưa ghép được đơn ERP nào. */
  | "ORPHAN_SHIPMENT"
  | "OTHER";

/** Ánh xạ từ `notifications.kind` sang loại việc. Một chỗ duy nhất. */
export const KIND_TO_CASE: Record<string, CaseType> = {
  ORDER_PENDING: "NEW_ORDER_UNPROCESSED",
  ORDER_CONFIRMED_STALE: "ORDER_CONFIRMATION_STALE",
  RETURN_PENDING_INSPECTION: "RETURN_RECEIVED_PENDING_INSPECTION",
  STOCKOUT_RISK: "STOCKOUT_RISK",
  ADS_ANOMALY: "ADS_ANOMALY",
  PROFITABILITY_ALERT: "PROFITABILITY_ALERT",
  SHIPMENT_FAILED: "DELIVERY_FAILED",
  SHIPMENT_STALE: "DELIVERY_STALE",
  SHIPMENT_RETURNING: "RETURNING",
  COD_OVERDUE: "COD_OVERDUE",
  DATA_ERROR: "DATA_ERROR",
  STOCK_LOW: "LOW_STOCK_RISK",
  CS_CASE: "CS_CASE",
  ORDER_INCOMPLETE: "ORDER_INCOMPLETE",
  RISKY_ORDER: "RISKY_ORDER",
  ADS_BILLING: "ADS_BILLING",
  AMBIGUOUS_MAPPING: "AMBIGUOUS_ORDER_SHIPMENT_MAPPING",
  ORPHAN_SHIPMENT: "ORPHAN_SHIPMENT",
};

export function caseTypeOf(kind: string): CaseType {
  return KIND_TO_CASE[kind] ?? "OTHER";
}

export const CASE_TYPE_LABEL: Record<CaseType, string> = {
  NEW_ORDER_UNPROCESSED: "Đơn mới chưa xử lý",
  ORDER_CONFIRMATION_STALE: "Đã chốt nhưng chưa gửi hàng",
  RETURN_RECEIVED_PENDING_INSPECTION: "Hàng hoàn về · chưa tái nhập kho",
  STOCKOUT_RISK: "Sắp cháy hàng theo tốc độ bán",
  ADS_ANOMALY: "Quảng cáo bất thường",
  PROFITABILITY_ALERT: "Lợi nhuận tụt ngưỡng",
  DELIVERY_FAILED: "Giao thất bại · còn cứu được",
  DELIVERY_STALE: "Vận đơn treo lâu",
  RETURNING: "Đang chuyển hoàn",
  COD_OVERDUE: "Quá hạn mà tiền chưa về",
  DATA_ERROR: "Dữ liệu sai nghiêm trọng",
  LOW_STOCK_RISK: "Sắp hết hàng",
  CS_CASE: "Case CSKH",
  ORDER_INCOMPLETE: "Đơn thiếu thông tin",
  RISKY_ORDER: "Đơn rủi ro cao",
  ADS_BILLING: "Tài khoản quảng cáo",
  AMBIGUOUS_ORDER_SHIPMENT_MAPPING: "Chưa rõ vận đơn thuộc đơn nào",
  ORPHAN_SHIPMENT: "Vận đơn chưa ghép được đơn",
  OTHER: "Khác",
};

/**
 * KHẢ NĂNG CỨU ĐƯỢC (0–1): hành động bây giờ còn thay đổi được kết quả bao nhiêu.
 * Đây là yếu tố phân biệt hàng đợi việc với danh sách cảnh báo thông thường.
 */
export const RECOVERABILITY: Record<CaseType, number> = {
  // Gọi khách ngay là cứu được nguyên đơn.
  DELIVERY_FAILED: 1,
  ORDER_INCOMPLETE: 1,
  NEW_ORDER_UNPROCESSED: 0.9,
  // Hàng còn trong kho, gửi ngay là xong — cứu được nguyên đơn.
  ORDER_CONFIRMATION_STALE: 0.9,
  RISKY_ORDER: 0.9,
  // Đếm và lập phiếu là trả lại được toàn bộ giá trị hàng vào tồn.
  RETURN_RECEIVED_PENDING_INSPECTION: 0.9,
  // Đặt sản xuất kịp thì không mất doanh thu nào.
  STOCKOUT_RISK: 0.8,
  // Tắt/sửa quảng cáo là chặn được tiền chảy tiếp.
  ADS_ANOMALY: 0.8,
  // Nhìn thấy sớm còn đổi được giá / bỏ mẫu lỗ.
  PROFITABILITY_ALERT: 0.6,
  CS_CASE: 0.8,
  // Còn kịp giục ĐVVC phát lại.
  DELIVERY_STALE: 0.7,
  // Sản xuất kịp thì không mất doanh thu.
  LOW_STOCK_RISK: 0.7,
  ADS_BILLING: 0.7,
  // Đòi được tiền, nhưng không thay đổi được kết quả đơn.
  COD_OVERDUE: 0.6,
  // Sửa được số liệu, hàng thì đã đi rồi.
  DATA_ERROR: 0.5,
  // Hàng đang trên đường về — chỉ còn xử lý hậu quả.
  RETURNING: 0.3,
  // Ghép đúng đơn thì số liệu đúng lại ngay, nhưng hàng thì đã xong từ lâu.
  AMBIGUOUS_ORDER_SHIPMENT_MAPPING: 0.4,
  ORPHAN_SHIPMENT: 0.4,
  OTHER: 0.5,
};

export const CASE_ACTION: Record<CaseType, string> = {
  NEW_ORDER_UNPROCESSED: "Xác nhận đơn trên Pancake rồi đẩy sang Viettel Post.",
  ORDER_CONFIRMATION_STALE: "Đơn đã chốt mà chưa có vận đơn — kho đóng gói và đẩy sang Viettel Post ngay.",
  RETURN_RECEIVED_PENDING_INSPECTION:
    "Kiểm đếm hàng hoàn thực nhận rồi lập phiếu tái nhập. Hàng hoàn KHÔNG tự vào tồn — chưa lập phiếu thì số tồn đang thiếu đúng bằng lô này.",
  STOCKOUT_RISK: "Xem Kế hoạch SX: đặt sản xuất trước ngày dự báo cháy hàng, trừ đi thời gian sản xuất.",
  ADS_ANOMALY: "Mở Báo cáo quảng cáo, đối chiếu chi tiêu với doanh thu giao thành công của đúng chiến dịch.",
  PROFITABILITY_ALERT: "Mở Báo cáo lợi nhuận, soi mẫu mã / kênh đang kéo tụt đóng góp.",
  DELIVERY_FAILED: "Gọi khách xác nhận rồi báo bưu tá phát lại — đây là nhóm cứu được nhiều tiền nhất.",
  DELIVERY_STALE: "Tra lại trên Viettel Post; nếu vẫn im thì mở khiếu nại.",
  RETURNING: "Chuẩn bị nhận hàng hoàn và lập phiếu tái nhập khi hàng về tới kho.",
  COD_OVERDUE: "Đối chiếu bảng kê và đòi Viettel Post phần còn thiếu.",
  DATA_ERROR: "Mở Chất lượng dữ liệu → Trung tâm điều khiển để xem bằng chứng của từng dòng.",
  LOW_STOCK_RISK: "Đặt sản xuất theo số đề xuất ở trang Kế hoạch SX.",
  CS_CASE: "Trả lời khách trên Pancake và đóng case.",
  ORDER_INCOMPLETE: "Bổ sung số điện thoại / địa chỉ trước khi gửi hàng.",
  RISKY_ORDER: "Xin cọc hoặc xác nhận lại với khách trước khi gửi.",
  ADS_BILLING: "Nạp tiền / kiểm tra ngưỡng thanh toán tài khoản quảng cáo.",
  OTHER: "Xem chi tiết rồi xử lý.",
  AMBIGUOUS_ORDER_SHIPMENT_MAPPING:
    "Mở Chất lượng dữ liệu, đối chiếu vận đơn với đơn theo mã tham chiếu. CHỈ xử lý khi các cách ghép cho ra kết quả khác nhau — mọi cách ghép cùng kết quả thì tổng hợp đã đúng.",
  ORPHAN_SHIPMENT:
    "Tìm đơn tương ứng theo mã tham chiếu trên Viettel Post. Vận đơn chiều hoàn KHÔNG có đơn là bình thường, không cần làm gì.",
};

export type CasePriority = "URGENT" | "HIGH" | "NORMAL" | "LOW";

export const PRIORITY_LABEL: Record<CasePriority, string> = {
  URGENT: "Gấp",
  HIGH: "Cao",
  NORMAL: "Bình thường",
  LOW: "Thấp",
};

export const PRIORITY_TONE: Record<CasePriority, string> = {
  URGENT: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  HIGH: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  NORMAL: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  LOW: "bg-muted text-muted-foreground",
};

const SEVERITY_WEIGHT: Record<string, number> = { critical: 30, warning: 15, info: 4 };

/**
 * CÓ NGƯỜI ĐANG CHỜ Ở ĐẦU KIA hay không.
 *
 * Yếu tố này tách khỏi "mức nghiêm trọng" vì hai thứ khác nhau: một luật dữ liệu sai có thể rất
 * nghiêm trọng nhưng không ai ngồi chờ; một đơn giao hụt thì có khách thật đang cầm điện thoại.
 * Việc có người chờ mà để lâu thì mất khách, không chỉ mất số liệu.
 */
const CUSTOMER_WAITING: Record<CaseType, number> = {
  DELIVERY_FAILED: 1,
  CS_CASE: 1,
  ORDER_INCOMPLETE: 1,
  NEW_ORDER_UNPROCESSED: 1,
  ORDER_CONFIRMATION_STALE: 1,
  DELIVERY_STALE: 0.8,
  RISKY_ORDER: 0.6,
  RETURNING: 0.4,
  STOCKOUT_RISK: 0.4,
  LOW_STOCK_RISK: 0.3,
  // Việc nội bộ: quan trọng, nhưng không có khách nào đang chờ.
  COD_OVERDUE: 0,
  DATA_ERROR: 0,
  ADS_BILLING: 0,
  ADS_ANOMALY: 0,
  PROFITABILITY_ALERT: 0,
  RETURN_RECEIVED_PENDING_INSPECTION: 0,
  AMBIGUOUS_ORDER_SHIPMENT_MAPPING: 0,
  ORPHAN_SHIPMENT: 0,
  OTHER: 0,
};

export type ScoreParts = {
  severity: number;
  age: number;
  money: number;
  recoverability: number;
  customer: number;
  proximity: number;
};

export type ScoreInput = {
  severity: string;
  ageHours: number;
  amount?: number | null;
  type: CaseType;
  /** Số ngày còn lại trước khi cháy hàng, nếu tra được. Càng gần 0 càng gấp. */
  daysToStockout?: number | null;
};

/**
 * ĐIỂM ƯU TIÊN (0–100). Công thức mở, cố ý đơn giản để người vận hành đọc là hiểu vì sao:
 *
 *   nghiêm trọng (0–30) + tuổi việc (0–20) + tiền liên quan (0–20)
 * + khả năng cứu (0–15) + có người đang chờ (0–10) + sắp cháy hàng (0–5)
 *
 * Từng phần đều trả ra được (`caseScoreBreakdown`) nên giao diện giải thích được vì sao một việc
 * đứng trên việc khác — điểm mà người đọc không kiểm chứng được thì không khác gì cảm tính.
 *
 * Tuổi việc bão hoà ở 7 ngày: việc để 3 tuần không gấp gấp ba lần việc để 1 tuần, nó chỉ nói lên
 * rằng nó đang bị bỏ quên. Tiền bão hoà ở 5 triệu để một đơn lớn không nhấn chìm mọi việc khác.
 *
 * "Tiền liên quan" nhận giá trị đơn, số COD đang treo hoặc doanh thu giao thành công đang bị đe
 * doạ — cùng một trục, khác nguồn, nên KHÔNG cộng chồng thành nhiều phần riêng.
 */
export function caseScoreBreakdown(input: ScoreInput): ScoreParts {
  const severity = SEVERITY_WEIGHT[input.severity] ?? 4;
  const age = Math.min(20, (Math.max(0, input.ageHours) / (7 * 24)) * 20);
  const money = Math.min(20, ((input.amount ?? 0) / 5_000_000) * 20);
  const recoverability = RECOVERABILITY[input.type] * 15;
  const customer = (CUSTOMER_WAITING[input.type] ?? 0) * 10;
  // Cháy hàng trong 3 ngày là gấp nhất; quá 14 ngày thì chưa phải việc của hôm nay.
  const days = input.daysToStockout;
  const proximity = days === null || days === undefined ? 0 : Math.max(0, Math.min(5, ((14 - days) / 14) * 5));
  return { severity, age, money, recoverability, customer, proximity };
}

export function caseScore(input: ScoreInput): number {
  const p = caseScoreBreakdown(input);
  return Math.round(p.severity + p.age + p.money + p.recoverability + p.customer + p.proximity);
}

/** Câu giải thích ngắn: yếu tố nào đẩy việc này lên cao nhất. */
export function scoreExplanation(parts: ScoreParts): string {
  const named: [string, number][] = [
    ["mức nghiêm trọng", parts.severity],
    ["để lâu chưa ai làm", parts.age],
    ["tiền đang treo", parts.money],
    ["còn cứu được", parts.recoverability],
    ["có khách đang chờ", parts.customer],
    ["sắp cháy hàng", parts.proximity],
  ];
  const top = named.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return top.length ? top.map(([label, v]) => `${label} ${Math.round(v)}`).join(" · ") : "không có yếu tố nào nổi bật";
}

export function priorityOf(score: number): CasePriority {
  if (score >= 70) return "URGENT";
  if (score >= 50) return "HIGH";
  if (score >= 30) return "NORMAL";
  return "LOW";
}

/**
 * NĂM TRẠNG THÁI, KHÔNG PHẢI BA.
 *
 * "Đã tiếp nhận" và "đang làm" là hai việc khác nhau: giơ tay không phải là đang chạy. Và "bỏ qua"
 * phải tách khỏi "đã xong", nếu không người vận hành buộc phải bấm "xong" cho việc mình cố ý không
 * làm — biến số "đã xong" thành con số vô nghĩa.
 */
export type CaseStatus = "OPEN" | "ACKNOWLEDGED" | "IN_PROGRESS" | "RESOLVED" | "IGNORED";

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  OPEN: "Chưa ai nhận",
  ACKNOWLEDGED: "Đã tiếp nhận",
  IN_PROGRESS: "Đang làm",
  RESOLVED: "Đã xong",
  IGNORED: "Bỏ qua có lý do",
};

export const CASE_STATUS_TONE: Record<CaseStatus, string> = {
  OPEN: "bg-muted text-muted-foreground",
  ACKNOWLEDGED: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  IN_PROGRESS: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  RESOLVED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  IGNORED: "bg-muted text-muted-foreground line-through",
};

/** Trạng thái còn phải làm — dùng cho mọi phép đếm "việc đang mở". */
export const ACTIVE_CASE_STATUSES: CaseStatus[] = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"];

/** Suy ra trạng thái từ các mốc thời gian. Một chỗ duy nhất, thứ tự ưu tiên cố định. */
export function caseStatusOf(row: {
  resolvedAt?: Date | null;
  ignoredAt?: Date | null;
  startedAt?: Date | null;
  acknowledgedAt?: Date | null;
}): CaseStatus {
  if (row.resolvedAt) return "RESOLVED";
  if (row.ignoredAt) return "IGNORED";
  if (row.startedAt) return "IN_PROGRESS";
  if (row.acknowledgedAt) return "ACKNOWLEDGED";
  return "OPEN";
}

/** Tuổi việc dạng chữ, đủ để đọc lướt. */
export function ageLabel(hours: number): string {
  if (hours < 1) return "vừa xong";
  if (hours < 24) return `${Math.floor(hours)} giờ`;
  const days = Math.floor(hours / 24);
  return `${days} ngày`;
}
