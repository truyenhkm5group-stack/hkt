import { z } from "zod";

/**
 * ═══════════ EMAIL BÁN SỈ — TRẠNG THÁI, CHẾ ĐỘ, HẠN MỨC (E1, 0263) ═══════════
 *
 * Tệp THUẦN, không import máy chủ: trang, server action, job, route công khai và middleware (Edge) cùng đọc một bảng.
 *
 * Bối cảnh: chủ shop CHƯA chọn nhà cung cấp email (SES / Resend / Gmail) và CHƯA có tên miền gửi. Bản này dựng đủ đường
 * ống — hàng đợi, cổng chính sách, tiêu đề huỷ đăng ký, nhận phản hồi — nhưng chỉ chạy được ở chế độ CHẠY THỬ (DRY_RUN):
 * không một byte nào ra mạng. LIVE bị từ chối cho tới khi có bộ chuyển (adapter) thật được khai ở `LIVE_EMAIL_ADAPTERS`.
 */

export const WHOLESALE_EMAIL_SETTING_KEY = "wholesale.email";

/** OFF = không gửi gì · DRY_RUN = đi hết đường ống, nhà cung cấp GIẢ, không gọi mạng · LIVE = gửi thật (cần adapter + chủ shop bật). */
export const EMAIL_MODES = ["OFF", "DRY_RUN", "LIVE"] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];
export const EMAIL_MODE_LABEL: Record<EmailMode, string> = { OFF: "Tắt — không gửi gì", DRY_RUN: "Chạy thử — không thư nào ra ngoài", LIVE: "Gửi thật" };

/** Chế độ của MỘT thư đã đi qua nhà cung cấp — ghi lúc gửi, không lúc soạn. */
export const EMAIL_SEND_MODES = ["DRY_RUN", "LIVE"] as const;
export type EmailSendMode = (typeof EMAIL_SEND_MODES)[number];

/**
 * Bộ chuyển nhà cung cấp THẬT đã có trong mã — mỗi tên là một connector (`lib/connectors/registry.ts`). E2 (chủ shop chốt
 * 30/10/2026): `gws-smtp` = Google Workspace SMTP. Có tên ở đây KHÔNG có nghĩa là gửi thật: chế độ mặc định vẫn TẮT, LIVE chỉ
 * quản trị bật được và chỉ khi kết nối đã kiểm tra đạt + đang bật; kết nối tắt lúc chạy ⇒ thư nằm chờ kèm lý do.
 */
export const LIVE_EMAIL_ADAPTERS: readonly string[] = ["gws-smtp"];

/**
 * Trạng thái một thư trong hộp thư đi. DRAFT → (duyệt) APPROVED → (xếp gửi) QUEUED → (job nhận) SENDING → SENT · FAILED · BLOCKED.
 *  · SENDING là chỗ giữ chống gửi trùng: job đổi QUEUED → SENDING bằng MỘT câu UPDATE có điều kiện trước khi gọi nhà cung cấp;
 *    tiến trình chết giữa chừng thì thư NẰM LẠI ở SENDING (không rõ đã ra chưa) chờ người kiểm — không bao giờ tự gửi lại.
 *  · BLOCKED = cổng chính sách từ chối vì lý do KHÔNG tự hết (thiếu đồng ý, bị chặn, khách đã trả lời…). Lý do TỰ HẾT (chế độ
 *    tắt, nút dừng, hạn mức) giữ thư ở QUEUED và hẹn lượt sau.
 */
