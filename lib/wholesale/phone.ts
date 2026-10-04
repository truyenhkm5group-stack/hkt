/**
 * ═══════════ CHUẨN HOÁ SỐ ĐIỆN THOẠI VIỆT NAM — HÀM THUẦN ═══════════
 *
 * Dùng cho Săn khách sỉ (`/wholesale`): khử trùng lead theo SĐT và phân loại di động / cố định.
 * Tệp THUẦN, client-safe — không đọc CSDL, không đọc môi trường.
 *
 * ─── LUẬT ───
 *
 *  · `+84912345678`, `84912345678`, `0912 345 678`, `+84 (0) 912-345-678` ⇒ CÙNG một số, khoá chuẩn
 *    `+84912345678` (E.164). Hai lead mang hai cách viết này là MỘT doanh nghiệp.
 *  · Di động: 10 chữ số quốc gia, đầu số sau chuyển đổi 2018 (03x, 05x, 07x, 08x, 09x).
 *    Cố định: 11 chữ số quốc gia, mã vùng 02xx. Tổng đài 1800 / 1900: giữ nguyên dạng nội địa,
 *    không có dạng E.164 (không gọi được từ nước ngoài).
 *  · KHÔNG BỊA SỐ. Chuỗi thiếu chữ số (`912345678`), đầu số cũ 11 số (`0168…`), số nước ngoài ⇒
 *    `normalized = null`, `kind = "UNKNOWN"`. Không tự thêm số 0, không tự đổi đầu số cũ: thêm một chữ
 *    số là tạo ra một số điện thoại của NGƯỜI KHÁC.
 */

export const PHONE_KINDS = ["MOBILE", "LANDLINE", "SPECIAL", "UNKNOWN"] as const;
export type PhoneKind = (typeof PHONE_KINDS)[number];

export const PHONE_KIND_LABEL: Record<PhoneKind, string> = {
  MOBILE: "Di động",
  LANDLINE: "Cố định",
  SPECIAL: "Tổng đài",
  UNKNOWN: "Chưa rõ",
};

export type NormalizedPhone = {
  /** Chuỗi gốc đã cắt khoảng trắng hai đầu — giữ để đối chiếu. */
  raw: string;
  /** Khoá khử trùng: E.164 (`+84…`) cho di động / cố định, dạng nội địa cho tổng đài; `null` = không chuẩn hoá được. */
  normalized: string | null;
  /** Dạng nội địa để hiển thị / bấm gọi (`0912345678`); `null` khi không chuẩn hoá được. */
  national: string | null;
  /** Mã quốc gia khi xác định được (`84`); `null` khi không. */
  countryCode: string | null;
  kind: PhoneKind;
};

const MOBILE_NATIONAL = /^0(3[2-9]|5[2-9]|7[06-9]|8[1-9]|9\d)\d{7}$/;
const LANDLINE_NATIONAL = /^02\d{9}$/;
const SPECIAL_NATIONAL = /^(1800|1900)\d{4,6}$/;

function unknown(raw: string): NormalizedPhone {
  return { raw, normalized: null, national: null, countryCode: null, kind: "UNKNOWN" };
}

/**
 * Một chuỗi ⇒ một số đã chuẩn hoá. Chuỗi chứa NHIỀU số (`0912… - 0987…`) thì dùng `extractVnPhones`;
 * ở đây chuỗi như vậy ra `UNKNOWN` (gộp chữ số của hai số là bịa ra số thứ ba).
 */
export function normalizeVnPhone(input: string | null | undefined): NormalizedPhone | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // "+84 (0) 912…" — số 0 trong ngoặc là thói quen viết, không phải chữ số của số.
  let s = raw.replace(/\(\s*0\s*\)/g, "");
  if (/[a-zA-Z]/.test(s.replace(/\b(ext|tel|hotline|sđt|sdt|đt|dt|phone|mobile)\b[.:]?/gi, ""))) return unknown(raw);
  const plus = s.trim().startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (!s) return unknown(raw);

  let national: string | null = null;
  if (plus) {
    if (!s.startsWith("84")) return unknown(raw); // số nước ngoài: không phải việc của bộ chuẩn hoá VN
    national = `0${s.slice(2)}`;
  } else if (s.startsWith("84") && (s.length === 11 || s.length === 12)) {
    national = `0${s.slice(2)}`;
  } else if (s.startsWith("0")) {
    national = s;
  } else if (SPECIAL_NATIONAL.test(s)) {
    return { raw, normalized: s, national: s, countryCode: null, kind: "SPECIAL" };
  } else {
    return unknown(raw); // thiếu số 0 đầu / thiếu chữ số — không đoán
  }

  // "+84 0912…" (thừa số 0 sau mã nước) — viết sai phổ biến, chữ số vẫn đủ và không mơ hồ.
  if (national.startsWith("00")) national = national.slice(1);

  if (MOBILE_NATIONAL.test(national)) return { raw, normalized: `+84${national.slice(1)}`, national, countryCode: "84", kind: "MOBILE" };
  if (LANDLINE_NATIONAL.test(national)) return { raw, normalized: `+84${national.slice(1)}`, national, countryCode: "84", kind: "LANDLINE" };
  return unknown(raw);
}

/** Hai chuỗi có phải cùng một số không — chỉ khi CẢ HAI chuẩn hoá được. Chưa rõ thì không khẳng định trùng. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeVnPhone(a)?.normalized;
  const y = normalizeVnPhone(b)?.normalized;
  return x != null && x === y;
}

/**
 * Tìm mọi số điện thoại VN trong một đoạn chữ (trang liên hệ của website, ô ghi chú). Chỉ trả số
 * chuẩn hoá ĐƯỢC, bỏ trùng theo khoá chuẩn, giữ thứ tự xuất hiện.
 */
export function extractVnPhones(text: string | null | undefined, limit = 10): NormalizedPhone[] {
  if (!text) return [];
  const out: NormalizedPhone[] = [];
  const seen = new Set<string>();
  // Ứng viên: chuỗi chữ số có thể chen khoảng trắng / chấm / gạch / ngoặc, dài 8–18 ký tự.
  // Tổng đài 1800 / 1900 ngắn (8 số) có mẫu riêng — mẫu chung đòi ≥ 9 chữ số.
  const re = /(?:\+?\s*84[\s.\-()]*|\b0)[\d\s.\-()]{6,16}\d|\b1[89]00[\s.\-]?\d{2}[\s.\-]?\d{2}(?:\d{2})?\b/g;
  for (const m of text.matchAll(re)) {
    const p = normalizeVnPhone(m[0]);
    if (!p?.normalized || seen.has(p.normalized)) continue;
    seen.add(p.normalized);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** Hiển thị dạng dễ đọc: `0912 345 678`, `028 3823 4567`, tổng đài giữ nguyên. Không chuẩn hoá được ⇒ chuỗi gốc. */
export function formatVnPhone(input: string | null | undefined): string {
  const p = normalizeVnPhone(input);
  if (!p) return "";
  if (!p.national) return p.raw;
  const n = p.national;
  if (p.kind === "MOBILE") return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  // Mã vùng: Hà Nội 024 và TP.HCM 028 dài 3 số (+ 8 số); các tỉnh còn lại 02xx dài 4 số (+ 7 số).
  if (p.kind === "LANDLINE") return /^02[48]/.test(n) ? `${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}` : `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  return n;
}
