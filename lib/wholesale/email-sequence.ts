/**
 * ═══════════ CHUỖI THƯ THEO DÕI (THƯ NHẮC) — LUẬT THUẦN — docs/tech/hslc-b2b-sales-agent.md · P4a ═══════════
 *
 * Mỗi lead luồng email có tối đa N lần nhắc (lần 2, lần 3…), mỗi lần sau K ngày kể từ thư trước mà khách KHÔNG phản hồi. N và K là
 * cấu hình của tổ chức (`settings["wholesale.emailSequence"]`), KHÔNG có số mặc định: chưa khai ⇒ không lead nào có lần nhắc. Lần
 * nhắc chỉ «đến hạn». Máy không gửi, không tự soạn hàng loạt: người bấm soạn nháp (AI qua hàng rào, hoặc mẫu shop khai), rồi người
 * duyệt ở Hộp thư đi.
 *
 * Chuỗi DỪNG ngay khi gặp một trong các điều kiện sau:
 *  · khách trả lời (bất kỳ thư vào nào nối luồng / khớp lead ⇒ sự kiện REPLY);
 *  · huỷ đăng ký / khiếu nại / bounce cứng;
 *  · lead ở danh sách không liên hệ, hoặc khớp danh sách chặn;
 *  · lead đã chuyển WON / LOST.
 * Hàm ở đây không đọc CSDL, không đọc đồng hồ (nhận `now`): cùng đầu vào ⇒ cùng kết luận.
 */

export const EMAIL_SEQUENCE_SETTING_KEY = "wholesale.emailSequence";
export const EMAIL_SEQUENCE_LIMITS = { maxFollowups: 5, maxGapDays: 60, templateMax: 3000 } as const;

/** `null` = CHƯA KHAI ⇒ không có lần nhắc nào. Mẫu tĩnh: rỗng = shop chưa khai mẫu ⇒ chỉ dùng được AI. */
export type EmailSequenceSettings = { maxFollowups: number | null; gapDays: number | null; templates: { vi: string; en: string } };

export function parseEmailSequenceSettings(raw: unknown): EmailSequenceSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const int = (v: unknown, max: number) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= max ? v : null);
  const t = o.templates && typeof o.templates === "object" && !Array.isArray(o.templates) ? (o.templates as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, EMAIL_SEQUENCE_LIMITS.templateMax) : "");
  return { maxFollowups: int(o.maxFollowups, EMAIL_SEQUENCE_LIMITS.maxFollowups), gapDays: int(o.gapDays, EMAIL_SEQUENCE_LIMITS.maxGapDays), templates: { vi: text(t.vi), en: text(t.en) } };
}

/** Sự kiện dừng chuỗi (đúng tên ở `wholesale_email_events.kind`). */
export const SEQUENCE_STOP_EVENTS = ["REPLY", "UNSUBSCRIBE", "COMPLAINT", "BOUNCE_HARD"] as const;
/** Trạng thái lead kết thúc chuỗi. */
export const SEQUENCE_STOP_STATUSES = ["WON", "LOST", "DO_NOT_CONTACT"] as const;
/** Thư còn đang mở của lead ⇒ chưa soạn lần nhắc mới (không hai thư cùng lúc). */
export const OPEN_OUTBOX_STATUSES = ["DRAFT", "APPROVED", "QUEUED", "SENDING"] as const;

export type SequenceStopReason = "NOT_CONFIGURED" | "NO_EMAIL" | "NOT_STARTED" | "REPLIED" | "UNSUBSCRIBED" | "COMPLAINT" | "BOUNCE_HARD" | "SUPPRESSED" | "LEAD_CLOSED" | "COMPLETED";
export const SEQUENCE_STOP_LABEL: Record<SequenceStopReason, string> = {
  NOT_CONFIGURED: "Tổ chức chưa khai số lần nhắc / số ngày chờ",
  NO_EMAIL: "Lead chưa có email",
  NOT_STARTED: "Chưa gửi thư mở đầu",
  REPLIED: "Khách đã trả lời",
  UNSUBSCRIBED: "Khách đã huỷ đăng ký",
  COMPLAINT: "Khách khiếu nại thư rác",
  BOUNCE_HARD: "Địa chỉ bị trả về (bounce cứng)",
  SUPPRESSED: "Lead ở danh sách không liên hệ / chặn",
  LEAD_CLOSED: "Lead đã chốt (Thắng / Mất)",
  COMPLETED: "Đã đủ số lần nhắc",
};

