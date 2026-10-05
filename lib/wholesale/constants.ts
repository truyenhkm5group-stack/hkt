/**
 * ═══════════ SĂN KHÁCH SỈ — TRẠNG THÁI, KÊNH, NHÃN ═══════════
 *
 * Tệp THUẦN, client-safe: trang, server action và job cùng đọc một bảng.
 */

export const LEAD_STATUSES = [
  "NEW",
  "QUALIFIED",
  "READY_TO_CONTACT",
  "CONTACTED",
  "NO_ANSWER",
  "INTERESTED",
  "CATALOG_SENT",
  "PRICE_SENT",
  "SAMPLE_REQUESTED",
  "NEGOTIATING",
  "WON",
  "LOST",
  "DO_NOT_CONTACT",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: "Mới",
  QUALIFIED: "Đủ điều kiện",
  READY_TO_CONTACT: "Sẵn sàng liên hệ",
  CONTACTED: "Đã liên hệ",
  NO_ANSWER: "Không nghe máy",
  INTERESTED: "Quan tâm",
  CATALOG_SENT: "Đã gửi catalog",
  PRICE_SENT: "Đã gửi báo giá",
  SAMPLE_REQUESTED: "Xin mẫu thử",
  NEGOTIATING: "Đang thương lượng",
  WON: "Chốt được",
  LOST: "Mất",
  DO_NOT_CONTACT: "Không liên hệ",
};

export const LEAD_STATUS_TONE: Record<LeadStatus, "slate" | "blue" | "amber" | "green" | "rose"> = {
  NEW: "slate",
  QUALIFIED: "blue",
  READY_TO_CONTACT: "blue",
  CONTACTED: "amber",
  NO_ANSWER: "amber",
  INTERESTED: "green",
  CATALOG_SENT: "green",
  PRICE_SENT: "green",
  SAMPLE_REQUESTED: "green",
  NEGOTIATING: "green",
  WON: "green",
  LOST: "rose",
  DO_NOT_CONTACT: "rose",
};

/** Đã có ít nhất một lần liên hệ. */
export const CONTACTED_STATUSES: readonly LeadStatus[] = ["CONTACTED", "NO_ANSWER", "INTERESTED", "CATALOG_SENT", "PRICE_SENT", "SAMPLE_REQUESTED", "NEGOTIATING", "WON", "LOST"];
/** Khách đã PHẢN HỒI (nghe máy / trả lời) — không gồm «Không nghe máy». */
export const RESPONDED_STATUSES: readonly LeadStatus[] = ["INTERESTED", "CATALOG_SENT", "PRICE_SENT", "SAMPLE_REQUESTED", "NEGOTIATING", "WON"];
export const INTERESTED_STATUSES: readonly LeadStatus[] = ["INTERESTED", "CATALOG_SENT", "PRICE_SENT", "SAMPLE_REQUESTED", "NEGOTIATING", "WON"];
export const NEGOTIATING_STATUSES: readonly LeadStatus[] = ["NEGOTIATING", "WON"];
/** Kết cục: lead đã đi tới cuối — dùng làm mẫu số cho «học từ kết quả». */
export const RESOLVED_STATUSES: readonly LeadStatus[] = ["WON", "LOST", "DO_NOT_CONTACT"];
/** Đang chăm: dữ liệu nguồn Google của lead ở các trạng thái này được làm mới trước khi hết hạn lưu. */
export const ACTIVE_PIPELINE_STATUSES: readonly LeadStatus[] = ["QUALIFIED", "READY_TO_CONTACT", "CONTACTED", "NO_ANSWER", "INTERESTED", "CATALOG_SENT", "PRICE_SENT", "SAMPLE_REQUESTED", "NEGOTIATING"];

export function isLeadStatus(v: unknown): v is LeadStatus {
  return typeof v === "string" && (LEAD_STATUSES as readonly string[]).includes(v);
}

/**
 * Chuyển trạng thái được phép. Luật duy nhất: KHÔNG LIÊN HỆ là một chiều — bỏ chặn là việc của người cấu hình
 * (gỡ khỏi danh sách không liên hệ), không phải một cú đổi trạng thái. «Chốt được» chỉ quay lại «Đang thương lượng»
 * khi CHƯA chuyển thành khách hàng (kiểm ở lõi, vì cần biết `customer_id`).
 */
export function canTransitionLead(from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) return false;
  if (from === "DO_NOT_CONTACT") return false;
  return true;
}

