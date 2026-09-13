import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { NoteCategory } from "@/lib/constants/product-notes";

/**
 * ═══════════ ĐỌC GHI CHÚ VẬN HÀNH ═══════════
 *
 * KHÔNG có bộ đệm và KHÔNG có phép tổng hợp nào ở đây. Ghi chú là thứ người ta vừa viết xong và
 * mong thấy ngay; đệm 60 giây sẽ làm họ bấm lưu lần thứ hai. Và không con số nào được dựng từ
 * bảng này — xem `tests/product-notes.test.ts`.
 */

const n = schema.productNotes;

export type ProductNote = {
  id: string;
  productId: string;
  variantId: string | null;
  variantSku: string | null;
  category: NoteCategory;
  body: string;
  /** `null` = MÁY ghi, khác hẳn "chưa biết ai". */
  actorUserId: string | null;
  actorName: string;
  createdAt: Date;
};

export async function listProductNotes(productId: string, limit = 50): Promise<ProductNote[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: n.id,
      productId: n.productId,
      variantId: n.variantId,
      variantSku: schema.productVariants.sku,
      category: n.category,
      body: n.body,
      actorUserId: n.actorUserId,
      actorName: n.actorName,
      createdAt: n.createdAt,
    })
    .from(n)
    .leftJoin(schema.productVariants, eq(schema.productVariants.id, n.variantId))
    .where(eq(n.productId, productId))
    .orderBy(desc(n.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, category: r.category as NoteCategory }));
}

export type NotePreview = { body: string; category: NoteCategory; actorName: string; createdAt: Date; total: number };

/**
 * Ghi chú MỚI NHẤT của nhiều sản phẩm, cho danh sách — MỘT truy vấn cho cả trang.
 *
 * Cách hiển nhiên là gọi `listProductNotes` trong vòng lặp dòng: đúng kết quả, và là N+1 trên một
 * bảng sẽ chỉ dài thêm. `distinct on` của Postgres lấy dòng đầu của mỗi nhóm trong một lượt quét.
 */
export async function latestNotes(productIds: string[]): Promise<Map<string, NotePreview>> {
  if (!productIds.length) return new Map();
  const db = await getDb();
  const rows = await db
    .selectDistinctOn([n.productId], {
      productId: n.productId,
      body: n.body,
      category: n.category,
      actorName: n.actorName,
      createdAt: n.createdAt,
      total: sql<number>`count(*) over (partition by ${n.productId})`,
    })
    .from(n)
    .where(inArray(n.productId, productIds))
    .orderBy(n.productId, desc(n.createdAt));
  return new Map(rows.map((r) => [r.productId, { body: r.body, category: r.category as NoteCategory, actorName: r.actorName, createdAt: r.createdAt, total: Number(r.total) }]));
}
