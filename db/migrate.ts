import path from "node:path";
import { sql } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";
import { getPlatformDb, isPglite, type Db } from "@/db";
import { isMigrationTimeoutError, migrationErrorText, missingMigrationTags, orgMigrationDegradeDecision } from "@/lib/constants/migration-serve-compat";

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

/**
 * ═══════ KHOÁ MIGRATE THEO TỪNG TỔ CHỨC, CÓ TRẦN CHỜ ═══════
 *
 * Trước 12/10/2026 là MỘT khoá tư vấn `pg_advisory_lock(780152001)` cho MỌI tổ chức, chờ VÔ HẠN. Sự cố đo được sau deploy #792
 * (migration 0245): CSDL `qa` chạy câu dẫn xuất tới trần 600 s rồi hỏng, mỗi lần mở lại thử lại — và vì mọi tổ chức lấy CÙNG một
 * khoá ở lần mở đầu sau khởi động (kể cả khi không còn migration nào), HSLC có thể đứng chờ tới 10 phút sau một lượt của `qa`.
 *
 * Nay khoá là CẶP `(ORG_MIGRATE_LOCK_CLASS, băm tên CSDL)` qua `pg_advisory_lock(int, int)`:
 *  · hai tổ chức KHÁC nhau ⇒ hai khoá khác nhau ⇒ không chờ nhau;
 *  · hai tiến trình cùng migrate MỘT tổ chức ⇒ cùng khoá ⇒ vẫn tuần tự (ý nghĩa cũ: lượt thua không chết giữa một `CREATE TABLE`).
 * Khoá hai số nằm ở không gian khác khoá một số (`objsubid` 2 so với 1) nên không va các `pg_advisory_xact_lock(hashtext(…))` khác.
 * Lấy bằng `pg_try_advisory_lock` lặp tới trần `ORG_MIGRATE_LOCK_WAIT_MS` — quá trần ⇒ ném `OrgMigrateError("LOCK_BUSY")`, không treo.
 */
export const ORG_MIGRATE_LOCK_CLASS = 780_152_001;

/** Băm FNV-1a 32 bit của tên CSDL, ra số nguyên CÓ DẤU (vừa kiểu `int` của Postgres). HÀM THUẦN, tất định. */
export function orgMigrateLockKey(databaseName: string): [number, number] {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(databaseName, "utf8")) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return [ORG_MIGRATE_LOCK_CLASS, h | 0];
}

