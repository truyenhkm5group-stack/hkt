/**
 * ═══════════ MIGRATE CSDL TỔ CHỨC CÔ LẬP — SỰ CỐ 0245 Ở `qa` (12/10/2026) ═══════════
 *
 * Sau deploy #792, CSDL `qa` chạy câu dẫn xuất của 0245 tới trần 600 s rồi hỏng; ba lỗi của tầng migrate biến một tổ chức chậm
 * thành sự cố của cả máy: (1) MỘT khoá tư vấn chung cho mọi tổ chức, chờ vô hạn ⇒ HSLC có thể đứng chờ `qa`; (2) lỗi migrate chỉ
 * xoá lời hứa ⇒ mỗi lời mở kế tiếp chạy lại câu 10 phút; (3) bước kiểm của deploy mở tuần tự không trần ⇒ treo tới hết giờ SSH.
 * Bài kiểm khoá:
 *  1. KHOÁ THEO TỔ CHỨC: khoá dẫn xuất tất định từ tên CSDL; hai tổ chức không chờ nhau; cùng tổ chức tuần tự; quá trần ⇒ LOCK_BUSY,
 *     không chạy migration; khoá nhả cả khi migration hỏng (Postgres giả theo phiên — khoá tư vấn thật cần hai phiên, PGlite có một).
 *  2. LÙI SAU LỖI (PGlite thật, `getDbFor`): migrate hỏng ⇒ lời mở ngay sau ném «đang LÙI» không chạy lại; hết hạn ⇒ thử lại thật;
 *     `releaseOrganizationDb` xoá lượt lùi; sửa xong ⇒ mở được. Chính sách lùi theo giai đoạn (CONNECT 0 · LOCK_BUSY ngắn · còn lại dài).
 *  3. TRẦN MỖI TỔ CHỨC của verify-migrations: tổ chức treo ⇒ TIMEOUT + gửi huỷ, tổ chức SAU vẫn được kiểm, kết quả không OK.
 *  4. OPS org-migrate-probe: đối số · nhãn an toàn · tóm tắt bấm giờ · chạy thật trên PGlite (cả nhánh bấm giờ) · mã nguồn chỉ đọc,
 *     ops-vps khai đủ bốn chỗ.
 * Không mốc ngày tuyệt đối nào (AGENTS 50); đồng hồ giả chỉ ở phép lặp khoá.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDbFor, organizationDatabaseUrl, releaseOrganizationDb, schema } from "@/db";
import {
  acquireBoundedLock,
  ORG_MIGRATE_LOCK_CLASS,
  OrgMigrateError,
  orgMigrateLockKey,
  orgMigrateRetryAfterMs,
  withOrgMigrateLock,
  type OrgLockClient,
} from "@/db/migrate";
import { verifyOrganizations, verifyOrgTimeoutMs, VERIFY_ORG_TIMEOUT_DEFAULT_S } from "@/scripts/verify-migrations";
import { lastAppliedTag, parseProbeArgs, probeOrganization, PROBE_TOP_DEFAULT, safeNoteLabel, timingSummary } from "@/scripts/org-migrate-probe";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Postgres giả: khoá tư vấn hai số GẮN VỚI PHIÊN (mỗi client một pid), đúng ngữ nghĩa `pg_try_advisory_lock` / `pg_advisory_unlock`. */
function fakePg() {
  const held = new Map<string, number>();
  let nextPid = 100;
  const tries: string[] = [];
  const session = (db: string): OrgLockClient & { pid: number } => {
    const pid = nextPid++;
    return {
      pid,
      async query(text: string, values?: unknown[]) {
        if (text.startsWith("select current_database()")) return { rows: [{ db, pid }] };
        const k = (values ?? []).join(":");
        if (text.includes("pg_try_advisory_lock")) {
          tries.push(`${db}@${pid}`);
          const h = held.get(k);
          if (h === undefined || h === pid) {
            held.set(k, pid);
            return { rows: [{ ok: true }] };
          }
          return { rows: [{ ok: false }] };
        }
        if (text.includes("pg_advisory_unlock")) {
          const ok = held.get(k) === pid;
          if (ok) held.delete(k);
          return { rows: [{ ok }] };
        }
        throw new Error(`câu lạ: ${text}`);
      },
    };
  };
  return { session, held, tries };
}

