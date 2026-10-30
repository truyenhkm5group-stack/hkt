import {
  EMAIL_BLOCK_REASONS,
  EMAIL_BLOCK_REASON_LABEL,
  EMAIL_HOLD_REASONS,
  EMAIL_STOP_EVENTS,
  LIVE_EMAIL_ADAPTERS,
  senderIdentityMissing,
  type EmailBlockReason,
  type EmailEventKind,
  type EmailSettings,
} from "@/lib/wholesale/email-constants";

/**
 * ═══════════ CỔNG CHÍNH SÁCH GỬI EMAIL — HÀM THUẦN, TẤT ĐỊNH (E1) ═══════════
 *
 * Câu hỏi DUY NHẤT: "thư này, lúc này, có được rời khỏi ERP không". Không đọc / ghi CSDL, không đọc đồng hồ (mốc nằm trong
 * đầu vào), chạy hai lần ra cùng kết quả. Người gọi (`lib/wholesale/email-outbox.ts`) gom dữ kiện từ CSDL rồi hỏi hàm này
 * NGAY TRƯỚC khi gọi nhà cung cấp — không phải lúc soạn, vì danh sách chặn / đồng ý / phản hồi có thể đổi giữa hai lúc.
 *
 * Luật:
 *  1. MỌI điều kiện phải ĐỦ; thiếu một ⇒ không gửi. Hàm gom HẾT lý do (không dừng ở lý do đầu) để màn hình nói đủ một lần.
 *  2. AI không bao giờ gọi gửi trực tiếp: đường duy nhất tới nhà cung cấp đi qua hàng đợi + cổng này, và cổng đòi một lượt
 *     DUYỆT của NGƯỜI (khoá tài khoản) khớp đúng nội dung đang gửi, dùng MỘT lần.
 *  3. Email công khai trên website KHÔNG phải đồng ý — điều đó nằm trong `contactability()` (P1a); cổng chỉ đòi kết quả của nó
 *     ở chế độ AUTOMATED và không tự suy diễn lại.
 *  4. Lý do TỰ HẾT (chế độ tắt, nút dừng, hạn mức, thiếu danh tính người gửi) ⇒ `hold = true`: thư nằm lại hàng đợi. Còn lại ⇒
 *     chặn hẳn, cần người sửa căn cứ.
 *  5. CỔNG NƯỚC (issue #1085): nước người nhận chưa có trong `allowedCountries` ⇒ ở chế độ GỬI THẬT thư nằm chờ với lý do
 *     `COUNTRY_NOT_REVIEWED`; ở CHẠY THỬ thư vẫn đi hết đường ống nhưng mang cảnh báo (`warnings`). Không xác định được nước
 *     ⇒ coi như CHƯA RÀ (rơi về phía hẹp).
 */

export type EmailPolicyMessage = {
  status: string;
  toEmail: string;
  recipientDomain: string | null;
  campaignId: string | null;
  approvedByUserId: string | null;
  approvedAt: Date | string | null;
  /** Băm nội dung lúc duyệt (người nhận + tiêu đề + thân). */
  approvedHash: string | null;
  /** Băm nội dung hiện tại — tính bằng `emailContentHash` cùng một cách. */
  contentHash: string;
  approvalUsedAt: Date | string | null;
};

export type EmailPolicyInput = {
  settings: EmailSettings;
  message: EmailPolicyMessage;
  /** Email hiện tại của lead, đã chuẩn hoá — khác `toEmail` ⇒ địa chỉ đã đổi sau khi soạn. */
  leadEmail: string | null;
  leadContactStatus: string;
  /** Kết quả `contactability(lead, …, "EMAIL", "AUTOMATED")` — chỗ DUY NHẤT quyết định máy có được tự liên hệ không. */
  contactability: { allowed: boolean; reason: string; detail: string };
  /** Lý do khớp danh sách không liên hệ (bất kỳ khoá nào của lead, kể cả EMAIL) — `null` = không khớp. */
  suppressionHit: string | null;
  /** Mọi loại sự kiện đã ghi cho lead (mọi thư) — có REPLY / UNSUBSCRIBE / BOUNCE_HARD / COMPLAINT ⇒ dừng. */
  leadEventKinds: readonly string[];
  /** Đã có thư THẬT khác cùng khoá chống trùng ở SENT / SENDING. */
  duplicateSent: boolean;
  /** Số thư cùng chế độ đã SENT: 60 phút qua · từ 0 giờ VN · cùng tên miền nhận từ 0 giờ VN. */
  counts: { lastHour: number; today: number; domainToday: number };
  /** Bộ chuyển thật đang có (mặc định đọc `LIVE_EMAIL_ADAPTERS`) — bài kiểm truyền vào để đo nhánh LIVE. */
  liveAdapters?: readonly string[];
  /** Nước người nhận (ISO2; `VN` = trong nước) — thang chứng cứ `leadCountryOf`; `null` = CHƯA BIẾT ⇒ coi như chưa rà. */
  recipientCountry: string | null;
};

