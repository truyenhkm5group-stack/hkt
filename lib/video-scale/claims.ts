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
 *  · SIZE: "size X" chỉ khi X đang bán.
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

/** Lỗi khẳng định của MỘT đoạn chữ. Rỗng là đạt. Hàm THUẦN. */
export function claimProblems(field: string, text: string, facts: ClaimFacts): string[] {
  const out: string[] = [];
  const name = norm(facts.name);
  const policy = norm(facts.policyLines.join(" \n "));
  const sizes = new Set(facts.sizes.map((x) => norm(x).replace(/\s+/g, "")));
  const colors = norm(facts.colors.join(" | "));
  const bad = wrongPrices(text, facts.priceVnd);
  if (bad.length) out.push(`${field} có con số giá "${bad.map((b) => b.raw).join('", "')}" ${facts.priceVnd === null ? "trong khi giá chưa rõ — bỏ mọi con số giá" : `khác giá ERP ${formatVND(facts.priceVnd)}`}`);
  for (const m of norm(text).matchAll(/(?:^|[^\p{L}\p{N}])size\s+([\p{L}\p{N}]{1,4})(?=[^\p{L}\p{N}]|$)/gu)) {
    if (!sizes.has(m[1])) out.push(`${field} nhắc "size ${m[1].toUpperCase()}" — size đang bán: ${facts.sizes.join(", ") || "chưa có dữ liệu"}`);
  }
  for (const w of MATERIAL_WORDS) if (hasWord(text, w) && !hasWord(name, w)) out.push(`${field} nêu chất liệu "${w}" — ERP không có dữ liệu chất liệu, không được khẳng định`);
  for (const w of PROMO_WORDS) if (hasWord(text, w) && !policy.includes(w)) out.push(`${field} có "${w}" — chưa có chính sách bán hàng nào khai điều này`);
  for (const w of COLOR_WORDS) if (hasWord(text, w) && !colors.includes(w)) out.push(`${field} nhắc màu "${w}" — màu đang bán: ${facts.colors.join(", ") || "chưa có dữ liệu"}`);
  return out;
}
