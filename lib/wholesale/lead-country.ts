import { intlSearchProvince, isIntlProvinceKey } from "@/lib/wholesale/areas-intl";
import { searchProvince } from "@/lib/wholesale/areas";

/**
 * ═══════════ NƯỚC CỦA MỘT LEAD — MỘT THANG CHỨNG CỨ, MỘT HÀM THUẦN ═══════════
 *
 * Trước đây có HAI luật: cổng nước / chọn làn đọc khoá tỉnh (thiếu khoá ⇒ «trong nước»), còn AI soạn email đọc mã nước SĐT +
 * đuôi tên miền (không dấu hiệu ⇒ «trong nước»). Cùng một lead `+1 · pacificseafood.com` bị một bên xếp Việt Nam, bên kia
 * viết tiếng Anh. Nay mọi nơi hỏi đúng hàm này:
 *
 *  1. NGƯỜI XÁC NHẬN (dòng hoạt động `EDIT` / `COUNTRY_CONFIRMED`) — chứng cứ mạnh nhất, đè mọi suy luận.
 *  2. Khoá tỉnh: `intl …` ⇒ nước của ô quét; tỉnh Việt Nam có trong danh sách chuẩn ⇒ VN. Khoá không nhận ra ⇒ bỏ qua.
 *  3. Mã nước SĐT: `phone_country_code` / số đã chuẩn hoá `+84…` ⇒ VN; số viết `+<mã>` ⇒ nước của mã. Mã dùng chung nhiều
 *     nước (+1 Mỹ/Canada…, +7 Nga/Kazakhstan) KHÔNG kết luận — luật thư chào hàng của Mỹ và Canada khác nhau.
 *  4. Đuôi tên miền QUỐC GIA 2 chữ của website rồi của email (.de, .fr, .com.vn…). Đuôi chung (.com, .net…) và đuôi quốc gia
 *     hay bị dùng như đuôi chung (.io, .co, .ai, .me…) KHÔNG kết luận.
 *  5. Còn lại ⇒ `null` = CHƯA BIẾT. Không có mặc định «trong nước».
 *
 * CHƯA BIẾT ⇒ cổng nước coi như chưa rà (gửi thật nằm chờ), kế hoạch kênh xếp vào làn «Thiếu căn cứ nước — người xác nhận»,
 * AI soạn email từ chối thay vì đoán ngôn ngữ.
 */

export type LeadCountrySource = "CONFIRMED" | "PROVINCE" | "PHONE" | "DOMAIN" | "EMAIL_DOMAIN";
export type LeadCountry = { country: string | null; source: LeadCountrySource | null; detail: string };

export type LeadCountryInput = {
  /** Nước nhân viên đã xác nhận (`countryConfirmationOf`) — `null` = chưa ai xác nhận. */
  confirmedCountry: string | null;
  provinceKey: string | null;
  /** Cột `phone_country_code` (chỉ có khi bộ chuẩn hoá VN nhận số — tức «84»). */
  phoneCountryCode: string | null;
  /** Các chuỗi SĐT có thật của lead: số đã chuẩn hoá, số gốc nhân viên / tệp nhập, số quốc tế của Google. */
  phones: readonly (string | null | undefined)[];
  websiteDomain: string | null;
  email: string | null;
};

/** Tên nước (tiếng Việt) cho mọi mã mà thang này có thể ra — cũng là danh sách nước nhân viên chọn khi xác nhận. */
export const COUNTRY_LABEL: Record<string, string> = {
  VN: "Việt Nam",
  SG: "Singapore",
  MY: "Malaysia",
  TH: "Thái Lan",
  ID: "Indonesia",
  PH: "Philippines",
  KH: "Campuchia",
  LA: "Lào",
  CN: "Trung Quốc",
  HK: "Hồng Kông",
  MO: "Ma Cao",
  TW: "Đài Loan",
  JP: "Nhật Bản",
  KR: "Hàn Quốc",
  IN: "Ấn Độ",
  AE: "UAE",
  AU: "Úc",
  NZ: "New Zealand",
  US: "Mỹ",
  CA: "Canada",
  GB: "Anh",
  IE: "Ireland",
  DE: "Đức",
  FR: "Pháp",
  NL: "Hà Lan",
  BE: "Bỉ",
  LU: "Luxembourg",
  CH: "Thuỵ Sĩ",
  AT: "Áo",
  IT: "Ý",
  ES: "Tây Ban Nha",
  PT: "Bồ Đào Nha",
  SE: "Thuỵ Điển",
  NO: "Na Uy",
  DK: "Đan Mạch",
  FI: "Phần Lan",
  PL: "Ba Lan",
  CZ: "Séc",
  RU: "Nga",
};

export function isKnownCountry(code: unknown): code is string {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(COUNTRY_LABEL, code);
}

