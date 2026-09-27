import path from "node:path";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { getPlatformDb, isPglite, type Db } from "@/db";

const holder = globalThis as unknown as { __erpMigrated?: Promise<void> };

/**
 * Áp dụng migration trong thư mục ./drizzle cho CSDL NHÀ (chạy một lần mỗi tiến trình).
 *
 * Luôn là CSDL nhà — kể cả khi được gọi trong ngữ cảnh một tổ chức khác — vì đây là lượt khởi động
 * của TIẾN TRÌNH, không phải của một người dùng. CSDL của tổ chức khác tự migrate khi được mở lần đầu
 * (`migrateOrganizationDb`, gọi từ `db/index.ts`).
 */
export function ensureMigrated() {
  if (!holder.__erpMigrated) {
    holder.__erpMigrated = (async () => {
      const db = await getPlatformDb();
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

/** Khoá tư vấn cho lượt migrate CSDL tổ chức — hằng số, không trùng khoá nào khác trong kho. */
const ORG_MIGRATE_LOCK = 780_152_001;

/**
 * ═══════ MIGRATE CSDL CỦA MỘT TỔ CHỨC KHÔNG PHẢI NHÀ ═══════
 *
 * Cùng bộ migration với CSDL nhà — một mã nguồn, một lược đồ. Hai việc khác với `ensureMigrated()`:
 *
 *  1. KHOÁ. App và một script vận hành có thể cùng mở CSDL tổ chức mới lần đầu; hai lượt migrate đua
 *     nhau thì lượt thua chết giữa chừng ở một `CREATE TABLE`. `pg_advisory_lock` trên CÙNG một kết
 *     nối với lượt migrate (khoá tư vấn gắn với phiên, nên phải giữ một client riêng từ bể).
 *
 *  2. DỌN BẢN SAO CỦA MẶT PHẲNG ĐIỀU KHIỂN. Migration 0152 chèn dòng "tổ chức nhà" vào bảng
 *     `platform_organizations` của MỌI CSDL nó chạy qua. Ở CSDL tổ chức khác dòng đó là sai sự thật
 *     (CSDL này không phải nhà), nên xoá — mỗi lần mở, idempotent. Không ai đọc các bảng này ở đây
 *     (`getPlatformDb()` luôn là CSDL nhà), nhưng một bảng nói dối thì sớm muộn cũng có người đọc.
 */
export async function migrateOrganizationDb(db: Db, opts: { pool?: Pool }) {
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  if (!opts.pool) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
  } else {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const client = await opts.pool.connect();
    try {
      await client.query("select pg_advisory_lock($1)", [ORG_MIGRATE_LOCK]);
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [ORG_MIGRATE_LOCK]).catch(() => undefined);
      client.release();
    }
  }
  await db.execute(sql`delete from platform_audit_log`);
  await db.execute(sql`delete from platform_organization_modules`);
  await db.execute(sql`delete from platform_flag_overrides`);
  await db.execute(sql`delete from platform_organizations`);
}
