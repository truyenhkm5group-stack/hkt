/**
 * HỌC BẢN ĐỒ QUẢNG CÁO → SẢN PHẨM, và tra lại nó.
 *
 * Một mã quảng cáo trỏ tới một mẫu hàng suốt đời chiến dịch. Đoán lại ở mỗi hội thoại vừa tốn,
 * vừa có thể ra kết quả khác nhau giữa hai lượt — mà "cùng một câu hỏi, hai câu trả lời" là thứ
 * làm người bán mất lòng tin vào máy nhanh nhất.
 *
 * LUẬT KHÔNG ĐƯỢC PHÁ: máy KHÔNG BAO GIỜ ghi đè một dòng do NGƯỜI đặt. Người sửa bản đồ là để
 * chữa cái máy đoán sai; máy đoán lại rồi ghi đè thì việc sửa ấy biến mất trong im lặng.
 */
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { ProductResolution } from "@/lib/ai-workforce/agents/sales/resolve-product";

export type LearnInput = {
  pageId: string;
  adId: string;
  postUrl: string;
  adDescription: string;
  resolution: ProductResolution;
};

/**
 * Ghi lại bản đồ khi vừa kết luận được sản phẩm TỪ CÂU QUẢNG CÁO.
 * Chỉ học từ tầng `AD_DESCRIPTION`: các tầng khác (khớp chữ khách, lượt trước) nói về HỘI THOẠI
 * này, không nói gì về việc quảng cáo kia bán mẫu nào — học từ chúng là gán nhầm cả chiến dịch.
 */
export async function learnAdMapping(input: LearnInput, db: Db): Promise<{ learned: boolean; reason: string }> {
  const khoa = input.adId || input.postUrl;
  if (!khoa) return { learned: false, reason: "Tin không kèm quảng cáo / bài viết" };
  if (input.resolution.source !== "AD_DESCRIPTION" || !input.resolution.productId) {
    return { learned: false, reason: "Chỉ học từ tầng khớp câu quảng cáo" };
  }

  const [dangCo] = await db
    .select({ id: schema.salesAdProductMap.id, source: schema.salesAdProductMap.source })
    .from(schema.salesAdProductMap)
    .where(and(eq(schema.salesAdProductMap.pageId, input.pageId), eq(schema.salesAdProductMap.adKey, khoa)))
    .limit(1);
  if (dangCo?.source === "HUMAN") return { learned: false, reason: "Đã có dòng do người đặt — máy không ghi đè" };

  await db
    .insert(schema.salesAdProductMap)
    .values({
      pageId: input.pageId,
      adKey: khoa,
      keyKind: input.adId ? "AD" : "POST",
      productId: input.resolution.productId,
      variantId: input.resolution.variantId,
      source: "AD_DESCRIPTION",
      confidence: input.resolution.confidence,
      evidence: input.resolution.evidence,
      adDescription: input.adDescription.slice(0, 1000),
    })
    .onConflictDoUpdate({
      target: [schema.salesAdProductMap.pageId, schema.salesAdProductMap.adKey],
      set: {
        productId: input.resolution.productId,
        variantId: input.resolution.variantId,
        confidence: input.resolution.confidence,
        evidence: input.resolution.evidence,
        adDescription: input.adDescription.slice(0, 1000),
        updatedAt: new Date(),
      },
      // Chốt chặn thứ hai, ở TẦNG CSDL: dù nhánh kiểm tra bên trên có bị bỏ qua, câu lệnh này
      // vẫn không chạm được vào dòng do người đặt.
      setWhere: eq(schema.salesAdProductMap.source, "AD_DESCRIPTION"),
    });
  return { learned: true, reason: `Đã ghi ${khoa} → ${input.resolution.productCode || input.resolution.productName}` };
}