function testLockKey() {
  const a = orgMigrateLockKey("erp_org_qa");
  const b = orgMigrateLockKey("erp_org_hslc_hmt_shop");
  assert.deepEqual(orgMigrateLockKey("erp_org_qa"), a, "tất định");
  assert.equal(a[0], ORG_MIGRATE_LOCK_CLASS);
  assert.equal(b[0], ORG_MIGRATE_LOCK_CLASS);
  assert.notEqual(a[1], b[1], "hai tổ chức ⇒ hai khoá");
  for (const k of [a[1], b[1], orgMigrateLockKey("")[1], orgMigrateLockKey("tổ-chức-có-dấu")[1]]) {
    assert.ok(Number.isInteger(k) && k >= -2147483648 && k <= 2147483647, `khoá ${k} phải vừa kiểu int của Postgres`);
  }
  console.log("  ✓ khoá migrate = (lớp cố định, băm FNV-1a tên CSDL) — tất định, khác nhau theo tổ chức, vừa int32");
}

async function testBoundedLoop() {
  let t = 0;
  let calls = 0;
  const ok = await acquireBoundedLock(async () => (calls++, false), { waitMs: 2_000, pollMs: 500, now: () => t, sleep: async (ms) => void (t += ms) });
  assert.equal(ok, false);
  assert.equal(calls, 5, "0 · 500 · 1000 · 1500 · 2000 ms rồi bỏ");
  let once = 0;
  assert.equal(await acquireBoundedLock(async () => (once++, false), { waitMs: 0, now: () => 0, sleep: async () => undefined }), false);
  assert.equal(once, 1, "trần 0 vẫn hỏi đúng một lần");
  let n = 0;
  assert.equal(await acquireBoundedLock(async () => ++n >= 3, { waitMs: 10_000, pollMs: 100, now: () => t, sleep: async (ms) => void (t += ms) }), true);
  console.log("  ✓ lặp pg_try_advisory_lock có trần: hỏi ít nhất một lần, quá trần ⇒ false, không chờ vô hạn");
}

async function testLockIsolation() {
  const pg = fakePg();
  const log: string[] = [];
  let releaseQa!: () => void;
  const qaGate = new Promise<void>((r) => (releaseQa = r));

  // qa cầm khoá và «migrate» lâu.
  const qa = withOrgMigrateLock(pg.session("erp_org_qa"), async () => {
    log.push("qa:bắt-đầu");
    await qaGate;
    log.push("qa:xong");
  }, { waitMs: 1_000, pollMs: 5 });
  await wait(5);

  // HSLC — tổ chức KHÁC: trần chờ 0 mà vẫn cầm được ngay, xong trong lúc qa còn chạy.
  await withOrgMigrateLock(pg.session("erp_org_hslc_hmt_shop"), async (pid) => {
    assert.ok(pid >= 100, "fn nhận pid của chính phiên");
    log.push("hslc:xong");
  }, { waitMs: 0 });
  assert.deepEqual(log, ["qa:bắt-đầu", "hslc:xong"], "HSLC không chờ qa");

  // Tiến trình thứ hai migrate CÙNG qa, trần ngắn ⇒ LOCK_BUSY, migration không chạy.
  let ran = false;
  await assert.rejects(
    withOrgMigrateLock(pg.session("erp_org_qa"), async () => void (ran = true), { waitMs: 30, pollMs: 5 }),
    (e: unknown) => e instanceof OrgMigrateError && e.phase === "LOCK_BUSY" && /erp_org_qa/.test(e.message),
  );
  assert.equal(ran, false, "không cầm được khoá ⇒ không chạy migration");

  // Tiến trình thứ ba cùng qa, trần đủ dài ⇒ đợi qa xong rồi mới chạy (tuần tự).
  const third = withOrgMigrateLock(pg.session("erp_org_qa"), async () => void log.push("qa2:chạy"), { waitMs: 2_000, pollMs: 5 });
  await wait(20);
  assert.ok(!log.includes("qa2:chạy"), "chưa được chạy khi qa còn giữ khoá");
  releaseQa();
  await qa;
  await third;
  assert.deepEqual(log, ["qa:bắt-đầu", "hslc:xong", "qa:xong", "qa2:chạy"], "cùng tổ chức ⇒ tuần tự");
  assert.equal(pg.held.size, 0, "mọi khoá đã nhả");

  // Migration HỎNG vẫn nhả khoá — lượt sau cầm ngay.
  await assert.rejects(withOrgMigrateLock(pg.session("erp_org_qa"), async () => {
    throw new Error("canceling statement due to statement timeout");
  }, { waitMs: 0 }), /statement timeout/);
  assert.equal(pg.held.size, 0, "khoá nhả sau lỗi");
  await withOrgMigrateLock(pg.session("erp_org_qa"), async () => undefined, { waitMs: 0 });
  console.log("  ✓ khoá theo tổ chức: HSLC không chờ qa · cùng qa tuần tự · quá trần ⇒ LOCK_BUSY không chạy migration · lỗi vẫn nhả khoá");
}