export const LEAD_SOURCES = ["GOOGLE_PLACES", "MANUAL_IMPORT", "WEBSITE", "STAFF"] as const;
export type LeadSourceKey = (typeof LEAD_SOURCES)[number];
export const LEAD_SOURCE_LABEL: Record<LeadSourceKey, string> = {
  GOOGLE_PLACES: "Google Places",
  MANUAL_IMPORT: "Nhập tệp",
  WEBSITE: "Website doanh nghiệp",
  STAFF: "Nhân viên thêm",
};

export const ENRICHMENT_STATUS_LABEL: Record<string, string> = {
  PENDING_DETAILS: "Đang lấy chi tiết",
  READY: "Sẵn sàng",
  FILTERED: "Bị lọc",
  DUPLICATE: "Trùng",
  FAILED: "Lỗi lấy dữ liệu",
};

export const FILTER_REASON_LABEL: Record<string, string> = {
  CLOSED: "Đã đóng cửa vĩnh viễn",
  CLOSED_TEMPORARILY: "Tạm đóng cửa",
  SEGMENT: "Nhóm khách không nằm trong mục tiêu",
  EXCLUDED_KEYWORD: "Tên chứa từ khoá loại trừ",
  NO_PHONE: "Không có SĐT (chiến dịch đòi SĐT)",
  NO_WEBSITE: "Không có website (chiến dịch đòi website)",
  LOW_RATING: "Sao dưới mức tối thiểu",
  LOW_REVIEWS: "Số đánh giá dưới mức tối thiểu",
  SUPPRESSED: "Nằm trong danh sách không liên hệ",
  PLACE_NOT_FOUND: "Google không còn địa điểm này",
  DUPLICATE_PHONE: "Trùng SĐT với lead đã có",
  DUPLICATE_DOMAIN: "Trùng website với lead đã có",
  DUPLICATE_NAME: "Trùng tên + địa chỉ với lead đã có",
  DETAILS_FAILED: "Lấy chi tiết lỗi nhiều lần",
  CHAIN: "Chuỗi lớn (thường mua theo hợp đồng, đòi hoá đơn VAT)",
  TOO_LARGE: "Quá đông khách so với quy mô nhắm tới (thường đòi hoá đơn)",
  COMPETITOR: "Đối thủ — cơ sở làm / bán buôn cùng mặt hàng",
};

export const CAMPAIGN_STATUSES = ["DRAFT", "RUNNING", "PAUSED", "STOPPED", "COMPLETED"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  DRAFT: "Nháp",
  RUNNING: "Đang quét",
  PAUSED: "Tạm dừng",
  STOPPED: "Đã dừng",
  COMPLETED: "Hoàn tất",
};

export const PAUSE_REASONS = ["MANUAL", "BUDGET_DAILY", "BUDGET_MONTHLY", "REQUEST_LIMIT", "FREE_TIER", "API_AUTH", "NO_CONNECTION"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
export const PAUSE_REASON_LABEL: Record<PauseReason, string> = {
  MANUAL: "Người dùng tạm dừng",
  BUDGET_DAILY: "Chạm trần chi tiêu NGÀY — tự chạy lại từ 0 giờ hôm sau",
  BUDGET_MONTHLY: "Chạm trần chi tiêu THÁNG — tự chạy lại từ ngày 1 tháng sau",
  REQUEST_LIMIT: "Chạm trần số lượt gọi ngày — tự chạy lại từ 0 giờ hôm sau",
  FREE_TIER: "Đã dùng hết lượt MIỄN PHÍ tháng này của Google (chế độ chỉ dùng miễn phí) — tự chạy lại từ ngày 1 tháng sau",
  API_AUTH: "Google từ chối khoá API — sửa kết nối rồi bấm Tiếp tục",
  NO_CONNECTION: "Chưa bật kết nối Google Places — bật ở Cài đặt → Kết nối, quét tự chạy lại",
};

export const OUTREACH_CHANNELS = ["PHONE_CALL", "ZALO", "SMS", "EMAIL", "FACEBOOK", "WHATSAPP"] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];
export const OUTREACH_CHANNEL_LABEL: Record<OutreachChannel, string> = {
  PHONE_CALL: "Gọi điện",
  ZALO: "Zalo",
  SMS: "SMS",
  EMAIL: "Email",
  FACEBOOK: "Facebook",
  WHATSAPP: "WhatsApp",
};

export const OUTREACH_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Chờ duyệt",
  APPROVED: "Đã duyệt — chờ gửi",
  SENT: "Đã gửi — chờ kết quả",
  DONE: "Đã ghi kết quả",
  CANCELLED: "Đã huỷ",
};