function envMs(name: string, fallback: number): number {
  const n = Number((process.env[name] || "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Trần chờ khoá migrate của MỘT tổ chức (mặc định 120 giây; ghi đè `ORG_MIGRATE_LOCK_WAIT_MS`). */
export function orgMigrateLockWaitMs(): number {
  return envMs("ORG_MIGRATE_LOCK_WAIT_MS", 120_000);
}

/**
 * Giai đoạn hỏng của lượt migrate một tổ chức — quyết định LÙI bao lâu (`orgMigrateRetryAfterMs`):
 *  · CONNECT — chưa xin được kết nối (CSDL đang khởi động lại…): không lùi, như cũ;
 *  · LOCK_BUSY — tiến trình khác đang migrate ĐÚNG tổ chức này quá trần chờ: lùi ngắn;
 *  · (lỗi không gắn giai đoạn) — chính migration / bước dọn hỏng: lùi dài, vì chạy lại ngay là chạy lại đúng câu vừa hỏng.
 */
export type OrgMigratePhase = "CONNECT" | "LOCK_BUSY";

export class OrgMigrateError extends Error {
  readonly phase: OrgMigratePhase;
  constructor(phase: OrgMigratePhase, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OrgMigrateError";
    this.phase = phase;
  }
}

/**
 * Bao lâu KHÔNG thử migrate lại một tổ chức sau một lượt hỏng, trong cùng tiến trình. HÀM THUẦN theo lỗi + môi trường.
 * Mặc định: CONNECT 0 · LOCK_BUSY 60 giây (`ORG_MIGRATE_BUSY_RETRY_MS`) · còn lại 30 phút (`ORG_MIGRATE_BACKOFF_MS`).
 */
export function orgMigrateRetryAfterMs(error: unknown): number {
  if (error instanceof OrgMigrateError && error.phase === "CONNECT") return 0;
  if (error instanceof OrgMigrateError && error.phase === "LOCK_BUSY") return envMs("ORG_MIGRATE_BUSY_RETRY_MS", 60_000);
  return envMs("ORG_MIGRATE_BACKOFF_MS", 30 * 60_000);
}

/**
 * Lặp `tryLock` tới khi được hoặc quá `waitMs`. Tiêm `sleep` / `now` để bài kiểm chạy không cần đồng hồ thật. Trả `true` = đã cầm khoá.
 * Luôn thử ÍT NHẤT một lần (trần 0 vẫn hỏi một lần).
 */
export async function acquireBoundedLock(
  tryLock: () => Promise<boolean>,
  opts: { waitMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = Math.max(1, opts.pollMs ?? 500);
  const deadline = now() + Math.max(0, opts.waitMs);
  for (;;) {
    if (await tryLock()) return true;
    const left = deadline - now();
    if (left <= 0) return false;
    await sleep(Math.min(pollMs, left));
  }
}

/**
 * ═══════ PHỤC VỤ BẰNG LƯỢC ĐỒ CŨ KHI MIGRATE HẾT GIỜ — `DEGRADED_MIGRATION` (chủ shop 12/10/2026, «Serve with old schema») ═══════
 *
 * Lượt migrate một tổ chức hỏng vì HẾT GIỜ (`isMigrationTimeoutError`) VÀ mọi migration còn thiếu đều nằm trong sổ tương thích
 * (lib/constants/migration-serve-compat.ts) ⇒ workspace VẪN được phục vụ bằng lược đồ hiện có, thử lại theo nhịp
 * `orgMigrateDegradedRetryMs()` (mặc định 6 giờ) + mỗi lần tiến trình khởi động. Mọi trường hợp khác ⇒ `serve: false`, bên gọi ném như
 * cũ. Tắt hẳn: `ORG_MIGRATE_SERVE_DEGRADED=0`.
 *
 * Vì sao 6 giờ chứ không 30 phút: mỗi lượt thử 0245 giữ ACCESS EXCLUSIVE trên sales_chat_conversations tới trần 600 giây — thử 30 phút
 * một lần là workspace đứng 1/3 thời gian.
 */
export function orgMigrateServeDegradedEnabled(): boolean {
  return (process.env.ORG_MIGRATE_SERVE_DEGRADED || "").trim() !== "0";
}

export function orgMigrateDegradedRetryMs(): number {
  return envMs("ORG_MIGRATE_DEGRADED_RETRY_MS", 6 * 3_600_000);
}

export type OrgDegradeCheck = { serve: true; missing: string[]; reason: string } | { serve: false; why: string };

export async function orgMigrationDegradeCheck(db: Db, error: unknown): Promise<OrgDegradeCheck> {
  if (!orgMigrateServeDegradedEnabled()) return { serve: false, why: "ORG_MIGRATE_SERVE_DEGRADED=0" };
  if (!isMigrationTimeoutError(error)) return { serve: false, why: "lỗi không phải hết giờ" };
  try {
    const { readFileSync } = await import("node:fs");
    const journal = (JSON.parse(readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] }).entries;
    const res = await db.execute(sql`select created_at from "drizzle"."__drizzle_migrations"`);
    const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as { created_at: unknown }[];
    const d = orgMigrationDegradeDecision(missingMigrationTags(journal, rows.map((r) => Number(r.created_at))));
    if (!d.serve) return { serve: false, why: d.why };
    return { serve: true, missing: d.missing, reason: migrationErrorText(error) };
  } catch (e) {
    return { serve: false, why: `không đọc được sổ migration: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Phần tối thiểu của một kết nối mà khoá cần — `PoolClient` thoả; bài kiểm tiêm bản giả. */
export type OrgLockClient = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };

/**
 * Cầm khoá migrate CỦA CSDL mà `client` đang nối (trần chờ `orgMigrateLockWaitMs()` hoặc `opts.waitMs`), chạy `fn(pid)`, rồi nhả khoá
 * — kể cả khi `fn` hỏng. Không cầm được trong trần ⇒ `OrgMigrateError("LOCK_BUSY")`, `fn` KHÔNG chạy. `pid` = mã tiến trình máy chủ của
 * chính kết nối này (để huỷ được câu đang chạy).
 */
export async function withOrgMigrateLock<T>(
  client: OrgLockClient,
  fn: (pid: number) => Promise<T>,
  opts: { waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<T> {
  const who = (await client.query("select current_database() as db, pg_backend_pid() as pid")).rows[0] as { db?: unknown; pid?: unknown } | undefined;
  const dbName = String(who?.db ?? "");
  const key = orgMigrateLockKey(dbName);
  const waitMs = opts.waitMs ?? orgMigrateLockWaitMs();
  const locked = await acquireBoundedLock(
    async () => ((await client.query("select pg_try_advisory_lock($1, $2) as ok", key)).rows[0] as { ok?: unknown } | undefined)?.ok === true,
    { waitMs, pollMs: opts.pollMs, sleep: opts.sleep, now: opts.now },
  );
  if (!locked) throw new OrgMigrateError("LOCK_BUSY", `Tiến trình khác đang migrate CSDL «${dbName || "?"}» — chờ khoá quá ${Math.round(waitMs / 1000)} giây.`);
  try {
    return await fn(Number(who?.pid));
  } finally {
    await client.query("select pg_advisory_unlock($1, $2)", key).catch(() => undefined);
  }
}

/**
 * ═══════ MIGRATE CSDL CỦA MỘT TỔ CHỨC KHÔNG PHẢI NHÀ ═══════
 *
 * Cùng bộ migration với CSDL nhà — một mã nguồn, một lược đồ. Hai việc khác với `ensureMigrated()`:
 *
 *  1. KHOÁ. App và một script vận hành có thể cùng mở CSDL tổ chức mới lần đầu; hai lượt migrate đua
 *     nhau thì lượt thua chết giữa chừng ở một `CREATE TABLE`. Khoá tư vấn THEO TỔ CHỨC (xem trên) trên CÙNG một kết
 *     nối với lượt migrate (khoá tư vấn gắn với phiên, nên phải giữ một client riêng từ bể), chờ có trần.
 *     `onMigrating(pid)` báo mã tiến trình máy chủ của kết nối đang migrate (sau khi cầm khoá) — để bên gọi HUỶ được câu
 *     đang chạy (`cancelOrganizationMigration`, bước kiểm của deploy quá trần thời gian).
 *
 *  2. DỌN BẢN SAO CỦA MẶT PHẲNG ĐIỀU KHIỂN. Migration 0152 chèn dòng "tổ chức nhà" vào bảng
 *     `platform_organizations` của MỌI CSDL nó chạy qua. Ở CSDL tổ chức khác dòng đó là sai sự thật
 *     (CSDL này không phải nhà), nên xoá — mỗi lần mở, idempotent. Không ai đọc các bảng này ở đây
 *     (`getPlatformDb()` luôn là CSDL nhà), nhưng một bảng nói dối thì sớm muộn cũng có người đọc.
 */
export async function migrateOrganizationDb(db: Db, opts: { pool?: Pool; onMigrating?: (pid: number) => void }) {
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  if (!opts.pool) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
  } else {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    let client: PoolClient;
    try {
      client = await opts.pool.connect();
    } catch (error) {
      throw new OrgMigrateError("CONNECT", error instanceof Error ? error.message : String(error), error);
    }
    try {
      await withOrgMigrateLock(client, async (pid) => {
        opts.onMigrating?.(pid);
        await migrate(drizzle(client), { migrationsFolder });
      });
    } finally {
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
  // 0237 · tín hiệu vận hành (gương sức khoẻ tổ chức + lỗi đăng nhập có lý do) — chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_org_health`);
  await db.execute(sql`delete from platform_auth_failures`);
  // 0240 · ảnh giá trị theo tổ chức + sức khoẻ theo ngày (Trung tâm giá trị SaaS) — chỉ bản ở CSDL nhà là thật.
  await db.execute(sql`delete from platform_tenant_value_snapshots`);
  await db.execute(sql`delete from platform_tenant_health_daily`);
}
