/**
 * ═══════════ HÀNG RÀO BỊA ĐẶT CHO EMAIL AI SOẠN (HÀM THUẦN) — docs/tech/hslc-b2b-sales-agent.md · P2b ═══════════
 *
 * MÁY chặn, không phải lời dặn trong prompt. Prompt có bảo AI «đừng bịa», nhưng con số cuối cùng có vào hộp thư đi hay không là do
 * tệp này quyết. Không đọc CSDL, không gọi mạng: cùng chữ + cùng dữ kiện ⇒ cùng phán quyết.
 *
 *  · Số tiền: mọi số tiền VND trong thư phải thuộc tập đã xác thực. Tập này gồm đơn giá các bậc của bảng giá sỉ đang áp, số của báo
 *    giá thật của lead, và số shop tự khai trong cấu hình. Đọc số tiền bằng ĐÚNG `extractVndAmounts` của hàng rào chatbot, không viết
 *    bộ đọc thứ hai. Tiền tệ khác VND bị chặn thẳng: ERP chưa có nguồn tỷ giá.
 *  · Khẳng định không có nguồn trong ERP — chứng nhận (P1c: `UNAVAILABLE`), năng lực xuất khẩu, tồn kho / sẵn hàng — bị chặn.
 *    Thời gian giao chỉ được nói khi shop đã khai câu giao hàng, và mọi con số trong câu ấy phải có trong lời khai.
 *  · Chiết khấu % không có trong dữ kiện bị chặn. Link / email / SĐT không có trong dữ kiện cũng bị chặn.
 *  · Sai ngôn ngữ so với nước của lead bị chặn.
 * Phép đọc thô và nghiêng về phía HẸP: chặn nhầm thì người viết lại, còn lọt một câu bịa thì nó tới tay khách.
 */
import { extractVndAmounts, unverifiedAmounts } from "@/lib/sales-chatbot/claim-guard";
import { foldVi } from "@/lib/sales-chatbot/text";

export type DraftLanguage = "vi" | "en";
export const DRAFT_LANGUAGE_LABEL: Record<DraftLanguage, string> = { vi: "Tiếng Việt", en: "English" };

export const DRAFT_VIOLATION_CODES = ["AMOUNT_UNVERIFIED", "FOREIGN_CURRENCY", "CERTIFICATION_CLAIM", "EXPORT_CLAIM", "STOCK_CLAIM", "DELIVERY_TIME_CLAIM", "DISCOUNT_UNVERIFIED", "CONTACT_INVENTED", "WRONG_LANGUAGE", "EMPTY", "TOO_LONG"] as const;
export type DraftViolationCode = (typeof DRAFT_VIOLATION_CODES)[number];
export type DraftViolation = { code: DraftViolationCode; detail: string };

/** Dữ kiện mà thư ĐƯỢC dựa vào — đúng khối đã đưa cho AI. */
export type DraftGuardFacts = {
  language: DraftLanguage;
  /** Số tiền đã xác thực (đơn giá bậc của bảng giá đang áp · số báo giá thật · số trong lời khai của shop). */
  allowedAmounts: ReadonlySet<number>;
  /** Toàn bộ khối dữ kiện dạng chữ — link / email / SĐT / % chỉ hợp lệ khi có trong đây. */
  factsText: string;
  /** Câu giao hàng shop đã khai (cấu hình Săn khách sỉ); rỗng = chưa khai ⇒ không được nói thời gian giao. */
  deliveryNote: string;
};

const MAX_BODY = 4000;

