import { and, asc, count, eq } from "drizzle-orm";
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
