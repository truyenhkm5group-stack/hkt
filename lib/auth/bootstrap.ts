import { count } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { hashPassword } from "@/lib/auth/password";

/** Tạo tài khoản quản trị đầu tiên từ biến môi trường nếu chưa có người dùng nào. */
export async function ensureAdminUser() {
  const db = await getDb();
  const [{ value }] = await db.select({ value: count() }).from(schema.users);
  if (value > 0) return false;
  const email = (process.env.ADMIN_EMAIL || "admin@shop.local").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "Admin@12345";
  const name = process.env.ADMIN_NAME || "Quản trị viên";
  await db.insert(schema.users).values({ email, name, passwordHash: await hashPassword(password), role: "ADMIN" });
  console.log(`[startup] Đã tạo tài khoản quản trị ${email}`);
  return true;
}
