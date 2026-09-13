import { desc } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { PeriodKind, TargetRow, TargetScope } from "@/lib/constants/metric-targets";

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
  return rows.map(toRow);
}

export type TargetAdminRow = TargetRow & { id: string; setByEmail: string; updatedAt: Date };

/** Bản đầy đủ cho màn quản trị: ai đặt, đặt lúc nào — để kỳ sau còn biết hỏi ai. */
export async function listTargetsForAdmin(): Promise<TargetAdminRow[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.metricTargets).orderBy(desc(schema.metricTargets.effectiveFrom));
  return rows.map((r) => ({ ...toRow(r), id: r.id, setByEmail: r.setByEmail, updatedAt: r.updatedAt }));
}

/** Một chỗ duy nhất dịch dòng CSDL sang hợp đồng — hai chỗ dịch là hai chỗ quên một cột mới. */
function toRow(r: typeof schema.metricTargets.$inferSelect): TargetRow {
  return {
    metricKey: r.metricKey,
    scope: r.scope as TargetScope,
    scopeRef: r.scopeRef,
    target: r.target,
    targetMax: r.targetMax,
    warningAt: r.warningAt,
    criticalAt: r.criticalAt,
    periodKind: r.periodKind as PeriodKind,
    note: r.note,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    version: r.version,
    ownerDepartment: r.ownerDepartment,
  };
}
