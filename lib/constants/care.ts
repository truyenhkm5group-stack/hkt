import type { BucketKey } from "@/lib/constants/delivery-tower";
import type { CsKind } from "@/lib/constants/cs";
// Giờ mở cửa khai ở MỘT chỗ (`care-resolution.ts`, nơi đã có phép tính mốc hẹn). Gõ lại số 9 ở đây
// là mở đường cho "sáng mai" của nút bấm nhanh lệch khỏi "sáng mai" của ô chọn giờ.
import { WORK_DAY_START_HOUR } from "@/lib/constants/care-resolution";

/**
 * ═══════════ CARE VẬN ĐƠN: TRẠNG THÁI NỘI BỘ, KHÔNG PHẢI TRẠNG THÁI ĐVVC ═══════════
 *
 * `shipments.stage` (chứng từ ĐVVC) trả lời "kiện đang ở đâu". `care_status` trả lời "đội đã làm
 * tới đâu với kiện đó". Không được suy cái này từ cái kia: đội bấm ĐÃ XONG không làm kiện thành đã
 * giao, và kiện được giao không tự đóng việc — nó chỉ RỜI hàng đợi mặc định.
 */
export const CARE_STATUSES = ["NEW", "ASSIGNED", "IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"] as const;
export type CareStatus = (typeof CARE_STATUSES)[number];

/** Trạng thái "đang chờ" — đội đã làm phần mình, kết quả ở phía khách / ĐVVC / bưu tá. */
export const CARE_WAITING_STATUSES: CareStatus[] = ["WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY"];
/** Trạng thái KẾT THÚC của một case. Mở lại chỉ qua `reopen`, không qua đổi trạng thái thường. */
export const CARE_TERMINAL_STATUSES: CareStatus[] = ["RESOLVED", "CANCELLED"];
/** Trạng thái "đang mở, chưa chờ ai": kiện nằm ở Cần care. */
export const CARE_ACTIVE_STATUSES: CareStatus[] = ["NEW", "ASSIGNED", "IN_PROGRESS"];

/**
 * VÒNG ĐỜI MỘT CASE — chuyển trạng thái chỉ được đi theo bảng này. Đi sai ⇒ lỗi nghiệp vụ, không ghi.
 *
 *   NEW → ASSIGNED → IN_PROGRESS → WAITING_CUSTOMER | WAITING_CARRIER | WAITING_REDELIVERY
 *                                → RESOLVED | ESCALATED | CANCELLED
 *
 * RESOLVED / CANCELLED là kết thúc: chỉ `reopen` mới đưa case về NEW (hoặc ASSIGNED nếu còn người).
 */
export const CARE_TRANSITIONS: Record<CareStatus, readonly CareStatus[]> = {
  NEW: ["ASSIGNED", "IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"],
  ASSIGNED: ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"],
  IN_PROGRESS: ["ASSIGNED", "WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"],
  WAITING_CARRIER: ["IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_REDELIVERY", "RESOLVED", "ESCALATED", "CANCELLED"],
  WAITING_REDELIVERY: ["IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_CARRIER", "RESOLVED", "ESCALATED", "CANCELLED"],
  ESCALATED: ["IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY", "RESOLVED", "CANCELLED"],
  RESOLVED: [],
  CANCELLED: [],
};

export function canTransition(from: CareStatus, to: CareStatus): boolean {
  return from === to || CARE_TRANSITIONS[from].includes(to);
}

export const CARE_STATUS_LABEL: Record<CareStatus, string> = {
  NEW: "Chưa xử lý",
  ASSIGNED: "Đã giao việc",
  IN_PROGRESS: "Đang xử lý",
  WAITING_CUSTOMER: "Chờ khách",
  WAITING_CARRIER: "Chờ ĐVVC",
  WAITING_REDELIVERY: "Chờ phát lại",
  RESOLVED: "Đã xong",
  ESCALATED: "Escalate",
  CANCELLED: "Huỷ case",
};

