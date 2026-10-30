import { intlSearchProvince, isIntlProvinceKey } from "@/lib/wholesale/areas-intl";
import { contactability, normalizeEmail, suppressionMatches, type Contactability, type ContactabilityLead, type ConsentRecord, type SuppressionRecord } from "@/lib/wholesale/contactability";

/**
 * ═══════════ KẾ HOẠCH KÊNH LIÊN HỆ — HÀM THUẦN (chủ shop chốt 30/10/2026) ═══════════
 *
 * «Tách phần tìm khách nước ngoài để gửi email với luồng khách trong nước để nhắn Zalo. Bổ sung gửi email cho cả khách trong
 * nước (trong trường hợp không gửi được tin nhắn Zalo cho khách đó).»
 *
 *  · Lead QUỐC TẾ (`isIntlProvinceKey`) ⇒ kênh EMAIL.
 *  · Lead TRONG NƯỚC ⇒ ZALO là kênh chính; EMAIL dự phòng KHI VÀ CHỈ KHI Zalo KHÔNG GỬI ĐƯỢC: không có SĐT di động (Zalo đi
 *    theo số di động), hoặc `zalo_status = NOT_FOUND` (không có tài khoản — một sự thật, không nhân đôi), hoặc nhân viên đánh
 *    dấu «Zalo không gửi được» (chặn tin người lạ · số sai…) mà chưa hoàn tác.
 *  · KHÁCH IM LẶNG KHÔNG PHẢI «KHÔNG GỬI ĐƯỢC»: hàm không nhận đầu vào nào về phản hồi / hẹn gọi lại — không có đường nào để
 *    sự im lặng đổi kênh.
 *  · KHÔNG LIÊN HỆ / khớp danh sách chặn ⇒ DỪNG trên mọi kênh (cùng luật `contactability()` của P1a — chặn thắng mọi đồng ý).
 *  · Không có email ⇒ kế hoạch nói thẳng «chưa có email — chạy tìm email», không đoán địa chỉ.
 *
 * Kế hoạch chỉ chia LÀN; được gửi hay không vẫn do cổng chính sách E1 (`evaluateEmailSend`) quyết NGAY TRƯỚC khi gửi —
 * `emailGate` ở đây là bản xem trước của đúng hàm `contactability(…, "AUTOMATED")` mà cổng đọc, không phải luật thứ hai.
 */

export const ZALO_UNDELIVERABLE_REASONS = ["NO_ACCOUNT", "BLOCKS_STRANGERS", "WRONG_NUMBER"] as const;
export type ZaloUndeliverableReason = (typeof ZALO_UNDELIVERABLE_REASONS)[number];
export const ZALO_UNDELIVERABLE_LABEL: Record<ZaloUndeliverableReason, string> = {
  NO_ACCOUNT: "Không có tài khoản Zalo",
  BLOCKS_STRANGERS: "Chặn tin nhắn người lạ",
  WRONG_NUMBER: "Số sai / không phải của doanh nghiệp",
};

/** `outcome` của dòng hoạt động kind `ZALO` — đánh dấu và hoàn tác là HAI dòng, không dòng nào bị xoá / sửa. */
export const ZALO_MARK_OUTCOME = "UNDELIVERABLE";
export const ZALO_UNMARK_OUTCOME = "UNDELIVERABLE_UNDONE";
export const ZALO_MARKER_OUTCOMES = [ZALO_MARK_OUTCOME, ZALO_UNMARK_OUTCOME] as const;
export const ZALO_MARKER_OUTCOME_LABEL: Record<string, string> = { [ZALO_MARK_OUTCOME]: "Zalo không gửi được", [ZALO_UNMARK_OUTCOME]: "Hoàn tác «Zalo không gửi được»" };

/** Lý do Zalo không gửi được do MÁY suy ra (không cần ai đánh dấu). */
export type ZaloBlock = { source: "NO_MOBILE" | "ZALO_STATUS" | "MARKER"; reason: string };

export type ZaloMarker = { reason: ZaloUndeliverableReason; at: string };

function isReason(v: unknown): v is ZaloUndeliverableReason {
  return typeof v === "string" && (ZALO_UNDELIVERABLE_REASONS as readonly string[]).includes(v);
}

/**
 * Dòng hoạt động `ZALO` của MỘT lead ⇒ dấu «không gửi được» còn hiệu lực (dòng mới nhất giữa hai loại là dòng đánh dấu), hoặc
 * `null`. Đọc ra lúc xem — không cột trạng thái nào phải giữ cho khớp. Dòng thiếu lý do hợp lệ bị bỏ, không đoán.
 */
export function zaloMarkerOf(rows: readonly { outcome: string | null; meta: unknown; createdAt: Date | string }[]): ZaloMarker | null {
  const ms = (d: Date | string) => (typeof d === "string" ? new Date(d).getTime() : d.getTime());
  const markers = rows.filter((r) => r.outcome === ZALO_MARK_OUTCOME || r.outcome === ZALO_UNMARK_OUTCOME).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const last = markers[0];
  if (!last || last.outcome !== ZALO_MARK_OUTCOME) return null;
  const reason = last.meta && typeof last.meta === "object" ? (last.meta as Record<string, unknown>).reason : null;
  if (!isReason(reason)) return null;
  return { reason, at: typeof last.createdAt === "string" ? last.createdAt : last.createdAt.toISOString() };
}

/** Nước người nhận theo khoá tỉnh: lead quốc tế ⇒ ISO2 của nước (không nhận ra ⇒ `null`); còn lại ⇒ `VN`. */
export function recipientCountryOf(provinceKey: string | null | undefined): string | null {
  if (!isIntlProvinceKey(provinceKey)) return "VN";
  return intlSearchProvince(provinceKey)?.locale?.regionCode ?? null;
}