export const EMAIL_OUTBOX_STATUSES = ["DRAFT", "APPROVED", "QUEUED", "SENDING", "SENT", "FAILED", "CANCELLED", "BLOCKED"] as const;
export type EmailOutboxStatus = (typeof EMAIL_OUTBOX_STATUSES)[number];
export const EMAIL_OUTBOX_STATUS_LABEL: Record<EmailOutboxStatus, string> = {
  DRAFT: "Chờ duyệt",
  APPROVED: "Đã duyệt — chưa xếp gửi",
  QUEUED: "Đang xếp hàng gửi",
  SENDING: "Đang gửi / không rõ kết quả",
  SENT: "Đã gửi",
  FAILED: "Gửi lỗi",
  CANCELLED: "Đã huỷ",
  BLOCKED: "Bị cổng chính sách chặn",
};
export const EMAIL_OUTBOX_STATUS_TONE: Record<EmailOutboxStatus, "slate" | "blue" | "amber" | "green" | "rose"> = {
  DRAFT: "slate",
  APPROVED: "blue",
  QUEUED: "blue",
  SENDING: "amber",
  SENT: "green",
  FAILED: "rose",
  CANCELLED: "slate",
  BLOCKED: "rose",
};
export function isEmailOutboxStatus(v: unknown): v is EmailOutboxStatus {
  return typeof v === "string" && (EMAIL_OUTBOX_STATUSES as readonly string[]).includes(v);
}

/** Trạng thái còn có thể huỷ (chưa ra khỏi tay người). */
export const EMAIL_CANCELLABLE: readonly EmailOutboxStatus[] = ["DRAFT", "APPROVED", "QUEUED"];

export const EMAIL_PREPARED_BY = ["AI", "USER"] as const;
export type EmailPreparedBy = (typeof EMAIL_PREPARED_BY)[number];

/** Sự kiện của thư — sổ CHỈ THÊM. `provider_event_id` UNIQUE nên webhook gửi lại không nhân dòng. */
export const EMAIL_EVENT_KINDS = ["QUEUED", "SENT", "DELIVERED", "BOUNCE_HARD", "BOUNCE_SOFT", "COMPLAINT", "REPLY", "UNSUBSCRIBE", "BLOCKED", "FAILED"] as const;
export type EmailEventKind = (typeof EMAIL_EVENT_KINDS)[number];
export const EMAIL_EVENT_LABEL: Record<EmailEventKind, string> = {
  QUEUED: "Xếp hàng gửi",
  SENT: "Đã gửi",
  DELIVERED: "Đã tới hộp thư",
  BOUNCE_HARD: "Trả về vĩnh viễn",
  BOUNCE_SOFT: "Trả về tạm thời",
  COMPLAINT: "Bị báo rác",
  REPLY: "Khách trả lời",
  UNSUBSCRIBE: "Huỷ đăng ký",
  BLOCKED: "Bị chặn",
  FAILED: "Gửi lỗi",
};

/** Sự kiện làm DỪNG HẲN mọi thư tự động tới lead — không tự hết, chỉ người mới mở lại được (bằng một quyết định có vết). */
export const EMAIL_STOP_EVENTS: readonly EmailEventKind[] = ["REPLY", "UNSUBSCRIBE", "BOUNCE_HARD", "COMPLAINT"];

/** Khoá mẫu thư. D0 = lời chào mở đầu (bước 0); FOLLOWUP = thư nhắc trong cùng luồng (bước ≥ 1). */
export const EMAIL_TEMPLATE_KEYS = ["OPENER_D0", "FOLLOWUP"] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];
export const EMAIL_TEMPLATE_LABEL: Record<EmailTemplateKey, string> = { OPENER_D0: "Lời chào mở đầu (D0)", FOLLOWUP: "Thư nhắc" };

/**
 * HẠN MỨC MẶC ĐỊNH — số có tên, ghi đè được ở `settings` (`wholesale.email.limits`) nhưng KHÔNG vượt trần cứng. Thư lạnh B2B
 * gửi dồn là cách nhanh nhất để tên miền bị đánh dấu rác; trần cứng là chỗ máy không cho ai nới quá tay.
 *  · perHour / perDay: thư cùng CHẾ ĐỘ (chạy thử đếm chạy thử, thật đếm thật) đã SENT trong 60 phút / từ 0 giờ VN.
 *  · perRecipientDomainPerDay: thư tới CÙNG một tên miền nhận trong ngày (vd 5 nhà hàng cùng dùng một tên miền chuỗi).
 */
