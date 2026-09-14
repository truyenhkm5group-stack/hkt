/**
 * Chuẩn bị CSDL cho phép đo HTTP: tạo dữ liệu mẫu theo quy mô và một tài khoản ADMIN để ký phiên.
 * In ra id tài khoản để truyền vào `scripts/bench-http.ts --user=<id>`.
 *
 *   npx tsx scripts/bench/http-setup.ts --scale=1 --dir=./data/pglite-http
 *
 * Chạy TRƯỚC khi khởi động máy chủ: PGlite chỉ cho một tiến trình mở thư mục dữ liệu.
 */
import "dotenv/config";
import { rmSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const scale = Number(arg("scale", "1"));
const dir = arg("dir", "./data/pglite-http");
const fresh = args.includes("--fresh");

if (fresh) rmSync(dir, { recursive: true, force: true });
process.env.DATABASE_URL = `pglite://${dir}`;

async function main() {
  const { ensureMigrated } = await import("@/db/migrate");
  const { getDb, schema } = await import("@/db");
  const { seedBenchData } = await import("./seed");
  await ensureMigrated();
  const db = await getDb();
  const existing = await db.query.users.findFirst({ columns: { id: true } });
  if (!existing) {
    const bcrypt = await import("bcryptjs");
    await db.insert(schema.users).values({
      id: "bench-admin",
      email: "bench@local",
      name: "Đo hiệu năng",
      passwordHash: await bcrypt.hash("bench-only-not-a-real-account", 10),
      role: "ADMIN",
    });
  }
  const orders = await db.query.orders.findFirst({ columns: { id: true } });
  if (!orders) await seedBenchData(scale);
  const admin = await db.query.users.findFirst({ columns: { id: true } });
  console.log(JSON.stringify({ dir, userId: admin?.id, databaseUrl: process.env.DATABASE_URL }));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
