/**
 * ═══════════ AI NHẬN CẢNH BÁO MARKETING, VÀ NHẬN LÚC NÀO ═══════════
 *
 * Lưu ở `settings["marketing.alerts"]`, đọc/ghi qua `lib/settings.ts`. KHÔNG có webhook nào nằm
 * trong mã nguồn: kho mã này PUBLIC, và một URL webhook Lark là một khoá gửi tin vào nhóm nội bộ.
 *
 * ─── VÌ SAO MỖI NGƯỜI MỘT KÊNH, KHÔNG PHẢI MỘT NHÓM CHUNG ───
 *
 * Bản tin gửi vào nhóm chung thì mỗi MKTer phải tự tìm dòng của mình giữa năm người khác, và con
 * số của người này hiện trước mặt người kia. Nên: MKTer nhận ĐÚNG bản của mình, quản lý nhận bản
 * TỔNG. Cảnh báo `CRITICAL` gửi cả hai — vì thứ nghiêm trọng mà chỉ một người biết thì không ai
 * quyết được.
 *
 * ─── CHƯA KHAI KÊNH KHÔNG PHẢI LÀ LỖI, NHƯNG PHẢI NHÌN THẤY ───
 *
 * Thiếu webhook ⇒ bản tin vẫn được DỰNG và vẫn vào `notifications` (hàng đợi trong ERP), chỉ là
 * không gửi đi được, và lượt gửi ghi lại lý do. Im lặng bỏ qua thì chủ shop tin rằng người ta đã
 * nhận được trong khi không ai nhận gì.
 */

export const MARKETING_ALERT_KEY = "marketing.alerts";

export type MarketingRecipient = {
  /** Id nhân sự — CÙNG không gian khoá với `ad_spends.marketer_id` và `order_attributions.marketer_id`. */
  marketerId: string;
  /** Webhook Custom Bot của Lark cho riêng người này (hoặc nhóm 1-1 với quản lý). */
  larkWebhookUrl: string;
  larkSecret: string;
  active: boolean;
};

export type MarketingAlertConfig = {
  /** Bật/tắt toàn bộ. Tắt thì không gửi gì, nhưng vẫn ghi việc vào hàng đợi ERP. */
  enabled: boolean;
  /** Bản tin tổng cho quản lý. Trống ⇒ dùng webhook cảnh báo chung ở `alerts.config`. */
  managerWebhookUrl: string;
  managerSecret: string;
  /** Có gửi bản riêng cho từng MKTer không. */
  perMarketer: boolean;
  recipients: MarketingRecipient[];
  /**
   * Giờ gửi bản tin hằng ngày (giờ VN, 0–23). Lịch thật do scheduler quyết định; con số này để
   * bản tin tự biết nó đang nói về "hôm qua" hay "hôm nay", và để hiện trên màn hình cấu hình.
   */
  digestHour: number;
  /**
   * Mức tối thiểu để một phát hiện được GỬI ĐI. Dưới mức này vẫn vào hàng đợi ERP nhưng không làm
   * phiền ai — đó là cách giữ cho kênh Lark còn được đọc.
   */
  minSeverityToSend: "INFO" | "WARNING" | "CRITICAL";
  /**
   * KHOẢNG LẶNG giữa hai lần gửi CÙNG một loại cho CÙNG một phạm vi, tính bằng giờ.
   * Chống trùng đã chặn cùng-ngày; khoảng lặng chặn thêm trường hợp job chạy nhiều lần trong ngày.
   */
  cooldownHours: number;
  /** Đường dẫn gốc để chèn liên kết "Xem báo cáo" vào tin nhắn. Trống ⇒ không chèn liên kết. */
  baseUrl: string;
};

export const DEFAULT_MARKETING_ALERT_CONFIG: MarketingAlertConfig = {
  enabled: false,
  managerWebhookUrl: "",
  managerSecret: "",
  perMarketer: true,
  recipients: [],
  digestHour: 9,
  minSeverityToSend: "WARNING",
  cooldownHours: 12,
  baseUrl: "",
};

export const SEVERITY_RANK: Record<"INFO" | "WARNING" | "CRITICAL", number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

/** Loại thông báo trong hàng đợi ERP. Một loại riêng để `/work` và bộ lọc còn tách được ra. */
export const MARKETING_NOTIFICATION_KIND = "MARKETING_DAILY";
