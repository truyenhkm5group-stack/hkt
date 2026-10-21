/**
 * Đọc «người này có phải chủ shop đã khai không» — xem `lib/constants/org-owner.ts`. CHỈ ĐỌC: tệp này và mọi tệp
 * khác trong ứng dụng không được ghi khoá `org.owner` (`tests/org-owner.test.ts`).
 *
 * Nhận `db` là CSDL hoặc giao dịch đang mở: bước duyệt kỳ đọc trong giao dịch (PGlite một kết nối tự khoá nếu đi
 * vòng qua `getDb()`).
 */
import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { DbOrTx } from "@/lib/db-transaction";
import { isDeclaredOwner, ORG_OWNER_KEY, parseOrgOwner } from "@/lib/constants/org-owner";

export async function isOrgOwner(db: DbOrTx, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, ORG_OWNER_KEY)).limit(1);
  const decl = parseOrgOwner(row?.value ?? null);
  if (!decl || decl.userId !== userId) return false;
  const [u] = await db.select({ id: schema.users.id, active: schema.users.active, role: schema.users.role }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return isDeclaredOwner(decl, u ?? null);
}
