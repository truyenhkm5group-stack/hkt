/**
 * ═══════════ ops `org-lifecycle` — LƯU TRỮ / KÍCH HOẠT LẠI một tổ chức (lib/platform/org-lifecycle.ts · scripts/org-lifecycle.ts) ═══════════
 *
 *  · Một vị ngữ vận hành (`isOperationalOrganization`) cho mọi cửa vào nền: fan-out, bước kiểm deploy, job, webhook, ngữ cảnh.
 *  · Tổ chức ARCHIVED: `getDbFor` từ chối mở (= migrate), chỉ `openForReactivation` vượt qua — và chỉ lõi vòng đời gọi nó.
 *  · Lưu trữ bị TỪ CHỐI khi: nhà · nghiệm thu SaaS · còn nghĩa vụ tiền (hoá đơn MỞ …) · sao lưu thiếu / hỏng / không ngoài máy / cũ ·
 *    diễn tập thiếu / SKIPPED / FAILED / sai CSDL / cũ. Lời khai diễn tập đọc CHUNG (trường `site` được chấp nhận).
 *  · Ghi: đúng một cột trạng thái + nhật ký nền tảng; đã ARCHIVED ⇒ không làm gì; kích hoạt lại chỉ ACTIVE khi đối chiếu sổ ĐẠT.
 *  · Thẻ sao lưu: tổ chức lưu trữ vẫn liệt kê nhưng không vào danh sách "HỎNG" của khách đang chạy.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { getDb, getDbFor, getPlatformDb, OrganizationArchivedError, schema } from "@/db";
import { splitOrgBackupRowsByStatus, type BackupStatusFiles } from "@/lib/constants/backup";
import { OrgContextError, withOrganization } from "@/lib/platform/context";
import { applyOffboard } from "@/lib/platform/offboard";
import {
  applyArchive,
  applyReactivate,
  archiveRefusals,
  archiveVerdict,
  backupEvidence,
  drillEvidence,
  lifecyclePlanLines,
  openForReactivation,
  planLifecycle,
  reactivateRefusals,
  type BackupEvidence,
  type DrillEvidence,
  type Obligation,
} from "@/lib/platform/org-lifecycle";
import { fanOutOrganizationCodes, invalidateOrganizations, isOperationalOrganization, listOrganizations, mayOpenOrganizationDb } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import type { Organization } from "@/lib/platform/types";
import { rowsOf } from "@/lib/sql-rows";
import { parseLifecycleArgs } from "@/scripts/org-lifecycle";
import { checkDb, readJournalEntries, verifyOrganizations } from "@/scripts/verify-migrations";

const goc = path.resolve(__dirname, "..");
const doc = (p: string) => readFileSync(path.join(goc, p), "utf8");

const NOW = new Date("2026-10-17T03:00:00Z");
const hAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const DB = "erp_org_qa";

const backupOk = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  kind: "org-backup",
  database: DB,
  result: "OK",
  trigger: "hourly",
  finishedAt: hAgo(1),
  db: { file: "x.dump", bytes: 1000, tableData: 10 },
  offsite: { state: "OK", remote: "r", reason: null },
  retention: {},
  ...over,
});
const drillOk = (over: Record<string, unknown> = {}) => ({ schema: 1, kind: "restore-drill", scope: "ORGANIZATION", database: DB, result: "OK", startedAt: hAgo(5), finishedAt: hAgo(4), reason: null, dumpFile: "x.dump", tables: [], ...over });
const noMoney: Obligation[] = [
  { key: "OPEN_INVOICE", rows: 0, amountVnd: null },
  { key: "PENDING_TOPUP", rows: 0, amountVnd: null },
  { key: "AI_CASH_BALANCE", rows: 0, amountVnd: null },
  { key: "PREPAID_PERIOD", rows: 0, amountVnd: null },
  { key: "UNRESOLVED_PAYMENT", rows: 0, amountVnd: null },
];
const ev = (files: Partial<BackupStatusFiles> & { lastSuccess?: unknown; lastDrill?: unknown }) => {
  const f: BackupStatusFiles = { dirReadable: true, ...files };
  return { backup: backupEvidence(f, DB, NOW), drill: drillEvidence(f.dirReadable, f.lastDrill, DB, NOW) };
};
const codes = (r: { code: string }[]) => r.map((x) => x.code).sort();
const refuse = (o: { obligations?: Obligation[]; backup: BackupEvidence; drill: DrillEvidence; isHome?: boolean; acceptance?: boolean }) =>
  archiveRefusals({ org: { code: "qa", isHome: o.isHome ?? false }, acceptance: o.acceptance ?? false, externalDatabase: false, obligations: o.obligations ?? noMoney, backup: o.backup, drill: o.drill });

function org(code: string, status: Organization["status"], isHome = false): Organization {
  return { id: `id-${code}`, code, name: code, status, isHome, moduleDefault: "DISABLED", plan: null, templateKey: null };
}

function tepMa(thuMuc: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ten of readdirSync(path.join(goc, d))) {
      if (ten === "node_modules" || ten.startsWith(".")) continue;
      const rel = `${d}/${ten}`;
      const st = statSync(path.join(goc, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(ten)) out.push(rel.split(path.sep).join("/"));
    }
  };
  walk(thuMuc);
  return out;
}

export function testOrgLifecyclePure() {
  // ── vị ngữ ──
  assert.equal(isOperationalOrganization(org("a", "ACTIVE")), true);
  for (const s of ["SUSPENDED", "ARCHIVED", "SETUP_FAILED"] as const) assert.equal(isOperationalOrganization(org("a", s)), false, `${s} không được chạy`);
  assert.equal(mayOpenOrganizationDb(org("a", "ARCHIVED")), false);
  for (const s of ["ACTIVE", "SUSPENDED", "SETUP_FAILED"] as const) assert.equal(mayOpenOrganizationDb(org("a", s)), true);
  assert.deepEqual(fanOutOrganizationCodes([org("home", "ACTIVE", true), org("qa", "ARCHIVED"), org("z", "ACTIVE"), org("b", "ACTIVE"), org("s", "SUSPENDED"), org("f", "SETUP_FAILED")]), ["b", "z"], "fan-out + bước kiểm deploy: chỉ ACTIVE, không nhà");

  // ── bằng chứng sao lưu / diễn tập ──
  const good = ev({ lastSuccess: backupOk(), lastDrill: drillOk() });
  assert.equal(good.backup.state, "OK");
  assert.equal(good.drill.state, "OK");
  assert.deepEqual(refuse(good), [], "đủ điều kiện ⇒ lưu trữ được");
  assert.equal(archiveVerdict("ACTIVE", []), "ARCHIVABLE");
  assert.equal(archiveVerdict("SUSPENDED", []), "ARCHIVABLE");
  assert.equal(archiveVerdict("ARCHIVED", []), "ALREADY_ARCHIVED", "đã lưu trữ ⇒ không làm gì, không phải lỗi");
  assert.equal(archiveVerdict("ACTIVE", [{ code: "HOME", text: "x" }]), "REFUSED");
  // Diễn tập NGOÀI MÁY: cùng hình dạng, thêm `site` — được chấp nhận, không đòi chạy trên VPS.
  const external = ev({ lastSuccess: backupOk(), lastDrill: drillOk({ site: "offsite-runner" }) });
  assert.equal(external.drill.state, "OK");
  assert.equal(external.drill.site, "offsite-runner");
  assert.deepEqual(refuse(external), []);

  // ── từ chối: tiền ──
  const withInvoice = noMoney.map((o) => (o.key === "OPEN_INVOICE" ? { ...o, rows: 1, amountVnd: 199_000 } : o));
  assert.deepEqual(codes(refuse({ ...good, obligations: withInvoice })), ["MONEY_OBLIGATION"], "hoá đơn MỞ ⇒ từ chối (hs-thien-nga-test)");
  for (const k of ["PENDING_TOPUP", "AI_CASH_BALANCE", "PREPAID_PERIOD", "UNRESOLVED_PAYMENT"] as const) {
    assert.deepEqual(codes(refuse({ ...good, obligations: noMoney.map((o) => (o.key === k ? { ...o, rows: 1 } : o)) })), ["MONEY_OBLIGATION"], `${k} ⇒ từ chối`);
  }
  // ── từ chối: nhà / nghiệm thu ──
  assert.ok(codes(refuse({ ...good, isHome: true })).includes("HOME"));
  assert.ok(codes(refuse({ ...good, acceptance: true })).includes("ACCEPTANCE_WORKSPACE"), "workspace nghiệm thu SaaS phải giữ ACTIVE");
  // ── từ chối: sao lưu ──
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk({ finishedAt: hAgo(27) }), lastDrill: drillOk() }))), ["BACKUP_STALE"], "sao lưu 27 giờ ⇒ cũ");
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk({ finishedAt: hAgo(25.9) }), lastDrill: drillOk() }))), [], "25,9 giờ vẫn trong 26");
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk({ offsite: { state: "NOT_CONFIGURED" } }), lastDrill: drillOk() }))), ["BACKUP_NOT_OFFSITE"]);
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk({ result: "PARTIAL" }), lastDrill: drillOk() }))), ["BACKUP_NOT_OK"]);
  assert.deepEqual(codes(refuse(ev({ lastDrill: drillOk() }))), ["BACKUP_MISSING"]);
  assert.deepEqual(codes(refuse(ev({ lastSuccess: "<unparsable>", lastDrill: drillOk() }))), ["BACKUP_UNREADABLE"]);
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk({ database: "erp_org_khac" }), lastDrill: drillOk() }))), ["BACKUP_UNREADABLE"], "lời khai của CSDL khác không phải bằng chứng");
  assert.ok(codes(refuse(ev({ dirReadable: false }))).includes("BACKUP_NOT_MOUNTED"));
  // ── từ chối: diễn tập ──
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk(), lastDrill: drillOk({ result: "SKIPPED", reason: "thiếu chỗ" }) }))), ["DRILL_NOT_OK"], "diễn tập SKIPPED ⇒ từ chối");
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk(), lastDrill: drillOk({ result: "FAILED" }) }))), ["DRILL_NOT_OK"]);
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk(), lastDrill: drillOk({ finishedAt: hAgo(73) }) }))), ["DRILL_STALE"], "diễn tập 73 giờ ⇒ cũ");
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk() }))), ["DRILL_MISSING"]);
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk(), lastDrill: drillOk({ database: "erp_org_khac" }) }))), ["DRILL_UNREADABLE"], "diễn tập CSDL khác ⇒ không dùng được");
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk(), lastDrill: drillOk({ scope: undefined }) }))), ["DRILL_UNREADABLE"], "diễn tập của NHÀ (không scope ORGANIZATION) không phủ CSDL tổ chức");
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk(), lastDrill: { schema: 1, kind: "restore-drill", scope: "ORGANIZATION", database: DB, result: "OK" } }))), ["DRILL_UNREADABLE"], "thiếu finishedAt ⇒ không dùng được");

  // ── kích hoạt lại ──
  assert.deepEqual(reactivateRefusals({ isHome: false, status: "ARCHIVED" }), []);
  assert.deepEqual(codes(reactivateRefusals({ isHome: false, status: "ACTIVE" })), ["NOT_ARCHIVED"]);
  assert.deepEqual(codes(reactivateRefusals({ isHome: false, status: "SUSPENDED" })), ["NOT_ARCHIVED"], "đình chỉ dùng công tắc, không phải lượt kích hoạt lại");
  assert.ok(codes(reactivateRefusals({ isHome: true, status: "ACTIVE" })).includes("HOME"));

  // ── ô arg ──
  assert.deepEqual(parseLifecycleArgs([]), { ok: true, mode: "LIST" });
  assert.deepEqual(parseLifecycleArgs(["qa"]), { ok: true, mode: "PLAN", code: "qa", action: null });
  assert.deepEqual(parseLifecycleArgs(["qa", "--archive"]), { ok: true, mode: "PLAN", code: "qa", action: "ARCHIVE" }, "thiếu --apply ⇒ chạy thử");
  assert.deepEqual(parseLifecycleArgs(["qa", "--archive", "--apply", "--confirm=qa"]), { ok: true, mode: "ARCHIVE", code: "qa", confirm: "qa" });
  assert.deepEqual(parseLifecycleArgs(["qa", "--reactivate", "--apply", "--confirm=qa", "--timeout=300"]), { ok: true, mode: "REACTIVATE", code: "qa", confirm: "qa", timeoutMs: 300_000 });
  for (const bad of [["qa", "--apply", "--confirm=qa"], ["qa", "--archive", "--apply"], ["qa", "--archive", "--reactivate"], ["qa", "--drop"], ["qa", "b"], ["--archive"], ["QA"], ["qa", "--archive", "--timeout=5"], ["qa", "--reactivate", "--apply", "--confirm=qa", "--timeout=5000"]]) {
    const r = parseLifecycleArgs(bad);
    assert.equal(r.ok, false, `arg sai phải bị từ chối: ${bad.join(" ")}`);
  }

  // ── thẻ sao lưu: lưu trữ tách khỏi "HỎNG" của khách đang chạy ──
  const owners = new Map([
    ["erp_org_qa", { code: "qa", status: "ARCHIVED" }],
    ["erp_org_hslc", { code: "hslc", status: "ACTIVE" }],
  ]);
  const split = splitOrgBackupRowsByStatus(
    { organizations: [{ database: "erp_org_qa", result: "FAILED", reason: null }, { database: "erp_org_hslc", result: "OK", reason: null }, { database: "erp_org_la", result: "FAILED", reason: null }] },
    owners,
  );
  assert.deepEqual(split.failingLive, ["erp_org_la"], "CSDL không khớp sổ vẫn báo HỎNG (chưa biết thì không giấu); tổ chức lưu trữ không vào đây");
  assert.deepEqual(split.archived, [{ database: "erp_org_qa", code: "qa", result: "FAILED" }], "tổ chức lưu trữ vẫn được liệt kê");

  // ── dòng in công khai: không dữ liệu người ──
  const lines = lifecyclePlanLines(
    {
      org: { id: "x", code: "qa", status: "ACTIVE", isHome: false },
      kind: "OPERATOR_CREATED",
      acceptance: false,
      commercial: "NOT_BILLED",
      obligations: withInvoice,
      database: { name: DB, external: false },
      backup: good.backup,
      drill: external.drill,
      activity: { readable: true, orders: 3, activeConnections: 0, activeChannelPages: 0, messengerPages: 0 },
      refusals: refuse({ ...good, obligations: withInvoice }),
      verdict: "REFUSED",
    },
    "thiếu 2 migration",
  );
  assert.ok(lines[0].includes("VẬN HÀNH ACTIVE") && lines[0].includes("THƯƠNG MẠI NOT_BILLED") && lines[0].includes("TRIỂN KHAI thiếu 2 migration"), "ba chiều in tách rời");
  assert.ok(lines.some((l) => l.includes("MONEY_OBLIGATION")));
  for (const l of lines) assert.ok(!l.includes("x.dump"), "không in tên tệp sao lưu");

  // ── QUÉT MÃ NGUỒN: cửa vào nền đi qua vị ngữ chung ──
  assert.match(doc("lib/platform/organizations.ts"), /fanOutOrganizationCodes[\s\S]*?isOperationalOrganization\(o\) && !o\.isHome/, "fan-out dùng vị ngữ chung");
  const CUA_VAO = ["lib/platform/context.ts", "lib/sync/jobs.ts", "lib/platform/webhooks.ts", "lib/saas/tenant-value-capture.ts", "lib/platform/saas-ledger.ts", "app/api/health/route.ts"];
  for (const f of CUA_VAO) {
    const m = doc(f);
    assert.ok(m.includes("isOperationalOrganization("), `${f} phải hỏi isOperationalOrganization()`);
    assert.doesNotMatch(m, /\b(?:org|target|o)\.status\s*[!=]==\s*"ACTIVE"/, `${f}: so chuỗi trạng thái tổ chức tay — dùng isOperationalOrganization()`);
  }
  const verify = doc("scripts/verify-migrations.ts");
  assert.match(verify, /const codes = fanOutOrganizationCodes\(await listOrganizations\(\)\);/, "bước kiểm deploy lấy tập tổ chức từ fan-out — không danh sách riêng");
  assert.doesNotMatch(verify, /ARCHIVED|SKIP_ORGS|skipOrgs|BO_QUA/, "bước kiểm deploy không có danh sách bỏ qua thứ hai (tổ chức ACTIVE migrate hỏng LUÔN đỏ)");
  assert.match(doc("app/api/sync/organizations/route.ts"), /fanOutOrganizationCodes\(await listOrganizations\(\)\)/);
  const dbIndex = doc("db/index.ts");
  assert.match(dbIndex, /export async function getDbFor\([\s\S]*?if \(!opts\.reactivation\) \{[\s\S]*?mayOpenOrganizationDb\(registered\)[\s\S]*?throw new OrganizationArchivedError/, "getDbFor chặn tổ chức lưu trữ");
  assert.match(doc("lib/queries/platform-health.ts"), /mode === "APP" && !mayOpenOrganizationDb\(org\)/, "trang /platform không migrate tổ chức lưu trữ");
  // Lối vượt chốt chỉ ở lõi vòng đời.
  const vuot: string[] = [];
  for (const d of ["lib", "app", "scripts", "db", "chatbot", "components"]) for (const f of tepMa(d)) if (/reactivation:\s*true\b/.test(doc(f))) vuot.push(f);
  assert.deepEqual(vuot, ["lib/platform/org-lifecycle.ts"], "chỉ lõi vòng đời được mở CSDL tổ chức lưu trữ");
  const vongDoi = doc("lib/platform/org-lifecycle.ts");
  assert.doesNotMatch(vongDoi, /drop\s+database|delete\s+from/i, "lưu trữ không xoá, không DROP");
  // Sao lưu vẫn phủ tổ chức lưu trữ.
  assert.match(doc("scripts/erp-backup.sh"), /status in \('ACTIVE','SUSPENDED','ARCHIVED'\)/, "tổ chức lưu trữ mất CSDL vẫn bị cảnh báo");
  // ops-vps
  const ops = doc(".github/workflows/ops-vps.yml");
  assert.match(ops, /- org-lifecycle\s+#/, "ops-vps khai lựa chọn org-lifecycle");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\borg-lifecycle\b/, "kết quả mã hoá");
  assert.match(ops, /DOC_NANG="[^"]*\borg-lifecycle\b/, "mặc định là thao tác ĐỌC (cờ --apply tự thành GHI)");
  assert.match(ops, /\n\s+org-lifecycle\)\n[\s\S]*?kiem_arg\n\s+ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/org-lifecycle\.ts ;;/, "nhánh case chạy đúng script, trong ma_hoa_ket_qua");
  console.log("  ✓ org-lifecycle (thuần): một vị ngữ vận hành · fan-out / bước kiểm deploy chỉ ACTIVE · từ chối khi tiền / sao lưu / diễn tập (SKIPPED, cũ, sai CSDL) · diễn tập ngoài máy được chấp nhận · thẻ sao lưu tách tổ chức lưu trữ · chỉ lõi vòng đời vượt chốt getDbFor");
}

// ─────────────────────────── CSDL ───────────────────────────

const MA = "lc-thu";
const TEN = "Cửa Hàng Vòng Đời Thử";
const EMAIL = "vongdoi.lifecycle@example.com";

async function orgStatus(code: string): Promise<string | null> {
  const pdb = await getPlatformDb();
  return rowsOf<{ status: string }>(await pdb.execute(sql`select status from platform_organizations where code = ${code}`))[0]?.status ?? null;
}

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.execute(sql`delete from platform_invoices where org_code = ${MA}`);
  await pdb.execute(sql`update platform_organizations set brand = 'chotdon', status = 'ACTIVE', settings = jsonb_set(settings, '{onboarding}', '{"source":"OPEN"}'::jsonb) where code = ${MA}`);
  invalidateOrganizations();
  const r = await applyOffboard(MA, { confirm: MA, createdBefore: new Date(Date.now() + 3_600_000), allowActive: true }, {});
  assert.ok(r.outcome === "DONE" || r.outcome === "GONE", `dọn ${MA}: ${r.lines.join(" | ")}`);
  await pdb.execute(sql`delete from platform_audit_log where target_org_code = ${MA}`);
  invalidateOrganizations();
}

export async function testOrgLifecycleDb() {
  await cleanup();
  await provisionOrganization({ code: MA, name: TEN, brand: "chotdon", modules: ["customers", "orders"], admin: { email: EMAIL, name: TEN, password: "VongDoi@12345" }, source: "TEST", actor: null });
  invalidateOrganizations();
  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const dbName = (await planLifecycle(MA))!.database.name;
  let files: BackupStatusFiles = { dirReadable: true };
  const deps = { now: () => now, readBackupFiles: async () => files };
  try {
    // 1 · chưa có sao lưu / diễn tập ⇒ TỪ CHỐI, không đổi gì.
    const p0 = await planLifecycle(MA, deps);
    assert.ok(p0);
    assert.equal(p0.verdict, "REFUSED");
    assert.deepEqual(codes(p0.refusals), ["BACKUP_MISSING", "DRILL_MISSING"]);
    // 2 · có sao lưu + diễn tập đạt nhưng còn hoá đơn MỞ ⇒ TỪ CHỐI vì tiền.
    files = {
      dirReadable: true,
      lastSuccess: { ...backupOk(), database: dbName, finishedAt: ago(1) },
      lastDrill: { ...drillOk(), database: dbName, finishedAt: ago(2), site: "ngoai-may" },
    };
    const pdb = await getPlatformDb();
    await pdb.insert(schema.platformInvoices).values({ orgCode: MA, planKey: "basic", months: 1, periodStart: "2026-11-01", periodEnd: "2026-11-30", listAmountVnd: 199_000, amountVnd: 199_000, transferCode: "ERPHDLC0001", kind: "RENEWAL" });
    const p1 = await planLifecycle(MA, deps);
    assert.deepEqual(codes(p1!.refusals), ["MONEY_OBLIGATION"], "hoá đơn MỞ ⇒ không lưu trữ");
    const r1 = await applyArchive(MA, { confirm: MA }, deps);
    assert.equal(r1.outcome, "REFUSED");
    assert.equal(await orgStatus(MA), "ACTIVE", "từ chối ⇒ trạng thái nguyên");
    await pdb.execute(sql`update platform_invoices set status = 'VOID', void_reason = 'kiểm thử' where org_code = ${MA}`);

    // 3 · sai confirm ⇒ TỪ CHỐI.
    const r2 = await applyArchive(MA, { confirm: "khac" }, deps);
    assert.equal(r2.outcome, "REFUSED");
    assert.equal(await orgStatus(MA), "ACTIVE");

    // 4 · lưu trữ ⇒ ARCHIVED trong CSDL; dữ liệu còn; mọi cửa vào từ chối.
    const r3 = await applyArchive(MA, { confirm: MA }, deps);
    assert.equal(r3.outcome, "DONE", r3.lines.join(" | "));
    assert.equal(await orgStatus(MA), "ARCHIVED");
    invalidateOrganizations();
    await assert.rejects(() => getDbFor({ code: MA, isHome: false }), OrganizationArchivedError, "getDbFor không mở (= migrate) tổ chức lưu trữ");
    await assert.rejects(() => withOrganization(MA, async () => 1), OrgContextError, "job / webhook / AI không vào được tổ chức lưu trữ");
    assert.ok(!fanOutOrganizationCodes(await listOrganizations()).includes(MA), "bộ lập lịch + bước kiểm deploy bỏ tổ chức lưu trữ");
    const audit = rowsOf<{ subject: string }>(await pdb.execute(sql`select subject from platform_audit_log where target_org_code = ${MA} and action = 'ORG_ARCHIVE' order by at, id`)).map((r) => r.subject);
    assert.deepEqual(audit, ["archive:start", "archive:done"]);
    const r4 = await applyArchive(MA, { confirm: MA }, deps);
    assert.equal(r4.outcome, "NOOP", "đã lưu trữ ⇒ không làm gì");

    // 5 · kích hoạt lại mà đối chiếu không đạt ⇒ VẪN ARCHIVED.
    const r5 = await applyReactivate(MA, { confirm: MA }, { verify: async () => ({ status: "MISSING", detail: "thiếu 1" }) });
    assert.equal(r5.outcome, "VERIFY_FAILED");
    assert.equal(await orgStatus(MA), "ARCHIVED", "đối chiếu không đạt ⇒ không phục vụ khách");
    assert.equal((await applyReactivate(MA, { confirm: "khac" }, { verify: async () => ({ status: "OK" }) })).outcome, "REFUSED");

    // 6 · kích hoạt lại thật: migrate qua lối kích hoạt lại + checkDb của bước kiểm deploy ⇒ ACTIVE.
    const entries = readJournalEntries();
    const r6 = await applyReactivate(MA, { confirm: MA }, {
      verify: async (c) => {
        const [v] = await verifyOrganizations([c], { open: openForReactivation, check: (x, db) => checkDb(`kiểm thử ${x}`, db, entries), cancel: async () => false, timeoutMs: 120_000, log: () => undefined, error: () => undefined });
        return { status: v.status, detail: v.detail };
      },
    });
    assert.equal(r6.outcome, "DONE", r6.lines.join(" | "));
    assert.equal(await orgStatus(MA), "ACTIVE");
    invalidateOrganizations();
    const users = await withOrganization(MA, async () => (await getDb()).select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.email, EMAIL)));
    assert.equal(users.length, 1, "dữ liệu còn nguyên sau lưu trữ + kích hoạt lại");
    assert.equal((await applyReactivate(MA, { confirm: MA }, { verify: async () => ({ status: "OK" }) })).outcome, "REFUSED", "đang ACTIVE ⇒ không kích hoạt lại");
  } finally {
    await cleanup();
  }
  console.log("  ✓ org-lifecycle (CSDL): từ chối khi thiếu sao lưu / diễn tập / còn hoá đơn MỞ · lưu trữ đổi ĐÚNG cột trạng thái + nhật ký · getDbFor / withOrganization / fan-out từ chối · chạy lại = không làm gì · kích hoạt lại chỉ ACTIVE khi checkDb khớp · dữ liệu còn nguyên");
}
