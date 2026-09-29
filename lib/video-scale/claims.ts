import { wrongPrices } from "@/lib/creative/writer";
import { formatVND } from "@/lib/format";
import type { ProductFacts } from "@/lib/video-scale/facts";

/**
 * ═══════════ MỘT CÂU CHỮ ĐƯỢC KHẲNG ĐỊNH GÌ — MỘT BỘ KIỂM CHO KỊCH BẢN LẪN CONTENT ═══════════
 *
 * Mọi câu tiếng Việt máy viết (chữ trên hình, lời đọc, CTA của video; móc câu, thân, CTA, hashtag của content) đi qua
 * ĐÚNG hàm này. Hai bộ kiểm cho hai nơi là hai luật — một ngày chúng lệch nhau và video nói một giá, bài đăng nói giá khác.
 *
 *  · GIÁ: mọi con số trông như giá phải bằng giá ERP; không có giá ⇒ không con số giá nào (`wrongPrices` của vòng mẫu ảnh).
 *  · SIZE: mọi chữ CÓ HÌNH DẠNG SIZE (S, M, L, XL, 2XL, XS, Free…) trong cụm sau "size" phải đang bán. Chữ thường đứng sau
 *    "size" ("size TỪ M đến 2XL", "hết size NHÉ") KHÔNG phải một size — bản cũ đọc chữ liền sau "size" làm tên size và chặn
 *    câu đúng (chủ shop báo 29/09/2026).
 *  · MÀU: tên màu chỉ khi có trong danh sách màu đang bán.
 *  · CHẤT LIỆU: không được nêu, trừ khi tên sản phẩm ghi rõ (ảnh không cho biết thành phần vải).
 *  · KHUYẾN MÃI / MIỄN SHIP / QUÀ: chỉ khi câu chính sách người đã khai có đúng chữ ấy.
 */

export const MATERIAL_WORDS = ["lụa", "satin", "cotton", "linen", "lanh", "đũi", "voan", "chiffon", "len", "dạ", "tweed", "denim", "jean", "kaki", "nhung", "ren", "thun", "tơ", "polyester", "cashmere", "organza", "tafta", "gấm", "xô"] as const;
export const PROMO_WORDS = ["giảm giá", "giảm", "sale", "khuyến mãi", "khuyến mại", "ưu đãi", "freeship", "free ship", "miễn phí", "tặng", "quà", "flash sale", "voucher", "mã giảm"] as const;
export const COLOR_WORDS = ["đen", "trắng", "kem", "be", "nâu", "hồng", "đỏ", "xanh", "vàng", "cam", "tím", "xám", "ghi", "bạc", "rêu", "đô", "mận", "pastel"] as const;

export type ClaimFacts = Pick<ProductFacts, "name" | "priceVnd" | "sizes" | "colors" | "policyLines">;

function norm(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

/** Từ đứng riêng (ranh giới là ký tự không phải chữ/số Unicode). */
export function hasWord(text: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "u").test(norm(text));
}

/** Chữ có HÌNH DẠNG size chữ cái: XS…4XL, S, M, L, Free / Freesize. */
const SIZE_SHAPE = /^(?:x{0,4}s|m|x{0,4}l|[2-6]x[sl]|free|freesize|fs|onesize)$/;

/** Từ nối giữa hai size số ("26 đến 30", "26 và 28"). */
const NUMERIC_JOINERS = new Set(["đến", "tới", "và", "hoặc", "hay"]);

/** Dạng chuẩn để so: XXL ≡ 2XL, XXXS ≡ 3XS, Free ≡ Freesize ≡ FS. Hàm THUẦN. */
export function canonSize(raw: string): string {
  const t = norm(raw).replace(/\s+/g, "");
  if (t === "free" || t === "fs" || t === "onesize") return "freesize";
  const m = /^(x{2,4})([sl])$/.exec(t);
  return m ? `${m[1].length}x${m[2]}` : t;
}

/**
 * Các size một đoạn chữ NHẮC TỚI — hàm THUẦN: quét cụm chữ sau mỗi chữ "size" tới dấu câu gần nhất, lấy những chữ có hình dạng
 * size. Số (vd "size 28") chỉ tính là size khi mã có size bằng số — shop bán size chữ thì "size M cho chị 45–52kg" có con số là
 * cân nặng, không phải size.
 */
export function sizeMentions(text: string, numericSizes: boolean): string[] {
  const out: string[] = [];
  for (const m of norm(text).matchAll(/(?:^|[^\p{L}\p{N}])size\s+([^.,!?;:\n]{0,40})/gu)) {
    let prev: string | null = null;
    let gap = "";
    let last = 0;
    for (const w of m[1].matchAll(/[\p{L}\p{N}]+/gu)) {
      const t = w[0];
      gap = m[1].slice(last, w.index);
      last = (w.index ?? 0) + t.length;
      // Số chỉ là size khi đứng NGAY sau "size" hoặc sau từ nối ("size 26 đến 30", "size 26-28") — "eo 68" là số đo.
      const numeric = numericSizes && /^\d{1,3}$/.test(t) && (prev === null || NUMERIC_JOINERS.has(prev) || /[-/]/.test(gap));
      if ((SIZE_SHAPE.test(t) || numeric) && !out.includes(t)) out.push(t);
      prev = t;
    }
  }
  return out;
}

/** Lỗi khẳng định của MỘT đoạn chữ. Rỗng là đạt. Hàm THUẦN. */
export function claimProblems(field: string, text: string, facts: ClaimFacts): string[] {
  const out: string[] = [];
  const name = norm(facts.name);
  const policy = norm(facts.policyLines.join(" \n "));
  const sizes = new Set(facts.sizes.map(canonSize));
  const colors = norm(facts.colors.join(" | "));
  const bad = wrongPrices(text, facts.priceVnd);
  if (bad.length) out.push(`${field} có con số giá "${bad.map((b) => b.raw).join('", "')}" ${facts.priceVnd === null ? "trong khi giá chưa rõ — bỏ mọi con số giá" : `khác giá ERP ${formatVND(facts.priceVnd)}`}`);
  for (const t of sizeMentions(text, facts.sizes.some((x) => /^\d+$/.test(x.trim())))) {
    if (!sizes.has(canonSize(t))) out.push(`${field} nhắc "size ${t.toUpperCase()}" — size đang bán: ${facts.sizes.join(", ") || "chưa có dữ liệu"}`);
  }
  for (const w of MATERIAL_WORDS) if (hasWord(text, w) && !hasWord(name, w)) out.push(`${field} nêu chất liệu "${w}" — ERP không có dữ liệu chất liệu, không được khẳng định`);
  for (const w of PROMO_WORDS) if (hasWord(text, w) && !policy.includes(w)) out.push(`${field} có "${w}" — chưa có chính sách bán hàng nào khai điều này`);
  for (const w of COLOR_WORDS) if (hasWord(text, w) && !colors.includes(w)) out.push(`${field} nhắc màu "${w}" — màu đang bán: ${facts.colors.join(", ") || "chưa có dữ liệu"}`);
  return out;
}
