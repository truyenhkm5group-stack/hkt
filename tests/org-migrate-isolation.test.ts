/**
 * ═══════════ MIGRATE CSDL TỔ CHỨC CÔ LẬP — SỰ CỐ 0245 Ở `qa` (12/10/2026) ═══════════
 *
 * Sau deploy #792, CSDL `qa` chạy câu dẫn xuất của 0245 tới trần 600 s rồi hỏng; ba lỗi của tầng migrate biến một tổ chức chậm
 * thành sự cố của cả máy: (1) MỘT khoá tư vấn chung cho mọi tổ chức, chờ vô hạn ⇒ HSLC có thể đứng chờ `qa`; (2) lỗi migrate chỉ
 * xoá lời hứa ⇒ mỗi lời mở kế tiếp chạy lại câu 10 phút; (3) bước kiểm của deploy mở tuần tự không trần ⇒ treo tới hết giờ SSH.
 * Bài kiểm khoá:
 *  1. KHOÁ THEO TỔ CHỨC + ĐIỀU PHỐI (sự cố 18/10/2026 — bước kiểm deploy và ứng dụng cùng migrate `qa`): khoá dẫn xuất tất định từ tên
 *     CSDL; hai tổ chức không chờ nhau; cùng tổ chức đúng MỘT lượt — người đến sau CHỜ tới hạn tự khai của người điều phối rồi nhận kết
 *     quả THẬT (OK / DEGRADED kèm lý do CỦA lượt đó), không chạy lượt thứ hai, không báo thời gian chờ khoá của chính mình; lượt quá trần
 *     tự huỷ; tiếp quản dòng RUNNING mồ côi; sổ trạng thái hỏng không chặn migrate (Postgres giả theo phiên + sổ trạng thái trong bộ nhớ,
 *     đồng hồ GIẢ tiêm vào — khoá tư vấn thật cần hai phiên, PGlite có một). PGlite thật: mở tổ chức ⇒ dòng trạng thái DONE ở CSDL nhà.
 *  2. LÙI SAU LỖI (PGlite thật, `getDbFor`): migrate hỏng ⇒ lời mở ngay sau ném «đang LÙI» không chạy lại; hết hạn ⇒ thử lại thật;
 *     `releaseOrganizationDb` xoá lượt lùi; sửa xong ⇒ mở được. Chính sách lùi theo giai đoạn (CONNECT 0 · LOCK_BUSY ngắn · còn lại dài).
 *  3. TRẦN MỖI TỔ CHỨC của verify-migrations (dẫn xuất từ trần lượt) + ngân sách tổng: tổ chức treo ⇒ TIMEOUT + gửi huỷ, tổ chức SAU vẫn
 *     được kiểm, hết ngân sách ⇒ CHƯA KIỂM (đỏ); mỗi kết quả in dòng «lượt migrate» (trạng thái · ai chạy · bao lâu · lý do).
 *  4. OPS org-migrate-probe: đối số · nhãn an toàn · tóm tắt bấm giờ · chạy thật trên PGlite (cả nhánh bấm giờ) · mã nguồn chỉ đọc,
 *     ops-vps khai đủ bốn chỗ.
 * Không mốc ngày tuyệt đối nào (AGENTS 50); đồng hồ giả chỉ ở phép lặp khoá.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDbFor, organizationDatabaseUrl, releaseOrganizationDb, schema } from "@/db";
import {
  coordinateOrgMigration,
  ORG_MIGRATE_LOCK_CLASS,
  OrgMigrateError,
  orgMigrateDegradedRetryAfterMs,
  orgMigrateDegradedRetryMs,
  orgMigrateLockKey,
  orgMigrateRetryAfterMs,
  pgLockSession,
  readOrgMigrationStatus,
  setOrgMigrateRole,
  type OrgLockClient,
  type OrgMigrateStatusStore,
} from "@/db/migrate";
import { isMigrationTimeoutError, migrationErrorText } from "@/lib/constants/migration-serve-compat";
import {
  decideAfterAcquire,
  decideWhileBusy,
  sameProcess,
  describeOrgMigrateStatus,
  ORG_MIGRATE_HOLDER_MARGIN_MS,
  ORG_MIGRATE_RUN_TIMEOUT_DEFAULT_MS,
  ORG_MIGRATE_RUN_TIMEOUT_MIN_MS,
  orgMigrateRoleFrom,
  orgMigrateRunTimeoutMs,
  type OrgMigrateHolder,
  type OrgMigrateStatus,
} from "@/lib/constants/org-migrate-coordination";
import { runStatusLine, verifyOrganizations, verifyOrgTimeoutMs } from "@/scripts/verify-migrations";
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

/** Sổ trạng thái trong bộ nhớ, đồng hồ CSDL giả (`clock`) — cùng hợp đồng với `homeOrgMigrateStatusStore`. */
function memStore(clock: () => number) {
  const rows = new Map<string, OrgMigrateStatus>();
  const store: OrgMigrateStatusStore = {
    async read(orgCode) {
      const r = rows.get(orgCode);
      return { status: r ? { ...r, missing: [...r.missing], dbNowMs: clock() } : null, dbNowMs: clock() };
    },
    async begin(row) {
      rows.set(row.orgCode, {
        orgCode: row.orgCode,
        runId: row.runId,
        state: "RUNNING",
        holder: row.holder,
        startedAtMs: clock(),
        deadlineAtMs: clock() + row.runTimeoutMs,
        finishedAtMs: null,
        targetTag: row.targetTag,
        missing: [...row.missing],
        timedOut: false,
        reason: null,
        takeoverOf: row.takeoverOf,
        dbNowMs: clock(),
      });
    },
    async finish(orgCode, runId, end) {
      const r = rows.get(orgCode);
      if (r && r.runId === runId) rows.set(orgCode, { ...r, state: end.state, finishedAtMs: clock(), timedOut: end.timedOut, reason: end.reason });
    },
  };
  return { rows, store };
}

const APP: OrgMigrateHolder = { role: "APP", osPid: 4242, host: "erp-app" };
const VERIFY: OrgMigrateHolder = { role: "VERIFY", osPid: 5151, host: "erp-app" };
const TAGS = ["0245_x", "0246_y", "0247_z"];
/** Cửa sổ lùi liên tiến trình dùng trong bài (30 phút, đồng hồ giả). */
const WINDOW = 1_800_000;
const tick = () => new Promise<void>((r) => setImmediate(r));

/** Một «CSDL tổ chức» giả: sổ drizzle đã áp + một cổng giữ lượt migrate lại tới khi bài kiểm cho đi. */
function fakeOrgDb() {
  const applied = new Set<string>();
  const ran: string[] = [];
  return {
    applied,
    ran,
    missingTags: async () => TAGS.filter((t) => !applied.has(t)),
    migrateAs: (who: string, gate: Promise<void>) => async () => {
      ran.push(who);
      await gate;
      for (const t of TAGS) applied.add(t);
    },
  };
}

