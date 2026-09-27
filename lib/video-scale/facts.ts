import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { parsePartialDna, type DesignDna } from "@/lib/constants/creative-loop";
import { describeDnaVi } from "@/lib/creative/design";
import { loadProductBrief } from "@/lib/queries/creative-plan";

/**
 * ═══════════ SỰ THẬT VỀ MỘT MÃ — THỨ DUY NHẤT NGƯỜI VIẾT ĐƯỢC NÓI ═══════════
 *
 * Kịch bản và câu chữ chỉ được khẳng định điều có trong khối này. Nguồn — đều là dữ liệu ERP:
 *  · tên, mã, GIÁ: `loadProductBrief` (cùng hàm của vòng mẫu ảnh — nhiều giá / chưa có giá ⇒ `null` ⇒ không con số giá nào);
 *  · MÀU, SIZE: các mẫu mã còn bán (`product_variants`, không tính mẫu mã đã gỡ);
 *  · kiểu dáng: DNA mô hình đọc từ ảnh (`product_dna`) — BỎ thuộc tính CHẤT LIỆU: ảnh nhìn thấy độ rủ, không nhìn thấy
 *    thành phần vải, nên "chất liệu" từ ảnh là đoán;
 *  · mô tả ảnh gốc (`creative_sources.vision_summary`) — để câu lệnh cảnh tả đúng thứ trong ảnh;
 *  · câu chính sách người đã khai (`policyLines` của cấu hình) — không có dòng nào ⇒ không khuyến mãi / miễn ship nào.
 */
export type ProductFacts = {
  productId: string;
  name: string;
  code: string;
  priceVnd: number | null;
  colors: string[];
  sizes: string[];
  styleSummary: string;
  sourceSummary: string;
  policyLines: string[];
};

export function distinctClean(xs: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const x of xs) {
    const v = x.replace(/\s+/g, " ").trim();
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()];
}

/** DNA không kèm chất liệu. Hàm THUẦN. */
export function styleWithoutMaterial(dna: Partial<DesignDna>): string {
  const rest: Partial<DesignDna> = { ...dna };
  delete rest.material;
  return describeDnaVi(rest);
}

export async function loadProductFacts(db: Db, productId: string, sourceId: string | null, policyLines: readonly string[]): Promise<ProductFacts | null> {
  const brief = await loadProductBrief(db, productId);
  if (!brief) return null;
  const pv = schema.productVariants;
  const [variants, dnaRow, source] = await Promise.all([
    db.select({ color: pv.color, size: pv.size }).from(pv).where(and(eq(pv.productId, productId), eq(pv.isRemoved, false))),
    db.select({ dna: schema.productDna.dna }).from(schema.productDna).where(eq(schema.productDna.productId, productId)).limit(1),
    sourceId
      ? db.select({ summary: schema.creativeSources.visionSummary }).from(schema.creativeSources).where(eq(schema.creativeSources.id, sourceId)).limit(1)
      : Promise.resolve([] as { summary: string }[]),
  ]);
  return {
    productId,
    name: brief.name,
    code: brief.code,
    priceVnd: brief.priceVnd,
    colors: distinctClean(variants.map((v) => v.color)),
    sizes: distinctClean(variants.map((v) => v.size)),
    styleSummary: dnaRow[0] ? styleWithoutMaterial(parsePartialDna(dnaRow[0].dna)) : "",
    sourceSummary: source[0]?.summary ?? "",
    policyLines: policyLines.map((l) => l.trim()).filter(Boolean),
  };
}
