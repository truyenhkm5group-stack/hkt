/**
 * ═══════════ PHỤC VỤ BẰNG LƯỢC ĐỒ CŨ — CHỨNG MINH CHO SỔ `MIGRATION_SERVE_COMPAT` (chủ shop 12/10/2026, «Serve with old schema») ═══════════
 *
 * Sổ lib/constants/migration-serve-compat.ts khẳng định «mã đang chạy chạy đúng khi migration X CHƯA áp». Bài kiểm này là `proof` của
 * khẳng định đó cho 0245, và khoá luật phục vụ `DEGRADED_MIGRATION`:
 *  1. THUẦN: nhận dạng HẾT GIỜ (57014 · 55P03 · LOCK_BUSY · bọc trong `cause`); quyết định phục vụ (chỉ khi MỌI mục thiếu đều trong sổ);
 *     mỗi mục trong sổ trỏ tới tag có thật + bài kiểm có thật.
 *  2. MÃ NGUỒN: không đường nào đọc / ghi hàng của bảng bị thêm cột theo kiểu NGẦM (`select().from(bảng)` · drizzle `insert(bảng)` —
 *     cả hai liệt kê MỌI cột của lược đồ theo tên ⇒ «column does not exist» trên lược đồ cũ). Đây là lỗi bài kiểm này đã BẮT ĐƯỢC THẬT:
 *     `openConversation` (khách mới nhắn page) và ba chỗ `select()` từng hỏng trên CSDL dừng ở 0244.
 *  3. PGlite THẬT: tổ chức có dữ liệu, hạ lược đồ về ĐÚNG trạng thái 0244 (so cột / trigger / hàm với một CSDL mới migrate tới 0244),
 *     cài một trigger giả làm câu dẫn xuất của 0245 HẾT GIỜ (SQLSTATE 57014 — chỉ khi `statement_timeout` = 600 s của chính 0245) ⇒
 *       · mở CSDL KHÔNG ném, trạng thái DEGRADED_MIGRATION, thiếu đúng 0245, không có cột 0245;
 *       · mã hiện tại chạy được: khách mới mở hội thoại · danh sách hộp thư · mở luồng · đánh dấu đọc · xem lại hội thoại · khách · đơn;
 *       · lỗi SQL THẬT (không phải hết giờ) ⇒ ném như cũ; thiếu migration NGOÀI sổ ⇒ không phục vụ; `ORG_MIGRATE_SERVE_DEGRADED=0` ⇒ tắt;
 *       · tới hạn ⇒ thử lại NỀN: hỏng vẫn phục vụ; hết nguyên nhân ⇒ 0245 áp xong, hết DEGRADED.
 * Không mốc ngày tuyệt đối (AGENTS 50).
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { eq, getTableName, is, sql, Table } from "drizzle-orm";
import { degradedOrganizations, getDb, getDbFor, getPlatformDb, organizationDatabaseUrl, organizationMigrationDegraded, releaseOrganizationDb, schema } from "@/db";
import { orgMigrationDegradeCheck } from "@/db/migrate";
import type { SessionUser } from "@/lib/auth/session";
import { forgetMemo } from "@/lib/cache";
import { isMigrationTimeoutError, MIGRATION_SERVE_COMPAT, missingMigrationTags, orgMigrationDegradeDecision, serveCompatAvoidColumns } from "@/lib/constants/migration-serve-compat";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { listCustomers } from "@/lib/queries/customers";
import { listOrders } from "@/lib/queries/orders";
import { openConversation } from "@/lib/sales-chatbot/engine";
import { loadConversationReview } from "@/lib/sales-chatbot/experiment-report";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import { listInbox, loadInboxThread } from "@/lib/sales-chatbot/inbox";
import { markInboxReadCore } from "@/lib/sales-chatbot/inbox-read";
import { parseListParams } from "@/lib/search-params";
import { rowsOf } from "@/lib/sql-rows";

const ORG = "serve-compat-0245";
const PAGE = "pg-serve-compat";
const TAG = "0245_sales_chat_last_inbound";
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─────────────────────────── 1. THUẦN ───────────────────────────

function testPure() {
  const pgErr = (code: string) => Object.assign(new Error("x"), { code });
  assert.ok(isMigrationTimeoutError(pgErr("57014")), "statement timeout / bị huỷ");
  assert.ok(isMigrationTimeoutError(pgErr("55P03")), "lock timeout");
  assert.ok(isMigrationTimeoutError(new Error("Failed query: UPDATE …", { cause: pgErr("57014") })), "drizzle bọc lỗi pg trong cause");
  assert.ok(isMigrationTimeoutError(Object.assign(new Error("bận"), { name: "OrgMigrateError", phase: "LOCK_BUSY" })));
  assert.ok(!isMigrationTimeoutError(Object.assign(new Error("bận"), { name: "OrgMigrateError", phase: "CONNECT" })));
  assert.ok(!isMigrationTimeoutError(pgErr("42703")), "column does not exist là lỗi SQL thật");
  assert.ok(!isMigrationTimeoutError(new Error("canceling statement due to statement timeout")), "không đoán theo câu chữ — chỉ SQLSTATE");
  assert.ok(!isMigrationTimeoutError(null));

  assert.deepEqual(orgMigrationDegradeDecision([TAG]), { serve: true, missing: [TAG] });
  const outside = orgMigrationDegradeDecision(["0244_sales_chat_inbound_sender", TAG]);
  assert.equal(outside.serve, false);
  assert.match((outside as { why: string }).why, /NGOÀI sổ tương thích: 0244_sales_chat_inbound_sender/);
  assert.equal(orgMigrationDegradeDecision([]).serve, false, "không thiếu gì ⇒ không có lý do phục vụ tạm");
  assert.deepEqual(missingMigrationTags([{ tag: "a", when: 1 }, { tag: "b", when: 2 }], [1]), ["b"]);
  assert.deepEqual([...serveCompatAvoidColumns("sales_chat_conversations")].sort(), ["last_read_at", "turn_unhandled"]);
  assert.equal(serveCompatAvoidColumns("orders").size, 0);

  const journal = (JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] }).entries.map((e) => e.tag);
  for (const e of MIGRATION_SERVE_COMPAT) {
    assert.ok(journal.includes(e.tag), `${e.tag}: phải là tag có thật trong sổ migration`);
    assert.ok(existsSync(e.proof), `${e.tag}: bài kiểm chứng minh ${e.proof} phải có thật`);
    assert.ok(e.why.trim().length >= 80, `${e.tag}: phải nói VÌ SAO mã chạy được khi nó chưa áp`);
    const sqlText = readFileSync(`drizzle/${e.tag}.sql`, "utf8");
    for (const [table, cols] of Object.entries(e.addedColumns)) {
      for (const c of cols) assert.match(sqlText, new RegExp(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${c}"`), `${e.tag}: khai thêm cột ${table}.${c} phải khớp tệp migration`);
    }
    assert.doesNotMatch(sqlText, /\bDROP COLUMN\b|\bRENAME\b|ALTER COLUMN [^\n]* (TYPE|SET NOT NULL)/i, `${e.tag}: mục tương thích không được xoá / đổi tên / đổi kiểu cột mã đang đọc`);
  }
  console.log("  ✓ thuần: hết giờ = 57014 · 55P03 · LOCK_BUSY (cả trong cause, không đoán theo chữ) · phục vụ chỉ khi MỌI mục thiếu trong sổ · sổ trỏ tới tag + bài kiểm thật");
}

// ─────────────────────────── 2. MÃ NGUỒN ───────────────────────────

function testSource() {
  const files = execFileSync("git", ["ls-files", "lib", "app", "chatbot", "components"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f));
  const keys = Object.entries(schema)
    .filter(([, t]) => is(t, Table) && serveCompatAvoidColumns(getTableName(t as Table)).size > 0)
    .map(([k]) => k);
  assert.deepEqual(keys, ["salesChatConversations"], "bảng bị thêm cột bởi mục tương thích");
  const pham: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const k of keys) {
      if (!src.includes(`schema.${k}`)) continue;
      const aliases = [`schema\\.${k}`, ...[...src.matchAll(new RegExp(`const (\\w+) = schema\\.${k};`, "g"))].map((m) => m[1])];
      const ref = `(?:${aliases.join("|")})`;
      const bad = [
        new RegExp(`\\.select\\(\\s*\\)\\s*\\.from\\(\\s*${ref}\\s*\\)`),
        new RegExp(`\\.insert\\(\\s*${ref}\\s*\\)`),
        new RegExp(`\\.query\\.${k}\\b`),
      ];
      for (const re of bad) if (re.test(src)) pham.push(`${f}: ${re.source.slice(0, 40)}`);
    }
  }
  assert.deepEqual(pham, [], "đọc / ghi hàng hội thoại kiểu NGẦM (mọi cột của lược đồ) hỏng trên lược đồ cũ — dùng compatTableColumns() / câu chèn liệt kê cột");
  console.log("  ✓ mã nguồn: không select() / insert() / query.* ngầm trên bảng bị thêm cột — đọc qua compatTableColumns, chèn liệt kê cột");
}

// ─────────────────────────── 3. PGlite THẬT ───────────────────────────

/** Hạ CSDL đã áp 0245 về ĐÚNG trạng thái 0244: gỡ mọi thứ 0245 dựng + dòng sổ của nó. Chỉ bài kiểm dùng. */
const MOC_0245 = (JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string; when: number }[] }).entries.find((e) => e.tag === "0245_sales_chat_last_inbound")?.when ?? 0;
/** Mọi tag từ 0245 trở đi — hạ về 0244 là thiếu ĐÚNG chừng ấy mục. */
const TU_0245 = (JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string; when: number }[] }).entries.filter((e) => e.when >= MOC_0245).map((e) => e.tag);
const DOWNGRADE_0245 = `
drop trigger if exists "sales_chat_inbound_turn" on "sales_chat_inbound";
drop trigger if exists "sales_chat_staff_messages_turn" on "sales_chat_staff_messages";
drop trigger if exists "sales_chat_messages_turn" on "sales_chat_messages";
drop trigger if exists "sales_chat_reads_turn" on "sales_chat_reads";
drop trigger if exists "sales_chat_conversations_turn_ins" on "sales_chat_conversations";
drop trigger if exists "sales_chat_conversations_turn_upd" on "sales_chat_conversations";
drop function if exists "sales_chat_inbound_turn_trg"(), "sales_chat_staff_turn_trg"(), "sales_chat_messages_turn_trg"(), "sales_chat_reads_turn_trg"(), "sales_chat_conversations_turn_trg"();
drop function if exists "sales_chat_turn_refresh_template"(text, text, text, timestamptz), "sales_chat_turn_refresh_conv"(text), "sales_chat_turn_refresh_thread"(text, text);
drop function if exists "sales_chat_turn_unhandled_of"(text, text, text, timestamptz), "sales_chat_turn_unhandled_web"(text, timestamptz), "sales_chat_turn_unhandled_thread"(text, text, timestamptz);
drop index if exists "sales_chat_conversations_thread_idx";
alter table "sales_chat_conversations" drop column if exists "turn_unhandled", drop column if exists "last_read_at";
-- 0246 (và mọi migration sau 0245 trong sổ khai tương thích): trả hai ràng buộc CHECK về định nghĩa trước 0246.
alter table "canonical_order_outcome" drop constraint if exists "canonical_cogs_basis_check";
alter table "canonical_order_outcome" add constraint "canonical_cogs_basis_check" check ("cogs_basis" is null or "cogs_basis" in ('RECEIPT_BEFORE', 'RECEIPT_AFTER', 'PROVISIONAL', 'NONE')) not valid;
alter table "return_dispositions" drop constraint if exists "return_dispositions_value_check";
alter table "return_dispositions" add constraint "return_dispositions_value_check" check (("disposition" = 'WRITE_OFF' or ("unit_cost_estimate" is null and "value_estimate" is null and "cost_basis" is null)) and ("value_estimate" is null or "value_estimate" >= 0) and ("cost_basis" is null or "cost_basis" in ('RECEIPT', 'ORDER_SNAPSHOT', 'VARIANT_DEFAULT', 'UNKNOWN'))) not valid;
-- 0247: chỉ mục chữ chuẩn hoá của PAGE_REPLY.
drop index if exists "sales_chat_inbound_page_reply_text_hash_idx";
-- Gỡ dòng sổ của 0245 VÀ mọi migration sau nó (mốc của 0245 = mốc nhỏ nhất trong nhóm đã áp sau 0244).
delete from "drizzle"."__drizzle_migrations" where created_at >= ${MOC_0245};
`;

