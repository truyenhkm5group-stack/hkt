import { normalizeVnPhone } from "@/lib/wholesale/phone";

/**
 * ═══════════ ĐƯỢC LIÊN HỆ HAY KHÔNG — HÀM THUẦN (P1a, 27/10/2026) ═══════════
 *
 * Tệp này không đọc và không ghi CSDL, nên client component cũng nạp được (nhãn căn cứ trên form).
 *
 * Bối cảnh pháp lý (DATA_PROCESSING_REGISTER.md D17): tiếp thị tới người CHƯA đồng ý là rủi ro theo NĐ 91 / Luật 91.
 * Trước bản này danh sách chặn có, nhưng KHÔNG có nhật ký đồng ý. `wholesale_contact_consents` là nhật ký đó, và hàm
 * `contactability()` dưới đây là chỗ DUY NHẤT quyết định "máy có được tự liên hệ kênh này không".
 *
 * Ba luật:
 *  1. MẶC ĐỊNH LÀ KHÔNG. Liên hệ TỰ ĐỘNG (máy tự gửi, không người bấm từng tin) chỉ được khi có MỘT bằng chứng đồng ý còn
 *     hiệu lực, đúng kênh, đúng địa chỉ liên hệ đã chuẩn hoá. Thiếu bằng chứng ⇒ `NO_CONSENT`, không phải "chưa rõ nên cho".
 *  2. EMAIL CÔNG KHAI TRÊN WEBSITE KHÔNG PHẢI ĐỒNG Ý. Doanh nghiệp công bố email để khách tìm tới họ, không phải để nhận tin
 *     tiếp thị tự động. Vì vậy không có căn cứ nào tên là "PUBLIC_WEBSITE", và bộ đọc website không bao giờ ghi một dòng đồng ý.
 *  3. DANH SÁCH CHẶN THẮNG MỌI ĐỒNG Ý. Khớp bất kỳ khoá nào của lead (Place ID · SĐT · tên miền · email) ⇒ không liên hệ trên
 *     MỌI kênh — cùng nghĩa với `suppressionHit()` đã có (danh sách "KHÔNG LIÊN HỆ" là của doanh nghiệp, không của một kênh).
 *
 * Liên hệ THỦ CÔNG (nhân viên tự gọi, tự bấm gửi từng tin) giữ nguyên như trước: chỉ chặn bởi danh sách chặn và trạng thái
 * KHÔNG LIÊN HỆ. Bản này không đổi quy trình gọi điện của đội bán sỉ; nó dựng cái cổng mà mọi kênh TỰ GỬI về sau phải qua.
 */