export const CARE_STATUS_HINT: Record<CareStatus, string> = {
  NEW: "Chưa ai động vào. Kiện vẫn đang trong điều kiện cần care.",
  ASSIGNED: "Việc đã giao cho một người, người đó chưa bắt tay làm.",
  IN_PROGRESS: "Có người đang gọi / sửa / nhắn. Vẫn nằm ở Cần care cho tới khi hẹn theo dõi hoặc xong.",
  WAITING_CUSTOMER: "Đã làm phần mình, đang chờ khách trả lời. Tới hạn theo dõi thì tự quay lại Cần care.",
  WAITING_CARRIER: "Đang chờ Viettel Post / bưu cục trả lời. Tới hạn theo dõi thì tự quay lại Cần care.",
  WAITING_REDELIVERY: "Đã hẹn / yêu cầu phát lại, chờ bưu tá đi. Tới hạn theo dõi thì tự quay lại Cần care.",
  RESOLVED: "Đội đã làm xong phần của mình. KHÔNG có nghĩa là kiện đã giao — chiều ĐVVC vẫn theo chứng từ.",
  ESCALATED: "Vượt tay CSKH: đã báo bưu cục / quản lý. Cần người có quyền cao hơn.",
  CANCELLED: "Case không còn ý nghĩa (đơn huỷ, trùng, khách tự xử lý). Kiện vẫn theo chứng từ ĐVVC.",
};

/**
 * MÀU PHẢI PHÂN BIỆT ĐƯỢC BA KIỂU "CHỜ" — chúng đòi ba hành động khác nhau.
 *
 * Bản trước tô CÙNG MỘT màu hổ phách cho `WAITING_CUSTOMER`, `WAITING_CARRIER` và
 * `WAITING_REDELIVERY`. Người trực nhìn hàng đợi thấy một mảng vàng và phải đọc chữ từng dòng mới
 * biết nên gọi KHÁCH, gọi ĐVVC, hay chỉ chờ tới giờ hẹn. Màu mà không phân biệt được thì nó chỉ
 * còn là trang trí.
 *
 * Bảng màu theo đúng yêu cầu của chủ shop: chờ khách HỔ PHÁCH · chờ ĐVVC TÍM · theo dõi tiếp CHÀM
 * · leo thang CAM (tách khỏi tím để không lẫn với "chờ ĐVVC") · đã giao người XANH DƯƠNG · đang xử
 * lý XANH LƠ.
 *
 * Mỗi ô khai riêng nền và chữ cho chế độ tối — dùng chung một sắc độ cho cả hai chế độ là cách
 * nhanh nhất để chữ xám trên nền xám.
 */
export const CARE_STATUS_TONE: Record<CareStatus, string> = {
  NEW: "bg-rose-100 text-rose-900 dark:bg-rose-950/60 dark:text-rose-200",
  ASSIGNED: "bg-blue-100 text-blue-900 dark:bg-blue-950/60 dark:text-blue-200",
  IN_PROGRESS: "bg-cyan-100 text-cyan-900 dark:bg-cyan-950/60 dark:text-cyan-200",
  WAITING_CUSTOMER: "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  WAITING_CARRIER: "bg-violet-100 text-violet-900 dark:bg-violet-950/60 dark:text-violet-200",
  WAITING_REDELIVERY: "bg-indigo-100 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-200",
  RESOLVED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200",
  ESCALATED: "bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-200",
  CANCELLED: "bg-muted text-muted-foreground",
};

/**
 * NHÓM ĐIỀU KIỆN CẦN CARE — quyết định kiện có vào hàng đợi mặc định hay không.
 *  · CUSTOMER_ACTION — cần gọi / nhắn / sửa thông tin với khách (CS).
 *  · CARRIER_ACTION  — cần thao tác với ĐVVC (phát tiếp, duyệt hoàn, khiếu nại).
 *  · DATA_FRESHNESS  — dữ liệu cũ / thiếu. KHÔNG phải kiện hỏng, KHÔNG tính vào backlog care;
 *                      là việc của giao vận / dữ liệu, trả riêng ở `dataGaps`.
 */
export type CareReasonClass = "CUSTOMER_ACTION" | "CARRIER_ACTION" | "DATA_FRESHNESS";

/** Sự kiện trong lịch sử case — chỉ thêm, không sửa, không xoá. */
export const CARE_EVENT_ACTIONS = ["STATUS", "ASSIGN", "NOTE", "FOLLOW_UP", "RESOLVE", "REOPEN", "CANCEL", "CARRIER_REQUEST", "CARRIER_RESULT", "CARRIER_MANUAL"] as const;
export type CareEventAction = (typeof CARE_EVENT_ACTIONS)[number];
/** Ai / cái gì gây ra sự kiện. */
export const CARE_EVENT_SOURCES = ["UI", "API", "AI", "SYSTEM"] as const;
export type CareEventSource = (typeof CARE_EVENT_SOURCES)[number];

