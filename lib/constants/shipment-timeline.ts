/**
 * ═══════════ NHẬT KÝ MỘT VẬN ĐƠN: BỐN LOẠI SỰ VIỆC, KHÔNG BAO GIỜ TRỘN ═══════════
 *
 * ─── VÌ SAO PHẢI PHÂN LOẠI, KHÔNG CHỈ XẾP THEO GIỜ ───
 *
 * Sáu bảng cùng kể chuyện về một kiện hàng: `shipment_events` (ĐVVC nói gì), `care_case_events`
 * (trạng thái xử lý đổi), `care_actions` (người đã gọi / nhắn gì), `care_business_actions` (bốn
 * quyết định nghiệp vụ), `carrier_action_requests` (lệnh gửi sang ĐVVC), `shipment_care` (mốc mở
 * và chốt ca). Xếp chúng lên một trục thời gian mà không gắn nhãn là mời người đọc kết luận
 * "giao thành công nhờ bạn A" từ một dòng không đủ tư cách kết luận điều đó.
 *
 * BỐN CHIỀU, và ranh giới giữa chúng là ranh giới của `docs/business-rules/ORDER_OUTCOME.md`:
 *
 *   CARRIER — Viettel Post nói. CHỨNG TỪ. Chỉ chiều này quyết định kiện hàng đang ở đâu.
 *   HUMAN   — người của shop làm. Không cú bấm nào làm gói hàng di chuyển.
 *   SYSTEM  — máy làm (đối chiếu, nhập tệp, quy tắc tự động). Có hậu quả, nhưng không phải chứng từ.
 *   DERIVED — ERP SUY RA (kết quả đơn theo luật tiền, kết cục ca). Đứng SAU hai chiều trên, không
 *             bao giờ đứng thay chúng.
 *
 * ─── ĐIỀU TỆP NÀY CẤM ───
 *
 * Một dòng `HUMAN` hay `DERIVED` KHÔNG BAO GIỜ được sửa một dòng `CARRIER`. Viettel Post ghi
 * "Giao thành công" thì nhật ký chứng từ mãi mãi ghi "Giao thành công", kể cả khi luật COD < 100K
 * của shop kết luận đơn này là hoàn — kết luận ấy là một dòng `DERIVED` riêng, đứng cạnh.
 */

export const TIMELINE_LANES = ["CARRIER", "HUMAN", "SYSTEM", "DERIVED"] as const;
export type TimelineLane = (typeof TIMELINE_LANES)[number];

export const LANE_LABEL: Record<TimelineLane, string> = {
  CARRIER: "Viettel Post",
  HUMAN: "Người xử lý",
  SYSTEM: "Hệ thống",
  DERIVED: "ERP suy ra",
};

export const LANE_HINT: Record<TimelineLane, string> = {
  CARRIER: "Chứng từ của đơn vị vận chuyển. Chỉ chiều này quyết định kiện hàng đang ở đâu.",
  HUMAN: "Việc nhân viên đã làm. Ghi để đo được hiệu quả care — không làm gói hàng di chuyển.",
  SYSTEM: "Máy làm: đối chiếu định kỳ, nhập tệp, quy tắc tự động.",
  DERIVED: "Kết luận ERP suy ra theo luật của shop. Đứng cạnh chứng từ, không đứng thay.",
};

export const LANE_TONE: Record<TimelineLane, string> = {
  CARRIER: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  HUMAN: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  SYSTEM: "bg-muted text-muted-foreground",
  DERIVED: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
};

/**
 * Loại sự việc. Cố ý là DANH MỤC ĐÓNG, không phải ô chữ tự do: báo cáo "ai phản hồi nhanh / chậm"
 * phải đếm được, và một chuỗi tự do thì mỗi người gõ một kiểu.
 */
