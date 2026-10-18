import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";
import { getPlatformDb, isPglite, type Db } from "@/db";
import { isMigrationTimeoutError, migrationErrorText, missingMigrationTags, orgMigrationDegradeDecision } from "@/lib/constants/migration-serve-compat";
import {
  decideAfterAcquire,
  decideWhileBusy,
  describeOrgMigrateStatus,
  holderLabel,
  ORG_MIGRATE_HOLDER_MARGIN_MS,
  ORG_MIGRATE_ROLES,
  ORG_MIGRATE_STATES,
  ORG_MIGRATE_WAIT_POLL_MS,
  orgMigrateRoleFrom,
  orgMigrateRunTimeoutMs,
  type OrgMigrateHolder,
  type OrgMigrateRole,
  type OrgMigrateState,
  type OrgMigrateStatus,
} from "@/lib/constants/org-migrate-coordination";
import { rowsOf } from "@/lib/sql-rows";

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
 * ═══════ KHOÁ MIGRATE THEO TỪNG TỔ CHỨC ═══════
 *
 * Trước 12/10/2026 là MỘT khoá tư vấn `pg_advisory_lock(780152001)` cho MỌI tổ chức, chờ VÔ HẠN. Sự cố đo được sau deploy #792
 * (migration 0245): CSDL `qa` chạy câu dẫn xuất tới trần 600 s rồi hỏng, mỗi lần mở lại thử lại — và vì mọi tổ chức lấy CÙNG một
 * khoá ở lần mở đầu sau khởi động (kể cả khi không còn migration nào), HSLC có thể đứng chờ tới 10 phút sau một lượt của `qa`.
 *
 * Nay khoá là CẶP `(ORG_MIGRATE_LOCK_CLASS, băm tên CSDL)` qua `pg_try_advisory_lock(int, int)`:
 *  · hai tổ chức KHÁC nhau ⇒ hai khoá khác nhau ⇒ không chờ nhau;
 *  · hai tiến trình cùng migrate MỘT tổ chức ⇒ cùng khoá ⇒ chỉ MỘT người điều phối (`coordinateOrgMigration`, dưới đây).
 * Khoá hai số nằm ở không gian khác khoá một số (`objsubid` 2 so với 1) nên không va các `pg_advisory_xact_lock(hashtext(…))` khác.
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

/**
 * Trần chờ của ỨNG DỤNG khi một tiến trình khác đang migrate tổ chức (mặc định 120 giây; ghi đè `ORG_MIGRATE_LOCK_WAIT_MS`). Chỉ áp cho
 * vai trò APP — request không đứng chờ cả lượt migrate; quá trần thì phục vụ tạm / lùi ngắn, KHÔNG chạy lượt thứ hai. Bước kiểm của deploy
 * và script vận hành chờ tới HẠN TỰ KHAI của người điều phối (lib/constants/org-migrate-coordination.ts).
 */
export function orgMigrateLockWaitMs(): number {
  return envMs("ORG_MIGRATE_LOCK_WAIT_MS", 120_000);
}

/**
 * Giai đoạn hỏng của lượt migrate một tổ chức — quyết định LÙI bao lâu (`orgMigrateRetryAfterMs`):
 *  · CONNECT — chưa xin được kết nối (CSDL đang khởi động lại…): không lùi, như cũ;
 *  · HOLDER_RUNNING — người điều phối khác còn đang chạy hợp lệ (trong hạn tự khai), mình hết trần chờ: lùi ngắn rồi đọc lại;
 *  · LOCK_BUSY — người khác giữ khoá QUÁ hạn tự khai, hoặc không rõ ai giữ (tiến trình không ghi được trạng thái): lùi ngắn;
 *  · HOLDER_FAILED — lượt của người điều phối khác vừa hỏng; mình KHÔNG chạy lại ngay đúng câu đó: lùi dài như lỗi của chính mình;
 *  · RUN_TIMEOUT — lượt của chính mình quá trần `orgMigrateRunTimeoutMs()` và đã bị huỷ: lùi dài;
 *  · ABORTED — bên gọi thôi chờ (bước kiểm deploy quá trần tổ chức gọi `cancelOrganizationMigration`): không nhận / không tiếp quản / không
 *    chạy gì nữa; lùi ngắn như khoá bận;
 *  · (lỗi không gắn giai đoạn) — chính migration / bước dọn hỏng: lùi dài, vì chạy lại ngay là chạy lại đúng câu vừa hỏng.
 */
export type OrgMigratePhase = "CONNECT" | "LOCK_BUSY" | "HOLDER_RUNNING" | "HOLDER_FAILED" | "RUN_TIMEOUT" | "ABORTED";