function testCoordinationPure() {
  const s = (over: Partial<OrgMigrateStatus>): OrgMigrateStatus => ({
    orgCode: "qa", runId: "r1", state: "RUNNING", holder: APP, startedAtMs: 1_000, deadlineAtMs: 601_000, finishedAtMs: null, targetTag: "0247_z", missing: TAGS, timedOut: false, reason: null, takeoverOf: null, dbNowMs: 100_000, ...over,
  });
  // Khoá bận: hạn của người điều phối đổi sang đồng hồ tiến trình bằng KHOẢNG CÒN LẠI đo trên CSDL — hai đồng hồ không bao giờ bị trừ lẫn.
  const running = s({});
  assert.deepEqual(decideWhileBusy({ status: running, localNowMs: 7, waitStartedMs: 7, ownCapMs: 630_000, appCapMs: null }), { kind: "WAIT" });
  const holderLimit = 7 + (601_000 + ORG_MIGRATE_HOLDER_MARGIN_MS - 100_000);
  // Hai đồng hồ trôi cùng nhịp: mỗi lần đọc lại, `dbNowMs` của dòng tiến đúng bằng chừng ấy.
  const at = (localNowMs: number) => ({ status: { ...running, dbNowMs: 100_000 + (localNowMs - 7) }, localNowMs, waitStartedMs: 7 });
  assert.deepEqual(decideWhileBusy({ ...at(holderLimit - 1), ownCapMs: 10_000_000, appCapMs: null }), { kind: "WAIT" });
  assert.deepEqual(decideWhileBusy({ ...at(holderLimit), ownCapMs: 10_000_000, appCapMs: null }), { kind: "OVERDUE", holderKnown: true }, "quá hạn tự khai + biên mà vẫn giữ khoá ⇒ OVERDUE");
  assert.deepEqual(decideWhileBusy({ ...at(7 + 120_000), ownCapMs: 630_000, appCapMs: 120_000 }), { kind: "HOLDER_RUNNING", holderLimitMs: holderLimit }, "APP hết trần ngắn, lượt kia còn trong hạn ⇒ HOLDER_RUNNING");
  assert.deepEqual(decideWhileBusy({ status: null, localNowMs: 7 + 630_000, waitStartedMs: 7, ownCapMs: 630_000, appCapMs: null }), { kind: "OVERDUE", holderKnown: false }, "không rõ ai giữ ⇒ chờ tới trần của chính mình rồi thôi");
  assert.deepEqual(decideWhileBusy({ status: s({ state: "DONE", finishedAtMs: 50_000 }), localNowMs: 7, waitStartedMs: 7, ownCapMs: 1, appCapMs: null }), { kind: "WAIT" }, "lượt đã kết thúc nhưng khoá chưa nhả ⇒ chờ (trần của mình)");

  // Vừa cầm khoá.
  const none = new Set<string>();
  const acq = (status: OrgMigrateStatus | null, over: Partial<Parameters<typeof decideAfterAcquire>[0]> = {}) =>
    decideAfterAcquire({ status, observed: none, sinceDbMs: 80_000, missing: TAGS, self: VERIFY, targetTag: "0247_z", recentFailureWindowMs: WINDOW, ...over }).kind;
  assert.equal(acq(s({ state: "DONE", finishedAtMs: 90_000 }), { missing: [] }), "ADOPT_OK", "lượt của người khác xong TRONG lúc mình gọi + sổ của mình đủ ⇒ nhận");
  assert.equal(acq(s({ state: "DONE", finishedAtMs: 90_000 }), { missing: ["0249_moi"] }), "RUN", "DONE chỉ nói người kia áp xong SỔ CỦA HỌ — sổ của mình còn thiếu (deploy lẫn phiên bản) ⇒ tự chạy, KHÔNG nhận là khoẻ");
  assert.equal(acq(s({ state: "DONE", finishedAtMs: 90_000 }), { missing: null }), "RUN", "không đọc được sổ = CHƯA BIẾT, không phải «không thiếu» ⇒ không nhận DONE");
  assert.equal(acq(null, { missing: null, sinceDbMs: null }), "RUN", "sổ không đọc được ⇒ để drizzle chạy và báo đúng lỗi");
  assert.equal(acq(s({ state: "DEGRADED", finishedAtMs: 90_000, timedOut: true })), "ADOPT_FAILURE", "lượt kia hỏng trong lúc mình chờ ⇒ nhận lỗi của NÓ, không chạy lượt thứ hai");
  assert.equal(acq(s({ state: "DEGRADED", finishedAtMs: 10_000, dbNowMs: 10_000 + WINDOW })), "RUN", "lượt hỏng từ TRƯỚC khi mình gọi, đã quá cửa sổ lùi ⇒ lượt thử lại thường");
  assert.equal(acq(s({ state: "DEGRADED", finishedAtMs: 10_000 }), { observed: new Set(["r1"]) }), "ADOPT_FAILURE", "lượt đã thấy ở lần gọi trước (lượt thử lại nền) ⇒ nhận — MỘT lần, bên gọi bỏ khỏi tập");
  assert.equal(acq(s({ state: "DONE", finishedAtMs: 10_000 }), { missing: [] }), "NOTHING");
  assert.equal(acq(running), "TAKEOVER", "khoá đã nhả mà dòng còn RUNNING ⇒ người điều phối đã chết");
  assert.equal(acq(null, { sinceDbMs: null }), "RUN");
  // Lùi LIÊN TIẾN TRÌNH: lượt của tiến trình KHÁC hỏng cho cùng đích, vừa kết thúc (đồng hồ CSDL) ⇒ không chạy lại ngay.
  const recent = s({ state: "FAILED", finishedAtMs: 100_000 - 5 * 60_000, dbNowMs: 100_000, timedOut: true });
  assert.equal(acq(recent, { sinceDbMs: 100_000 }), "BACKOFF", "tiến trình mới khởi động không chạy lại câu vừa hỏng 5 phút trước ở tiến trình kia");
  assert.equal(acq({ ...recent, targetTag: "0249_moi" }, { sinceDbMs: 100_000 }), "RUN", "đích khác (mã mới có migration mới) ⇒ thử ngay");
  assert.equal(acq({ ...recent, finishedAtMs: 100_000 - WINDOW }, { sinceDbMs: 100_000 }), "RUN", "hết cửa sổ lùi ⇒ thử lại");
  assert.equal(acq({ ...recent, holder: VERIFY }, { sinceDbMs: 100_000 }), "RUN", "lượt của CHÍNH tiến trình này — nhịp thử lại đã do bên gọi quyết");
  // Container khởi động lại: cùng pid + tên máy nhưng KHÁC mã tiến trình ⇒ là tiến trình khác, lùi vẫn áp.
  const oldBoot = { ...VERIFY, token: "boot-cu" };
  const newBoot = { ...VERIFY, token: "boot-moi" };
  assert.equal(sameProcess(oldBoot, newBoot), false, "pid + tên máy trùng sau khi container khởi động lại — mã tiến trình phân biệt");
  assert.equal(sameProcess(oldBoot, { ...oldBoot }), true);
  assert.equal(sameProcess(VERIFY, { ...VERIFY }), true, "thiếu mã ⇒ lùi về pid + tên máy");
  assert.equal(acq({ ...recent, holder: oldBoot }, { sinceDbMs: 100_000, self: newBoot }), "BACKOFF", "tiến trình trước khi khởi động lại KHÔNG phải chính mình");
  assert.equal(acq(recent, { sinceDbMs: 100_000, missing: [] }), "NOTHING", "sổ đã đủ ⇒ không có gì để lùi");

  assert.equal(orgMigrateRoleFrom({}, null), "SCRIPT");
  assert.equal(orgMigrateRoleFrom({ NEXT_RUNTIME: "nodejs" }, null), "APP");
  assert.equal(orgMigrateRoleFrom({ NEXT_RUNTIME: "nodejs" }, "VERIFY"), "VERIFY", "đặt tường minh thắng");
  assert.equal(orgMigrateRunTimeoutMs({}), ORG_MIGRATE_RUN_TIMEOUT_DEFAULT_MS);
  assert.equal(orgMigrateRunTimeoutMs({ ORG_MIGRATE_RUN_TIMEOUT_MS: "abc" }), ORG_MIGRATE_RUN_TIMEOUT_DEFAULT_MS);
  assert.equal(orgMigrateRunTimeoutMs({ ORG_MIGRATE_RUN_TIMEOUT_MS: "600" }), ORG_MIGRATE_RUN_TIMEOUT_MIN_MS, "gõ nhầm giây thành mili giây ⇒ kẹp về sàn, không tự huỷ mọi lượt sau 0,6 giây");
  const overdue = describeOrgMigrateStatus(s({ dbNowMs: 601_000 + ORG_MIGRATE_HOLDER_MARGIN_MS + 45_000 }));
  assert.match(overdue, /^RUNNING QUÁ HẠN · APP pid 4242@erp-app · .* đã qua 45 giây \(sau biên\) — tiến trình có thể đã chết/, "dòng RUNNING quá hạn KHÔNG in như RUNNING bình thường");
  assert.match(describeOrgMigrateStatus(s({ state: "DEGRADED", finishedAtMs: 613_500, timedOut: true, reason: "[57014] canceling statement" })), /^DEGRADED · APP pid 4242@erp-app · bắt đầu .* · 612\.5 giây · thiếu 0245_x, 0246_y, 0247_z · lý do: \[57014\]/);
  assert.match(describeOrgMigrateStatus(running), /^RUNNING · APP pid 4242@erp-app · bắt đầu .* \(99\.0 giây\) · hạn .* · đích 0247_z$/);

  // TRẦN LƯỢT phải LỚN HƠN trần câu lệnh lớn nhất mà migration tự khai — để câu ấy hỏng với lỗi chính xác của nó trước khi lượt bị huỷ.
  const unitMs: Record<string, number> = { ms: 1, s: 1_000, min: 60_000, h: 3_600_000 };
  let maxStmt = 0;
  for (const f of readdirSync("drizzle").filter((x) => x.endsWith(".sql"))) {
    for (const m of readFileSync(`drizzle/${f}`, "utf8").replace(/^--.*$/gm, "").matchAll(/statement_timeout\s*=\s*'(\d+)\s*(ms|s|min|h)?'/gi)) maxStmt = Math.max(maxStmt, Number(m[1]) * unitMs[(m[2] ?? "ms").toLowerCase()]);
  }
  assert.ok(maxStmt > 0, "đọc được ít nhất một statement_timeout trong drizzle/*.sql");
  assert.ok(ORG_MIGRATE_RUN_TIMEOUT_DEFAULT_MS > maxStmt, `trần lượt ${ORG_MIGRATE_RUN_TIMEOUT_DEFAULT_MS} ms phải lớn hơn statement_timeout lớn nhất ${maxStmt} ms`);
  assert.ok(verifyOrgTimeoutMs({}) > ORG_MIGRATE_RUN_TIMEOUT_DEFAULT_MS + ORG_MIGRATE_HOLDER_MARGIN_MS, "trần mỗi tổ chức của bước kiểm = lưới an toàn SAU hạn của người điều phối + biên");
  console.log("  ✓ quyết định thuần: chờ tới hạn TỰ KHAI của người điều phối (đổi đồng hồ bằng khoảng còn lại) · APP trần ngắn ⇒ HOLDER_RUNNING · quá hạn ⇒ OVERDUE · nhận kết quả lượt kết thúc trong lúc chờ · tiếp quản RUNNING mồ côi · trần lượt > statement_timeout lớn nhất");
}