/** Ánh xạ trạng thái cũ (bản 0060) → mới, dùng đúng một lần trong migration 0061. */
export const CARE_STATUS_LEGACY: Record<string, CareStatus> = { WAITING: "WAITING_CUSTOMER", DONE: "RESOLVED" };

/** Năm góc nhìn của bàn làm việc. Chữ giải thích nằm trong tooltip, tiêu đề chỉ là năm từ. */
export const CARE_VIEWS = ["care", "waiting", "escalated", "done", "all"] as const;
export type CareView = (typeof CARE_VIEWS)[number];

export const CARE_VIEW_LABEL: Record<CareView, string> = {
  care: "Cần care",
  waiting: "Đang chờ kết quả",
  escalated: "Escalated",
  done: "Đã xử lý",
  all: "Tất cả vận đơn",
};

export const CARE_VIEW_HINT: Record<CareView, string> = {
  care: "Kiện đang trong điều kiện cần người: giao thất bại, khách không nghe máy, chờ phát lại, im lặng quá ngưỡng, thiếu dữ liệu, sai địa chỉ / SĐT, và mọi yêu cầu của khách sau khi đơn đã giao cho ĐVVC (giục giao, trả, đổi, khiếu nại) — và chưa xong hoặc đã tới hạn theo dõi.",
  waiting: "Đội đã làm phần của mình, đang chờ khách / ĐVVC. Tới hạn hẹn thì tự quay về Cần care.",
  escalated: "Đã báo bưu cục / quản lý. Người có quyền cao hơn phải theo.",
  done: "Đội đã đóng trong 7 ngày qua. Kiện vẫn có thể còn chạy ở chiều ĐVVC.",
  all: "Toàn bộ vận đơn để tra cứu, có bộ lọc trạng thái ĐVVC / COD / kỳ.",
};

/**
 * Rổ của tháp giao vận là ĐIỀU KIỆN CẦN CARE. Rổ hàng hoàn thuộc đường ống kho, không vào đây.
 *
 * `AWAITING_PICKUP` CỐ Ý KHÔNG có mặt. Đó là việc GIỤC ĐVVC TỚI LẤY (hoặc hỏi kho xem hàng đã đóng
 * xong chưa) — không có khách nào để gọi, nên nó không phải việc của bàn chăm sóc. Nó hiện ở THÁP
 * GIAO VẬN, nơi đội logistics làm việc. Thêm nó vào đây sẽ đẩy 40 kiện vào hàng đợi care cùng đồng
 * hồ SLA của bàn đó, làm lệch chính những con số đo hiệu quả chăm khách.
 */
export const CARE_BUCKETS: BucketKey[] = ["NO_CONTACT", "DELIVERY_FAILED", "AWAITING_REDELIVERY", "WAITING_CARRIER", "STALE_NO_UPDATE", "DATA_GAP"];

/** Lý do kiện cần care — rổ tháp hoặc case CSKH cần sửa thông tin. */
/**
 * `LEFT_CARE_CONDITION` KHÔNG phải một rổ của tháp giao vận: nó là câu trả lời cho *"vì sao dòng
 * này còn nằm đây"* khi ĐIỀU KIỆN CẦN CARE đã hết mà đợt care vẫn còn mở. Trước bản 19/09/2026 các
 * dòng ấy mượn khoá `CARE_TODAY`, nên chúng vừa mang nhãn "Đã rời điều kiện cần care" vừa được đếm
 * vào rổ "Cần care" — một dòng nói hai điều trái nhau.
 */
/**
 * Lý do đến TỪ CASE CSKH đã chuyển sang bàn này vì đơn ĐÃ GIAO CHO ĐVVC
 * (`lib/constants/cs-domain.ts`, chủ shop chốt 25/09/2026: "giao cho ĐVVC rồi thì thuộc Vận đơn").
 * Mỗi loại case đúng một lý do — `CS_KIND_CARE_REASON` là bảng ánh xạ duy nhất. `DELIVERY_FAILED`
 * không có ở đây: kiện giao hụt đã vào bàn care qua rổ của tháp giao vận.
 */