export class OrgMigrateError extends Error {
  readonly phase: OrgMigratePhase;
  /** Lỗi thuộc loại HẾT GIỜ (đọc bởi `isMigrationTimeoutError` — điều kiện 1 của phục vụ bằng lược đồ cũ). */
  readonly timedOut: boolean;
  /** Trạng thái của người điều phối KHÁC mà lỗi này nói tới (HOLDER_* / LOCK_BUSY) — để bên gọi in đúng người chạy. */
  readonly holderStatus: OrgMigrateStatus | null;
  /** Hạn thử lại do CHÍNH lỗi này quyết (lùi liên tiến trình: tới đúng hạn của lượt hỏng kia, đo trên đồng hồ CSDL) — thắng mọi mặc định. */
  readonly retryAfterMs: number | null;
  constructor(phase: OrgMigratePhase, message: string, cause?: unknown, extra: { timedOut?: boolean; holderStatus?: OrgMigrateStatus | null; retryAfterMs?: number } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OrgMigrateError";
    this.phase = phase;
    this.timedOut = extra.timedOut ?? (phase === "LOCK_BUSY" || phase === "HOLDER_RUNNING" || phase === "RUN_TIMEOUT" || phase === "ABORTED");
    this.holderStatus = extra.holderStatus ?? null;
    this.retryAfterMs = extra.retryAfterMs ?? null;
  }
}

const isBusyPhase = (error: unknown) => error instanceof OrgMigrateError && (error.phase === "LOCK_BUSY" || error.phase === "HOLDER_RUNNING" || error.phase === "ABORTED");

/**
 * Bao lâu KHÔNG thử migrate lại một tổ chức sau một lượt hỏng, trong cùng tiến trình. HÀM THUẦN theo lỗi + môi trường.
 * Mặc định: CONNECT 0 · LOCK_BUSY / HOLDER_RUNNING 60 giây (`ORG_MIGRATE_BUSY_RETRY_MS`) · còn lại 30 phút (`ORG_MIGRATE_BACKOFF_MS`).
 */
export function orgMigrateRetryAfterMs(error: unknown): number {
  if (error instanceof OrgMigrateError && error.phase === "CONNECT") return 0;
  if (error instanceof OrgMigrateError && error.retryAfterMs !== null) return error.retryAfterMs;
  if (isBusyPhase(error)) return envMs("ORG_MIGRATE_BUSY_RETRY_MS", 60_000);
  return envMs("ORG_MIGRATE_BACKOFF_MS", 30 * 60_000);
}

/**
 * Bao lâu tới lượt thử lại kế tiếp của một tổ chức đang `DEGRADED_MIGRATION`. Lý do là «người khác còn đang migrate / giữ khoá» ⇒ đọc lại
 * sau `orgMigrateRetryAfterMs` (ngắn) — trước đây nó chờ trọn 6 giờ dù lượt kia xong sau 30 giây, và cờ degraded nói dối suốt 6 giờ ấy.
 * Lượt migrate THẬT hỏng vì hết giờ (của mình hoặc của người điều phối khác) ⇒ `orgMigrateDegradedRetryMs()` như cũ.
 */
export function orgMigrateDegradedRetryAfterMs(error: unknown): number {
  // Lùi liên tiến trình (BACKOFF) mang hạn của chính nó: tiến trình khởi động lại 5 phút sau lượt hỏng của tiến trình kia thử lại khi hết
  // cửa sổ 30 phút ĐÓ — không phải đứng DEGRADED 6 giờ như thể chính nó vừa hỏng.
  if (error instanceof OrgMigrateError && error.retryAfterMs !== null) return error.retryAfterMs;
  return isBusyPhase(error) ? orgMigrateRetryAfterMs(error) : orgMigrateDegradedRetryMs();
}

/**
 * ═══════ PHỤC VỤ BẰNG LƯỢC ĐỒ CŨ KHI MIGRATE HẾT GIỜ — `DEGRADED_MIGRATION` (chủ shop 12/10/2026, «Serve with old schema») ═══════
 *
 * Lượt migrate một tổ chức hỏng vì HẾT GIỜ (`isMigrationTimeoutError`) VÀ mọi migration còn thiếu đều nằm trong sổ tương thích
 * (lib/constants/migration-serve-compat.ts) ⇒ workspace VẪN được phục vụ bằng lược đồ hiện có, thử lại theo nhịp
 * `orgMigrateDegradedRetryAfterMs()` (mặc định 6 giờ; ngắn khi chỉ là người khác đang migrate) + mỗi lần tiến trình khởi động. Mọi trường
 * hợp khác ⇒ `serve: false`, bên gọi ném như cũ. Tắt hẳn: `ORG_MIGRATE_SERVE_DEGRADED=0`.
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

type JournalEntry = { tag: string; when: number };

function readJournal(): JournalEntry[] {
  return (JSON.parse(readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] }).entries;
}

/** Mốc `created_at` đã áp trong sổ drizzle của CSDL `db`. Sổ chưa có (CSDL trống) ⇒ mảng rỗng. */
async function appliedWhen(run: (text: string) => Promise<unknown[]>): Promise<number[]> {
  try {
    return (await run(`select created_at from "drizzle"."__drizzle_migrations"`)).map((r) => Number((r as { created_at: unknown }).created_at));
  } catch (error) {
    // Sổ chưa có (CSDL trống — 42P01 / 3F000); drizzle bọc lỗi trình điều khiển trong `cause` nên đọc cả chuỗi.
    for (let e: unknown = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
      const c = (e as { code?: unknown }).code;
      if (c === "42P01" || c === "3F000") return [];
    }
    throw error;
  }
}

