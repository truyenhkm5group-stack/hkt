import { desc } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { TargetRow, TargetScope } from "@/lib/constants/metric-targets";

/**
 * Đọc TOÀN BỘ đích một lần rồi giải trong bộ nhớ.
 *
 * Bảng này nhỏ theo bản chất (một dòng cho mỗi chỉ số × tầng × lần đổi) và luật chọn đích cần
 * NHÌN THẤY CẢ BA TẦNG cùng lúc mới quyết được. Lọc sẵn ở SQL theo phòng/chức danh sẽ vứt mất
 * tầng công ty — đúng cái tầng dùng làm mặc định.
 *
 * KHÔNG memo: đích vừa đặt xong mà thẻ điểm còn hiện đích cũ thêm hai phút là cách chắc chắn để
 * người dùng bấm lại lần nữa và tưởng máy hỏng.
 */
export async function listTargets(): Promise<TargetRow[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.metricTargets).orderBy(desc(schema.metricTargets.effectiveFrom));
  return rows.map((r) => ({ metricKey: r.metricKey, scope: r.scope as TargetScope, scopeRef: r.scopeRef, target: r.target, note: r.note, effectiveFrom: r.effectiveFrom }));
}

export type TargetAdminRow = TargetRow & { id: string; setByEmail: string; updatedAt: Date };

/** Bản đầy đủ cho màn quản trị: ai đặt, đặt lúc nào — để kỳ sau còn biết hỏi ai. */
export async function listTargetsForAdmin(): Promise<TargetAdminRow[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.metricTargets).orderBy(desc(schema.metricTargets.effectiveFrom));
  return rows.map((r) => ({
    id: r.id,
    metricKey: r.metricKey,
    scope: r.scope as TargetScope,
    scopeRef: r.scopeRef,
    target: r.target,
    note: r.note,
    effectiveFrom: r.effectiveFrom,
    setByEmail: r.setByEmail,
    updatedAt: r.updatedAt,
  }));
}