export const CS_CARE_REASONS = ["WRONG_INFO", "CUSTOMER_RETURN", "CUSTOMER_COMPLAINT", "CUSTOMER_EXCHANGE", "CUSTOMER_URGING", "CUSTOMER_OTHER"] as const;
export type CsCareReason = (typeof CS_CARE_REASONS)[number];
export type CareReasonKey = BucketKey | CsCareReason | "LEFT_CARE_CONDITION";
export const CS_KIND_CARE_REASON: Record<Exclude<CsKind, "DELIVERY_FAILED">, CsCareReason> = {
  WRONG_ADDRESS: "WRONG_INFO",
  WRONG_PHONE: "WRONG_INFO",
  RETURN: "CUSTOMER_RETURN",
  COMPLAINT: "CUSTOMER_COMPLAINT",
  EXCHANGE_SIZE: "CUSTOMER_EXCHANGE",
  EXCHANGE_COLOR: "CUSTOMER_EXCHANGE",
  URGE_DELIVERY: "CUSTOMER_URGING",
  SIZE_ADVICE: "CUSTOMER_OTHER",
  WRONG_PRICE: "CUSTOMER_OTHER",
  ORDER_NOT_CREATED: "CUSTOMER_OTHER",
  PHONE_VERIFY: "CUSTOMER_OTHER",
  OTHER: "CUSTOMER_OTHER",
};
/** Việc cần làm của từng lý do đến từ case CSKH — hiện ở cột "làm gì tiếp" của bàn care. */
export const CS_CARE_NEXT_ACTION: Record<CsCareReason, string> = {
  WRONG_INFO: "Xác nhận lại với khách rồi sửa người nhận / địa chỉ trên Viettel Post trước khi bưu tá đi phát.",
  CUSTOMER_RETURN: "Hỏi rõ khách muốn gì: giữ đơn (thuyết phục · đổi) hay trả — kiện đang chạy thì phát tiếp hoặc duyệt hoàn; đã nhận rồi thì tạo phiếu đổi / trả.",
  CUSTOMER_COMPLAINT: "Nghe khách, chụp bằng chứng, rồi chốt hướng xử lý: đổi, hoàn tiền một phần hay nhận lại hàng.",
  CUSTOMER_EXCHANGE: "Chốt mẫu / size mới với khách; kiện chưa tới thì cân nhắc dừng phát, đã nhận thì tạo đơn đổi.",
  CUSTOMER_URGING: "Xem kiện đang kẹt ở đâu, hối bưu cục / bưu tá, rồi báo lại khách thời gian giao dự kiến.",
  CUSTOMER_OTHER: "Đọc case, trả lời khách; việc cần thao tác trên kiện thì làm ngay trên Viettel Post.",
};
export const CARE_REASON_LABEL: Record<CareReasonKey, string> = {
  CUSTOMER_URGING: "Khách giục giao",
  CUSTOMER_RETURN: "Khách muốn trả / không nhận",
  CUSTOMER_COMPLAINT: "Khách khiếu nại",
  CUSTOMER_EXCHANGE: "Khách đổi size / mẫu",
  CUSTOMER_OTHER: "Khách cần hỗ trợ",
  CARE_TODAY: "Cần care",
  NO_CONTACT: "Khách không nghe máy",
  DELIVERY_FAILED: "Giao thất bại",
  AWAITING_REDELIVERY: "Chờ phát lại",
  AWAITING_PICKUP: "ĐVVC chưa tới lấy hàng",
  WAITING_CARRIER: "ĐVVC để treo, chưa xử lý",
  STALE_NO_UPDATE: "Im lặng quá ngưỡng",
  RETURNING: "Đang chuyển hoàn",
  RETURN_AT_SHOP: "Hoàn đã về shop",
  DATA_GAP: "Thiếu dữ liệu ĐVVC",
  WRONG_INFO: "Cần sửa địa chỉ / SĐT",
  LEFT_CARE_CONDITION: "Đã rời điều kiện cần care",
};

/**
 * SLA của một kiện cần care, tính từ lúc kiện VÀO điều kiện (sự kiện giao hụt gần nhất / tin cuối).
 * Không phải cảm tính: đo trên dữ liệu, kiện giao hụt để quá 24 giờ rơi thành hoàn nhanh nhất.
 */
export const CARE_SLA = {
  /** Giờ tối đa cho lần phản hồi ĐẦU TIÊN của người. */
  firstResponseHours: 2,
  /** Giờ tối đa để đóng hoặc escalate. */
  resolveHours: 24,
  /** "Đã xử lý" hiện bao nhiêu ngày gần nhất. */
  doneWindowDays: 7,
} as const;

