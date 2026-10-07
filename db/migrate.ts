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
  // 0169 · gói (gieo bằng migration), mã mời, lượt đăng ký — cũng là mặt phẳng điều khiển, cũng chỉ thật ở CSDL nhà.
  await db.execute(sql`delete from platform_signup_attempts`);
  await db.execute(sql`delete from platform_signup_invites`);
  await db.execute(sql`delete from platform_plans`);
  // 0172 · cài đặt nền tảng (chế độ đăng ký /start) — chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_settings`);
  // 0176 · sổ dùng AI — mặt phẳng điều khiển, chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_ai_usage`);
  // 0187 · thu phí thuê bao — mặt phẳng điều khiển, chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_billing_payments`);
  await db.execute(sql`delete from platform_invoices`);
  await db.execute(sql`delete from platform_subscriptions`);
  // 0193 · chỉ mục danh tính (email / SĐT / Google / Facebook ⇒ tổ chức) — mặt phẳng điều khiển, chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_identities`);
  // 0199 · sổ kinh tế SaaS (ảnh chụp MRR theo ngày + mốc kích hoạt) — mặt phẳng điều khiển, chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_saas_daily`);
  await db.execute(sql`delete from platform_org_milestones`);
  // 0204 · sổ dùng theo ngày của từng tổ chức — mặt phẳng điều khiển, chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_tenant_usage_daily`);
  // 0207 · page Messenger ⇒ tổ chức — mặt phẳng điều khiển, chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_messenger_pages`);
  // 0214 · mã xác minh SĐT khi đăng ký — mặt phẳng điều khiển, chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_phone_otps`);
  // 0222 · ghi đè giá / tính năng / mức áp theo tổ chức — mặt phẳng điều khiển, chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_org_pricing`);
  // 0224 · SaaS control plane (tài khoản · thuê bao sản phẩm · sổ dùng · sổ chi phí · bảng kê · job cấp phát) — chỉ bản ở CSDL
  // nhà là thật. Bảng có khoá ngoài tới `platform_accounts` xoá TRƯỚC; `platform_organizations` đã xoá ở trên.
  await db.execute(sql`delete from platform_product_subscriptions`);
  await db.execute(sql`delete from platform_billing_statements`);
  await db.execute(sql`delete from platform_usage_events`);
  await db.execute(sql`delete from platform_cost_entries`);
  await db.execute(sql`delete from platform_provisioning_jobs`);
  await db.execute(sql`delete from platform_accounts`);
  // 0228 · bảng giá có phiên bản + ghim phiên bản theo tổ chức — chỉ bản ở CSDL nhà là thật. Bảng có khoá ngoài tới
  // `platform_price_versions` xoá TRƯỚC.
  await db.execute(sql`delete from platform_price_pins`);
  await db.execute(sql`delete from platform_plan_prices`);
  await db.execute(sql`delete from platform_price_versions`);
  // 0235 · Số dư AI (sổ cái chỉ ghi thêm + phiếu nạp + tài khoản) — chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_ai_ledger_entries`);
  await db.execute(sql`delete from platform_payment_intents`);
  await db.execute(sql`delete from platform_ai_accounts`);
}
