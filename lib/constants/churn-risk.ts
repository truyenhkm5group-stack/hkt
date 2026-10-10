/**
 * ═══════════ RỦI RO RỜI BỎ — MÃ LÝ DO · BẢNG ÁNH XẠ MÃ → MỨC (MỘT CHỖ) — CLIENT-SAFE (docs/saas/VALUE_CENTER.md §4) ═══════════
 *
 * Không điểm, không trọng số (spec 11 §7, quyết định D9): mức rủi ro của một khách là mức NẶNG NHẤT trong các mã lý do đã bật,
 * mỗi mã là một SỰ VIỆC kiểm được. Bảng `CHURN_REASONS` là chỗ DUY NHẤT nói mã nào ra mức nào — đổi một dòng ở đây là đổi luật,
 * nên phải tăng `CHURN_RULE_VERSION` (hai ảnh chụp khác phiên bản không so trực tiếp — luật 40). Ngưỡng «giảm sử dụng» đọc từ
 * quyết định D8 (`DEFAULT_TENANT_VALUE_DECISIONS`), không gõ lại.
 *
 * THIẾU TÍN HIỆU BẮT BUỘC ⇒ `UNKNOWN`, KHÔNG BAO GIỜ `LOW` mặc định (luật 39 · 42): `LOW` chỉ khi MỌI tín hiệu bắt buộc đọc được và
 * không mã nào bật. Một mã ĐÃ bật vẫn quyết định mức dù còn tín hiệu khác thiếu — sự việc đã có không bị che vì thiếu sự việc khác.
 * Mọi mức đều kèm ít nhất một mã: `LOW` mang `NO_RISK_SIGNAL`, `UNKNOWN` mang `REQUIRED_SIGNAL_MISSING` (hoặc `INACTIVE`).
 */

/** Phiên bản LUẬT ánh xạ. Đổi bảng / ngưỡng ⇒ tăng. */
export const CHURN_RULE_VERSION = 1;

export const CHURN_RISK_LEVELS = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type ChurnRiskLevel = (typeof CHURN_RISK_LEVELS)[number];

export const CHURN_RISK_LABEL: Record<ChurnRiskLevel, string> = {
  CRITICAL: "Rất cao",
  HIGH: "Cao",
  MEDIUM: "Trung bình",
  LOW: "Thấp",
  UNKNOWN: "Chưa đủ dữ liệu",
};

/** Thứ tự nặng → nhẹ. `UNKNOWN` không phải «nhẹ nhất»: nó chỉ thắng khi không mã rủi ro nào bật. */
export const CHURN_RISK_RANK: Record<ChurnRiskLevel, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };

type ChurnReasonSpec = { risk: ChurnRiskLevel; label: string; explanation: string };

/**
 * BẢNG ÁNH XẠ — mã → mức. Bảy mã rủi ro đầu theo báo cáo kiểm toán §4 PR-5 (đề xuất, chủ shop chốt ngưỡng ở D8); ba mã cuối là
 * mã KẾT LUẬN để mọi mức đều có lý do in được.
 */
export const CHURN_REASONS = {
  PRODUCT_DOWN: { risk: "CRITICAL", label: "Sản phẩm không chạy cho khách", explanation: "Mức sức khoẻ đang Nguy cấp (AI tắt / lỗi, mất kênh, hết hạn sau khi đã trả…) — khách không dùng được thì không còn lý do ở lại." },
  PAID_THEN_EXPIRED: { risk: "CRITICAL", label: "Đã trả tiền rồi để hết hạn", explanation: "Khách từng trả tiền nhưng thuê bao đã hết hạn (chỉ xem) — đang rời đi, không phải dùng thử hết hạn." },
  PAST_DUE_AND_USAGE_DOWN: { risk: "HIGH", label: "Quá hạn thanh toán và dùng giảm", explanation: "Thuê bao quá hạn đang ân hạn VÀ số hội thoại giảm mạnh so với cửa sổ trước." },
  NO_LOGIN_AND_INBOUND_DROP: { risk: "HIGH", label: "Không ai đăng nhập và tin khách dừng", explanation: "Mọi phiên đăng nhập đã hết hạn VÀ tin khách tới shop đã dừng so với nền — shop có thể đã ngừng bán qua kênh này." },
  USAGE_TREND_DOWN: { risk: "MEDIUM", label: "Dùng giảm", explanation: "Số hội thoại có khách nhắn giảm từ ngưỡng D8 trở lên so với cửa sổ liền trước (cửa sổ trước đủ mẫu)." },
  VALUE_BELOW_SPEND: { risk: "MEDIUM", label: "Giá trị nhận thấp hơn tiền trả", explanation: "Bội số giá trị < 1: lãi gộp quy công cho AI nhỏ hơn số khách trả (độ phủ giá vốn đủ ngưỡng D3)." },
  NOT_ACTIVATED_AFTER_GRACE: { risk: "MEDIUM", label: "Chưa kích hoạt sau ân hạn", explanation: "Quá thời gian ân hạn thiết lập mà AI vẫn chưa trả lời khách thật nào." },
  NO_RISK_SIGNAL: { risk: "LOW", label: "Không thấy dấu hiệu rời bỏ", explanation: "Mọi tín hiệu bắt buộc đọc được và không mã rủi ro nào bật." },
  REQUIRED_SIGNAL_MISSING: { risk: "UNKNOWN", label: "Thiếu tín hiệu bắt buộc", explanation: "Không mã rủi ro nào bật nhưng còn tín hiệu bắt buộc chưa đọc được — KHÔNG phải rủi ro thấp." },
  INACTIVE: { risk: "UNKNOWN", label: "Khách đã dừng", explanation: "Tài khoản / workspace đã dừng do người quyết — không xếp mức rủi ro rời bỏ." },
} as const satisfies Record<string, ChurnReasonSpec>;
export type ChurnReasonCode = keyof typeof CHURN_REASONS;

/** Tín hiệu đầu vào. `required: true` thiếu ⇒ không được kết luận `LOW`. */
export const CHURN_SIGNALS = {
  HEALTH: { required: true, gap: "HEALTH_MISSING", why: "Chưa có mức sức khoẻ của khách (healthOf)." },
  SUBSCRIPTION_STATUS: { required: true, gap: "SUBSCRIPTION_STATUS_MISSING", why: "Chưa đọc được tình trạng thuê bao / thu phí của khách." },
  USAGE_TREND: { required: true, gap: "USAGE_TREND_UNMEASURED", why: "Chưa so được số hội thoại với cửa sổ trước (thiếu số, hoặc cửa sổ trước dưới mẫu tối thiểu D8)." },
  VALUE_MULTIPLE: { required: false, gap: "VALUE_MULTIPLE_UNMEASURED", why: "Chưa có bội số giá trị (giá vốn dưới ngưỡng độ phủ D3, khách trả chưa biết, hoặc không phải cửa sổ bội số D12) — mã «giá trị thấp hơn tiền trả» không xét được." },
} as const satisfies Record<string, { required: boolean; gap: string; why: string }>;
export type ChurnSignal = keyof typeof CHURN_SIGNALS;
export type ChurnGapCode = (typeof CHURN_SIGNALS)[ChurnSignal]["gap"];