/** Chứng nhận / tiêu chuẩn — ERP không lưu giấy chứng nhận nào (catalog-readiness P1c: `UNAVAILABLE`). Đã bỏ dấu, chữ thường. */
const CERTIFICATION_RE = /\b(chung nhan|chung chi|dat chuan|tieu chuan|certif\w*|haccp|iso\s?\d{3,5}|iso\b|fda|halal|kosher|organic|huu co|vietgap|globalgap|gmp|brc|ocop|vsattp|ve sinh an toan thuc pham)\b/;
/** Năng lực xuất khẩu — ERP chưa có nguồn (P1c: điều kiện xuất khẩu `UNAVAILABLE`). */
const EXPORT_RE = /\b(xuat khau|export\w*|fob|cif|cfr|incoterms?|giao quoc te|van chuyen quoc te|ship(ping)? (worldwide|internationally|to any country)|international shipping)\b/;
/** Tồn kho / sẵn hàng — tồn đổi từng giờ, thư không được hứa. */
const STOCK_RE = /\b(con hang|san hang|co san hang|hang co san|ton kho|luon co hang|so luong lon san|in stock|ready stock|readily available|available (now|immediately)|unlimited (supply|quantity)|always available)\b/;
/** Câu nói thời gian giao. */
const DELIVERY_RE = /\b(giao (hang )?(trong|ngay|sau|chi)|trong vong \d+\s*(ngay|gio|tieng)|\d+\s*(ngay|gio|tieng)\s*(lam viec\s*)?(la )?(co hang|nhan hang|giao)|deliver(y|ed|s)?\s+(with)?in|ship(ped|s)?\s+within|lead time|\d+\s*(business |working )?days?\s+(delivery|shipping|lead))\b/;
/** Tiền tệ khác VND. */
const FOREIGN_CURRENCY_RE = /(\$|€|£|¥|\b(usd|eur|gbp|jpy|cny|rmb|aud|sgd|dollars?|euros?)\b)/i;
const PERCENT_RE = /\d+(?:[.,]\d+)?\s*%/g;
const LINK_RE = /https?:\/\/\S+|www\.\S+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** SĐT: bắt đầu bằng «+mã nước» hoặc «0», không dính sau một chữ số / dấu tách (để «250.000 230.000» không thành SĐT). Tệp chỉ chạy ở máy chủ. */
const PHONE_RE = /(?<![\d.,])(?:\+\d{2,3}[ .]?|0)\d{2,3}[ .]?\d{3}[ .]?\d{3,4}(?!\d)/g;
/** Chữ cái riêng của tiếng Việt (có dấu). */
const VI_LETTERS_RE = /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/gi;

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Ngôn ngữ thư có khớp không — tỉ lệ chữ cái tiếng Việt có dấu trên mọi chữ cái. */
export function looksLikeLanguage(text: string, lang: DraftLanguage): boolean {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters < 20) return true;
  const vi = (text.match(VI_LETTERS_RE) ?? []).length / letters;
  return lang === "vi" ? vi >= 0.04 : vi < 0.02;
}

/**
 * Ngôn ngữ thư theo NƯỚC ĐÃ BIẾT của lead (thang `leadCountryOf` — lib/wholesale/lead-country.ts; hàm này KHÔNG tự suy nước).
 * Việt Nam / Việt Kiều ⇒ tiếng Việt; nước khác ⇒ tiếng Anh. Chưa biết nước thì người gọi phải TỪ CHỐI soạn, không gọi hàm này.
 */
export function draftLanguageForCountry(country: string, opts: { diaspora?: boolean } = {}): DraftLanguage {
  if (opts.diaspora) return "vi";
  return country === "VN" ? "vi" : "en";
}