export const TIMELINE_EVENT_TYPES = [
  "VTP_STATUS_CHANGED",
  "VTP_STATUS_UNMAPPED",
  "PANCAKE_MIRROR",
  "CASE_OPENED",
  "CARE_STATUS_CHANGED",
  "ASSIGNED",
  "REASSIGNED",
  "UNASSIGNED",
  "NOTE_ADDED",
  "CARE_ACTION",
  "CARE_DECISION",
  "VTP_COMMAND",
  "MANUAL_IMPORT",
  "RECONCILIATION",
  "MANUAL_VERIFICATION",
  "ESCALATED",
  "CASE_RESOLVED",
  "CASE_REOPENED",
  "SLA_BREACHED",
  "KPI_OUTCOME",
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

export const TIMELINE_EVENT_LABEL: Record<TimelineEventType, string> = {
  VTP_STATUS_CHANGED: "Viettel Post đổi trạng thái",
  VTP_STATUS_UNMAPPED: "Viettel Post gửi trạng thái ERP chưa hiểu",
  PANCAKE_MIRROR: "Bản sao trạng thái từ Pancake",
  CASE_OPENED: "Mở đợt chăm sóc",
  CARE_STATUS_CHANGED: "Đổi trạng thái xử lý",
  ASSIGNED: "Giao việc",
  REASSIGNED: "Chuyển người",
  UNASSIGNED: "Bỏ nhận việc",
  NOTE_ADDED: "Ghi chú",
  CARE_ACTION: "Thao tác chăm sóc",
  CARE_DECISION: "Quyết định nghiệp vụ",
  VTP_COMMAND: "Lệnh gửi Viettel Post",
  MANUAL_IMPORT: "Nhập từ tệp Viettel Post",
  RECONCILIATION: "Đối chiếu qua API Viettel Post",
  MANUAL_VERIFICATION: "Người tra trên web Viettel Post rồi ghi lại",
  ESCALATED: "Escalate",
  CASE_RESOLVED: "Chốt đợt chăm sóc",
  CASE_REOPENED: "Mở lại đợt",
  SLA_BREACHED: "Vỡ hạn xử lý",
  KPI_OUTCOME: "Kết quả đơn theo luật của shop",
};

export const EVENT_LANE: Record<TimelineEventType, TimelineLane> = {
  VTP_STATUS_CHANGED: "CARRIER",
  VTP_STATUS_UNMAPPED: "CARRIER",
  // Bản sao Pancake mang mốc "giờ Pancake ghi nhận", không phải giờ sự kiện của ĐVVC — nên nó
  // KHÔNG đứng ở chiều chứng từ, dù nội dung nói về hành trình. Xem `CARRIER_EVENT_SOURCES`.
  PANCAKE_MIRROR: "SYSTEM",
  CASE_OPENED: "SYSTEM",
  CARE_STATUS_CHANGED: "HUMAN",
  ASSIGNED: "HUMAN",
  REASSIGNED: "HUMAN",
  UNASSIGNED: "HUMAN",
  NOTE_ADDED: "HUMAN",
  CARE_ACTION: "HUMAN",
  CARE_DECISION: "HUMAN",
  VTP_COMMAND: "HUMAN",
  MANUAL_IMPORT: "SYSTEM",
  RECONCILIATION: "SYSTEM",
  MANUAL_VERIFICATION: "HUMAN",
  ESCALATED: "HUMAN",
  CASE_RESOLVED: "SYSTEM",
  CASE_REOPENED: "SYSTEM",
  SLA_BREACHED: "SYSTEM",
  KPI_OUTCOME: "DERIVED",
};

/**
 * AI LÀM — bốn câu trả lời, và chúng KHÔNG thay thế được nhau.
 *
 * `MACHINE` tách hẳn khỏi `UNKNOWN_ACTOR` (luật 34/36 của AGENTS.md): "máy làm" là một sự thật,
 * "không biết ai" là một lỗ hổng dữ liệu. Gộp hai thứ này là biến 187 việc của một job thành 187
 * việc "đang có người làm".
 */
export const ACTOR_KINDS = ["USER", "MACHINE", "CARRIER", "UNKNOWN_ACTOR"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const ACTOR_KIND_LABEL: Record<ActorKind, string> = {
  USER: "Nhân viên",
  MACHINE: "Máy",
  CARRIER: "Viettel Post",
  UNKNOWN_ACTOR: "Chưa biết ai",
};

/** Nguồn dữ liệu của một mốc ĐVVC — hiện trong chú giải để người đọc biết tin ở đâu ra. */
export const TIMELINE_SOURCE_LABEL: Record<string, string> = {
  VTP_WEBHOOK: "Webhook",
  VTP_POLL: "Đối chiếu API",
  VTP_IMPORT: "Nhập tệp",
  VTP_UI_MANUAL_VERIFICATION: "Người tra tay",
  MANUAL: "Ghi tay",
  PANCAKE: "Pancake",
};

export function timelineSourceLabel(source: string): string {
  return TIMELINE_SOURCE_LABEL[source] ?? source;
}
