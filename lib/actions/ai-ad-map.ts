"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";

export type ActionResult = { ok: true } | { error: string };

/**
 * NGƯỜI ĐẶT BẢN ĐỒ QUẢNG CÁO → SẢN PHẨM.
 *
 * Máy tự học được từ câu quảng cáo, nhưng chỉ khi câu ấy có chứa tên mẫu. Khi nó không kết luận
 * được — hoặc kết luận SAI — thì người bấm một lần, và từ đó mọi hội thoại đến từ quảng cáo ấy
 * đều nhận ra đúng mẫu mà không phải đoán lại.
 *
 * Dòng do người đặt mang `source = 'HUMAN'` và máy KHÔNG BAO GIỜ ghi đè nó (chặn ở cả
 * `learnAdMapping` lẫn mệnh đề `setWhere` của câu lệnh ghi).
 */
const schemaVao = z.object({
  pageId: z.string().trim().min(1, "Thiếu page"),
  adKey: z.string().trim().min(1, "Thiếu mã quảng cáo / bài viết"),
  keyKind: z.enum(["AD", "POST"]).default("AD"),
  /** Rỗng = GỠ ánh xạ (khách vẫn sẽ được hỏi lại), không phải "trỏ vào sản phẩm rỗng". */
  productId: z.string().trim().optional(),
  variantId: z.string().trim().optional(),
  note: z.string().trim().max(500).optional(),
});

export async function setAdProductMapping(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "ai:view")) return { error: "Không có quyền sửa bản đồ quảng cáo" };
  const parsed = schemaVao.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const data = parsed.data;

  const db = await getDb();
  if (data.productId) {
    const sp = await db.query.products.findFirst({ where: eq(schema.products.id, data.productId), columns: { id: true } });
    if (!sp) return { error: "Không tìm thấy sản phẩm" };
  }

  const dangCo = await db.query.salesAdProductMap.findFirst({
    where: and(eq(schema.salesAdProductMap.pageId, data.pageId), eq(schema.salesAdProductMap.adKey, data.adKey)),
    columns: { id: true },
  });

  const giaTri = {
    pageId: data.pageId,
    adKey: data.adKey,
    keyKind: data.keyKind,
    productId: data.productId || null,
    variantId: data.variantId || null,
    // Người bấm là SỰ THẬT, không phải suy luận — nên độ tin cậy là 1 và nguồn là HUMAN.
    source: "HUMAN" as const,
    confidence: 1,
    evidence: data.note?.trim() || `Do ${user.email} đặt tay`,
    createdByUserId: user.id,
  };

  if (dangCo) {
    await db.update(schema.salesAdProductMap).set({ ...giaTri, updatedAt: new Date() }).where(eq(schema.salesAdProductMap.id, dangCo.id));
  } else {
    await db.insert(schema.salesAdProductMap).values(giaTri);
  }

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: dangCo ? "UPDATE" : "CREATE",
    entity: "sales_ad_product_map",
    entityId: dangCo?.id ?? data.adKey,
    after: { pageId: data.pageId, adKey: data.adKey, productId: data.productId || null, keyKind: data.keyKind },
  });
  revalidatePath("/ai/ad-map");
  revalidatePath("/ai/review");
  return { ok: true };
}