function testRetryPolicy() {
  const saved = { b: process.env.ORG_MIGRATE_BACKOFF_MS, r: process.env.ORG_MIGRATE_BUSY_RETRY_MS };
  delete process.env.ORG_MIGRATE_BACKOFF_MS;
  delete process.env.ORG_MIGRATE_BUSY_RETRY_MS;
  try {
    assert.equal(orgMigrateRetryAfterMs(new OrgMigrateError("CONNECT", "ECONNREFUSED")), 0, "chưa kết nối được ⇒ không lùi (CSDL đang khởi động lại)");
    assert.equal(orgMigrateRetryAfterMs(new OrgMigrateError("LOCK_BUSY", "bận")), 60_000);
    assert.equal(orgMigrateRetryAfterMs(new Error("canceling statement due to statement timeout")), 30 * 60_000, "migration hỏng ⇒ lùi 30 phút");
    process.env.ORG_MIGRATE_BACKOFF_MS = "5000";
    process.env.ORG_MIGRATE_BUSY_RETRY_MS = "abc";
    assert.equal(orgMigrateRetryAfterMs(new Error("x")), 5_000, "ghi đè bằng biến môi trường");
    assert.equal(orgMigrateRetryAfterMs(new OrgMigrateError("LOCK_BUSY", "bận")), 60_000, "giá trị hỏng ⇒ mặc định");
  } finally {
    if (saved.b === undefined) delete process.env.ORG_MIGRATE_BACKOFF_MS;
    else process.env.ORG_MIGRATE_BACKOFF_MS = saved.b;
    if (saved.r === undefined) delete process.env.ORG_MIGRATE_BUSY_RETRY_MS;
    else process.env.ORG_MIGRATE_BUSY_RETRY_MS = saved.r;
  }
  console.log("  ✓ chính sách lùi: CONNECT 0 · LOCK_BUSY 60 s · migration hỏng 30 phút · ghi đè được bằng biến môi trường");
}

const ORG = "migrate-lui";

async function seedBroken(dir: string, sqlText: string) {
  const { PGlite } = await import("@electric-sql/pglite");
  const c = new PGlite(dir);
  await c.exec(sqlText);
  await c.close();
}