export type SequenceInput = {
  settings: EmailSequenceSettings;
  hasEmail: boolean;
  leadStatus: string;
  suppressed: boolean;
  /** Thư ĐÃ GỬI (theo chế độ đang chạy) của chuỗi, thứ tự bất kỳ. */
  sent: readonly { sequenceStep: number; sentAt: Date }[];
  /** Mọi loại sự kiện thư của lead. */
  eventKinds: readonly string[];
  /** Lead đang có thư mở / nháp nhắc đang mở. */
  hasOpenMail: boolean;
};

export type SequenceState =
  | { state: "STOPPED"; reason: SequenceStopReason }
  | { state: "WAITING"; nextStep: number; dueAt: Date; lastSentAt: Date }
  | { state: "DUE"; nextStep: number; dueAt: Date; lastSentAt: Date }
  | { state: "PENDING_MAIL"; nextStep: number };

const DAY_MS = 86_400_000;

/** Trạng thái chuỗi của MỘT lead lúc `now`. Thứ tự kiểm: cấu hình → điều kiện dừng → đã đủ → thư đang mở → hạn. HÀM THUẦN. */
export function sequenceState(input: SequenceInput, now: Date): SequenceState {
  const { settings: s } = input;
  if (s.maxFollowups === null || s.gapDays === null) return { state: "STOPPED", reason: "NOT_CONFIGURED" };
  if (!input.hasEmail) return { state: "STOPPED", reason: "NO_EMAIL" };
  if (input.eventKinds.includes("REPLY")) return { state: "STOPPED", reason: "REPLIED" };
  if (input.eventKinds.includes("UNSUBSCRIBE")) return { state: "STOPPED", reason: "UNSUBSCRIBED" };
  if (input.eventKinds.includes("COMPLAINT")) return { state: "STOPPED", reason: "COMPLAINT" };
  if (input.eventKinds.includes("BOUNCE_HARD")) return { state: "STOPPED", reason: "BOUNCE_HARD" };
  if (input.suppressed || input.leadStatus === "DO_NOT_CONTACT") return { state: "STOPPED", reason: "SUPPRESSED" };
  if (input.leadStatus === "WON" || input.leadStatus === "LOST") return { state: "STOPPED", reason: "LEAD_CLOSED" };
  if (!input.sent.some((m) => m.sequenceStep === 0)) return { state: "STOPPED", reason: "NOT_STARTED" };
  const nextStep = Math.max(...input.sent.map((m) => m.sequenceStep)) + 1;
  if (nextStep > s.maxFollowups) return { state: "STOPPED", reason: "COMPLETED" };
  if (input.hasOpenMail) return { state: "PENDING_MAIL", nextStep };
  const lastSentAt = new Date(Math.max(...input.sent.map((m) => m.sentAt.getTime())));
  const dueAt = new Date(lastSentAt.getTime() + s.gapDays * DAY_MS);
  return now.getTime() >= dueAt.getTime() ? { state: "DUE", nextStep, dueAt, lastSentAt } : { state: "WAITING", nextStep, dueAt, lastSentAt };
}

/** Mẫu tĩnh: thay `{{ten_doanh_nghiep}}` / `{{ten_shop}}` / `{{lan_nhac}}`; biến lạ giữ nguyên để hàng rào / người duyệt thấy. HÀM THUẦN. */
export function renderSequenceTemplate(template: string, vars: { businessName: string; shopName: string; step: number }): string {
  return template.replace(/\{\{\s*(ten_doanh_nghiep|ten_shop|lan_nhac)\s*\}\}/g, (_, k: string) => (k === "ten_doanh_nghiep" ? vars.businessName : k === "ten_shop" ? vars.shopName : String(vars.step + 1)));
}