/** Câu dẫn xuất của 0245 «hết giờ»: trigger giả CHỈ nổ trong giao dịch của 0245 (nó đặt statement_timeout 600 s = '10min'). */
const FAKE_TIMEOUT = (errcode: string) => `
create or replace function "qa_fake_migrate_fail"() returns trigger language plpgsql as $f$ begin
  if current_setting('statement_timeout') = '10min' then raise exception 'canceling statement due to statement timeout (giả)' using errcode = '${errcode}'; end if;
  return new; end $f$;
drop trigger if exists "qa_fake_migrate_fail" on "sales_chat_conversations";
create trigger "qa_fake_migrate_fail" before update on "sales_chat_conversations" for each row execute function "qa_fake_migrate_fail"();
`;

async function pgliteExec(dir: string, sqlText: string) {
  const { PGlite } = await import("@electric-sql/pglite");
  const c = new PGlite(dir);
  try {
    await c.exec(sqlText);
  } finally {
    await c.close();
  }
}

/** Dấu vân tay lược đồ quanh 0245: cột của bảng hội thoại · trigger của năm bảng nguồn · hàm sales_chat_* · chỉ mục hội thoại. */
const SHAPE_SQL = `select
  (select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema = 'public' and table_name = 'sales_chat_conversations') as cols,
  (select coalesce(string_agg(tgname, ',' order by tgname), '') from pg_trigger t join pg_class r on r.oid = t.tgrelid where not t.tgisinternal and r.relname like 'sales_chat_%' and tgname <> 'qa_fake_migrate_fail') as trg,
  (select coalesce(string_agg(proname, ',' order by proname), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'sales_chat_%') as fns,
  (select coalesce(string_agg(indexname, ',' order by indexname), '') from pg_indexes where schemaname = 'public' and tablename = 'sales_chat_conversations') as idx`;