export type EmailPolicyDecision = {
  allowed: boolean;
  /** Mọi lý do chặn, theo thứ tự cố định của `EMAIL_BLOCK_REASONS`. Rỗng ⇔ `allowed`. */
  reasons: EmailBlockReason[];
  /** Mọi lý do đều TỰ HẾT ⇒ giữ ở hàng đợi; có một lý do chặn hẳn ⇒ `false`. */
  hold: boolean;
  /** Câu giải thích từng lý do — in ra màn hình / ghi `blocked_reason`. */
  details: string[];
  /** Chế độ gửi nếu được phép. */
  sendMode: "DRY_RUN" | "LIVE" | null;
  /** Điều không chặn ở chế độ hiện tại nhưng SẼ chặn khi gửi thật (hôm nay: nước chưa rà luật ở CHẠY THỬ). */
  warnings: string[];
};

function stopEventsOf(kinds: readonly string[]): EmailEventKind[] {
  return EMAIL_STOP_EVENTS.filter((k) => kinds.includes(k));
}

export function evaluateEmailSend(input: EmailPolicyInput): EmailPolicyDecision {
  const { settings: s, message: m } = input;
  const adapters = input.liveAdapters ?? LIVE_EMAIL_ADAPTERS;
  const hit = new Map<EmailBlockReason, string>();
  const add = (r: EmailBlockReason, detail?: string) => {
    if (!hit.has(r)) hit.set(r, detail ? `${EMAIL_BLOCK_REASON_LABEL[r]}: ${detail}` : EMAIL_BLOCK_REASON_LABEL[r]);
  };

  if (m.status !== "QUEUED") add("BAD_STATUS", m.status);

  // ── Chế độ của tổ chức ──
  if (s.mode === "OFF") add("MODE_OFF");
  if (s.mode === "LIVE") {
    if (!adapters.length) add("LIVE_NO_ADAPTER");
    if (!s.liveEnabledByUserId) add("LIVE_NOT_OWNER_ENABLED");
  }

  // ── Nút dừng ──
  if (s.paused) add("KILL_ORG", s.pausedReason || undefined);
  if (m.campaignId && s.pausedCampaignIds.includes(m.campaignId)) add("KILL_CAMPAIGN");
  if (m.recipientDomain && s.blockedDomains.includes(m.recipientDomain)) add("KILL_DOMAIN", m.recipientDomain);

  const missing = senderIdentityMissing(s.sender);
  if (missing.length) add("SENDER_INCOMPLETE", `thiếu ${missing.join(", ")}`);

  // ── Cổng nước: gửi thật chỉ tới nước đã rà luật; chạy thử vẫn đi nhưng nói rõ ──
  const warnings: string[] = [];
  const country = input.recipientCountry;
  if (!country || !s.allowedCountries.includes(country)) {
    const detail = country ? `chưa rà luật nước ${country}` : "không xác định được nước người nhận";
    if (s.mode === "LIVE") add("COUNTRY_NOT_REVIEWED", detail);
    else warnings.push(`${EMAIL_BLOCK_REASON_LABEL.COUNTRY_NOT_REVIEWED}: ${detail}`);
  }

  // ── Lead ──
  const stops = stopEventsOf(input.leadEventKinds);
  if (input.leadContactStatus === "DO_NOT_CONTACT") add("LEAD_STOPPED", "KHÔNG LIÊN HỆ");
  else if (stops.length) add("LEAD_STOPPED", stops.join(", "));
  if (!input.contactability.allowed) add("NOT_CONTACTABLE", input.contactability.detail || input.contactability.reason);
  if (input.suppressionHit) add("SUPPRESSED", input.suppressionHit);
  if (input.leadEmail !== m.toEmail) add("ADDRESS_CHANGED", input.leadEmail ? `lead đang mang ${input.leadEmail}` : "lead không còn email");

  // ── Duyệt: của NGƯỜI, khớp nội dung, một lần ──
  if (!m.approvedByUserId || !m.approvedAt || !m.approvedHash) add("NOT_APPROVED");
  else if (m.approvedHash !== m.contentHash) add("APPROVAL_STALE");
  if (m.approvalUsedAt) add("APPROVAL_USED");

  if (input.duplicateSent) add("DUPLICATE");

  // ── Hạn mức ──
  if (input.counts.lastHour >= s.limits.perHour) add("LIMIT_HOUR", `${input.counts.lastHour}/${s.limits.perHour}`);
  if (input.counts.today >= s.limits.perDay) add("LIMIT_DAY", `${input.counts.today}/${s.limits.perDay}`);
  if (input.counts.domainToday >= s.limits.perRecipientDomainPerDay) add("LIMIT_DOMAIN", `${input.counts.domainToday}/${s.limits.perRecipientDomainPerDay}`);

  const reasons = EMAIL_BLOCK_REASONS.filter((r) => hit.has(r));
  const allowed = reasons.length === 0;
  return {
    allowed,
    reasons,
    hold: !allowed && reasons.every((r) => EMAIL_HOLD_REASONS.includes(r)),
    details: reasons.map((r) => hit.get(r)!),
    sendMode: allowed ? (s.mode === "LIVE" ? "LIVE" : "DRY_RUN") : null,
    warnings,
  };
}