export const EMAIL_DEFAULT_LIMITS = { perHour: 20, perDay: 100, perRecipientDomainPerDay: 5 } as const;
export const EMAIL_HARD_LIMITS = { perHour: 200, perDay: 1000, perRecipientDomainPerDay: 50 } as const;

/** Số lần thử tối đa khi nhà cung cấp lỗi TẠM; lùi dần 5′ · 10′ · 20′ … trần 6 giờ. */
export const EMAIL_MAX_ATTEMPTS = 5;
export const EMAIL_BACKOFF_BASE_MS = 5 * 60_000;
export const EMAIL_BACKOFF_CAP_MS = 6 * 3_600_000;
/** Một lượt job xử lý tối đa bấy nhiêu thư — thư còn lại nằm chờ lượt sau (3 phút / lượt). */
export const EMAIL_BATCH_PER_TICK = 25;
/** Hạn mức chặn ⇒ hẹn lại sau bấy lâu (giờ sau / ngày sau tính lại ở lượt đó). */
export const EMAIL_HOLD_RETRY_MS = 15 * 60_000;

/** Lùi dần có trần cho lần thử thứ `attempt` (bắt đầu từ 1). HÀM THUẦN. */
export function emailBackoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(EMAIL_BACKOFF_CAP_MS, EMAIL_BACKOFF_BASE_MS * 2 ** (n - 1));
}

const limitsSchema = z.object({
  perHour: z.number().int().min(1).max(EMAIL_HARD_LIMITS.perHour),
  perDay: z.number().int().min(1).max(EMAIL_HARD_LIMITS.perDay),
  perRecipientDomainPerDay: z.number().int().min(1).max(EMAIL_HARD_LIMITS.perRecipientDomainPerDay),
});

const senderSchema = z.object({
  /** Tên hiển thị người gửi (vd «Hải sản Hà My»). */
  name: z.string().trim().max(120),
  /** Địa chỉ gửi — chỉ có nghĩa khi có nhà cung cấp thật; chạy thử vẫn cần để dựng Message-ID. */
  email: z.string().trim().max(254),
  /** Danh tính pháp lý in ở chân thư (CAN-SPAM / NĐ 91/2020): tên doanh nghiệp + địa chỉ thật. */
  companyName: z.string().trim().max(200),
  address: z.string().trim().max(300),
});

export const emailSettingsSchema = z.object({
  mode: z.enum(EMAIL_MODES),
  /** Nút dừng KHẨN cấp toàn tổ chức — thắng mọi chế độ. */
  paused: z.boolean(),
  pausedReason: z.string().trim().max(300),
  /** Nút dừng theo chiến dịch săn khách (id `wholesale_campaigns`). */
  pausedCampaignIds: z.array(z.string().trim().min(1).max(64)).max(200),
  /** Nút dừng theo tên miền NHẬN (vd một chuỗi nhà hàng xin thôi nhận). Chữ thường, không `@`. */
  blockedDomains: z.array(z.string().trim().toLowerCase().min(3).max(253)).max(500),
  limits: limitsSchema,
  sender: senderSchema,
  /** Ai bật LIVE, lúc nào — chỉ chủ shop (ADMIN có `wholesale:config`). `null` = LIVE chưa từng được bật. */
  liveEnabledByUserId: z.string().max(64).nullable(),
  liveEnabledAt: z.string().max(40).nullable(),
  /**
   * Nước đã RÀ LUẬT thư chào hàng (ISO-3166 alpha-2, `VN` = khách trong nước — issue #1085). Mặc định RỖNG và không có nước
   * mặc định: nước chưa có trong danh sách ⇒ thư chỉ chạy thử, ở chế độ gửi thật thì nằm chờ (`COUNTRY_NOT_REVIEWED`).
   * Chỉ quản trị sửa, kèm lý do + audit (`lib/wholesale/email-countries.ts`).
   */
  allowedCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(60),
});
export type EmailSettings = z.infer<typeof emailSettingsSchema>;

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  mode: "OFF",
  paused: false,
  pausedReason: "",
  pausedCampaignIds: [],
  blockedDomains: [],
  limits: { ...EMAIL_DEFAULT_LIMITS },
  sender: { name: "", email: "", companyName: "", address: "" },
  liveEnabledByUserId: null,
  liveEnabledAt: null,
  allowedCountries: [],
};