/** Mã gọi quốc tế ⇒ nước. Chỉ mã thuộc ĐÚNG MỘT nước trong danh sách; mã dùng chung (1, 7) cố ý vắng mặt. */
const CALLING_CODE: Record<string, string> = {
  "84": "VN",
  "65": "SG",
  "60": "MY",
  "66": "TH",
  "62": "ID",
  "63": "PH",
  "855": "KH",
  "856": "LA",
  "86": "CN",
  "852": "HK",
  "853": "MO",
  "886": "TW",
  "81": "JP",
  "82": "KR",
  "91": "IN",
  "971": "AE",
  "61": "AU",
  "64": "NZ",
  "44": "GB",
  "353": "IE",
  "49": "DE",
  "33": "FR",
  "31": "NL",
  "32": "BE",
  "352": "LU",
  "41": "CH",
  "43": "AT",
  "39": "IT",
  "34": "ES",
  "351": "PT",
  "46": "SE",
  "47": "NO",
  "45": "DK",
  "358": "FI",
  "48": "PL",
  "420": "CZ",
};
/** Mã gọi dùng chung nhiều nước — thấy là biết «nước ngoài» nhưng KHÔNG biết nước nào. */
const SHARED_CALLING_CODES = new Set(["1", "7"]);

/** Đuôi quốc gia 2 chữ hay bị dùng như đuôi chung — không phải bằng chứng doanh nghiệp ở nước đó. */
const VANITY_CCTLD = new Set(["io", "co", "ai", "me", "tv", "fm", "gg", "to", "cc", "ws", "ly", "sh", "gl", "am", "la", "so", "vc", "eu"]);

/** `+<mã> …` / `00<mã> …` ⇒ mã gọi quốc tế (khớp tiền tố dài nhất có trong bảng). Không có dấu `+`/`00` ⇒ `null`. */
export function callingCodeOf(raw: string | null | undefined): { code: string; country: string | null } | null {
  if (!raw) return null;
  const t = raw.trim();
  const intl = t.startsWith("+") ? t.slice(1) : t.startsWith("00") ? t.slice(2) : null;
  if (intl === null) return null;
  const digits = intl.replace(/\D/g, "");
  if (digits.length < 6) return null;
  for (const len of [3, 2, 1]) {
    const p = digits.slice(0, len);
    if (CALLING_CODE[p]) return { code: p, country: CALLING_CODE[p]! };
    if (SHARED_CALLING_CODES.has(p)) return { code: p, country: null };
  }
  return null;
}

/** Đuôi tên miền quốc gia ⇒ nước (`.uk` ⇒ GB). Đuôi chung / đuôi «mượn» ⇒ `null`. */
export function countryOfDomain(domain: string | null | undefined): string | null {
  const d = (domain ?? "").trim().toLowerCase().replace(/\.+$/, "");
  const tld = d.includes(".") ? d.slice(d.lastIndexOf(".") + 1) : "";
  if (!/^[a-z]{2}$/.test(tld) || VANITY_CCTLD.has(tld)) return null;
  const code = tld === "uk" ? "GB" : tld.toUpperCase();
  return isKnownCountry(code) ? code : null;
}

export function leadCountryOf(input: LeadCountryInput): LeadCountry {
  if (isKnownCountry(input.confirmedCountry)) return { country: input.confirmedCountry, source: "CONFIRMED", detail: "Nhân viên đã xác nhận nước" };

  const key = input.provinceKey?.trim() ?? "";
  if (key) {
    if (isIntlProvinceKey(key)) {
      const iso = intlSearchProvince(key)?.locale?.regionCode ?? null;
      if (iso) return { country: iso, source: "PROVINCE", detail: `Ô quét quốc tế (${iso})` };
    } else if (searchProvince(key)) return { country: "VN", source: "PROVINCE", detail: `Tỉnh / thành Việt Nam (${key})` };
  }

  if (input.phoneCountryCode === "84") return { country: "VN", source: "PHONE", detail: "SĐT Việt Nam" };
  let shared: string | null = null;
  for (const p of input.phones) {
    const c = callingCodeOf(p);
    if (!c) continue;
    if (c.country) return { country: c.country, source: "PHONE", detail: `SĐT mã +${c.code}` };
    shared ??= c.code;
  }

  const byDomain = countryOfDomain(input.websiteDomain);
  if (byDomain) return { country: byDomain, source: "DOMAIN", detail: `Tên miền website .${input.websiteDomain!.split(".").pop()}` };
  const emailDomain = input.email && input.email.includes("@") ? input.email.slice(input.email.lastIndexOf("@") + 1) : null;
  const byEmail = countryOfDomain(emailDomain);
  if (byEmail) return { country: byEmail, source: "EMAIL_DOMAIN", detail: `Tên miền email .${emailDomain!.split(".").pop()}` };

  return { country: null, source: null, detail: shared ? `SĐT mã +${shared} dùng chung nhiều nước — chưa biết nước nào` : "Không có chứng cứ nước (ô quét · SĐT · tên miền)" };
}

// ─────────────── xác nhận của người ───────────────

/** Dòng `wholesale_lead_activities` kind `EDIT` ghi lượt xác nhận nước — chỉ thêm, dòng mới nhất thắng. */
export const COUNTRY_CONFIRM_OUTCOME = "COUNTRY_CONFIRMED";

export function countryConfirmationOf(rows: readonly { outcome: string | null; meta: unknown; createdAt: Date | string }[]): string | null {
  const ms = (d: Date | string) => (typeof d === "string" ? new Date(d).getTime() : d.getTime());
  const last = rows.filter((r) => r.outcome === COUNTRY_CONFIRM_OUTCOME).sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
  const c = last?.meta && typeof last.meta === "object" ? (last.meta as Record<string, unknown>).country : null;
  return isKnownCountry(c) ? c : null;
}