async function testBackoffAndProbe() {
  const url = organizationDatabaseUrl({ code: ORG, isHome: false });
  assert.ok(url.startsWith("pglite://"), "bài kiểm chạy trên PGlite");
  const dir = url.replace(/^pglite:\/\//, "");
  await releaseOrganizationDb(ORG);
  rmSync(dir, { recursive: true, force: true });
  const saved = process.env.ORG_MIGRATE_BACKOFF_MS;
  process.env.ORG_MIGRATE_BACKOFF_MS = "400";
  try {
    // Sổ migration sai hình dạng ⇒ drizzle hỏng ở câu đọc sổ (thiếu cột hash) — một lượt migrate HỎNG thật, tất định.
    await seedBroken(dir, `create schema drizzle; create table drizzle.__drizzle_migrations (id int)`);
    const org = { code: ORG, isHome: false };
    // BẤT BIẾN ĐA TỔ CHỨC (chủ shop 12/10/2026): «migration failure isolated per workspace» — một tổ chức hỏng migrate, tổ chức khác mở
    // CÙNG LÚC vẫn lên bình thường (khoá theo tổ chức + lùi theo tổ chức + handle theo tổ chức).
    const healthy = { code: `${ORG}-khoe`, isHome: false };
    const healthyDir = organizationDatabaseUrl(healthy).replace(/^pglite:\/\//, "");
    await releaseOrganizationDb(healthy.code);
    rmSync(healthyDir, { recursive: true, force: true });
    let err1 = "";
    process.env.ORG_MIGRATE_BACKOFF_MS = "60000"; // tổ chức khoẻ migrate đủ bộ mất vài giây — hạn lùi phải còn khi hỏi lại
    try {
      const [broken, ok] = await Promise.allSettled([getDbFor(org), getDbFor(healthy)]);
      assert.equal(broken.status, "rejected", "tổ chức hỏng migrate ⇒ ném");
      err1 = broken.status === "rejected" ? String((broken.reason as Error)?.message ?? broken.reason) : "";
      assert.equal(ok.status, "fulfilled", "tổ chức KHÁC mở cùng lúc vẫn lên");
      if (ok.status === "fulfilled") await ok.value.execute(sql`select 1`);
      await assert.rejects(getDbFor(org), /đang LÙI/);
      await (await getDbFor(healthy)).execute(sql`select 1`);
    } finally {
      await releaseOrganizationDb(healthy.code);
      rmSync(healthyDir, { recursive: true, force: true });
    }
    assert.doesNotMatch(err1, /đang LÙI/, "lần đầu là lỗi gốc của migration");
    console.log("  ✓ bất biến đa tổ chức: tổ chức hỏng migrate ném + lùi, tổ chức khác mở CÙNG LÚC vẫn lên và vẫn dùng được trong lúc tổ chức kia lùi");
    await releaseOrganizationDb(ORG);
    process.env.ORG_MIGRATE_BACKOFF_MS = "400";
    await assert.rejects(getDbFor(org), (e: unknown) => e instanceof Error && !/đang LÙI/.test(e.message), "release xoá lượt lùi ⇒ thử lại thật");
    const t0 = Date.now();
    await assert.rejects(getDbFor(org), (e: unknown) => e instanceof Error && /đang LÙI/.test(e.message) && /hash/.test(e.message));
    assert.ok(Date.now() - t0 < 200, "trong hạn lùi ⇒ ném NGAY, không chạy lại migration");

    await wait(500);
    await assert.rejects(getDbFor(org), (e: unknown) => e instanceof Error && !/đang LÙI/.test(e.message), "hết hạn lùi ⇒ thử lại THẬT (vẫn hỏng vì chưa sửa)");
    await assert.rejects(getDbFor(org), /đang LÙI/, "lỗi lần hai lại đặt hạn lùi");

    // releaseOrganizationDb xoá lượt lùi; sửa sổ ⇒ mở được ngay, không phải đợi.
    await releaseOrganizationDb(ORG);
    await seedBroken(dir, `drop table drizzle.__drizzle_migrations`);
    const db = await getDbFor(org);
    console.log("  ✓ lùi sau lỗi: migrate hỏng ⇒ lời mở ngay sau ném «đang LÙI» (không chạy lại) · hết hạn ⇒ thử lại thật · release xoá lượt lùi · sửa xong mở được");

    // Ops probe chạy THẬT trên CSDL vừa migrate (cả nhánh bấm giờ, ép bằng forceTiming vì CSDL thử đã có hàm 0245).
    const now = Date.now();
    const rows: (typeof schema.salesChatInbound.$inferInsert)[] = [];
    for (let i = 0; i < 6; i++) rows.push({ pageId: "pg-probe", threadId: "t1", messageId: `c${i}`, text: `khách hỏi ${i}`, createdAt: new Date(now - (10 - i) * 60_000) });
    rows.push({ pageId: "pg-probe", threadId: "t1", messageId: "r1", text: "Dạ shop chào chị, sản phẩm bên em đang có sẵn đủ size ạ, chị cần tư vấn thêm không ạ", note: "PAGE_REPLY", createdAt: new Date(now - 30 * 60_000) });
    rows.push({ pageId: "pg-probe", threadId: "t2", messageId: "r2", text: "Dạ shop chào chị, sản phẩm bên em đang có sẵn đủ size ạ, chị cần tư vấn thêm không ạ", note: "PAGE_REPLY", createdAt: new Date(now - 20 * 60_000) });
    rows.push({ pageId: "pg-probe", threadId: "t2", messageId: "c-t2", text: "giá sao", createdAt: new Date(now - 40 * 60_000) });
    await db.insert(schema.salesChatInbound).values(rows);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await probeOrganization(db, ORG, 5, { forceTiming: true });
    } finally {
      console.log = orig;
    }
    const all = lines.join("\n");
    assert.ok(lines.every((l) => l.startsWith("[ops:tom-tat] ")), "mọi dòng đi kênh tóm tắt");
    assert.match(all, /hàm 0245 CÓ · cột turn_unhandled CÓ/);
    assert.match(all, /sales_chat_inbound theo loại dòng: \(trống\) 7 · PAGE_REPLY 2/);
    assert.match(all, /1 page · 2 luồng · dòng\/luồng lớn nhất 7 .* PAGE_REPLY sender_kind NULL chữ ≥ 40: 2/);
    assert.match(all, /cửa sổ 168 giờ \(trượt theo dòng\): lớn nhất 2 /);
    assert.match(all, /SAU lượt khách cuối .*: 1 dòng \/ 1 luồng/, "r2 (t2) sau tin khách cuối của t2; r1 (t1) trước tin khách cuối của t1");
    assert.match(all, /bấm giờ định nghĩa #803 .*: 2 luồng \(lớn nhất 7 dòng\) · xong 2 · quá 60 s 0/);
    assert.doesNotMatch(all, /pg-probe|khách hỏi|shop chào/, "tóm tắt không mang mã page / chữ tin");
    console.log("  ✓ ops org-migrate-probe chạy thật (PGlite): sổ migration · note · phân bố luồng · cửa sổ 168 giờ · dòng sau lượt khách · bấm giờ — không mã / chữ tin");
  } finally {
    if (saved === undefined) delete process.env.ORG_MIGRATE_BACKOFF_MS;
    else process.env.ORG_MIGRATE_BACKOFF_MS = saved;
    await releaseOrganizationDb(ORG);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testVerifyDeadline() {
  assert.equal(verifyOrgTimeoutMs({}), VERIFY_ORG_TIMEOUT_DEFAULT_S * 1000);
  assert.equal(verifyOrgTimeoutMs({ VERIFY_ORG_MIGRATE_TIMEOUT_S: "30" }), 30_000);
  assert.equal(verifyOrgTimeoutMs({ VERIFY_ORG_MIGRATE_TIMEOUT_S: "-1" }), VERIFY_ORG_TIMEOUT_DEFAULT_S * 1000);

  const cancelled: string[] = [];
  const checked: string[] = [];
  const out: string[] = [];
  const t0 = Date.now();
  const results = await verifyOrganizations(["a-shop", "qa", "loi", "thieu", "cu", "test-shop"], {
    open: (code) => (code === "qa" ? new Promise<string>(() => undefined) : code === "loi" ? Promise.reject(new Error("không kết nối được")) : Promise.resolve(code)),
    check: async (code) => (checked.push(code), code === "thieu" ? 2 : 0),
    cancel: async (code) => (cancelled.push(code), true),
    degraded: (code) => (code === "cu" ? { reason: "[57014] canceling statement due to statement timeout", missing: ["0245_sales_chat_last_inbound"] } : null),
    timeoutMs: 60,
    log: (l) => out.push(l),
    error: (l) => out.push(l),
  });
  assert.ok(Date.now() - t0 < 2_000, "tổ chức treo không làm treo bước kiểm");
  assert.deepEqual(results.map((r) => `${r.code}:${r.status}`), ["a-shop:OK", "qa:TIMEOUT", "loi:ERROR", "thieu:MISSING", "cu:DEGRADED", "test-shop:OK"]);
  assert.deepEqual(checked, ["a-shop", "thieu", "cu", "test-shop"], "tổ chức SAU tổ chức treo vẫn được kiểm");
  assert.deepEqual(cancelled, ["qa"], "quá trần ⇒ gửi lệnh huỷ câu migration của chính bước kiểm");
  assert.ok(out.some((l) => /✗ tổ chức «qa»: quá \d+ giây/.test(l) && /HUỶ/.test(l)), "in ✗ rõ ràng");
  assert.ok(out.some((l) => /2\/6 khớp · hỏng: qa \(TIMEOUT\), loi \(ERROR\), thieu \(MISSING\), cu \(DEGRADED\)/.test(l)), "dòng tổng kết");
  assert.ok(out.some((l) => /✗ tổ chức «cu»: DEGRADED_MIGRATION — đang phục vụ bằng LƯỢC ĐỒ CŨ, thiếu 0245_sales_chat_last_inbound; lý do: \[57014\]/.test(l)), "degraded ⇒ ✗ + lý do");
  assert.ok(out.some((l) => /DEGRADED WORKSPACES: cu —/.test(l)), "dòng DEGRADED WORKSPACES");

  const src = readFileSync("scripts/verify-migrations.ts", "utf8");
  assert.match(src, /if \(CHAY_THANG\) \{\n\s+main\(\)/, "main() chỉ chạy khi gọi thẳng — import từ bài kiểm không kéo process.exit");
  assert.match(src, /if \(results\.some\(\(r\) => r\.status !== "OK"\)\) failed = true;/, "tổ chức hỏng / quá trần ⇒ thoát 1");
  const install = readFileSync("scripts/install-vps.sh", "utf8");
  assert.match(install, /if ! docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/verify-migrations\.ts; then\n\s+warn [^\n]*\n\s+MIGRATIONS_UNAPPLIED=1\nfi\n/, "install-vps.sh: verify hỏng ⇒ cảnh báo rồi chạy TIẾP smoke (không đổi hành vi deploy)");
  console.log("  ✓ verify-migrations: trần mỗi tổ chức (mặc định 150 s > trần chờ khoá 120 s) · DEGRADED ⇒ ✗ + lý do + «DEGRADED WORKSPACES» · treo ⇒ TIMEOUT + huỷ · tổ chức sau vẫn kiểm · không OK ⇒ thoát 1 · deploy chạy tiếp smoke");
}

function testProbePureAndSource() {
  assert.deepEqual(parseProbeArgs(["qa"]), { code: "qa", top: PROBE_TOP_DEFAULT });
  assert.deepEqual(parseProbeArgs(["hslc-hmt-shop", "--top=5"]), { code: "hslc-hmt-shop", top: 5 });
  for (const bad of [[], ["QA"], ["qa", "b"], ["--top=5"], ["qa", "--top=0"], ["qa", "--top=51"], ["qa", "--all"]]) assert.ok("error" in parseProbeArgs(bad), JSON.stringify(bad));
  assert.equal(safeNoteLabel("PAGE_REPLY"), "PAGE_REPLY");
  assert.equal(safeNoteLabel(null), "(trống)");
  assert.equal(safeNoteLabel("chị Lan 0901234567"), "(khác)", "chữ tự do không lọt ra tóm tắt");
  const journal = [{ tag: "0244_x", when: 10 }, { tag: "0245_sales_chat_last_inbound", when: 20 }];
  assert.equal(lastAppliedTag(10, journal), "0244_x");
  assert.equal(lastAppliedTag(0, journal), "(chưa áp mục nào)");
  assert.match(lastAppliedTag(99, journal), /không có trong sổ/);
  const s = timingSummary([{ rows: 900, ms: 1200 }, { rows: 500, ms: null }, { rows: 400, ms: 300 }], 17);
  assert.match(s, /^3 luồng \(lớn nhất 900 dòng\) · xong 2 · quá 60 s 1 · bỏ 17 \(dừng sau 2 lần quá trần\) · lớn nhất 1\.20 s · trung vị 0\.30 s · tổng 1\.50 s$/);
  assert.match(timingSummary([], 0), /0 luồng .* lớn nhất — · trung vị — · tổng —/, "không có số đo ⇒ «—», không phải 0");

  const sc = readFileSync("scripts/org-migrate-probe.ts", "utf8");
  assert.match(sc, /if \(CHAY_THANG\) process\.env\.ERP_READ_ONLY = "1";\n\nimport "dotenv\/config";/, "đặt chỉ đọc TRƯỚC khi nạp @/db");
  assert.match(sc, /show default_transaction_read_only/);
  assert.match(sc, /getDbForInspection/);
  assert.doesNotMatch(sc, /\bgetDbFor\(|\bgetDb\(|withOrganization/, "không mở CSDL qua đường migrate");
  assert.match(sc, /process\.stdout\.write\("", \(\) => r\(\)\)/, "xả stdout trước khi thoát");
  const code = sc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\.(insert|update|delete)\(|\binsert into\b|\bupdate "?\w+"? set\b|\bdelete from\b/i, "script không câu ghi");
  assert.doesNotMatch(code, /tomTat\([^\n]*\$\{[^}]*\b(page_id|thread_id|pageId|threadId|text)\b/, "tóm tắt không nhận mã / chữ tin");
  assert.match(sc, /from "@\/lib\/sales-chatbot\/response-ownership-ledger"/, "bấm giờ bằng ĐÚNG hàm #803 đã có trong image");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- org-migrate-probe\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\borg-migrate-probe\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\borg-migrate-probe\b/, "làn ĐỌC nặng");
  assert.match(ops, /org-migrate-probe\)\n[\s\S]*?scripts\/org-migrate-probe\.ts ;;/, "nhánh chạy");
  console.log("  ✓ ops org-migrate-probe: đối số <mã> [--top] · nhãn note an toàn · tóm tắt bấm giờ «—» khi chưa đo · chỉ đọc · ops khai đủ bốn chỗ");
}

function testSourceShape() {
  const m = readFileSync("db/migrate.ts", "utf8");
  assert.doesNotMatch(m, /pg_advisory_lock\(\$1\)|select pg_advisory_lock\(/, "không còn khoá chung chờ vô hạn");
  assert.match(m, /pg_try_advisory_lock\(\$1, \$2\)/);
  const idx = readFileSync("db/index.ts", "utf8");
  const i = idx.indexOf("async function getOrgDb(");
  const body = idx.slice(i, idx.indexOf("\n}\n", i));
  assert.match(body, /orgMigrateBackoff/, "lùi nằm ĐÚNG ở getOrgDb — mọi lối vào CSDL tổ chức đi qua đây");
  assert.equal((idx.match(/orgMigrateBackoff \?\?= new Map\(\)/g) ?? []).length, 1, "một chỗ dựng sổ lùi");
  console.log("  ✓ mã nguồn: hết khoá chung vô hạn · lùi ở đúng một chỗ (getOrgDb)");
}

export async function testOrgMigrateIsolation() {
  console.log("Migrate CSDL tổ chức cô lập (sự cố 0245 ở qa, 12/10/2026):");
  testLockKey();
  await testBoundedLoop();
  await testLockIsolation();
  testRetryPolicy();
  testSourceShape();
  await testVerifyDeadline();
  testProbePureAndSource();
  await testBackoffAndProbe();
}

if (process.argv[1] && /org-migrate-isolation\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testOrgMigrateIsolation)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}