export const OUTREACH_RESULTS = ["NO_ANSWER", "INTERESTED", "NOT_INTERESTED", "CALLBACK", "WRONG_NUMBER", "REPLIED", "DO_NOT_CONTACT"] as const;
export type OutreachResult = (typeof OUTREACH_RESULTS)[number];
export const OUTREACH_RESULT_LABEL: Record<OutreachResult, string> = {
  NO_ANSWER: "Không nghe máy / chưa trả lời",
  INTERESTED: "Quan tâm",
  NOT_INTERESTED: "Không quan tâm",
  CALLBACK: "Hẹn gọi lại",
  WRONG_NUMBER: "Sai số",
  REPLIED: "Đã trả lời",
  DO_NOT_CONTACT: "Yêu cầu KHÔNG liên hệ nữa",
};

/** Kết quả liên hệ ⇒ trạng thái lead kế tiếp (`null` = giữ nguyên). */
export const OUTREACH_RESULT_STATUS: Record<OutreachResult, LeadStatus | null> = {
  NO_ANSWER: "NO_ANSWER",
  INTERESTED: "INTERESTED",
  NOT_INTERESTED: null,
  CALLBACK: "CONTACTED",
  WRONG_NUMBER: null,
  REPLIED: "CONTACTED",
  DO_NOT_CONTACT: "DO_NOT_CONTACT",
};

/**
 * KẾT QUẢ CUỘC GỌI — tách khỏi TRẠNG THÁI lead (chủ shop 05/10/2026, giao diện điện thoại): người bán chọn ĐIỀU XẢY RA
 * trong cuộc gọi, máy suy ra trạng thái bằng `callOutcomeEffect` — người bán không cần hiểu quy trình phía sau. Kết quả
 * lưu nguyên ở `wholesale_lead_activities.outcome` (dòng `CALL`), nên báo cáo đọc được cả hai tầng.
 * `ANSWERED` / `BUSY` giữ cho dòng cũ và màn máy tính.
 */