/**
 * VÙNG CẢNH BÁO TRƯỚC KHI VỠ HẠN — tỷ lệ, không phải số giờ.
 *
 * Bàn care cần phân biệt "còn thời gian" với "sắp hết giờ", nhưng gõ thêm một con số giờ ở đây là
 * dựng một ngưỡng thứ hai phải nhớ sửa mỗi lần chủ shop đổi hạn ở `settings.work.sla` (luật 22) —
 * và lần quên đầu tiên thì màn hình cảnh báo theo một cái hạn không còn ai dùng. Một TỶ LỆ của
 * chính cái hạn đang hiệu lực thì đi theo hạn ấy: hạn 2 giờ cảnh báo từ phút 90, hạn 24 giờ cảnh
 * báo từ giờ thứ 18.
 *
 * Đây là ngưỡng TRÌNH BÀY (tô màu, xếp việc), không phải đích đạt/không đạt của luật 38 — kết luận
 * "vỡ hạn" vẫn chỉ do `slaOf()` đưa ra.
 */
export const CARE_SLA_SOON_FRACTION = 0.75;

/**
 * HẸN THEO DÕI MẶC ĐỊNH khi một thao tác đưa ca vào trạng thái CHỜ mà người không chọn giờ.
 *
 * Đo production 13/09/2026: `follow_up_at` NULL trên toàn bộ 182 đợt đang mở, trong đó 16 đợt ở
 * trạng thái chờ — và `careViewOf` đưa chúng ra khỏi "Cần care" vĩnh viễn vì "chưa tới hạn" của
 * một cái hạn không tồn tại. Một cái hẹn không có giờ không phải một cái hẹn; 24 giờ là mốc mà
 * kiện giao hụt rơi thành hoàn nhanh nhất (cùng căn cứ với `resolveHours`).
 */
export const CARE_FOLLOW_UP_DEFAULT_HOURS = 24;

export function defaultFollowUpAt(from = new Date()): Date {
  return new Date(from.getTime() + CARE_FOLLOW_UP_DEFAULT_HOURS * 3_600_000);
}

/** Ba kiểu hẹn theo dõi bấm một phát — không mở lịch. */
export const FOLLOW_UP_PRESETS: { key: string; label: string; hours: number }[] = [
  { key: "2h", label: "+2 giờ", hours: 2 },
  { key: "tomorrow", label: "Sáng mai", hours: -1 },
  { key: "2d", label: "+2 ngày", hours: 48 },
];

/**
 * MỐC HẸN CỦA MỘT NÚT BẤM NHANH — hàm THUẦN, MỘT bản dựng cho mọi màn hình.
 *
 * `hours < 0` là quy ước "không phải một khoảng thời gian" (hiện chỉ có "Sáng mai"): mốc neo vào
 * giờ mở cửa hôm sau chứ không phải "24 giờ nữa", vì bấm lúc 16h mà hẹn 16h hôm sau là bỏ mất cả
 * buổi sáng — đúng buổi mà khách dễ nghe máy nhất.
 *
 * Trước bản 19/09/2026 phép tính này nằm trong `workbench.tsx` dưới dạng một hàm `sangMai()` cục
 * bộ, nên ngăn kéo KHÔNG có nút hẹn nhanh nào: thêm vào đó nghĩa là chép lại phép tính, và hai bản
 * chép sẽ trôi xa nhau. Nhận `now` từ ngoài để kiểm thử được mà không phải ghim đồng hồ (luật 50).
 */
export function followUpPresetAt(preset: { hours: number }, now: Date = new Date()): Date {
  if (preset.hours >= 0) return new Date(now.getTime() + preset.hours * 3_600_000);
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(WORK_DAY_START_HOUR, 0, 0, 0);
  return d;
}

/** Hành động gửi ĐVVC — khoá ổn định, dùng làm idempotency và nhãn. */
export const CARRIER_ACTION_KEYS = ["redeliver", "approve-return", "resend", "approve", "cancel", "edit"] as const;
export type CarrierActionKey = (typeof CARRIER_ACTION_KEYS)[number];

export const CARRIER_ACTION_LABEL: Record<CarrierActionKey, string> = {
  redeliver: "Phát tiếp",
  "approve-return": "Duyệt hoàn",
  resend: "Gửi lại",
  approve: "Duyệt đơn",
  cancel: "Huỷ vận đơn",
  edit: "Sửa người nhận / COD",
};

export const CARRIER_REQUEST_STATUSES = ["PENDING", "SENT", "ACKNOWLEDGED", "SUCCESS", "FAILED", "UNSUPPORTED", "MANUAL_REQUIRED", "MANUAL_DONE"] as const;
export type CarrierRequestStatus = (typeof CARRIER_REQUEST_STATUSES)[number];

