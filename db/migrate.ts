import path from "node:path";
import { getDb, isPglite } from "@/db";

const holder = globalThis as unknown as { __erpMigrated?: Promise<void> };

/** Áp dụng migration trong thư mục ./drizzle (chạy một lần mỗi tiến trình). */
export function ensureMigrated() {
  if (!holder.__erpMigrated) {
    holder.__erpMigrated = (async () => {
      const db = await getDb();
      const migrationsFolder = path.join(process.cwd(), "drizzle");
      if (isPglite()) {
        const { migrate } = await import("drizzle-orm/pglite/migrator");
        await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
      } else {
        const { migrate } = await import("drizzle-orm/node-postgres/migrator");
        await migrate(db, { migrationsFolder });
      }
    })().catch((error) => {
      holder.__erpMigrated = undefined;
      throw error;
    });
  }
  return holder.__erpMigrated;
}