/** Hai tiến trình mở CÙNG tổ chức: đúng MỘT người chạy, người kia CHỜ và nhận kết quả thật — kể cả khi lượt đó hết giờ. */
async function testConcurrentOpeners() {
  // (a) Thành công: ứng dụng chạy, bước kiểm chờ và nhận OK — có tên người chạy.
  {
    let t = 5_000_000;
    const { rows, store } = memStore(() => t);
    const pg = fakePg();
    const org = fakeOrgDb();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let polls = 0;
    const logs: string[] = [];
    const base = { orgCode: "qa", store, runTimeoutMs: 600_000, ownCapMs: 630_000, recentFailureWindowMs: WINDOW, targetTag: "0247_z", missingTags: org.missingTags, classifyFailure: async () => "DEGRADED" as const, now: () => t, pollMs: 1_000, log: (l: string) => void logs.push(l) };
    const a = coordinateOrgMigration({ ...base, session: await pgLockSession(pg.session("erp_org_qa")), holder: APP, appCapMs: 120_000, migrate: org.migrateAs("APP", gate), sleep: async () => undefined });
    for (let i = 0; i < 20 && !org.ran.length; i++) await tick();
    assert.deepEqual(org.ran, ["APP"], "ứng dụng cầm khoá và đang migrate");
    assert.equal(rows.get("qa")?.state, "RUNNING");
    const b = coordinateOrgMigration({
      ...base,
      session: await pgLockSession(pg.session("erp_org_qa")),
      holder: VERIFY,
      appCapMs: null,
      migrate: org.migrateAs("VERIFY", Promise.resolve()),
      sleep: async (ms) => {
        t += ms;
        if (++polls === 3) open();
        await tick();
      },
    });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.kind, "RAN");
    assert.equal(rb.kind, "ADOPTED", "bước kiểm NHẬN kết quả, không chạy");
    assert.deepEqual(org.ran, ["APP"], "đúng MỘT lượt migrate");
    assert.equal(rb.kind === "ADOPTED" ? rb.status.holder.role : "", "APP", "kết quả mang tên người chạy");
    assert.equal(rows.get("qa")?.state, "DONE");
    assert.ok(polls >= 3, "bước kiểm đã chờ (hỏi lại theo nhịp), không bỏ cuộc ở lần đầu");
    assert.ok(logs.some((l) => /«qa»: RUNNING · APP pid 4242@erp-app .* — VERIFY CHỜ lượt đó kết thúc, không chạy lượt thứ hai\./.test(l)), "log nói rõ AI đang chạy và bước kiểm đang chờ");
    assert.equal(pg.held.size, 0, "mọi khoá đã nhả");
  }

  // (b) Lượt của ứng dụng HẾT GIỜ (trần lượt ⇒ tự huỷ): bước kiểm báo DEGRADED với lý do CỦA LƯỢT ĐÓ — không phải «chờ khoá quá N giây».
  {
    let t = 9_000_000;
    const { rows, store } = memStore(() => t);
    const pg = fakePg();
    const org = fakeOrgDb();
    let cancelMigration!: () => void;
    const timers: { ms: number; fn: () => void; cleared: boolean }[] = [];
    let polls = 0;
    const cancelled: number[] = [];
    const base = { orgCode: "qa", store, runTimeoutMs: 600_000, ownCapMs: 630_000, recentFailureWindowMs: WINDOW, targetTag: "0247_z", missingTags: org.missingTags, now: () => t, pollMs: 1_000 };
    const a = coordinateOrgMigration({
      ...base,
      session: await pgLockSession(pg.session("erp_org_qa")),
      holder: APP,
      appCapMs: 120_000,
      classifyFailure: async (e) => (isMigrationTimeoutError(e) ? "DEGRADED" : "FAILED"),
      migrate: async () => {
        org.ran.push("APP");
        await new Promise<void>((_, reject) => (cancelMigration = () => reject(Object.assign(new Error("canceling statement due to user request"), { code: "57014" }))));
      },
      cancelRunning: async (pid) => {
        cancelled.push(pid);
        cancelMigration();
      },
      schedule: (ms, fn) => {
        const h = { ms, fn, cleared: false };
        timers.push(h);
        return () => void (h.cleared = true);
      },
    });
    a.catch(() => undefined);
    for (let i = 0; i < 20 && !org.ran.length; i++) await tick();
    assert.equal(timers[0]?.ms, 600_000, "người điều phối hẹn tự huỷ ĐÚNG ở trần lượt tự khai");
    const b = coordinateOrgMigration({
      ...base,
      session: await pgLockSession(pg.session("erp_org_qa")),
      holder: VERIFY,
      appCapMs: null,
      classifyFailure: async () => "FAILED",
      migrate: org.migrateAs("VERIFY", Promise.resolve()),
      sleep: async (ms) => {
        t += ms;
        if (++polls === 3) timers[0].fn(); // tới trần lượt của ứng dụng
        await tick();
      },
    });
    const [ea, eb] = await Promise.allSettled([a, b]);
    assert.equal(ea.status, "rejected");
    const errA = ea.status === "rejected" ? (ea.reason as OrgMigrateError) : null;
    assert.ok(errA instanceof OrgMigrateError && errA.phase === "RUN_TIMEOUT" && errA.timedOut, "lượt quá trần ⇒ RUN_TIMEOUT (loại hết giờ)");
    assert.deepEqual(cancelled, [100], "huỷ ĐÚNG kết nối đang migrate của chính người điều phối");
    assert.deepEqual(timers.map((h) => h.ms), [600_000, 5_000], "đã nổ ở trần lượt ⇒ hẹn nhắc huỷ mỗi 5 giây tới khi câu dừng");
    assert.equal(timers[1].cleared, true, "lượt dừng ⇒ dọn hẹn nhắc");
    const row = rows.get("qa");
    assert.equal(row?.state, "DEGRADED");
    assert.equal(row?.timedOut, true);
    assert.match(row?.reason ?? "", /^vượt trần lượt migrate 600 giây — đã huỷ câu đang chạy: \[57014\] canceling statement due to user request/);
    assert.equal(eb.status, "rejected");
    const errB = eb.status === "rejected" ? (eb.reason as OrgMigrateError) : null;
    assert.ok(errB instanceof OrgMigrateError && errB.phase === "HOLDER_FAILED", "bước kiểm nhận lỗi của lượt kia");
    assert.match(errB.message, /^DEGRADED ở lượt của APP pid 4242@erp-app \(\d+\.\d giây; không chạy lượt thứ hai\): vượt trần lượt migrate 600 giây/);
    assert.doesNotMatch(errB.message, /chờ khoá|chờ quá|Tiến trình khác/, "KHÔNG báo thời gian chờ khoá của chính mình");
    assert.ok(isMigrationTimeoutError(errB), "lượt kia hết giờ ⇒ lỗi nhận về cũng là loại hết giờ (phục vụ tạm bằng lược đồ cũ được)");
    assert.equal(migrationErrorText(errB), errB.message.slice(0, 300), "câu lý do giữ «lượt của ai»");
    assert.equal(orgMigrateRetryAfterMs(errB), orgMigrateRetryAfterMs(new Error("x")), "lượt kia vừa hỏng ⇒ lùi dài, không chạy lại ngay đúng câu đó");
    assert.equal(orgMigrateDegradedRetryAfterMs(errB), orgMigrateDegradedRetryMs());
    assert.deepEqual(org.ran, ["APP"], "bước kiểm KHÔNG chạy lượt thứ hai");
    assert.equal(pg.held.size, 0);

    // (c) Lượt thử lại nền (db/index.ts::maybeRetryDegraded) mang lượt đã thấy ⇒ nhận kết quả ĐÚNG MỘT LẦN; bên gọi bỏ lượt khỏi tập, nên
    //     lượt thử lại KẾ TIẾP chạy thật — không «nhận» mãi cùng một thất bại cũ mỗi 6 giờ.
    const runId = row?.runId ?? "";
    t += 3_600_000;
    const seen = new Set([runId]);
    const pass1 = new Set(seen);
    seen.clear();
    await assert.rejects(
      coordinateOrgMigration({ ...base, session: await pgLockSession(pg.session("erp_org_qa")), holder: VERIFY, appCapMs: null, adoptRunIds: pass1, classifyFailure: async () => "FAILED", migrate: org.migrateAs("RETRY", Promise.resolve()) }),
      (e: unknown) => e instanceof OrgMigrateError && e.phase === "HOLDER_FAILED",
    );
    assert.deepEqual(org.ran, ["APP"], "lần thử lại thứ nhất nhận kết quả của lượt đã thấy");
    const retry = await coordinateOrgMigration({ ...base, session: await pgLockSession(pg.session("erp_org_qa")), holder: VERIFY, appCapMs: null, adoptRunIds: seen, classifyFailure: async () => "FAILED", migrate: org.migrateAs("RETRY", Promise.resolve()) });
    assert.equal(retry.kind, "RAN", "lần thử lại thứ hai (lượt cũ đã nhận rồi, đã quá cửa sổ lùi) ⇒ CHẠY thật");
    assert.deepEqual(org.ran, ["APP", "RETRY"]);
    assert.equal(rows.get("qa")?.state, "DONE");
  }
  console.log("  ✓ hai tiến trình cùng mở qa: đúng MỘT lượt migrate · người đến sau CHỜ tới hạn tự khai rồi nhận kết quả THẬT kèm tên người chạy · lượt quá trần ⇒ tự huỷ, ghi DEGRADED + lý do, bước kiểm báo đúng lý do đó (không phải chờ khoá) · không chạy lượt thứ hai");
}

