/**
 * ═══════════ MỘT BỘ PHÂN GIẢI ĐỐI TƯỢNG (Phase 6 · X5) — CHỈ MÁY CHỦ ═══════════
 *
 * Hợp đồng: docs/platform/phase-6-contracts.md mục 2. `resolveObject(key)` trả `ObjectDef` cho CẢ đối tượng hệ thống
 * (sổ tĩnh `OBJECT_REGISTRY`) LẪN đối tượng tuỳ biến (`meta_objects` của TỔ CHỨC HIỆN HÀNH — `getDb()` chọn CSDL theo
 * ngữ cảnh, nên khoá `x_…` của tổ chức khác không tồn tại ở đây). Mọi dịch vụ Phase 2 (field, giá trị, form, danh
 * sách, trạng thái) và Phase 3 (chủ thể luật) đi qua hàm này khi khoá có thể là đối tượng tuỳ biến. `objectDef()`
 * tĩnh ở lại cho mã chỉ nói về đối tượng hệ thống.
 *
 * KHÔNG ĐỆM trong tiến trình (M13): một câu nhỏ theo khoá chính mỗi lần; tạo / sửa / lưu trữ đối tượng có hiệu lực ở
 * lượt đọc kế tiếp của MỌI tiến trình. Hàm KHÔNG kiểm module / trạng thái — `requireObject` (lib/metadata/common.ts)
 * làm việc đó; màn hình quản trị cần đọc cả đối tượng đã lưu trữ.
 */
import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { objectDef, type AnyObjectDef } from "@/lib/constants/object-registry";
import { customObjectDef } from "@/lib/metadata/custom-object-def";
import { isCustomObjectKey } from "@/lib/metadata/types";

export async function resolveObject(key: string): Promise<AnyObjectDef | null> {
  const sys = objectDef(key);
  if (sys) return sys;
  if (!isCustomObjectKey(key)) return null;
  const db = await getDb();
  const [row] = await db.select().from(schema.metaObjects).where(eq(schema.metaObjects.key, key)).limit(1);
  return row ? customObjectDef(row) : null;
}

/** Mọi đối tượng tuỳ biến của tổ chức hiện hành (mặc định chỉ ACTIVE), xếp theo tên. */
export async function listCustomObjectDefs(opts: { includeArchived?: boolean } = {}): Promise<AnyObjectDef[]> {
  const db = await getDb();
  const t = schema.metaObjects;
  const rows = await db
    .select()
    .from(t)
    .where(opts.includeArchived ? undefined : eq(t.status, "ACTIVE"))
    .orderBy(asc(t.label), asc(t.key));
  return rows.map(customObjectDef);
}
