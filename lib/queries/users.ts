import { and, asc, count, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";

/** Danh sách người dùng (không bao gồm mật khẩu băm) */
export async function listUsers() {
  const db = await getDb();
  const [rows, [admins]] = await Promise.all([
    db.query.users.findMany({
      columns: { id: true, email: true, name: true, role: true, permissions: true, active: true, lastLoginAt: true, createdAt: true, updatedAt: true },
      orderBy: [asc(schema.users.createdAt), asc(schema.users.email)],
    }),
    db
      .select({ count: count() })
      .from(schema.users)
      .where(and(eq(schema.users.role, "ADMIN"), eq(schema.users.active, true))),
  ]);
  return { rows, activeAdmins: Number(admins?.count ?? 0) };
}

export type UserRow = Awaited<ReturnType<typeof listUsers>>["rows"][number];

/** Tài khoản đang bật cho ô chọn người (field custom kiểu `user`). Nhãn = tên, không có thì email. */
export async function userPickOptions(): Promise<{ id: string; label: string }[]> {
  const db = await getDb();
  const u = schema.users;
  const rows = await db.select({ id: u.id, name: u.name, email: u.email }).from(u).where(eq(u.active, true)).orderBy(asc(u.name), asc(u.email)).limit(1000);
  return rows.map((r) => ({ id: r.id, label: r.name || r.email }));
}

/** Tên theo id (kể cả tài khoản đã tắt) — in giá trị field `user` trên danh sách. Id lạ thì vắng mặt. */
export async function userLabelsByIds(ids: readonly string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0))];
  if (!uniq.length) return {};
  const db = await getDb();
  const u = schema.users;
  const rows = await db.select({ id: u.id, name: u.name, email: u.email }).from(u).where(inArray(u.id, uniq));
  return Object.fromEntries(rows.map((r) => [r.id, r.name || r.email]));
}