async function testHolderEdgeCases() {
  let t = 20_000_000;
  const { rows, store } = memStore(() => t);
  const pg = fakePg();
  const sleep = async (ms: number) => void (t += ms);
  const base = { store, runTimeoutMs: 600_000, ownCapMs: 630_000, recentFailureWindowMs: WINDOW, targetTag: "0247_z", classifyFailure: async () => "FAILED" as const, now: () => t, pollMs: 1_000, sleep };

  // TIẾP QUẢN: dòng RUNNING của một tiến trình đã chết (khoá tự nhả khi phiên đóng) ⇒ chạy, ghi rõ lượt bị tiếp quản.
  rows.set("qa", { orgCode: "qa", runId: "chet", state: "RUNNING", holder: { role: "APP", osPid: 999, host: "erp-app" }, startedAtMs: t - 900_000, deadlineAtMs: t - 300_000, finishedAtMs: null, targetTag: "0247_z", missing: TAGS, timedOut: false, reason: null, takeoverOf: null, dbNowMs: t });
  const org = fakeOrgDb();
  const logs: string[] = [];
  const out = await coordinateOrgMigration({ ...base, orgCode: "qa", session: await pgLockSession(pg.session("erp_org_qa")), holder: VERIFY, appCapMs: null, missingTags: org.missingTags, migrate: org.migrateAs("VERIFY", Promise.resolve()), log: (l) => void logs.push(l) });
  assert.equal(out.kind, "RAN");
  assert.deepEqual(org.ran, ["VERIFY"]);
  assert.equal(rows.get("qa")?.state, "DONE");
  assert.equal(rows.get("qa")?.holder.role, "VERIFY");
  assert.match(rows.get("qa")?.takeoverOf ?? "", /^APP pid 999@erp-app \(bắt đầu /);
  assert.ok(logs.some((l) => /TIẾP QUẢN lượt bỏ dở của APP pid 999@erp-app/.test(l)));

  // KHOÁ BẬN QUÁ HẠN TỰ KHAI: không cướp khoá đang giữ, báo LOCK_BUSY có tên người giữ.
  const holderSession = await pgLockSession(pg.session("erp_org_hslc"));
  assert.equal(await holderSession.tryLock(), true);
  rows.set("hslc", { orgCode: "hslc", runId: "treo", state: "RUNNING", holder: APP, startedAtMs: t, deadlineAtMs: t + 10_000, finishedAtMs: null, targetTag: "0247_z", missing: TAGS, timedOut: false, reason: null, takeoverOf: null, dbNowMs: t });
  const t0 = t;
  await assert.rejects(
    coordinateOrgMigration({ ...base, orgCode: "hslc", session: await pgLockSession(pg.session("erp_org_hslc")), holder: VERIFY, appCapMs: null, missingTags: async () => TAGS, migrate: async () => assert.fail("không được chạy") }),
    (e: unknown) => e instanceof OrgMigrateError && e.phase === "LOCK_BUSY" && /^APP pid 4242@erp-app giữ khoá migrate «hslc» QUÁ hạn tự khai/.test(e.message) && e.holderStatus?.runId === "treo",
  );
  assert.equal(t - t0, 10_000 + ORG_MIGRATE_HOLDER_MARGIN_MS, "chờ ĐÚNG tới hạn tự khai + biên (đồng hồ giả)");

  // Không rõ ai giữ (không dòng trạng thái) ⇒ chờ tới trần của chính mình rồi thôi.
  rows.delete("hslc");
  const t1 = t;
  await assert.rejects(
    coordinateOrgMigration({ ...base, orgCode: "hslc", session: await pgLockSession(pg.session("erp_org_hslc")), holder: VERIFY, appCapMs: null, missingTags: async () => TAGS, migrate: async () => assert.fail("không được chạy") }),
    (e: unknown) => e instanceof OrgMigrateError && e.phase === "LOCK_BUSY" && /không ghi trạng thái/.test(e.message),
  );
  assert.equal(t - t1, 630_000);

  // ỨNG DỤNG: trần ngắn, lượt kia còn trong hạn ⇒ HOLDER_RUNNING (loại hết giờ, đọc lại sau ít phút — không phải 6 giờ).
  rows.set("hslc", { orgCode: "hslc", runId: "dang-chay", state: "RUNNING", holder: VERIFY, startedAtMs: t, deadlineAtMs: t + 600_000, finishedAtMs: null, targetTag: "0247_z", missing: TAGS, timedOut: false, reason: null, takeoverOf: null, dbNowMs: t });
  const t2 = t;
  let busy: unknown = null;
  await coordinateOrgMigration({ ...base, orgCode: "hslc", session: await pgLockSession(pg.session("erp_org_hslc")), holder: APP, appCapMs: 120_000, missingTags: async () => TAGS, migrate: async () => assert.fail("không được chạy") }).catch((e: unknown) => (busy = e));
  assert.ok(busy instanceof OrgMigrateError && busy.phase === "HOLDER_RUNNING" && busy.timedOut && /^VERIFY pid 5151@erp-app đang migrate «hslc»/.test(busy.message));
  assert.equal(t - t2, 120_000);
  assert.equal(orgMigrateRetryAfterMs(busy), orgMigrateRetryAfterMs(new OrgMigrateError("LOCK_BUSY", "x")), "lùi NGẮN");
  assert.equal(orgMigrateDegradedRetryAfterMs(busy), orgMigrateRetryAfterMs(busy), "degraded vì người khác đang chạy ⇒ đọc lại sau ít phút");
  await holderSession.unlock();

  // Hai tổ chức KHÁC nhau không chờ nhau.
  const qaSession = await pgLockSession(pg.session("erp_org_qa"));
  assert.equal(await qaSession.tryLock(), true);
  const other = fakeOrgDb();
  const r = await coordinateOrgMigration({ ...base, orgCode: "hslc", session: await pgLockSession(pg.session("erp_org_hslc")), holder: APP, appCapMs: 0, missingTags: other.missingTags, migrate: other.migrateAs("APP", Promise.resolve()), sleep: async () => assert.fail("không được chờ") });
  assert.equal(r.kind, "RAN");
  await qaSession.unlock();

  // Sổ trạng thái hỏng (CSDL nhà chưa có bảng) KHÔNG chặn migrate — chỉ cảnh báo.
  const broken: OrgMigrateStatusStore = { read: async () => Promise.reject(new Error('relation "platform_org_migration_status" does not exist')), begin: async () => Promise.reject(new Error("x")), finish: async () => Promise.reject(new Error("x")) };
  const third = fakeOrgDb();
  const warn: string[] = [];
  const r3 = await coordinateOrgMigration({ ...base, store: broken, orgCode: "qa", session: await pgLockSession(pg.session("erp_org_qa")), holder: APP, appCapMs: 120_000, missingTags: third.missingTags, migrate: third.migrateAs("APP", Promise.resolve()), log: (l) => void warn.push(l) });
  assert.equal(r3.kind, "RAN");
  assert.equal(warn.filter((l) => /không đọc được trạng thái lượt migrate ở CSDL nhà/.test(l)).length, 1, "cảnh báo MỘT lần");
  // Không còn gì thiếu ⇒ không ghi dòng mới, khoá nhả.
  const r4 = await coordinateOrgMigration({ ...base, orgCode: "qa", session: await pgLockSession(pg.session("erp_org_qa")), holder: APP, appCapMs: 120_000, missingTags: async () => [], migrate: async () => assert.fail("không có gì để chạy") });
  assert.equal(r4.kind, "NOTHING");

  // B2 · người kia DONE với sổ CỦA HỌ, sổ của mình còn mục mới (deploy lẫn phiên bản) ⇒ mình CHẠY, không nhận là khoẻ.
  {
    const holderS = await pgLockSession(pg.session("erp_org_mix"));
    assert.equal(await holderS.tryLock(), true);
    rows.set("mix", { orgCode: "mix", runId: "cu", state: "RUNNING", holder: APP, startedAtMs: t, deadlineAtMs: t + 600_000, finishedAtMs: null, targetTag: "0248_cu", missing: ["0248_cu"], timedOut: false, reason: null, takeoverOf: null, dbNowMs: t });
    let ranNew = 0;
    let polls = 0;
    const out = await coordinateOrgMigration({
      ...base,
      orgCode: "mix",
      session: await pgLockSession(pg.session("erp_org_mix")),
      holder: VERIFY,
      appCapMs: null,
      targetTag: "0249_moi",
      missingTags: async () => (ranNew ? [] : ["0249_moi"]),
      migrate: async () => void ranNew++,
      sleep: async (ms) => {
        t += ms;
        if (++polls === 2) {
          const r = rows.get("mix");
          if (r) rows.set("mix", { ...r, state: "DONE", finishedAtMs: t });
          await holderS.unlock();
        }
      },
    });
    assert.equal(out.kind, "RAN", "DONE của tiến trình cũ không che mục 0249 còn thiếu");
    assert.equal(ranNew, 1);
    // Sổ không đọc được + người kia DONE ngay trước khi mình gọi ⇒ vẫn chạy (để drizzle báo đúng lỗi), không nhận.
    const prev = rows.get("mix");
    assert.ok(prev);
    rows.set("mix", { ...prev, state: "DONE", runId: "xong-truoc", finishedAtMs: t });
    let ranUnknown = 0;
    const out2 = await coordinateOrgMigration({ ...base, orgCode: "mix", session: await pgLockSession(pg.session("erp_org_mix")), holder: VERIFY, appCapMs: null, missingTags: async () => Promise.reject(new Error("sổ hình dạng lạ")), migrate: async () => void ranUnknown++ });
    assert.equal(out2.kind, "RAN");
    assert.equal(ranUnknown, 1, "CHƯA BIẾT không bao giờ được coi là «không thiếu gì»");
  }

  // NB3 · lùi liên tiến trình: tiến trình khác vừa hỏng cho cùng đích ⇒ không chạy lại ngay; quá cửa sổ ⇒ chạy.
  {
    rows.set("lui", { orgCode: "lui", runId: "hong", state: "DEGRADED", holder: APP, startedAtMs: t - 700_000, deadlineAtMs: t - 40_000, finishedAtMs: t - 60_000, targetTag: "0247_z", missing: TAGS, timedOut: true, reason: "[57014] canceling statement due to statement timeout", takeoverOf: null, dbNowMs: t });
    let ran = 0;
    let err: unknown = null;
    await coordinateOrgMigration({ ...base, orgCode: "lui", session: await pgLockSession(pg.session("erp_org_lui")), holder: VERIFY, appCapMs: null, missingTags: async () => TAGS, migrate: async () => void ran++ }).catch((e: unknown) => (err = e));
    assert.equal(ran, 0, "không chạy lại câu vừa hỏng 1 phút trước ở tiến trình khác");
    assert.ok(err instanceof OrgMigrateError && err.phase === "HOLDER_FAILED" && err.timedOut && /chưa tới hạn thử lại/.test(err.message) && /\[57014\]/.test(err.message));
    // Hạn thử lại = ĐÚNG phần còn lại của cửa sổ lùi (đồng hồ CSDL), cho cả lùi lẫn DEGRADED — không phải 6 giờ như lượt tự hỏng.
    assert.equal(err.retryAfterMs, WINDOW - 60_000);
    assert.equal(orgMigrateRetryAfterMs(err), WINDOW - 60_000);
    assert.equal(orgMigrateDegradedRetryAfterMs(err), WINDOW - 60_000);
    const busyMin = orgMigrateRetryAfterMs(new OrgMigrateError("LOCK_BUSY", "x"));
    rows.set("lui", { ...rows.get("lui")!, finishedAtMs: t - WINDOW + 1_000 });
    let err2: unknown = null;
    await coordinateOrgMigration({ ...base, orgCode: "lui", session: await pgLockSession(pg.session("erp_org_lui")), holder: VERIFY, appCapMs: null, missingTags: async () => TAGS, migrate: async () => void ran++ }).catch((e: unknown) => (err2 = e));
    assert.ok(err2 instanceof OrgMigrateError && err2.retryAfterMs === busyMin, "còn 1 giây ⇒ không ngắn hơn nhịp «khoá bận»");
    rows.set("lui", { ...rows.get("lui")!, finishedAtMs: t - 60_000 });
    t += WINDOW;
    const after = await coordinateOrgMigration({ ...base, orgCode: "lui", session: await pgLockSession(pg.session("erp_org_lui")), holder: VERIFY, appCapMs: null, missingTags: async () => (ran ? [] : TAGS), migrate: async () => void ran++ });
    assert.equal(after.kind, "RAN", "hết cửa sổ lùi ⇒ thử lại thật");
  }

  // NB4 · bên gọi thôi chờ (trần của bước kiểm) ⇒ lượt chờ dừng: không tiếp quản, không chạy — kể cả khi khoá vừa nhả với dòng mồ côi.
  {
    const holderS = await pgLockSession(pg.session("erp_org_ab"));
    assert.equal(await holderS.tryLock(), true);
    rows.set("ab", { orgCode: "ab", runId: "treo", state: "RUNNING", holder: APP, startedAtMs: t, deadlineAtMs: t + 600_000, finishedAtMs: null, targetTag: "0247_z", missing: TAGS, timedOut: false, reason: null, takeoverOf: null, dbNowMs: t });
    const ac = new AbortController();
    let ran = 0;
    let polls = 0;
    await assert.rejects(
      coordinateOrgMigration({
        ...base,
        orgCode: "ab",
        session: await pgLockSession(pg.session("erp_org_ab")),
        holder: VERIFY,
        appCapMs: null,
        signal: ac.signal,
        missingTags: async () => TAGS,
        migrate: async () => void ran++,
        sleep: async (ms) => {
          t += ms;
          if (++polls === 2) {
            ac.abort();
            await holderS.unlock(); // khoá nhả, dòng vẫn RUNNING — đúng ca tiếp quản nếu không có tín hiệu dừng
          }
        },
      }),
      (e: unknown) => e instanceof OrgMigrateError && e.phase === "ABORTED" && e.timedOut,
    );
    assert.equal(ran, 0, "sau khi bên gọi thôi chờ, không lượt VERIFY nào được chạy");
    assert.equal(rows.get("ab")?.runId, "treo", "không ghi đè trạng thái");
  }

  // NB1 · nhả khoá hỏng (lệnh tự huỷ rơi đúng câu nhả): thử lại một lần; vẫn hỏng ⇒ NÉM để bên gọi huỷ kết nối thay vì trả về bể.
  {
    let fails = 0;
    const flaky: OrgLockClient = {
      async query(text: string) {
        if (text.startsWith("select current_database()")) return { rows: [{ db: "erp_org_x", pid: 7 }] };
        if (text.includes("pg_advisory_unlock") && fails-- > 0) throw Object.assign(new Error("canceling statement due to user request"), { code: "57014" });
        return { rows: [{ ok: true }] };
      },
    };
    fails = 1;
    await (await pgLockSession(flaky)).unlock();
    fails = 2;
    await assert.rejects((await pgLockSession(flaky)).unlock(), /user request/);
  }
  assert.equal(pg.held.size, 0, "mọi khoá đã nhả");
  console.log("  ✓ tiếp quản dòng RUNNING mồ côi (ghi rõ lượt bị bỏ dở) · khoá giữ quá hạn tự khai ⇒ LOCK_BUSY có tên người giữ, không cướp khoá · không rõ ai giữ ⇒ trần của mình · APP ⇒ HOLDER_RUNNING lùi ngắn · hai tổ chức không chờ nhau · sổ trạng thái hỏng không chặn migrate · DONE với sổ của người khác / sổ không đọc được ⇒ tự chạy · lùi liên tiến trình cho cùng đích · bên gọi thôi chờ ⇒ không tiếp quản, không chạy · nhả khoá hỏng ⇒ ném để huỷ kết nối");
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
    setOrgMigrateRole("SCRIPT");
    const db = await getDbFor(org);
    setOrgMigrateRole(null);
    // Lượt vừa chạy để lại trạng thái BỀN ở CSDL nhà: ai chạy (vai trò + pid), đích, mục đã thiếu.
    const run = await readOrgMigrationStatus(ORG);
    const journal = (JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] }).entries;
    assert.equal(run.error, null);
    assert.equal(run.status?.state, "DONE");
    assert.equal(run.status?.holder.role, "SCRIPT");
    assert.equal(run.status?.holder.osPid, process.pid);
    assert.match(run.status?.holder.token ?? "", /^[0-9a-f-]{36}$/, "mã tiến trình được ghi");
    assert.equal(run.status?.targetTag, journal.at(-1)?.tag);
    assert.equal(run.status?.missing.length, journal.length, "CSDL trống ⇒ thiếu cả sổ");
    assert.ok(run.status && run.status.finishedAtMs !== null && run.status.finishedAtMs >= run.status.startedAtMs && run.status.deadlineAtMs > run.status.startedAtMs);
    console.log("  ✓ PGlite thật: mở tổ chức ⇒ dòng platform_org_migration_status DONE ở CSDL nhà (SCRIPT · pid · đích · mục đã thiếu · hạn > bắt đầu)");
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
  assert.equal(verifyOrgTimeoutMs({}), ORG_MIGRATE_RUN_TIMEOUT_DEFAULT_MS + 2 * ORG_MIGRATE_HOLDER_MARGIN_MS, "trần mỗi tổ chức DẪN XUẤT từ trần lượt");
  assert.equal(verifyOrgTimeoutMs({ ORG_MIGRATE_RUN_TIMEOUT_MS: "100000" }), 100_000 + 2 * ORG_MIGRATE_HOLDER_MARGIN_MS, "đổi trần lượt ⇒ trần bước kiểm đi theo");
  assert.equal(verifyOrgTimeoutMs({ VERIFY_ORG_MIGRATE_TIMEOUT_S: "30" }), 30_000);
  assert.equal(verifyOrgTimeoutMs({ VERIFY_ORG_MIGRATE_TIMEOUT_S: "-1" }), ORG_MIGRATE_RUN_TIMEOUT_DEFAULT_MS + 2 * ORG_MIGRATE_HOLDER_MARGIN_MS);

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

  // Tổ chức ĐANG HOẠT ĐỘNG mà lượt migrate (của tiến trình khác) hỏng thật ⇒ ERROR, bước kiểm ĐỎ; mỗi kết quả in dòng «lượt migrate».
  // Ngân sách tổng hết ⇒ tổ chức còn lại CHƯA KIỂM (đỏ). Đồng hồ ngân sách GIẢ — không phụ thuộc máy chạy.
  let fake = 0;
  const failedRun: OrgMigrateStatus = { orgCode: "loi", runId: "r9", state: "FAILED", holder: APP, startedAtMs: 1_000, deadlineAtMs: 661_000, finishedAtMs: 4_500, targetTag: "0247_z", missing: TAGS, timedOut: false, reason: "[42703] column \"x\" does not exist", takeoverOf: null, dbNowMs: 9_000 };
  const out2: string[] = [];
  const r2 = await verifyOrganizations(["ok-shop", "loi", "sau-cung"], {
    open: (code) => (code === "loi" ? ((fake += 500), Promise.reject(new OrgMigrateError("HOLDER_FAILED", `FAILED ở lượt của APP pid 4242@erp-app (3.5 giây; không chạy lượt thứ hai): ${failedRun.reason}`, undefined, { timedOut: false, holderStatus: failedRun }))) : Promise.resolve(code)),
    check: async () => ((fake += 600), 0),
    cancel: async () => false,
    runStatus: async (code) => ({ status: code === "loi" ? failedRun : null, error: null }),
    self: VERIFY,
    timeoutMs: 60_000,
    budgetMs: 1_000,
    now: () => fake,
    log: (l) => out2.push(l),
    error: (l) => out2.push(l),
  });
  assert.deepEqual(r2.map((r) => `${r.code}:${r.status}`), ["ok-shop:OK", "loi:ERROR", "sau-cung:NOT_CHECKED"]);
  assert.ok(out2.some((l) => /✗ tổ chức «loi»: không mở \/ migrate được — FAILED ở lượt của APP pid 4242@erp-app/.test(l)), "lỗi mang tên người chạy");
  assert.ok(out2.some((l) => /«loi» · lượt migrate: FAILED · APP pid 4242@erp-app · bắt đầu .* · 3\.5 giây · thiếu 0245_x, 0246_y, 0247_z · lý do: \[42703\] .* — do tiến trình KHÁC chạy; bước kiểm chờ và nhận kết quả, không chạy lượt thứ hai$/.test(l)), "dòng trạng thái: ai · bao lâu · lý do");
  assert.ok(out2.some((l) => /✗ tổ chức «sau-cung»: CHƯA KIỂM — hết ngân sách 1 giây/.test(l)));
  assert.match(runStatusLine("x", null, VERIFY, "relation does not exist"), /chưa đọc được trạng thái \(relation does not exist\)/);
  assert.doesNotMatch(runStatusLine("loi", { ...failedRun, holder: VERIFY }, VERIFY), /tiến trình KHÁC/, "lượt của chính bước kiểm không bị gắn nhãn «tiến trình khác»");

  const src = readFileSync("scripts/verify-migrations.ts", "utf8");
  assert.match(src, /if \(CHAY_THANG\) \{\n\s+main\(\)/, "main() chỉ chạy khi gọi thẳng — import từ bài kiểm không kéo process.exit");
  const mainBody = src.slice(src.indexOf("async function main()"));
  assert.ok(mainBody.indexOf('setOrgMigrateRole("VERIFY")') >= 0 && mainBody.indexOf('setOrgMigrateRole("VERIFY")') < mainBody.indexOf("getDbFor("), "bước kiểm khai vai trò VERIFY TRƯỚC khi mở tổ chức nào");
  assert.match(mainBody, /runStatus: \(code\) => readOrgMigrationStatus\(code\)/, "in trạng thái bền của lượt migrate");
  assert.match(src, /if \(results\.some\(\(r\) => r\.status !== "OK"\)\) failed = true;/, "tổ chức hỏng / quá trần ⇒ thoát 1");
  const install = readFileSync("scripts/install-vps.sh", "utf8");
  assert.match(install, /if ! docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/verify-migrations\.ts; then\n\s+warn [^\n]*\n\s+MIGRATIONS_UNAPPLIED=1\nfi\n/, "install-vps.sh: verify hỏng ⇒ cảnh báo rồi chạy TIẾP smoke (không đổi hành vi deploy)");
  console.log("  ✓ verify-migrations: trần mỗi tổ chức dẫn xuất từ trần lượt · DEGRADED ⇒ ✗ + lý do + «DEGRADED WORKSPACES» · treo ⇒ TIMEOUT + huỷ · lượt của tiến trình khác hỏng ⇒ ERROR mang tên người chạy + dòng «lượt migrate» · hết ngân sách ⇒ CHƯA KIỂM · không OK ⇒ thoát 1 · deploy chạy tiếp smoke");
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
  assert.equal((idx.match(/migrateOrganizationDb\(db, \{\s*orgCode: code,/g) ?? []).length, 2, "cả lượt mở đầu lẫn lượt thử lại nền đều đi qua điều phối theo MÃ tổ chức");
  assert.match(idx, /const adoptRunIds = new Set\(st\.holderRunIds\);\n\s+st\.holderRunIds\.clear\(\);/, "mỗi lượt đã thấy chỉ vào ĐÚNG MỘT lượt thử lại (nhận một lần rồi thôi)");
  assert.equal((idx.match(/holderStatus\?\.state === "RUNNING"\) (?:holderRunIds|st\.holderRunIds)\.add/g) ?? []).length, 2, "chỉ lượt CÒN ĐANG CHẠY mới vào tập chờ nhận");
  assert.match(idx, /h\?\.abort\?\.abort\(\);/, "cancelOrganizationMigration dừng cả lượt đang CHỜ");
  assert.match(m, /client\.release\(unlockError\)/, "nhả khoá hỏng ⇒ huỷ kết nối, không trả về bể còn cầm khoá");
  assert.match(idx, /nextRetryAt: now \+ orgMigrateDegradedRetryAfterMs\(error\)/, "degraded vì người khác đang chạy ⇒ đọc lại sau ít phút, không phải 6 giờ");
  assert.doesNotMatch(m.replace(/\/\*[\s\S]*?\*\//g, ""), /chờ khoá quá/,"không còn câu «chờ khoá quá N giây» vô danh");
  console.log("  ✓ mã nguồn: hết khoá chung vô hạn · lùi ở đúng một chỗ (getOrgDb)");
}

export async function testOrgMigrateIsolation() {
  console.log("Migrate CSDL tổ chức cô lập (sự cố 0245 ở qa, 12/10/2026):");
  testLockKey();
  testCoordinationPure();
  await testConcurrentOpeners();
  await testHolderEdgeCases();
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