/**
 * Trộn giá trị đã lưu với mặc định — TỪNG TRƯỜNG qua lược đồ, trường hỏng rơi về mặc định (không làm hỏng cả cấu hình).
 * Đọc thô (`getSettingJson(key, null)`), không để `getSettingJson` trộn nông: mảng lồng bên trong phải giữ nguyên là mảng.
 * Chế độ không đọc được ⇒ OFF (mọi nhánh lỗi rơi về phía HẸP).
 */
export function mergeEmailSettings(raw: unknown): EmailSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_EMAIL_SETTINGS;
  const r = raw as Record<string, unknown>;
  const pick = <K extends keyof EmailSettings>(k: K): EmailSettings[K] => {
    const s = emailSettingsSchema.shape[k].safeParse(r[k]);
    return s.success ? (s.data as EmailSettings[K]) : DEFAULT_EMAIL_SETTINGS[k];
  };
  const limitsRaw = r.limits && typeof r.limits === "object" ? (r.limits as Record<string, unknown>) : {};
  const senderRaw = r.sender && typeof r.sender === "object" ? (r.sender as Record<string, unknown>) : {};
  const lim = (k: keyof EmailSettings["limits"]) => {
    const s = limitsSchema.shape[k].safeParse(limitsRaw[k]);
    return s.success ? s.data : EMAIL_DEFAULT_LIMITS[k];
  };
  const snd = (k: keyof EmailSettings["sender"]) => {
    const s = senderSchema.shape[k].safeParse(senderRaw[k]);
    return s.success ? s.data : "";
  };
  return {
    mode: pick("mode"),
    paused: pick("paused"),
    pausedReason: pick("pausedReason"),
    pausedCampaignIds: pick("pausedCampaignIds"),
    blockedDomains: pick("blockedDomains"),
    limits: { perHour: lim("perHour"), perDay: lim("perDay"), perRecipientDomainPerDay: lim("perRecipientDomainPerDay") },
    sender: { name: snd("name"), email: snd("email"), companyName: snd("companyName"), address: snd("address") },
    liveEnabledByUserId: pick("liveEnabledByUserId"),
    liveEnabledAt: pick("liveEnabledAt"),
    allowedCountries: pick("allowedCountries"),
  };
}

/** Danh tính người gửi đủ để in chân thư hợp lệ chưa — thiếu tên doanh nghiệp / địa chỉ ⇒ không gửi (kể cả chạy thử). */
export function senderIdentityMissing(s: EmailSettings["sender"]): string[] {
  const out: string[] = [];
  if (!s.name) out.push("tên người gửi");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.email)) out.push("email người gửi");
  if (!s.companyName) out.push("tên doanh nghiệp");
  if (!s.address) out.push("địa chỉ doanh nghiệp");
  return out;
}

/** Tên miền của một email đã chuẩn hoá (phần sau `@`, chữ thường). */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

/**
 * Khoá chống gửi trùng: lead + mẫu + bước + email nhận. Hai lượt soạn cùng khoá chỉ ra MỘT thư (UNIQUE một phần ở CSDL — trừ
 * thư CHẠY THỬ đã «gửi», để chạy thử hôm nay không ăn mất lượt gửi thật về sau).
 */
export function emailIdempotencyKey(leadId: string, templateKey: string, step: number, toEmail: string): string {
  return `${leadId}:${templateKey}:${step}:${toEmail}`;
}

