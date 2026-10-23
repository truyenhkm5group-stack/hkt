import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { normFromRow, type StoredFabricNorm } from "@/lib/constants/pending-matrix";

/**
 * Định mức vải của các sản phẩm đang hiện trên `/inventory/shortage` (OD-P2-04).
 *
 * Sản phẩm chưa có dòng thì KHÔNG có khoá trong kết quả — màn hình in «—», không in 0.
 *
 * Bảng chưa có (lược đồ cũ hơn 0255 lúc đang triển khai) ⇒ trả rỗng: trang vẫn dựng, chỉ là chưa có
 * định mức nào (`lib/constants/migration-serve-compat.ts`, mục 0255). Bắt ĐÚNG mã `42P01` — câu lỗi
 * của drizzle chứa nguyên văn câu truy vấn, so theo chữ thì mọi lỗi (kể cả mất kết nối) đều khớp.
 */
export async function getFabricNorms(productIds: readonly string[]): Promise<Record<string, StoredFabricNorm>> {
  if (!productIds.length) return {};
  const db = await getDb();
  try {
    const rows = await db.select().from(schema.fabricNorms).where(inArray(schema.fabricNorms.productId, [...productIds]));
    return Object.fromEntries(rows.map((r) => [r.productId, { norm: normFromRow(r), updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null, updatedByName: r.updatedByName }]));
  } catch (e) {
    if (pgCode(e) === "42P01") return {};
    throw e;
  }
}

function pgCode(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}