export const CALL_OUTCOMES = ["INTERESTED", "PRICE_REQUESTED", "CALLBACK", "CONSIDERING", "NO_ANSWER", "NOT_INTERESTED", "WRONG_NUMBER", "WRONG_CONTACT", "DO_NOT_CONTACT", "ANSWERED", "BUSY"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = {
  INTERESTED: "Có nhu cầu",
  PRICE_REQUESTED: "Gửi bảng giá",
  CALLBACK: "Hẹn gọi lại",
  CONSIDERING: "Đang cân nhắc",
  NO_ANSWER: "Không nghe máy",
  NOT_INTERESTED: "Không có nhu cầu",
  WRONG_NUMBER: "Sai số",
  WRONG_CONTACT: "Sai người phụ trách",
  DO_NOT_CONTACT: "Không liên hệ lại",
  ANSWERED: "Nghe máy, đã nói chuyện",
  BUSY: "Máy bận",
};
/** Chín nút của màn điện thoại, đúng thứ tự trên màn hình. */
export const MOBILE_CALL_OUTCOMES = ["INTERESTED", "PRICE_REQUESTED", "CALLBACK", "CONSIDERING", "NO_ANSWER", "NOT_INTERESTED", "WRONG_NUMBER", "WRONG_CONTACT", "DO_NOT_CONTACT"] as const satisfies readonly CallOutcome[];
export const CALL_OUTCOME_ICON: Record<CallOutcome, string> = {
  INTERESTED: "✅",
  PRICE_REQUESTED: "📋",
  CALLBACK: "📞",
  CONSIDERING: "⏳",
  NO_ANSWER: "📵",
  NOT_INTERESTED: "❌",
  WRONG_NUMBER: "☎️",
  WRONG_CONTACT: "👤",
  DO_NOT_CONTACT: "🚫",
  ANSWERED: "🗣️",
  BUSY: "⛔",
};
/** Có người nghe máy và nói chuyện — mốc «phản hồi đầu tiên» và cửa chép tên + SĐT thành dữ liệu của shop. */
export const ANSWERED_CALL_OUTCOMES: readonly CallOutcome[] = ["ANSWERED", "INTERESTED", "PRICE_REQUESTED", "CALLBACK", "CONSIDERING", "NOT_INTERESTED", "WRONG_CONTACT"];
/** Việc tiếp theo máy ghi khi khách xin bảng giá — chip «Chờ báo giá» lọc đúng chuỗi này. */
export const PRICE_REQUEST_ACTION = "Gửi bảng giá";

export type CallOutcomeEffect = {
  /** Trạng thái lead sau cuộc gọi (bằng `from` khi không đổi). */
  to: LeadStatus;
  nextAction: string | null;
  lostReason: string | null;
  /** Số ngày hẹn gọi lại gợi ý khi người bán không chọn ngày; `null` = không gợi ý. */
  followupDays: number | null;
  /** Bắt buộc phải có ngày gọi lại (người bán không chọn ⇒ dùng `followupDays`). */
  followupRequired: boolean;
};

const EARLY_STATUSES: readonly LeadStatus[] = ["NEW", "QUALIFIED", "READY_TO_CONTACT", "NO_ANSWER", "CONTACTED"];

/**
 * Kết quả cuộc gọi ⇒ trạng thái lead. HÀM THUẦN. Không bao giờ LÙI một lead đã đi xa (đang thương lượng mà lần này không
 * nghe máy thì vẫn đang thương lượng); «Không có nhu cầu» / «Sai số» kết thúc lead với lý do (ràng buộc LOST đòi lý do);
 * «Không liên hệ lại» đi đường danh sách chặn riêng.
 */
export function callOutcomeEffect(from: LeadStatus, outcome: CallOutcome): CallOutcomeEffect {
  const early = EARLY_STATUSES.includes(from);
  const keep = (to: LeadStatus, extra: Partial<CallOutcomeEffect> = {}): CallOutcomeEffect => ({ to: early ? to : from, nextAction: null, lostReason: null, followupDays: null, followupRequired: false, ...extra });
  switch (outcome) {
    case "INTERESTED":
      return keep("INTERESTED", { followupDays: 2 });
    case "PRICE_REQUESTED":
      return keep("INTERESTED", { nextAction: PRICE_REQUEST_ACTION, followupDays: 1 });
    case "CONSIDERING":
      return keep("INTERESTED", { nextAction: "Khách đang cân nhắc — gọi lại", followupDays: 3, followupRequired: true });
    case "CALLBACK":
      return keep("CONTACTED", { followupDays: 1, followupRequired: true });
    case "ANSWERED":
      return keep("CONTACTED");
    case "NO_ANSWER":
    case "BUSY":
      return keep("NO_ANSWER", { followupDays: 1 });
    case "WRONG_CONTACT":
      return keep("CONTACTED", { nextAction: "Xin SĐT người phụ trách nhập hàng", followupDays: 1, followupRequired: true });
    case "NOT_INTERESTED":
      return { to: "LOST", nextAction: null, lostReason: "Không có nhu cầu", followupDays: null, followupRequired: false };
    case "WRONG_NUMBER":
      return { to: "LOST", nextAction: null, lostReason: "Sai số điện thoại", followupDays: null, followupRequired: false };
    case "DO_NOT_CONTACT":
      return { to: "DO_NOT_CONTACT", nextAction: null, lostReason: null, followupDays: null, followupRequired: false };
  }
}

/** Ghi chú nhanh một chạm trên màn điện thoại (bàn phím điện thoại vẫn đọc giọng nói vào ô ghi chú như thường). */
export const QUICK_NOTE_CHIPS = ["Cần bảng giá", "Quan tâm chả mực", "Quan tâm ruốc", "Quan tâm nước mắm", "Hỏi chiết khấu", "Gọi lại", "Cần gặp chủ", "Cần gặp người nhập hàng", "Đang có nhà cung cấp"] as const;

export const ACTIVITY_KIND_LABEL: Record<string, string> = {
  CALL_INITIATED: "Bấm gọi (mở ứng dụng gọi)",
  DISCOVERED: "Tìm thấy",
  IMPORTED: "Nhập tệp",
  ENRICHED: "Bổ sung dữ liệu",
  SCORED: "Chấm điểm",
  NOTE: "Ghi chú",
  CALL: "Cuộc gọi",
  STATUS: "Đổi trạng thái",
  ASSIGN: "Giao việc",
  OUTREACH: "Liên hệ",
  OPPORTUNITY: "Cơ hội",
  CONVERT: "Chuyển thành khách",
  EDIT: "Sửa thông tin",
  CAMPAIGN: "Chiến dịch",
};

/**
 * Tên miền DÙNG CHUNG — không phải website của một doanh nghiệp. Hai lead cùng `facebook.com` không phải một doanh
 * nghiệp, nên khử trùng theo tên miền bỏ qua các host này.
 */
export const SHARED_WEBSITE_HOSTS: readonly string[] = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "instagram.com",
  "tiktok.com",
  "zalo.me",
  "youtube.com",
  "linktr.ee",
  "beacons.ai",
  "google.com",
  "goo.gl",
  "business.site",
  "sites.google.com",
  "wixsite.com",
  "blogspot.com",
  "wordpress.com",
  "shopee.vn",
  "lazada.vn",
  "foody.vn",
  "shopeefood.vn",
  "grab.com",
  "booking.com",
  "agoda.com",
  "tripadvisor.com",
  "tripadvisor.com.vn",
  "pasgo.vn",
  "bit.ly",
];