// ─────────────── LÝ DO CỔNG CHÍNH SÁCH ───────────────

export const EMAIL_BLOCK_REASONS = [
  "BAD_STATUS",
  "MODE_OFF",
  "LIVE_NO_ADAPTER",
  "LIVE_NOT_OWNER_ENABLED",
  "KILL_ORG",
  "KILL_CAMPAIGN",
  "KILL_DOMAIN",
  "SENDER_INCOMPLETE",
  "COUNTRY_NOT_REVIEWED",
  "LEAD_STOPPED",
  "NOT_CONTACTABLE",
  "SUPPRESSED",
  "ADDRESS_CHANGED",
  "NOT_APPROVED",
  "APPROVAL_STALE",
  "APPROVAL_USED",
  "DUPLICATE",
  "LIMIT_HOUR",
  "LIMIT_DAY",
  "LIMIT_DOMAIN",
] as const;
export type EmailBlockReason = (typeof EMAIL_BLOCK_REASONS)[number];

export const EMAIL_BLOCK_REASON_LABEL: Record<EmailBlockReason, string> = {
  BAD_STATUS: "Thư không ở trạng thái chờ gửi",
  MODE_OFF: "Email của tổ chức đang TẮT",
  LIVE_NO_ADAPTER: "Chế độ gửi thật nhưng CHƯA có nhà cung cấp email nào được kết nối",
  LIVE_NOT_OWNER_ENABLED: "Chế độ gửi thật chưa được chủ shop bật",
  KILL_ORG: "Nút dừng khẩn cấp của tổ chức đang bật",
  KILL_CAMPAIGN: "Chiến dịch của lead đang bị dừng gửi email",
  KILL_DOMAIN: "Tên miền nhận đang bị dừng gửi",
  SENDER_INCOMPLETE: "Thiếu danh tính người gửi (tên · email · doanh nghiệp · địa chỉ) để in chân thư",
  COUNTRY_NOT_REVIEWED: "Chưa rà luật thư chào hàng của nước người nhận — chỉ chạy thử, chưa gửi thật",
  LEAD_STOPPED: "Lead đã trả lời / huỷ đăng ký / thư trả về / báo rác / KHÔNG LIÊN HỆ — dừng mọi thư tự động",
  NOT_CONTACTABLE: "Chưa đủ căn cứ để MÁY tự gửi email cho địa chỉ này",
  SUPPRESSED: "Khớp danh sách không liên hệ",
  ADDRESS_CHANGED: "Email của lead đã đổi sau khi soạn thư",
  NOT_APPROVED: "Thư chưa được người duyệt",
  APPROVAL_STALE: "Nội dung đã sửa sau khi duyệt — phải duyệt lại",
  APPROVAL_USED: "Lượt duyệt này đã dùng rồi",
  DUPLICATE: "Thư cùng khoá (lead · mẫu · bước · email) đã gửi thật",
  LIMIT_HOUR: "Chạm hạn mức thư / giờ",
  LIMIT_DAY: "Chạm hạn mức thư / ngày",
  LIMIT_DOMAIN: "Chạm hạn mức thư / tên miền nhận / ngày",
};

/**
 * Lý do TỰ HẾT: thư nằm lại QUEUED, hẹn lượt sau. Mọi lý do khác là chặn hẳn (BLOCKED) — cần người sửa căn cứ rồi mở lại.
 * LIVE_NO_ADAPTER tự hết khi có adapter; nút dừng tự hết khi người gỡ; hạn mức tự hết theo giờ.
 */
export const EMAIL_HOLD_REASONS: readonly EmailBlockReason[] = ["MODE_OFF", "LIVE_NO_ADAPTER", "LIVE_NOT_OWNER_ENABLED", "KILL_ORG", "KILL_CAMPAIGN", "KILL_DOMAIN", "SENDER_INCOMPLETE", "COUNTRY_NOT_REVIEWED", "LIMIT_HOUR", "LIMIT_DAY", "LIMIT_DOMAIN"];