async function shapeOf(dir: string) {
  const { PGlite } = await import("@electric-sql/pglite");
  const c = new PGlite(dir);
  try {
    return (await c.query<Record<string, string>>(SHAPE_SQL)).rows[0];
  } finally {
    await c.close();
  }
}

/** CSDL MỚI migrate tới NGAY TRƯỚC 0245 (sổ cắt bớt mục cuối) — chuẩn để so trạng thái hạ cấp. */
async function fresh0244Shape(): Promise<Record<string, string>> {
  const base = `./data/serve-compat-${process.pid}`;
  const mig = `${base}/drizzle`;
  const dbDir = `${base}/db`;
  rmSync(base, { recursive: true, force: true });
  mkdirSync(path.join(mig, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
  const i = journal.entries.findIndex((e) => e.tag === TAG);
  assert.ok(i > 0, "0245 có trong sổ");
  journal.entries = journal.entries.slice(0, i);
  writeFileSync(path.join(mig, "meta", "_journal.json"), JSON.stringify(journal));
  for (const f of readdirSync("drizzle")) if (f.endsWith(".sql") && !f.startsWith("0245")) copyFileSync(path.join("drizzle", f), path.join(mig, f));
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const c = new PGlite(dbDir);
  try {
    await migrate(drizzle(c), { migrationsFolder: mig });
    return (await c.query<Record<string, string>>(SHAPE_SQL)).rows[0];
  } finally {
    await c.close();
    rmSync(base, { recursive: true, force: true });
  }
}

async function cleanup() {
  await releaseOrganizationDb(ORG);
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

const ENV_KEYS = ["ORG_MIGRATE_SERVE_DEGRADED", "ORG_MIGRATE_DEGRADED_RETRY_MS", "ORG_MIGRATE_BACKOFF_MS"] as const;

async function testDb() {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dir = organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, "");
  const org = { code: ORG, isHome: false };
  await cleanup();
  try {
    await provisionOrganization({ code: ORG, name: "Shop lược đồ cũ", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "LuocDo@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    // Dữ liệu trên lược đồ ĐẦY ĐỦ: một hội thoại fanpage có tin khách.
    let convId = "";
    await withOrganization(ORG, async () => {
      const db = await getDb();
      convId = (await openConversation("FANPAGE", { visitorKey: fanpageVisitorKey(PAGE, "t1") })).id;
      await db.update(schema.salesChatConversations).set({ pageId: PAGE, threadId: "t1" }).where(eq(schema.salesChatConversations.id, convId));
      const now = Date.now();
      await db.insert(schema.salesChatInbound).values([
        { pageId: PAGE, threadId: "t1", messageId: "m1", text: "shop ơi còn hàng không", createdAt: new Date(now - 10 * 60_000) },
        { pageId: PAGE, threadId: "t1", messageId: "m2", text: "size M nhé", createdAt: new Date(now - 9 * 60_000) },
      ]);
    });
    await releaseOrganizationDb(ORG);

    // Hạ về 0244 + chứng minh đúng trạng thái 0244 (so với CSDL mới migrate tới 0244).
    await pgliteExec(dir, DOWNGRADE_0245);
    const [downgraded, fresh] = [await shapeOf(dir), await fresh0244Shape()];
    assert.deepEqual(downgraded, fresh, "CSDL hạ cấp phải trùng lược đồ của một CSDL mới migrate tới 0244 (cột · trigger · hàm · chỉ mục)");
    assert.ok(!fresh.cols.split(",").includes("turn_unhandled"));

    // (a) HẾT GIỜ + chỉ thiếu 0245 ⇒ phục vụ bằng lược đồ cũ.
    await pgliteExec(dir, FAKE_TIMEOUT("57014"));
    process.env.ORG_MIGRATE_DEGRADED_RETRY_MS = String(3_600_000);
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
    try {
      await getDbFor(org);
    } finally {
      console.warn = origWarn;
    }
    const dg = organizationMigrationDegraded(ORG);
    assert.ok(dg, "mở được, trạng thái DEGRADED_MIGRATION");
    assert.deepEqual(dg.missing, TU_0245, "thiếu đúng 0245 và các migration sau nó (đều khai trong sổ tương thích)");
    assert.match(dg.reason, /statement timeout/);
    assert.ok(degradedOrganizations().some((d) => d.code === ORG));
    assert.equal(warns.filter((w) => w.includes("DEGRADED_MIGRATION") && w.includes(ORG)).length, 1, "log rõ MỘT lần khi vào trạng thái");
    console.log("  ✓ hết giờ + chỉ thiếu 0245 ⇒ mở được, DEGRADED_MIGRATION (thiếu đúng 0245, lý do, log một lần)");

    // (b) Mã hiện tại chạy được trên lược đồ 0244.
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const [col] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from information_schema.columns where table_name = 'sales_chat_conversations' and column_name = 'turn_unhandled'`));
      assert.equal(Number(col.n), 0, "đúng là lược đồ cũ");
      await forgetMemo("inbox-unread-switch");
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] } as unknown as SessionUser;

      const opened = await openConversation("FANPAGE", { visitorKey: fanpageVisitorKey(PAGE, "t2") });
      assert.ok(opened.id, "khách MỚI nhắn page ⇒ mở được hội thoại (câu chèn liệt kê cột)");
      const list = await listInbox(admin, {});
      assert.ok(list.ok, `listInbox: ${JSON.stringify(list).slice(0, 200)}`);
      assert.ok(list.rows.some((r) => r.id === convId), "hội thoại cũ có trong hộp thư");
      assert.equal(list.rows.find((r) => r.id === convId)?.unread, true, "«chưa đọc» tính trực tiếp bằng hàm #803 khi thiếu cột");
      const th = await loadInboxThread(admin, convId);
      assert.ok(th.ok, `loadInboxThread: ${JSON.stringify(th).slice(0, 200)}`);
      assert.ok(th.thread.readThrough, "luồng có tin để đánh dấu đọc");
      const read = await markInboxReadCore(admin, convId, th.thread.readThrough.id);
      assert.ok(read.ok, `markInboxReadCore: ${JSON.stringify(read).slice(0, 200)}`);
      const after = await listInbox(admin, {});
      assert.ok(after.ok);
      assert.equal(after.rows.find((r) => r.id === convId)?.unread, false, "đọc xong ⇒ hết chưa đọc (con trỏ đọc, không cần cột lưu sẵn)");
      const review = await loadConversationReview(admin, convId);
      assert.ok("ok" in review, `loadConversationReview: ${JSON.stringify(review).slice(0, 200)}`);
      const params = parseListParams({ period: "all" }, { defaultPeriod: "all", defaultPageSize: 50 });
      await listCustomers(params);
      await listOrders(params);
    });
    console.log("  ✓ mã hiện tại trên lược đồ 0244: khách mới mở hội thoại · listInbox · loadInboxThread · markInboxRead · xem lại hội thoại · khách · đơn — không lỗi cột");

    // (c) Thiếu migration NGOÀI sổ ⇒ không phục vụ; công tắc tắt ⇒ không phục vụ.
    const live = await getDbFor(org);
    const timeoutErr = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const maxRow = rowsOf<{ m: string }>(await live.execute(sql`select max(created_at)::text as m from "drizzle"."__drizzle_migrations"`));
    await live.execute(sql`delete from "drizzle"."__drizzle_migrations" where created_at = ${maxRow[0].m}::bigint`);
    const outside = await orgMigrationDegradeCheck(live, timeoutErr);
    assert.equal(outside.serve, false);
    assert.match((outside as { why: string }).why, /NGOÀI sổ tương thích: 0244_sales_chat_inbound_sender/);
    await live.execute(sql`insert into "drizzle"."__drizzle_migrations" (hash, created_at) values ('khoi-phuc', ${maxRow[0].m}::bigint)`);
    process.env.ORG_MIGRATE_SERVE_DEGRADED = "0";
    assert.deepEqual(await orgMigrationDegradeCheck(live, timeoutErr), { serve: false, why: "ORG_MIGRATE_SERVE_DEGRADED=0" });
    delete process.env.ORG_MIGRATE_SERVE_DEGRADED;
    assert.equal((await orgMigrationDegradeCheck(live, Object.assign(new Error("x"), { code: "42703" }))).serve, false, "lỗi SQL thật ⇒ không phục vụ");
    console.log("  ✓ thiếu migration ngoài sổ ⇒ không phục vụ · ORG_MIGRATE_SERVE_DEGRADED=0 ⇒ tắt · lỗi SQL thật ⇒ không phục vụ");

    // (d) Lỗi SQL THẬT trong lượt migrate ⇒ ném như cũ, không degraded.
    await releaseOrganizationDb(ORG);
    await pgliteExec(dir, FAKE_TIMEOUT("22012"));
    process.env.ORG_MIGRATE_BACKOFF_MS = "1";
    await assert.rejects(getDbFor(org), (e: unknown) => !/đang LÙI/.test(String(e)), "lỗi SQL thật ⇒ ném");
    assert.equal(organizationMigrationDegraded(ORG), null);
    console.log("  ✓ lỗi SQL thật trong lượt migrate ⇒ ném như cũ, không DEGRADED");

    // (e) Thử lại theo nhịp: hỏng vẫn phục vụ; hết nguyên nhân ⇒ 0245 áp xong, hết DEGRADED.
    await releaseOrganizationDb(ORG);
    await pgliteExec(dir, FAKE_TIMEOUT("57014"));
    process.env.ORG_MIGRATE_DEGRADED_RETRY_MS = "200";
    const silence = console.warn;
    console.warn = () => undefined;
    try {
      await getDbFor(org);
      assert.equal(organizationMigrationDegraded(ORG)?.attempts, 1);
      await wait(300);
      await getDbFor(org); // tới hạn ⇒ thử lại NỀN, lời gọi nhận ngay handle đang phục vụ
      for (let i = 0; i < 300 && (organizationMigrationDegraded(ORG)?.retrying ?? false); i++) await wait(100);
      const st = organizationMigrationDegraded(ORG);
      assert.ok(st && st.attempts === 2, "lượt thử thứ hai hỏng ⇒ VẪN phục vụ, vẫn DEGRADED");
      const served = await getDbFor(org);
      await served.execute(sql.raw(`drop trigger "qa_fake_migrate_fail" on "sales_chat_conversations"`));
      await served.execute(sql.raw(`drop function "qa_fake_migrate_fail"()`));
      await wait(300);
      await getDbFor(org);
      for (let i = 0; i < 600 && organizationMigrationDegraded(ORG); i++) await wait(100);
    } finally {
      console.warn = silence;
    }
    assert.equal(organizationMigrationDegraded(ORG), null, "hết nguyên nhân ⇒ migrate xong, hết DEGRADED");
    const [colAfter] = rowsOf<{ n: number }>(await (await getDbFor(org)).execute(sql`select count(*)::int as n from information_schema.columns where table_name = 'sales_chat_conversations' and column_name = 'turn_unhandled'`));
    assert.equal(Number(colAfter.n), 1, "0245 đã áp");
    console.log("  ✓ thử lại theo nhịp (ORG_MIGRATE_DEGRADED_RETRY_MS): hỏng vẫn phục vụ · hết nguyên nhân ⇒ 0245 áp xong, hết DEGRADED");
  } finally {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await cleanup();
  }
}

export async function testMigrationServeCompat() {
  console.log("Phục vụ bằng lược đồ cũ (DEGRADED_MIGRATION) — chứng minh sổ tương thích:");
  testPure();
  testSource();
  await testDb();
}

if (process.argv[1] && /migration-serve-compat\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testMigrationServeCompat)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}