/** Phán quyết cho một bản nháp (tiêu đề + thân). Rỗng = qua. HÀM THUẦN. */
export function draftViolations(subject: string, body: string, facts: DraftGuardFacts): DraftViolation[] {
  const out: DraftViolation[] = [];
  const text = `${subject}\n${body}`.normalize("NFC");
  const folded = foldVi(text);
  const factsFolded = foldVi(facts.factsText);
  if (!body.trim()) return [{ code: "EMPTY", detail: "AI trả về thư rỗng." }];
  if (body.length > MAX_BODY) out.push({ code: "TOO_LONG", detail: `Thư dài ${body.length} ký tự (trần ${MAX_BODY}).` });

  const bad = unverifiedAmounts(extractVndAmounts(text), facts.allowedAmounts);
  if (bad.length) out.push({ code: "AMOUNT_UNVERIFIED", detail: `Số tiền không có trong bảng giá / báo giá thật: ${bad.map((n) => `${n.toLocaleString("vi-VN")} ₫`).join(", ")}.` });
  const fx = FOREIGN_CURRENCY_RE.exec(text);
  if (fx) out.push({ code: "FOREIGN_CURRENCY", detail: `Có tiền tệ khác VND («${fx[0]}») — ERP chưa có nguồn tỷ giá.` });

  const cert = CERTIFICATION_RE.exec(folded);
  if (cert && !CERTIFICATION_RE.test(factsFolded)) out.push({ code: "CERTIFICATION_CLAIM", detail: `Nói tới chứng nhận / tiêu chuẩn («${cert[0]}») — ERP không có giấy chứng nhận nào.` });
  const exp = EXPORT_RE.exec(folded);
  if (exp) out.push({ code: "EXPORT_CLAIM", detail: `Khẳng định năng lực xuất khẩu / điều kiện giao quốc tế («${exp[0]}») — ERP chưa có nguồn.` });
  const stock = STOCK_RE.exec(folded);
  if (stock) out.push({ code: "STOCK_CLAIM", detail: `Hứa tồn kho / sẵn hàng («${stock[0]}») — tồn phải kiểm khi chốt đơn.` });
  const deliv = DELIVERY_RE.exec(folded);
  if (deliv) {
    const note = facts.deliveryNote.trim();
    const sentence = folded.slice(Math.max(0, deliv.index - 40), deliv.index + deliv[0].length + 40);
    const nums = sentence.match(/\d+/g) ?? [];
    if (!note) out.push({ code: "DELIVERY_TIME_CLAIM", detail: `Nói thời gian giao («${deliv[0]}») trong khi shop chưa khai câu giao hàng.` });
    else if (nums.some((n) => !digitsOf(note).includes(n))) out.push({ code: "DELIVERY_TIME_CLAIM", detail: `Thời gian giao trong thư khác lời khai của shop («${note}»).` });
  }

  for (const m of text.match(PERCENT_RE) ?? []) {
    if (!facts.factsText.replace(/\s/g, "").includes(m.replace(/\s/g, ""))) {
      out.push({ code: "DISCOUNT_UNVERIFIED", detail: `Con số phần trăm «${m}» không có trong dữ kiện (chiết khấu do người duyệt, không do AI hứa).` });
      break;
    }
  }
  const links = text.match(LINK_RE) ?? [];
  const emails = text.match(EMAIL_RE) ?? [];
  const phones = (text.match(PHONE_RE) ?? []).filter((p) => digitsOf(p).length >= 9);
  const factsDigits = digitsOf(facts.factsText);
  const invented = [...links, ...emails].find((x) => !facts.factsText.toLowerCase().includes(x.replace(/[).,;]+$/, "").toLowerCase())) ?? phones.find((p) => !factsDigits.includes(digitsOf(p)));
  if (invented) out.push({ code: "CONTACT_INVENTED", detail: `Có link / email / số điện thoại không có trong dữ kiện: «${invented}».` });

  if (!looksLikeLanguage(body, facts.language)) out.push({ code: "WRONG_LANGUAGE", detail: `Thư không viết bằng ${DRAFT_LANGUAGE_LABEL[facts.language]} (ngôn ngữ theo nước của lead).` });
  return out;
}

/** Tỷ lệ sửa (0…1) giữa chữ AI và bản cuối người duyệt — khoảng cách theo TỪ / độ dài lớn hơn. HÀM THUẦN. */
export function editRatio(original: string, final: string): number {
  const a = original.trim().split(/\s+/).filter(Boolean);
  const b = final.trim().split(/\s+/).filter(Boolean);
  const n = Math.max(a.length, b.length);
  if (n === 0) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.round((prev[b.length] / n) * 1000) / 1000;
}