export type OrgDegradeCheck = { serve: true; missing: string[]; reason: string } | { serve: false; why: string };

export async function orgMigrationDegradeCheck(db: Db, error: unknown): Promise<OrgDegradeCheck> {
  if (!orgMigrateServeDegradedEnabled()) return { serve: false, why: "ORG_MIGRATE_SERVE_DEGRADED=0" };
  if (!isMigrationTimeoutError(error)) return { serve: false, why: "lỗi không phải hết giờ" };
  try {
    const applied = await appliedWhen(async (text) => rowsOf(await db.execute(sql.raw(text))));
    const d = orgMigrationDegradeDecision(missingMigrationTags(readJournal(), applied));
    if (!d.serve) return { serve: false, why: d.why };
    return { serve: true, missing: d.missing, reason: migrationErrorText(error) };
  } catch (e) {
    return { serve: false, why: `không đọc được sổ migration: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Phần tối thiểu của một kết nối mà khoá cần — `PoolClient` thoả; bài kiểm tiêm bản giả. */
export type OrgLockClient = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };

/** Phiên cầm khoá migrate của MỘT CSDL tổ chức — cùng kết nối chạy migration (khoá tư vấn gắn với phiên). */
export type OrgLockSession = { dbName: string; backendPid: number; tryLock(): Promise<boolean>; unlock(): Promise<void> };

/**
 * Phiên khoá trên một kết nối Postgres (thật hoặc giả trong bài kiểm). `unlock` NÉM khi không nhả được (vd lệnh tự huỷ vì quá trần lượt rơi
 * đúng vào câu nhả khoá — thử lại một lần trước): bên gọi phải HUỶ kết nối (`client.release(err)`) thay vì trả nó về bể còn cầm khoá.
 */
export async function pgLockSession(client: OrgLockClient): Promise<OrgLockSession> {
  const who = (await client.query("select current_database() as db, pg_backend_pid() as pid")).rows[0] as { db?: unknown; pid?: unknown } | undefined;
  const dbName = String(who?.db ?? "");
  const key = orgMigrateLockKey(dbName);
  return {
    dbName,
    backendPid: Number(who?.pid),
    tryLock: async () => ((await client.query("select pg_try_advisory_lock($1, $2) as ok", key)).rows[0] as { ok?: unknown } | undefined)?.ok === true,
    unlock: async () => {
      try {
        await client.query("select pg_advisory_unlock($1, $2)", key);
      } catch {
        await client.query("select pg_advisory_unlock($1, $2)", key);
      }
    },
  };
}

/**
 * ═══════ SỔ TRẠNG THÁI LƯỢT MIGRATE — `platform_org_migration_status` (CSDL NHÀ, mỗi tổ chức một dòng) ═══════
 *
 * Người điều phối GHI; mọi tiến trình khác ĐỌC. Ở CSDL nhà vì đó là chỗ mọi tiến trình (ứng dụng, bước kiểm, script) cùng đọc được trước
 * khi CSDL tổ chức kịp có bảng mới, và là chỗ người vận hành đọc trạng thái MỌI tổ chức trong một câu. Mọi mốc do `now()` của CSDL nhà
 * đặt — hai tiến trình không bao giờ so đồng hồ của nhau.
 */
export type OrgMigrateStatusStore = {
  read(orgCode: string): Promise<{ status: OrgMigrateStatus | null; dbNowMs: number }>;
  begin(row: { orgCode: string; runId: string; holder: OrgMigrateHolder; runTimeoutMs: number; targetTag: string | null; missing: readonly string[]; takeoverOf: string | null }): Promise<void>;
  finish(orgCode: string, runId: string, end: { state: Exclude<OrgMigrateState, "RUNNING">; timedOut: boolean; reason: string | null }): Promise<void>;
};

const STATUS_COLUMNS = sql.raw(`s.run_id, s.state, s.holder_role, s.holder_pid, s.holder_host, s.holder_token,
  (extract(epoch from s.started_at) * 1000)::float8 as started_ms, (extract(epoch from s.deadline_at) * 1000)::float8 as deadline_ms,
  (extract(epoch from s.finished_at) * 1000)::float8 as finished_ms, s.target_tag, s.missing_tags, s.timed_out, s.reason, s.takeover_of`);

type StatusRow = {
  db_now: unknown;
  run_id: string | null;
  state: string;
  holder_role: string;
  holder_pid: unknown;
  holder_host: string;
  holder_token: string | null;
  started_ms: unknown;
  deadline_ms: unknown;
  finished_ms: unknown;
  target_tag: string | null;
  missing_tags: unknown;
  timed_out: unknown;
  reason: string | null;
  takeover_of: string | null;
};

function statusFromRow(orgCode: string, r: StatusRow): OrgMigrateStatus | null {
  if (!r.run_id) return null;
  const missing = typeof r.missing_tags === "string" ? (JSON.parse(r.missing_tags) as unknown) : r.missing_tags;
  return {
    orgCode,
    runId: r.run_id,
    state: (ORG_MIGRATE_STATES as readonly string[]).includes(r.state) ? (r.state as OrgMigrateState) : "FAILED",
    holder: {
      role: (ORG_MIGRATE_ROLES as readonly string[]).includes(r.holder_role) ? (r.holder_role as OrgMigrateRole) : "SCRIPT",
      osPid: Number(r.holder_pid),
      host: r.holder_host,
      token: r.holder_token ?? undefined,
    },
    startedAtMs: Number(r.started_ms),
    deadlineAtMs: Number(r.deadline_ms),
    finishedAtMs: r.finished_ms === null || r.finished_ms === undefined ? null : Number(r.finished_ms),
    targetTag: r.target_tag,
    missing: Array.isArray(missing) ? missing.map(String) : [],
    timedOut: r.timed_out === true,
    reason: r.reason,
    takeoverOf: r.takeover_of,
    dbNowMs: Number(r.db_now),
  };
}

/** Sổ trạng thái thật — CSDL nhà. */
export function homeOrgMigrateStatusStore(): OrgMigrateStatusStore {
  return {
    async read(orgCode) {
      const pdb = await getPlatformDb();
      const [r] = rowsOf<StatusRow>(
        await pdb.execute(sql`select (extract(epoch from now()) * 1000)::float8 as db_now, ${STATUS_COLUMNS}
          from (select 1) as one left join platform_org_migration_status s on s.org_code = ${orgCode}`),
      );
      return { status: r ? statusFromRow(orgCode, r) : null, dbNowMs: Number(r?.db_now ?? NaN) };
    },
    async begin(row) {
      const pdb = await getPlatformDb();
      await pdb.execute(sql`insert into platform_org_migration_status
          (org_code, run_id, state, holder_role, holder_pid, holder_host, holder_token, started_at, deadline_at, finished_at, target_tag, missing_tags, timed_out, reason, takeover_of, updated_at)
        values (${row.orgCode}, ${row.runId}, 'RUNNING', ${row.holder.role}, ${row.holder.osPid}, ${row.holder.host.slice(0, 120)}, ${row.holder.token ?? null}, now(),
          now() + (${Math.round(row.runTimeoutMs)} * interval '1 millisecond'), null, ${row.targetTag}, ${JSON.stringify(row.missing)}::jsonb, false, null,
          ${row.takeoverOf ? row.takeoverOf.slice(0, 300) : null}, now())
        on conflict (org_code) do update set run_id = excluded.run_id, state = excluded.state, holder_role = excluded.holder_role,
          holder_pid = excluded.holder_pid, holder_host = excluded.holder_host, holder_token = excluded.holder_token, started_at = excluded.started_at, deadline_at = excluded.deadline_at,
          finished_at = null, target_tag = excluded.target_tag, missing_tags = excluded.missing_tags, timed_out = false, reason = null,
          takeover_of = excluded.takeover_of, updated_at = now()`);
    },
    async finish(orgCode, runId, end) {
      const pdb = await getPlatformDb();
      // Chỉ đóng ĐÚNG lượt của mình: lượt đã bị tiếp quản (run_id khác) không bị ghi đè.
      await pdb.execute(sql`update platform_org_migration_status set state = ${end.state}, finished_at = now(), timed_out = ${end.timedOut},
          reason = ${end.reason ? end.reason.slice(0, 500) : null}, updated_at = now()
        where org_code = ${orgCode} and run_id = ${runId}`);
    },
  };
}

/** Trạng thái lượt migrate gần nhất của một tổ chức (bước kiểm deploy, trang /platform). Không đọc được ⇒ `null` kèm lý do ở `error`. */
export async function readOrgMigrationStatus(orgCode: string): Promise<{ status: OrgMigrateStatus | null; error: string | null }> {
  try {
    return { status: (await homeOrgMigrateStatusStore().read(orgCode)).status, error: null };
  } catch (e) {
    return { status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const roleHolder = globalThis as unknown as { __erpOrgMigrateRole?: OrgMigrateRole; __erpOrgMigrateToken?: string };

/**
 * Mã NGẪU NHIÊN của tiến trình này (sinh một lần khi nạp mô-đun). pid + tên máy không đủ để nói «cùng tiến trình»: container khởi động lại
 * giữ nguyên tên máy và thường cả pid, nên một dòng của tiến trình ĐÃ CHẾT trông như của chính mình.
 */
function processToken(): string {
  return (roleHolder.__erpOrgMigrateToken ??= randomUUID());
}

/** Đặt vai trò của TIẾN TRÌNH (bước kiểm deploy gọi `setOrgMigrateRole("VERIFY")` trước khi mở tổ chức nào). */
export function setOrgMigrateRole(role: OrgMigrateRole | null): void {
  roleHolder.__erpOrgMigrateRole = role ?? undefined;
}

/** Danh tính của tiến trình này khi migrate: vai trò + pid hệ điều hành + tên máy (trong docker là mã container). */
export function currentOrgMigrateHolder(): OrgMigrateHolder {
  return { role: orgMigrateRoleFrom(process.env, roleHolder.__erpOrgMigrateRole), osPid: process.pid, host: hostname(), token: processToken() };
}

export type OrgMigrateOutcome =
  /** Chính tiến trình này chạy lượt migrate (và nó thành công). */
  | { kind: "RAN"; runId: string; status: OrgMigrateStatus | null }
  /** Lượt của người điều phối KHÁC đã áp xong trong lúc mình chờ — mình không chạy gì. */
  | { kind: "ADOPTED"; status: OrgMigrateStatus }
  /** Không còn migration nào thiếu. */
  | { kind: "NOTHING"; status: OrgMigrateStatus | null };

export type CoordinateDeps = {
  orgCode: string;
  session: OrgLockSession;
  store: OrgMigrateStatusStore;
  holder: OrgMigrateHolder;
  runTimeoutMs: number;
  /** Trần chờ của chính mình khi KHÔNG biết hạn của người giữ khoá (thường = trần lượt + biên). */
  ownCapMs: number;
  /** Trần chờ thêm của ỨNG DỤNG (`null` = bước kiểm / script: chờ tới hạn của người điều phối). */
  appCapMs: number | null;
  /** Lượt của người khác mà tiến trình này đã thấy ở lần gọi trước (lượt thử lại nền của DEGRADED) — kết thúc rồi thì nhận kết quả. */
  adoptRunIds?: ReadonlySet<string>;
  /** Lùi LIÊN TIẾN TRÌNH: lượt của tiến trình khác hỏng cho cùng đích, kết thúc chưa quá chừng này ⇒ không chạy lại ngay. */
  recentFailureWindowMs: number;
  /** Bên gọi thôi chờ ⇒ ném ABORTED ở lần kiểm kế tiếp; không nhận, không tiếp quản, không chạy. */
  signal?: AbortSignal;
  targetTag: string | null;
  missingTags(): Promise<string[]>;
  migrate(backendPid: number): Promise<void>;
  /** Lượt hỏng: DEGRADED (hết giờ + phục vụ được bằng lược đồ cũ) hay FAILED. */
  classifyFailure(error: unknown): Promise<"DEGRADED" | "FAILED">;
  /** Huỷ câu đang chạy của chính lượt này (quá trần lượt). Không có ⇒ không ép được trần (PGlite: một tiến trình, không ai chờ). */
  cancelRunning?: (backendPid: number) => Promise<void>;
  onRun?: (backendPid: number) => void;
  schedule?: (ms: number, fn: () => void) => () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  log?: (line: string) => void;
};

const defaultSchedule = (ms: number, fn: () => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/**
 * ═══════ ĐIỀU PHỐI MỘT LƯỢT MIGRATE CỦA MỘT TỔ CHỨC (chủ shop 18/10/2026) ═══════
 *
 * Luật đầy đủ ở lib/constants/org-migrate-coordination.ts. Tóm tắt dòng chảy:
 *  1. Đọc trạng thái (lấy mốc CSDL `sinceDbMs` TRƯỚC lần thử khoá đầu) rồi thử khoá — KHÔNG lặp mù.
 *  2. Khoá bận ⇒ đọc trạng thái người giữ, `decideWhileBusy`: chờ tới hạn tự khai của họ + biên; hết chờ ⇒ HOLDER_RUNNING / LOCK_BUSY
 *     mang tên người giữ — không bao giờ một câu «chờ khoá quá N giây» vô danh.
 *  3. Cầm được khoá ⇒ `decideAfterAcquire`: nhận kết quả lượt vừa kết thúc của người khác (OK, hoặc HOLDER_FAILED mang lý do CỦA HỌ —
 *     không chạy lượt thứ hai), không có gì để làm, tiếp quản lượt của tiến trình đã chết, hoặc chạy.
 *  4. Chạy ⇒ ghi RUNNING (hạn = now() + trần lượt) → migrate (quá trần ⇒ tự huỷ câu đang chạy, nhắc lại mỗi 5 giây tới khi dừng) → ghi
 *     DONE / DEGRADED / FAILED → rồi mới nhả khoá. Ghi trạng thái hỏng (CSDL nhà chưa có bảng…) KHÔNG chặn migrate: chỉ cảnh báo, và tiến
 *     trình khác lùi về «không rõ ai giữ khoá» — vẫn có trần.
 */
export async function coordinateOrgMigration(deps: CoordinateDeps): Promise<OrgMigrateOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const schedule = deps.schedule ?? defaultSchedule;
  const pollMs = Math.max(1, deps.pollMs ?? ORG_MIGRATE_WAIT_POLL_MS);
  const log = deps.log ?? (() => undefined);
  const code = deps.orgCode;
  let storeBroken = false;
  const safe = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      if (!storeBroken) log(`[org-migrate] «${code}»: không ${what} được trạng thái lượt migrate ở CSDL nhà (${e instanceof Error ? e.message : String(e)}) — vẫn migrate; tiến trình khác coi như «không rõ ai giữ khoá».`);
      storeBroken = true;
      return null;
    }
  };
  const readStatus = async () => (await safe("đọc", () => deps.store.read(code))) ?? { status: null, dbNowMs: NaN };

  const first = await readStatus();
  const sinceDbMs = Number.isFinite(first.dbNowMs) ? first.dbNowMs : null;
  const waitStartedMs = now();
  let announcedRunId: string | null | undefined;
  /** Lượt RUNNING đã thấy ở một vòng TRƯỚC. Một dòng đã quá hạn ngay lần đầu thấy có thể là dòng mồ côi của tiến trình đã chết, còn khoá
   *  đang thuộc về người điều phối MỚI chưa kịp ghi dòng của mình (cửa sổ giữa thử khoá và ghi RUNNING) ⇒ hỏi lại một nhịp rồi mới kết luận. */
  const seenRunning = new Set<string>();

  const abortIfAsked = () => {
    if (deps.signal?.aborted) throw new OrgMigrateError("ABORTED", `${deps.holder.role} thôi chờ lượt migrate «${code}» (bên gọi đã quá trần của nó) — không nhận, không tiếp quản, không chạy lượt nào.`);
  };

  for (;;) {
    abortIfAsked();
    if (!(await deps.session.tryLock())) {
      const { status } = await readStatus();
      const decision = decideWhileBusy({ status, localNowMs: now(), waitStartedMs, ownCapMs: deps.ownCapMs, appCapMs: deps.appCapMs });
      const runningId = status?.state === "RUNNING" ? status.runId : null;
      const firstSight = runningId !== null && !seenRunning.has(runningId);
      if (runningId !== null) seenRunning.add(runningId);
      if (decision.kind === "OVERDUE" && decision.holderKnown && firstSight) {
        await sleep(pollMs);
        continue;
      }
      if (decision.kind === "WAIT") {
        if (announcedRunId !== runningId) {
          announcedRunId = runningId;
          log(
            status?.state === "RUNNING"
              ? `[org-migrate] «${code}»: ${describeOrgMigrateStatus(status)} — ${deps.holder.role} CHỜ lượt đó kết thúc, không chạy lượt thứ hai.`
              : `[org-migrate] «${code}»: một tiến trình không ghi trạng thái đang giữ khoá migrate — ${deps.holder.role} chờ tối đa ${Math.round(deps.ownCapMs / 1000)} giây.`,
          );
        }
        await sleep(pollMs);
        continue;
      }
      const waited = ((now() - waitStartedMs) / 1000).toFixed(1);
      if (decision.kind === "HOLDER_RUNNING" && status) {
        throw new OrgMigrateError(
          "HOLDER_RUNNING",
          `${holderLabel(status.holder)} đang migrate «${code}» (bắt đầu ${new Date(status.startedAtMs).toISOString()}, hạn ${new Date(status.deadlineAtMs).toISOString()}) — ${deps.holder.role} đã chờ ${waited} giây, KHÔNG chạy lượt thứ hai; đọc lại sau.`,
          undefined,
          { holderStatus: status },
        );
      }
      throw new OrgMigrateError(
        "LOCK_BUSY",
        status?.state === "RUNNING"
          ? `${holderLabel(status.holder)} giữ khoá migrate «${code}» QUÁ hạn tự khai (${new Date(status.deadlineAtMs).toISOString()}) — không cướp khoá đang giữ; kiểm tiến trình đó (đã chờ ${waited} giây).`
          : `Tiến trình khác (không ghi trạng thái) đang migrate CSDL «${deps.session.dbName || code}» — chờ quá ${waited} giây.`,
        undefined,
        { holderStatus: status },
      );
    }

    // ─── Đã cầm khoá ───
    try {
      abortIfAsked();
      // Sổ drizzle đọc không được (hình dạng lạ) ⇒ CHƯA BIẾT thiếu gì — không phải «không thiếu gì»: để drizzle chạy và báo đúng lỗi của nó.
      const missing = await deps.missingTags().catch(() => null);
      const { status } = await readStatus();
      const decision = decideAfterAcquire({
        status,
        observed: deps.adoptRunIds ?? new Set(),
        sinceDbMs,
        missing,
        self: deps.holder,
        targetTag: deps.targetTag,
        recentFailureWindowMs: deps.recentFailureWindowMs,
      });
      if (decision.kind === "ADOPT_OK") return { kind: "ADOPTED", status: decision.status };
      if (decision.kind === "ADOPT_FAILURE") {
        const s = decision.status;
        const dur = s.finishedAtMs !== null ? ((s.finishedAtMs - s.startedAtMs) / 1000).toFixed(1) : "?";
        throw new OrgMigrateError("HOLDER_FAILED", `${s.state} ở lượt của ${holderLabel(s.holder)} (${dur} giây; không chạy lượt thứ hai): ${s.reason ?? "không ghi lý do"}`, undefined, {
          timedOut: s.timedOut,
          holderStatus: s,
        });
      }
      if (decision.kind === "BACKOFF") {
        const s = decision.status;
        throw new OrgMigrateError(
          "HOLDER_FAILED",
          `${s.state} ở lượt gần nhất của ${holderLabel(s.holder)} (kết thúc ${new Date(s.finishedAtMs ?? 0).toISOString()}, cùng đích ${s.targetTag ?? "?"}) — chưa tới hạn thử lại (${new Date(decision.retryAtDbMs).toISOString()}), không chạy lại ngay: ${s.reason ?? "không ghi lý do"}`,
          undefined,
          // Thử lại ĐÚNG lúc cửa sổ lùi của lượt kia hết (khoảng còn lại đo trên đồng hồ CSDL), không ngắn hơn nhịp «khoá bận».
          { timedOut: s.timedOut, holderStatus: s, retryAfterMs: Math.max(decision.retryAtDbMs - s.dbNowMs, orgMigrateRetryAfterMs(new OrgMigrateError("LOCK_BUSY", "nhịp tối thiểu"))) },
        );
      }
      if (decision.kind === "NOTHING") {
        // Dòng cũ còn RUNNING (người điều phối chết SAU khi commit) / DEGRADED / FAILED mà sổ đã khớp ⇒ đóng cho đúng sự thật.
        if (status && status.state !== "DONE") {
          await safe("ghi", () => deps.store.finish(code, status.runId, { state: "DONE", timedOut: false, reason: `sổ migration đã khớp khi ${holderLabel(deps.holder)} kiểm lại (dòng cũ: ${status.state})` }));
        }
        return { kind: "NOTHING", status };
      }

      // ─── RUN / TAKEOVER: chính mình là người điều phối ───
      const takeoverOf = decision.kind === "TAKEOVER" ? `${holderLabel(decision.stale.holder)} (bắt đầu ${new Date(decision.stale.startedAtMs).toISOString()})` : null;
      const runId = randomUUID();
      await safe("ghi", () => deps.store.begin({ orgCode: code, runId, holder: deps.holder, runTimeoutMs: deps.runTimeoutMs, targetTag: deps.targetTag, missing: missing ?? [], takeoverOf }));
      log(
        `[org-migrate] «${code}»: ${holderLabel(deps.holder)} bắt đầu migrate ${missing?.length ?? "?"} mục (đích ${deps.targetTag ?? "?"}), trần ${Math.round(deps.runTimeoutMs / 1000)} giây` +
          (takeoverOf ? ` — TIẾP QUẢN lượt bỏ dở của ${takeoverOf} (khoá đã nhả mà trạng thái còn RUNNING).` : "."),
      );
      deps.onRun?.(deps.session.backendPid);
      const t0 = now();
      let fired = false;
      let stopTimers: () => void = () => undefined;
      if (deps.cancelRunning) {
        const cancel = deps.cancelRunning;
        const fire = () => {
          fired = true;
          void cancel(deps.session.backendPid).catch(() => undefined);
          stopTimers = schedule(5_000, fire);
        };
        stopTimers = schedule(deps.runTimeoutMs, fire);
      }
      let failure: unknown = null;
      try {
        await deps.migrate(deps.session.backendPid);
      } catch (e) {
        failure = fired
          ? new OrgMigrateError("RUN_TIMEOUT", `vượt trần lượt migrate ${Math.round(deps.runTimeoutMs / 1000)} giây — đã huỷ câu đang chạy: ${migrationErrorText(e)}`, e)
          : e;
      } finally {
        stopTimers();
      }
      const secs = ((now() - t0) / 1000).toFixed(1);
      if (failure === null) {
        await safe("ghi", () => deps.store.finish(code, runId, { state: "DONE", timedOut: false, reason: null }));
        log(`[org-migrate] «${code}»: DONE sau ${secs} giây (${holderLabel(deps.holder)}).`);
        return { kind: "RAN", runId, status: (await readStatus()).status };
      }
      const state = await deps.classifyFailure(failure).catch(() => "FAILED" as const);
      const reason = migrationErrorText(failure);
      await safe("ghi", () => deps.store.finish(code, runId, { state, timedOut: isMigrationTimeoutError(failure), reason }));
      log(`[org-migrate] «${code}»: ${state} sau ${secs} giây (${holderLabel(deps.holder)}) — ${reason}`);
      throw failure;
    } finally {
      await deps.session.unlock();
    }
  }
}

/**
 * ═══════ MIGRATE CSDL CỦA MỘT TỔ CHỨC KHÔNG PHẢI NHÀ ═══════
 *
 * Cùng bộ migration với CSDL nhà — một mã nguồn, một lược đồ. Ba việc khác với `ensureMigrated()`:
 *
 *  1. ĐIỀU PHỐI. Ứng dụng, bước kiểm của deploy và script vận hành có thể cùng mở một CSDL tổ chức; chỉ MỘT tiến trình chạy lượt migrate
 *     (`coordinateOrgMigration` — khoá tư vấn THEO TỔ CHỨC trên CÙNG kết nối với lượt migrate, vì khoá tư vấn gắn với phiên), các tiến trình
 *     khác chờ và NHẬN kết quả của lượt đó. `onMigrating(pid)` báo mã tiến trình máy chủ của kết nối đang migrate (chỉ khi CHÍNH tiến
 *     trình này chạy) — để bên gọi HUỶ được câu đang chạy (`cancelOrganizationMigration`, bước kiểm của deploy quá trần thời gian).
 *
 *  2. TRẦN LƯỢT. Lượt của chính mình quá `orgMigrateRunTimeoutMs()` ⇒ tự huỷ câu đang chạy (`pg_cancel_backend` qua một kết nối khác
 *     của cùng bể) ⇒ drizzle rollback ⇒ lỗi RUN_TIMEOUT (loại HẾT GIỜ — phục vụ tạm bằng lược đồ cũ nếu sổ tương thích cho phép).
 *
 *  3. DỌN BẢN SAO CỦA MẶT PHẲNG ĐIỀU KHIỂN. Migration 0152 chèn dòng "tổ chức nhà" vào bảng
 *     `platform_organizations` của MỌI CSDL nó chạy qua. Ở CSDL tổ chức khác dòng đó là sai sự thật
 *     (CSDL này không phải nhà), nên xoá — mỗi lần mở, idempotent. Không ai đọc các bảng này ở đây
 *     (`getPlatformDb()` luôn là CSDL nhà), nhưng một bảng nói dối thì sớm muộn cũng có người đọc.
 *
 * PGlite (máy cá nhân / kiểm thử): một tiến trình, không khoá tư vấn, không ép trần — vẫn ghi trạng thái như Postgres thật.
 */
export async function migrateOrganizationDb(
  db: Db,
  opts: {
    orgCode: string;
    pool?: Pool;
    onMigrating?: (pid: number) => void;
    adoptRunIds?: ReadonlySet<string>;
    /** Bên gọi thôi chờ (cancelOrganizationMigration) ⇒ lượt chờ dừng, không tiếp quản / không chạy. */
    signal?: AbortSignal;
    /** Chuỗi kết nối để HUỶ câu đang chạy qua một kết nối RIÊNG — không tranh chỗ với bể (PGPOOL_MAX_ORG mặc định 2). */
    cancelUrl?: string;
  },
): Promise<OrgMigrateOutcome> {
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  const journal = readJournal();
  const runTimeoutMs = orgMigrateRunTimeoutMs();
  const holder = currentOrgMigrateHolder();
  const common = {
    orgCode: opts.orgCode,
    store: homeOrgMigrateStatusStore(),
    holder,
    runTimeoutMs,
    ownCapMs: runTimeoutMs + ORG_MIGRATE_HOLDER_MARGIN_MS,
    appCapMs: holder.role === "APP" ? orgMigrateLockWaitMs() : null,
    adoptRunIds: opts.adoptRunIds,
    // Lùi liên tiến trình = đúng hạn lùi của một lượt migrate hỏng (ORG_MIGRATE_BACKOFF_MS) — một nguồn cho cả hai.
    recentFailureWindowMs: orgMigrateRetryAfterMs(new Error("lượt migrate hỏng")),
    signal: opts.signal,
    targetTag: journal.at(-1)?.tag ?? null,
    classifyFailure: async (error: unknown) => ((await orgMigrationDegradeCheck(db, error)).serve ? ("DEGRADED" as const) : ("FAILED" as const)),
    onRun: opts.onMigrating,
  };
  let outcome: OrgMigrateOutcome;
  if (!opts.pool) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    outcome = await coordinateOrgMigration({
      ...common,
      session: { dbName: opts.orgCode, backendPid: 0, tryLock: async () => true, unlock: async () => undefined },
      missingTags: async () => missingMigrationTags(journal, await appliedWhen(async (text) => rowsOf(await db.execute(sql.raw(text))))),
      migrate: async () => {
        await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
      },
    });
  } else {
    const pool = opts.pool;
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      throw new OrgMigrateError("CONNECT", error instanceof Error ? error.message : String(error), error);
    }
    // Không nhả được khoá (vd lệnh tự huỷ rơi đúng câu nhả) ⇒ HUỶ kết nối khi trả về bể: đóng phiên là Postgres tự nhả khoá tư vấn.
    // Trả kết nối còn cầm khoá về bể thì mọi lượt sau của tổ chức này thấy «khoá bận» mãi.
    let unlockError: Error | undefined;
    try {
      const pgSession = await pgLockSession(client);
      outcome = await coordinateOrgMigration({
        ...common,
        session: {
          ...pgSession,
          unlock: async () => {
            await pgSession.unlock().catch((e: unknown) => {
              unlockError = e instanceof Error ? e : new Error(String(e));
              console.warn(`[org-migrate] «${opts.orgCode}»: không nhả được khoá migrate (${unlockError.message}) — huỷ kết nối thay vì trả về bể.`);
            });
          },
        },
        missingTags: async () => missingMigrationTags(journal, await appliedWhen(async (text) => (await client.query(text)).rows)),
        migrate: async () => {
          await migrate(drizzle(client), { migrationsFolder });
        },
        cancelRunning: async (pid) => {
          if (!opts.cancelUrl) {
            await pool.query("select pg_cancel_backend($1)", [pid]);
            return;
          }
          const { Client } = await import("pg");
          const c = new Client({ connectionString: opts.cancelUrl, connectionTimeoutMillis: 10_000 });
          await c.connect();
          try {
            await c.query("select pg_cancel_backend($1)", [pid]);
          } finally {
            await c.end().catch(() => undefined);
          }
        },
        log: (line) => console.log(line),
      });
    } finally {
      client.release(unlockError);
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
  // 0248 · trạng thái lượt migrate của từng tổ chức — mặt phẳng điều khiển, chỉ bản ở CSDL nhà là thật (bản ở đây chưa từng được ghi).
  await db.execute(sql`delete from platform_org_migration_status`);
  return outcome;
}