export const CARRIER_REQUEST_LABEL: Record<CarrierRequestStatus, string> = {
  PENDING: "Đang gửi",
  SENT: "Đã gửi",
  ACKNOWLEDGED: "ĐVVC đã nhận",
  SUCCESS: "ĐVVC xác nhận",
  FAILED: "ĐVVC từ chối",
  UNSUPPORTED: "Không hỗ trợ",
  MANUAL_REQUIRED: "Phải làm tay",
  MANUAL_DONE: "Đã làm tay",
};

export const CARRIER_REQUEST_TONE: Record<CarrierRequestStatus, string> = {
  PENDING: "bg-muted text-muted-foreground",
  SENT: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  ACKNOWLEDGED: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  SUCCESS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  FAILED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  UNSUPPORTED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  MANUAL_REQUIRED: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  MANUAL_DONE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
};

/**
 * Sự kiện ĐVVC nào XÁC NHẬN một yêu cầu đã có tác dụng — chỉ khi thấy nó mới được ghi SUCCESS.
 * Phản hồi "OK" của API chỉ là ACK: ĐVVC nhận yêu cầu, chưa chắc bưu tá đã đi.
 */
export const CARRIER_ACTION_CONFIRM_STAGES: Record<CarrierActionKey, string[]> = {
  redeliver: ["OUT_FOR_DELIVERY", "DELIVERED"],
  "approve-return": ["RETURNING", "RETURNED"],
  resend: ["PENDING", "PICKED_UP", "IN_TRANSIT"],
  approve: ["PICKED_UP", "IN_TRANSIT"],
  cancel: ["CANCELLED"],
  edit: [],
};

/** Chặng ĐVVC cho phép bấm hành động (lấy đúng luật đã dùng ở trang chi tiết vận đơn). */
export function carrierActionAllowed(key: CarrierActionKey, stage: string): boolean {
  const final = ["DELIVERED", "RETURNED", "CANCELLED"].includes(stage);
  switch (key) {
    case "redeliver":
    case "approve-return":
      return ["DELIVERY_FAILED", "OUT_FOR_DELIVERY", "IN_TRANSIT", "PICKED_UP"].includes(stage);
    case "resend":
      return ["RETURNING", "RETURNED", "CANCELLED", "DELIVERY_FAILED"].includes(stage);
    case "approve":
      return stage === "PENDING";
    case "cancel":
      return !final && stage !== "OUT_FOR_DELIVERY";
    case "edit":
      return !final;
  }
}

// ───────────────────────────── MẪU NOTE NHANH ─────────────────────────────

import type { CareActionKind } from "@/lib/constants/delivery-tower";

/** Một mẫu note: bấm là đổ chữ vào ô và chọn sẵn loại hành động. Chủ shop tự thêm / bớt. */
export type CareNotePreset = { id: string; kind: CareActionKind; text: string };

export const CARE_NOTE_PRESETS_KEY = "care.notePresets";
export const CARE_NOTE_PRESETS_MAX = 30;

/** Bộ mặc định khi chưa ai chỉnh — đúng những câu CS gõ đi gõ lại mỗi ngày. */
export const CARE_NOTE_PRESETS_DEFAULT: CareNotePreset[] = [
  { id: "p-no-answer", kind: "CALLED_NO_ANSWER", text: "Gọi 2 lần không nghe máy, đã nhắn Zalo/Pancake hẹn giao lại." },
  { id: "p-reached-tomorrow", kind: "RESCHEDULED", text: "Khách hẹn nhận sáng mai, đã báo bưu tá phát lại." },
  { id: "p-reached-weekend", kind: "RESCHEDULED", text: "Khách đi vắng, hẹn giao lại cuối tuần." },
  { id: "p-address", kind: "ADDRESS_FIXED", text: "Khách đổi địa chỉ / SĐT nhận, đã cập nhật cho bưu cục." },
  { id: "p-refused", kind: "CUSTOMER_REFUSED", text: "Khách xác nhận không lấy hàng nữa, cho hoàn về." },
  { id: "p-carrier", kind: "ESCALATED_CARRIER", text: "Bưu tá báo sai, khách vẫn ở nhà — đã khiếu nại bưu cục yêu cầu phát lại." },
  { id: "p-messaged", kind: "MESSAGED", text: "Đã nhắn tin xác nhận đơn, chờ khách trả lời." },
  { id: "p-wrong-phone", kind: "CALLED_NO_ANSWER", text: "SĐT không liên lạc được (thuê bao), đã nhắn Pancake xin số khác." },
];
