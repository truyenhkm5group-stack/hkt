import { and, eq, inArray, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { IdentityKind } from "@/lib/auth/identity-shared";
import { listOrganizations } from "@/lib/platform/organizations";

/**
 * ═══════════ CHỈ MỤC DANH TÍNH TOÀN NỀN TẢNG (`platform_identities`, 0193) — CHỈ MÁY CHỦ ═══════════
 *
 * Trả lời đúng MỘT câu: «danh tính này có tài khoản ở những tổ chức nào?» — để khách đăng nhập ở trang chung mà không
 * phải nhớ mã tổ chức. KHÔNG là nguồn sự thật của tài khoản: mật khẩu, quyền, khoá vẫn đọc ở CSDL tổ chức mỗi lượt, và
 * dòng trỏ tới tổ chức không còn hoạt động bị bỏ qua lúc đọc.
 *
 * Ghi dần: mỗi lượt đăng nhập thành công (`verifyLogin` — màn đăng nhập, đăng ký, nhận lời mời) và mỗi lượt đăng nhập
 * bằng Google / Facebook. Ghi hỏng KHÔNG làm hỏng lượt đăng nhập: chỉ mục là tiện ích, phiên đã đúng rồi.
 */

export type IdentityHit = { orgCode: string; userId: string };

export async function recordIdentity(kind: IdentityKind, value: string, orgCode: string, userId: string, now: Date = new Date()): Promise<void> {
  if (!value) return;
  try {
    const pdb = await getPlatformDb();
    const t = schema.platformIdentities;
    await pdb
      .insert(t)
      .values({ kind, value, orgCode, userId, lastUsedAt: now })
      .onConflictDoUpdate({ target: [t.kind, t.value, t.orgCode], set: { userId, lastUsedAt: now } });
  } catch (error) {
    console.warn(`[identities] không ghi được ${kind} cho ${orgCode}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Tổ chức ĐANG HOẠT ĐỘNG có danh tính này (mới dùng nhất trước). Bảng chưa có (máy chưa migrate) ⇒ rỗng. */
export async function findIdentity(kind: IdentityKind, value: string): Promise<IdentityHit[]> {
  if (!value) return [];
  let rows: { orgCode: string; userId: string }[] = [];
  try {
    const pdb = await getPlatformDb();
    const t = schema.platformIdentities;
    rows = await pdb
      .select({ orgCode: t.orgCode, userId: t.userId })
      .from(t)
      .where(and(eq(t.kind, kind), eq(t.value, value)))
      .orderBy(sql`${t.lastUsedAt} desc nulls last`)
      .limit(20);
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  const active = new Set((await listOrganizations()).filter((o) => o.status === "ACTIVE").map((o) => o.code));
  return rows.filter((r) => active.has(r.orgCode));
}

/** Gỡ mọi danh tính của một tài khoản (tài khoản bị xoá). */
export async function forgetIdentitiesOf(orgCode: string, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const pdb = await getPlatformDb();
  const t = schema.platformIdentities;
  await pdb.delete(t).where(and(eq(t.orgCode, orgCode), inArray(t.userId, [...userIds])));
}