export const CONTACT_TRACKS = ["INTL_EMAIL", "DOMESTIC_ZALO", "DOMESTIC_EMAIL_FALLBACK", "NO_CHANNEL", "STOPPED"] as const;
export type ContactTrack = (typeof CONTACT_TRACKS)[number];
export const CONTACT_TRACK_LABEL: Record<ContactTrack, string> = {
  INTL_EMAIL: "Nước ngoài — Email",
  DOMESTIC_ZALO: "Trong nước — Zalo",
  DOMESTIC_EMAIL_FALLBACK: "Trong nước — chuyển sang email",
  NO_CHANNEL: "Thiếu kênh",
  STOPPED: "Dừng liên hệ",
};
/** Làn mà nút «Đưa vào hộp thư đi» (E1) được hiện. */
export const EMAIL_TRACKS: readonly ContactTrack[] = ["INTL_EMAIL", "DOMESTIC_EMAIL_FALLBACK"];

export const NO_EMAIL_HINT = "Chưa có email — chạy «Thu thập email» (Khách sỉ tiềm năng) hoặc nhập email khách cho.";

export type ContactPlanInput = {
  lead: ContactabilityLead & { provinceKey: string | null; phoneKind: string | null; zaloStatus: string | null };
  consents: readonly ConsentRecord[];
  suppressions: readonly SuppressionRecord[];
  /** Dấu «Zalo không gửi được» còn hiệu lực (`zaloMarkerOf`). */
  zaloMarker: ZaloMarker | null;
  /** `wholesale.email.allowedCountries` — chỉ để in cổng nước, cổng thật nằm ở `evaluateEmailSend`. */
  allowedCountries: readonly string[];
};

export type ContactPlan = {
  track: ContactTrack;
  /** Kênh để liên hệ bây giờ (`null` khi dừng / thiếu kênh). */
  channel: "EMAIL" | "ZALO" | null;
  international: boolean;
  country: string | null;
  /** Nước đã rà luật thư chào hàng chưa — `false` ⇒ email chỉ chạy thử. */
  countryReviewed: boolean;
  email: string | null;
  /** Zalo không gửi được vì đâu (`null` = gửi được / không áp dụng). */
  zaloBlock: ZaloBlock | null;
  /** Bản xem trước cổng tự gửi email của P1a (cùng hàm, chế độ AUTOMATED) — `null` khi không có email. */
  emailGate: Contactability | null;
  /** Câu cho người đọc: vì sao ở làn này, thiếu gì. */
  notes: string[];
};

function zaloBlockOf(lead: ContactPlanInput["lead"], marker: ZaloMarker | null): ZaloBlock | null {
  if (!lead.phone || lead.phoneKind !== "MOBILE") return { source: "NO_MOBILE", reason: lead.phone ? "SĐT không phải số di động — Zalo đi theo số di động" : "Chưa có SĐT" };
  if (lead.zaloStatus === "NOT_FOUND") return { source: "ZALO_STATUS", reason: ZALO_UNDELIVERABLE_LABEL.NO_ACCOUNT };
  if (marker) return { source: "MARKER", reason: ZALO_UNDELIVERABLE_LABEL[marker.reason] };
  return null;
}

export function contactPlanOf(input: ContactPlanInput): ContactPlan {
  const { lead } = input;
  const international = isIntlProvinceKey(lead.provinceKey);
  const country = recipientCountryOf(lead.provinceKey);
  const countryReviewed = Boolean(country && input.allowedCountries.includes(country));
  const email = normalizeEmail(lead.email);
  const emailGate = email ? contactability(lead, input.consents, input.suppressions, "EMAIL", "AUTOMATED") : null;
  const base = { international, country, countryReviewed, email, emailGate };

  if (lead.contactStatus === "DO_NOT_CONTACT") return { ...base, track: "STOPPED", channel: null, zaloBlock: null, notes: ["Lead ở danh sách KHÔNG LIÊN HỆ — dừng mọi kênh."] };
  const hit = suppressionMatches(lead, input.suppressions);
  if (hit) return { ...base, track: "STOPPED", channel: null, zaloBlock: null, notes: [`Khớp danh sách không liên hệ (${hit.kind}) — dừng mọi kênh.`] };

  const countryNote = countryReviewed ? null : `Chưa rà luật thư chào hàng của nước ${country ?? "(không xác định)"} — email chỉ chạy thử.`;
  const emailNotes = (head: string[]) => [...head, ...(countryNote ? [countryNote] : [])];

  if (international) {
    if (!email) return { ...base, track: "NO_CHANNEL", channel: null, zaloBlock: null, notes: ["Khách nước ngoài đi kênh email.", NO_EMAIL_HINT] };
    return { ...base, track: "INTL_EMAIL", channel: "EMAIL", zaloBlock: null, notes: emailNotes(["Khách nước ngoài đi kênh email."]) };
  }

  const zaloBlock = zaloBlockOf(lead, input.zaloMarker);
  if (!zaloBlock) return { ...base, track: "DOMESTIC_ZALO", channel: "ZALO", zaloBlock: null, notes: ["Khách trong nước nhắn Zalo trước. Khách chưa trả lời KHÔNG làm đổi kênh."] };
  if (!email) return { ...base, track: "NO_CHANNEL", channel: null, zaloBlock, notes: [`Zalo không gửi được: ${zaloBlock.reason}.`, NO_EMAIL_HINT] };
  return { ...base, track: "DOMESTIC_EMAIL_FALLBACK", channel: "EMAIL", zaloBlock, notes: emailNotes([`Zalo không gửi được: ${zaloBlock.reason} — chuyển sang email.`]) };
}