export const CONSENT_CHANNELS = ["EMAIL", "PHONE", "ZALO"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export const CONSENT_CHANNEL_LABEL: Record<ConsentChannel, string> = { EMAIL: "Email", PHONE: "Điện thoại / SMS", ZALO: "Zalo" };

/**
 * Căn cứ của một lần đồng ý — danh sách ĐÓNG (CHECK ở CSDL). Mỗi giá trị là một sự việc ĐÃ XẢY RA mà người ghi kể lại được
 * trong `evidence_text`; không có giá trị nào là "suy ra từ dữ liệu công khai".
 *
 *  · OPT_IN_FORM — người liên hệ TỰ điền form / đăng ký nhận báo giá, catalog (landing, hội chợ, phiếu giấy). Bằng chứng: link
 *    form hoặc mô tả lần gửi.
 *  · REPLIED_INBOUND — khách CHỦ ĐỘNG nhắn / gọi / gửi mail tới shop trước, hoặc trả lời và xin thêm thông tin trên chính kênh
 *    này. Đồng ý chỉ áp cho kênh khách đã dùng.
 *  · VERBAL_CONSENT — khách đồng ý bằng lời trong một cuộc gọi ("em gửi bảng giá qua mail cho chị"). Nhân viên ghi lúc nào,
 *    với ai, câu khách nói.
 *  · EXISTING_CUSTOMER — đã là khách hàng ERP (lead đã chuyển thành khách). Máy chủ chỉ nhận căn cứ này khi lead có `customer_id`.
 *  · B2B_PUBLIC_PROCUREMENT — doanh nghiệp công bố lời MỜI CHÀO HÀNG / mời báo giá cho đúng nhóm hàng, kèm kênh nhận
 *    (vd «cần tìm nhà cung cấp hải sản khô, gửi báo giá về email …»). Khác hẳn email liên hệ chung trên website: phải có
 *    link tới chính lời mời.
 *  · OWNER_ATTESTED — chủ shop xác nhận có căn cứ nằm ngoài hệ thống (hợp đồng giấy, thoả thuận đối tác). Bắt buộc mô tả.
 *
 * Không có giá trị "NONE": nhật ký chỉ ghi bằng chứng. "Không có căn cứ" là KHÔNG có dòng nào — ghi một dòng NONE là để
 * một truy vấn đếm dòng một ngày nào đó coi nó là đồng ý.
 */
export const CONSENT_BASES = ["OPT_IN_FORM", "REPLIED_INBOUND", "VERBAL_CONSENT", "EXISTING_CUSTOMER", "B2B_PUBLIC_PROCUREMENT", "OWNER_ATTESTED"] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export const CONSENT_BASIS_LABEL: Record<ConsentBasis, string> = {
  OPT_IN_FORM: "Tự đăng ký qua form",
  REPLIED_INBOUND: "Khách chủ động liên hệ / trả lời",
  VERBAL_CONSENT: "Đồng ý bằng lời khi gọi",
  EXISTING_CUSTOMER: "Đã là khách hàng",
  B2B_PUBLIC_PROCUREMENT: "Lời mời chào hàng công khai",
  OWNER_ATTESTED: "Chủ shop xác nhận căn cứ khác",
};

export const CONSENT_BASIS_HINT: Record<ConsentBasis, string> = {
  OPT_IN_FORM: "Dán link form / mô tả lần khách tự đăng ký.",
  REPLIED_INBOUND: "Khách nhắn / gọi / gửi mail tới trước trên đúng kênh này — ghi lúc nào, nội dung gì.",
  VERBAL_CONSENT: "Ghi ngày gọi, người nghe máy, câu khách đồng ý.",
  EXISTING_CUSTOMER: "Chỉ nhận khi lead đã chuyển thành khách hàng ERP.",
  B2B_PUBLIC_PROCUREMENT: "Bắt buộc link tới CHÍNH lời mời chào hàng — email liên hệ chung trên website không tính.",
  OWNER_ATTESTED: "Mô tả căn cứ (hợp đồng, thoả thuận đối tác…).",
};

/** Căn cứ bắt buộc có link bằng chứng. */
export const CONSENT_BASES_NEED_URL: readonly ConsentBasis[] = ["B2B_PUBLIC_PROCUREMENT"];

/** Ai / đường nào ghi dòng đồng ý. Hôm nay chỉ có STAFF; IMPORT / SYSTEM khai sẵn cho tệp nhập và kênh khách nhắn tới. */
export const CONSENT_SOURCES = ["STAFF", "IMPORT", "SYSTEM"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const SUPPRESSION_KINDS = ["PHONE", "DOMAIN", "PLACE", "EMAIL"] as const;
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number];

export const SUPPRESSION_KIND_LABEL: Record<SuppressionKind, string> = { PHONE: "SĐT", DOMAIN: "Website", PLACE: "Địa điểm Google", EMAIL: "Email" };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Chuẩn hoá email: bỏ khoảng trắng hai đầu, bỏ tiền tố `mailto:`, chữ thường. KHÔNG bỏ dấu chấm của Gmail và không bỏ phần
 * `+nhãn` — đó là luật riêng của từng nhà cung cấp, đoán sai là gộp hai người làm một. Không đúng dạng ⇒ `null`.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw
    .trim()
    .replace(/^mailto:/i, "")
    .trim()
    .toLowerCase();
  return v && v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

/** Giá trị liên hệ đã chuẩn hoá theo kênh: email ⇒ `normalizeEmail`; SĐT / Zalo ⇒ khoá `+84…` của `normalizeVnPhone`. */
export function normalizeContactValue(channel: ConsentChannel, raw: string | null | undefined): string | null {
  if (channel === "EMAIL") return normalizeEmail(raw);
  return normalizeVnPhone(raw)?.normalized ?? null;
}

export const CONTACT_MODES = ["AUTOMATED", "MANUAL"] as const;
export type ContactMode = (typeof CONTACT_MODES)[number];

export type ContactabilityLead = {
  contactStatus: string;
  placeId: string | null;
  /** SĐT đã chuẩn hoá (`+84…`) — của tổ chức hoặc snapshot Google còn hạn. */
  phone: string | null;
  email: string | null;
  websiteDomain: string | null;
};

export type ConsentRecord = { channel: string; contactValue: string; basis: string; revokedAt: Date | string | null };
export type SuppressionRecord = { kind: string; value: string };

export const CONTACTABILITY_REASONS = ["DO_NOT_CONTACT", "NO_CONTACT_VALUE", "SUPPRESSED", "CONSENT_REVOKED", "NO_CONSENT", "CONSENTED", "MANUAL_ALLOWED"] as const;
export type ContactabilityReason = (typeof CONTACTABILITY_REASONS)[number];

export type Contactability = { allowed: boolean; reason: ContactabilityReason; detail: string; basis: ConsentBasis | null };

function isBasis(v: string): v is ConsentBasis {
  return (CONSENT_BASES as readonly string[]).includes(v);
}

/** Khoá của lead mà một dòng chặn có thể khớp — cùng bốn khoá với `suppressionHit()`. */
export function suppressionMatches(lead: ContactabilityLead, suppressions: readonly SuppressionRecord[]): SuppressionRecord | null {
  const email = normalizeEmail(lead.email);
  for (const s of suppressions) {
    if (s.kind === "PLACE" && lead.placeId && s.value === lead.placeId) return s;
    if (s.kind === "PHONE" && lead.phone && s.value === lead.phone) return s;
    if (s.kind === "DOMAIN" && lead.websiteDomain && s.value === lead.websiteDomain) return s;
    if (s.kind === "EMAIL" && email && s.value === email) return s;
  }
  return null;
}

/**
 * Lead này có được liên hệ trên `channel` không. `mode = "AUTOMATED"` (mặc định — câu hỏi khó hơn): máy tự gửi, cần đồng ý
 * còn hiệu lực. `mode = "MANUAL"`: người tự bấm — chỉ danh sách chặn / KHÔNG LIÊN HỆ chặn được.
 *
 * Thứ tự kiểm cố định: KHÔNG LIÊN HỆ → thiếu địa chỉ → danh sách chặn → đồng ý. Đồng ý ghi cho địa chỉ KHÁC (khách đổi email)
 * không tính: đồng ý gắn với một địa chỉ, không gắn với doanh nghiệp.
 */
export function contactability(lead: ContactabilityLead, consents: readonly ConsentRecord[], suppressions: readonly SuppressionRecord[], channel: ConsentChannel, mode: ContactMode = "AUTOMATED"): Contactability {
  if (lead.contactStatus === "DO_NOT_CONTACT") return { allowed: false, reason: "DO_NOT_CONTACT", detail: "Lead ở trạng thái KHÔNG LIÊN HỆ.", basis: null };
  const value = channel === "EMAIL" ? normalizeEmail(lead.email) : lead.phone ? normalizeContactValue(channel, lead.phone) : null;
  if (!value) return { allowed: false, reason: "NO_CONTACT_VALUE", detail: channel === "EMAIL" ? "Lead chưa có email hợp lệ." : "Lead chưa có SĐT hợp lệ.", basis: null };
  const hit = suppressionMatches(lead, suppressions);
  if (hit) return { allowed: false, reason: "SUPPRESSED", detail: `Khớp danh sách không liên hệ (${SUPPRESSION_KIND_LABEL[hit.kind as SuppressionKind] ?? hit.kind}: ${hit.value}).`, basis: null };
  const forValue = consents.filter((c) => c.channel === channel && c.contactValue === value);
  const live = forValue.find((c) => !c.revokedAt && isBasis(c.basis));
  if (mode === "MANUAL") {
    return { allowed: true, reason: "MANUAL_ALLOWED", detail: live ? `Người liên hệ thủ công · có đồng ý (${CONSENT_BASIS_LABEL[live.basis as ConsentBasis]}).` : "Người liên hệ thủ công · chưa có bằng chứng đồng ý — máy KHÔNG được tự gửi.", basis: live && isBasis(live.basis) ? live.basis : null };
  }
  if (live && isBasis(live.basis)) return { allowed: true, reason: "CONSENTED", detail: `Có đồng ý: ${CONSENT_BASIS_LABEL[live.basis]}.`, basis: live.basis };
  if (forValue.length) return { allowed: false, reason: "CONSENT_REVOKED", detail: "Đồng ý cho địa chỉ này đã bị thu hồi — máy không được tự liên hệ.", basis: null };
  return {
    allowed: false,
    reason: "NO_CONSENT",
    detail: channel === "EMAIL" ? "Chưa có bằng chứng đồng ý cho email này. Email công khai trên website KHÔNG phải đồng ý." : "Chưa có bằng chứng đồng ý cho kênh này.",
    basis: null,
  };
}
