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
import { getDb, getDbFor, getDbForInspection, getPlatformDb, OrganizationArchivedError, releaseOrganizationDb, schema } from "@/db";
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
  restoreStatusFor,
  type BackupEvidence,
  type DrillEvidence,
  type Obligation,
} from "@/lib/platform/org-lifecycle";
import { fanOutOrganizationCodes, invalidateOrganizations, isOperationalOrganization, listOrganizations, mayOpenOrganizationDb } from "@/lib/platform/organizations";
import { ARCHIVE_PROTECTED_ORGS, archiveProtectionOf } from "@/lib/constants/org-archive-protection";
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
const refuse = (o: { obligations?: Obligation[]; backup: BackupEvidence; drill: DrillEvidence; isHome?: boolean; acceptance?: boolean; code?: string; status?: string }) =>
  archiveRefusals({ org: { code: o.code ?? "qa", isHome: o.isHome ?? false, status: o.status ?? "ACTIVE" }, acceptance: o.acceptance ?? false, externalDatabase: false, obligations: o.obligations ?? noMoney, backup: o.backup, drill: o.drill });

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
  // Lời khai thật của `record-external-drill-org` (#884): không có `site`, `tempDatabase = ngoai-vps`, `reason` mang tên tệp.
  const ngoaiVps = ev({ lastSuccess: backupOk(), lastDrill: drillOk({ tempDatabase: "ngoai-vps", reason: "NGOÀI VPS: erp_org_qa-20261017-0300.dump" }) });
  assert.equal(ngoaiVps.drill.site, "ngoai-vps");
  assert.deepEqual(refuse(ngoaiVps), [], "diễn tập ngoài VPS đã được VPS đối chiếu ⇒ dùng được");

  // ── từ chối: tiền ──
  const withInvoice = noMoney.map((o) => (o.key === "OPEN_INVOICE" ? { ...o, rows: 1, amountVnd: 199_000 } : o));
  assert.deepEqual(codes(refuse({ ...good, obligations: withInvoice })), ["MONEY_OBLIGATION"], "hoá đơn MỞ ⇒ từ chối (hs-thien-nga-test)");
  for (const k of ["PENDING_TOPUP", "AI_CASH_BALANCE", "PREPAID_PERIOD", "UNRESOLVED_PAYMENT"] as const) {
    assert.deepEqual(codes(refuse({ ...good, obligations: noMoney.map((o) => (o.key === k ? { ...o, rows: 1 } : o)) })), ["MONEY_OBLIGATION"], `${k} ⇒ từ chối`);
  }
  // ── từ chối: nhà / sổ bảo vệ / nghiệm thu — THEO MÃ, kể cả khi sao lưu + diễn tập sạch và 0 đồng nợ ──
  assert.ok(codes(refuse({ ...good, isHome: true })).includes("HOME"));
  for (const c of ["vnx", "hslc-hmt", "hslc-hmt-shop", "hslc-vgcnj"]) {
    assert.deepEqual(codes(refuse({ ...good, code: c })), ["PROTECTED_ORG"], `${c} nằm trong sổ bảo vệ ⇒ từ chối dù mọi điều kiện khác sạch`);
    assert.ok(archiveProtectionOf(c), `${c} có mục bảo vệ kèm lý do`);
  }
  for (const o of ARCHIVE_PROTECTED_ORGS) assert.ok(o.reason.length > 20, `mục bảo vệ ${o.code} phải khai lý do`);
  assert.deepEqual(codes(refuse({ ...good, code: "hslc-moi-chua-khai" })), ["PROTECTED_ORG"], "mã HSLC mới chưa ghi vào sổ vẫn bị từ chối (tiền tố, sai về phía an toàn)");
  assert.deepEqual(codes(refuse({ ...good, code: " VNX " })), ["PROTECTED_ORG"], "so khớp chữ thường, bỏ khoảng trắng");
  for (const c of ["qa", "test-shop", "q-store", "hs-thien-nga-test"]) assert.equal(archiveProtectionOf(c), null, `${c} không nằm trong sổ bảo vệ (thử / còn tiền là chuyện khác)`);
  // ── từ chối: trạng thái ──
  assert.deepEqual(codes(refuse({ ...good, status: "SETUP_FAILED" })), ["STATUS_NOT_ARCHIVABLE"], "dựng hỏng ⇒ không lưu trữ (kích hoạt lại sẽ trả về một workspace dựng dở)");
  assert.deepEqual(codes(refuse({ ...good, status: "SUSPENDED" })), [], "đình chỉ ⇒ lưu trữ được (và kích hoạt lại về đúng SUSPENDED)");
  // ── mốc tương lai không phải "mới" ──
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk({ finishedAt: hAgo(-0.2) }), lastDrill: drillOk() }))), ["BACKUP_UNREADABLE"], "sao lưu mốc tương lai 12 phút ⇒ từ chối");
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk({ finishedAt: hAgo(-0.05) }), lastDrill: drillOk() }))), [], "lệch đồng hồ 3 phút vẫn trong dung sai");
  assert.deepEqual(codes(refuse(ev({ lastSuccess: backupOk(), lastDrill: drillOk({ finishedAt: hAgo(-1) }) }))), ["DRILL_UNREADABLE"], "diễn tập mốc tương lai ⇒ từ chối");
  // ── kích hoạt lại về ĐÚNG trạng thái cũ ──
  assert.deepEqual(restoreStatusFor("ACTIVE"), { status: "ACTIVE", fallback: false });
  assert.deepEqual(restoreStatusFor("SUSPENDED"), { status: "SUSPENDED", fallback: false }, "đình chỉ trước khi lưu trữ ⇒ vẫn đình chỉ sau khi kích hoạt lại");
  for (const x of [null, "SETUP_FAILED", "ARCHIVED", "lạ"]) assert.deepEqual(restoreStatusFor(x), { status: "SUSPENDED", fallback: true }, `trạng thái cũ ${String(x)} ⇒ SUSPENDED (phía hẹp hơn)`);
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
      commercialOpen: { liveProductSubscriptions: 2, billingEnabled: false },
      obligations: withInvoice,
      database: { name: DB, external: false },
      backup: good.backup,
      drill: drillEvidence(true, drillOk({ site: "erp_org_qa_x.dump/../ngoai may" }), DB, NOW),
      activity: { readable: true, orders: 3, activeConnections: 0, activeChannelPages: 0, messengerPages: 0 },
      refusals: refuse({ ...good, obligations: withInvoice }),
      verdict: "REFUSED",
    },
    "thiếu 2 migration",
  );
  assert.ok(lines[0].includes("VẬN HÀNH ACTIVE") && lines[0].includes("THƯƠNG MẠI NOT_BILLED") && lines[0].includes("TRIỂN KHAI thiếu 2 migration"), "ba chiều in tách rời");
  assert.ok(lines.some((l) => l.includes("MONEY_OBLIGATION")));
  for (const l of lines) assert.ok(!/\.dump|\.\.\//.test(l), `không in tên tệp sao lưu / đường dẫn: ${l}`);
  assert.ok(lines.some((l) => l.includes("CẢNH BÁO thương mại") && l.includes("thuê bao sản phẩm chưa kết thúc 2")), "chiều thương mại còn mở ⇒ cảnh báo (không chặn)");
  assert.ok(lines.some((l) => l.includes("nơi chạy (đã ẩn)")), "nơi chạy diễn tập trông như tên tệp sao lưu ⇒ ẩn");

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
  for (const f of ["lib/ai-usage/platform-ai-admin.ts", "lib/ai-usage/platform-ai-ab.ts"]) {
    assert.ok(doc(f).includes("organizationDbForReport(") && !/\bgetDbFor\(/.test(doc(f)), `${f}: tổ chức lưu trữ đọc qua handle chỉ đọc, không qua getDbFor`);
  }
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
  console.log("  ✓ org-lifecycle (thuần): một vị ngữ vận hành · fan-out / bước kiểm deploy chỉ ACTIVE · sổ bảo vệ vnx + HSLC từ chối theo mã · chỉ ACTIVE / SUSPENDED lưu trữ được, kích hoạt lại về đúng trạng thái cũ (thiếu ⇒ SUSPENDED) · mốc tương lai không phải mới · từ chối khi tiền / sao lưu / diễn tập (SKIPPED, cũ, sai CSDL) · diễn tập ngoài máy được chấp nhận · thẻ sao lưu tách tổ chức lưu trữ · chỉ lõi vòng đời vượt chốt getDbFor");
}

// ─────────────────────────── CSDL ───────────────────────────

const MA = "lc-thu";
const TEN = "Cửa Hàng Vòng Đời Thử";
const EMAIL = "vongdoi.lifecycle@example.com";

async function orgStatus(code: string): Promise<string | null> {
  const pdb = await getPlatformDb();
  return rowsOf<{ status: string }>(await pdb.execute(sql`select status from platform_organizations where code = ${code}`))[0]?.status ?? null;
}

async function setStatus(code: string, status: string) {
  const pdb = await getPlatformDb();
  await pdb.execute(sql`update platform_organizations set status = ${status} where code = ${code}`);
  invalidateOrganizations();
}

async function auditSubjects(code: string, action: string): Promise<string[]> {
  const pdb = await getPlatformDb();
  return rowsOf<{ subject: string }>(await pdb.execute(sql`select subject from platform_audit_log where target_org_code = ${code} and action = ${action} order by at, id`)).map((r) => r.subject);
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

/** Đối chiếu thật: mở qua lối kích hoạt lại (migrate) rồi checkDb của bước kiểm deploy. */
const realVerify = async (c: string) => {
  const entries = readJournalEntries();
  const [v] = await verifyOrganizations([c], { open: openForReactivation, check: (x, db) => checkDb(`kiểm thử ${x}`, db, entries), cancel: async () => false, timeoutMs: 120_000, log: () => undefined, error: () => undefined });
  return { status: v.status, detail: v.detail };
};
const okVerify = async () => ({ status: "OK" as const });

export async function testOrgLifecycleDb() {
  await cleanup();
  await provisionOrganization({ code: MA, name: TEN, brand: "chotdon", modules: ["customers", "orders"], admin: { email: EMAIL, name: TEN, password: "VongDoi@12345" }, source: "TEST", actor: null });
  invalidateOrganizations();
  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const dbName = (await planLifecycle(MA))!.database.name;
  let files: BackupStatusFiles = { dirReadable: true };
  const deps = { now: () => now, readBackupFiles: async () => files };
  const pdb = await getPlatformDb();
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
    await pdb.insert(schema.platformInvoices).values({ orgCode: MA, planKey: "basic", months: 1, periodStart: "2026-11-01", periodEnd: "2026-11-30", listAmountVnd: 199_000, amountVnd: 199_000, transferCode: "ERPHDLC0001", kind: "RENEWAL" });
    const p1 = await planLifecycle(MA, deps);
    assert.deepEqual(codes(p1!.refusals), ["MONEY_OBLIGATION"], "hoá đơn MỞ ⇒ không lưu trữ");
    assert.equal((await applyArchive(MA, { confirm: MA }, deps)).outcome, "REFUSED");
    assert.equal(await orgStatus(MA), "ACTIVE", "từ chối ⇒ trạng thái nguyên");
    await pdb.execute(sql`update platform_invoices set status = 'VOID', void_reason = 'kiểm thử' where org_code = ${MA}`);
    // 3 · sai confirm ⇒ TỪ CHỐI. SETUP_FAILED ⇒ TỪ CHỐI.
    assert.equal((await applyArchive(MA, { confirm: "khac" }, deps)).outcome, "REFUSED");
    await setStatus(MA, "SETUP_FAILED");
    const rSetup = await applyArchive(MA, { confirm: MA }, deps);
    assert.ok(rSetup.outcome === "REFUSED" && codes(rSetup.refusals).includes("STATUS_NOT_ARCHIVABLE"), "dựng hỏng ⇒ không lưu trữ");
    await setStatus(MA, "ACTIVE");
    // 4 · tiền về GIỮA lượt ⇒ hoàn tác + archive:stopped (finally).
    const rLate = await applyArchive(MA, { confirm: MA }, { ...deps, hook: async () => void (await pdb.insert(schema.platformInvoices).values({ orgCode: MA, planKey: "basic", months: 1, periodStart: "2026-12-01", periodEnd: "2026-12-31", listAmountVnd: 199_000, amountVnd: 199_000, transferCode: "ERPHDLC0002", kind: "RENEWAL" })) });
    assert.equal(rLate.outcome, "CHANGED_DURING_RUN");
    assert.equal(await orgStatus(MA), "ACTIVE", "tiền về giữa chừng ⇒ hoàn tác");
    assert.deepEqual(await auditSubjects(MA, "ORG_ARCHIVE"), ["archive:start", "archive:stopped"], "không tới done ⇒ luôn có stopped");
    await pdb.execute(sql`update platform_invoices set status = 'VOID', void_reason = 'kiểm thử' where org_code = ${MA} and status = 'OPEN'`);
    await pdb.execute(sql`delete from platform_audit_log where target_org_code = ${MA}`);

    // 5 · SỔ MIGRATION TỤT: bỏ ĐÚNG mục 0247 (ghim THEO TÊN, không theo vị trí — 0247 chỉ `CREATE INDEX IF NOT EXISTS`, áp lại vô hại)
    //     khỏi sổ của CSDL tổ chức, như một CSDL đứng ngoài migration trong lúc lưu trữ. Bài kiểm KHÔNG BAO GIỜ áp lại migration nào
    //     khác (AGENTS.md mục 50 / 65): migration mới vào kho sau 0247 không đổi được kết luận của bài này.
    const entries = readJournalEntries();
    const PIN = "0247_sales_chat_inbound_text_hash_idx";
    const pin = entries.find((e) => e.tag === PIN);
    assert.ok(pin, `sổ migration phải còn ${PIN}`);
    assert.match(readFileSync(path.join(goc, "drizzle", `${PIN}.sql`), "utf8").replace(/--.*$/gm, ""), /create index if not exists/i, `${PIN} phải idempotent`);
    const pinIsLast = entries[entries.length - 1].tag === PIN;
    const saved = await withOrganization(MA, async () => {
      const db = await getDb();
      const [row] = rowsOf<{ hash: string; created_at: string | number }>(await db.execute(sql`select hash, created_at from "drizzle"."__drizzle_migrations" where created_at = ${pin.when}`));
      await db.execute(sql`delete from "drizzle"."__drizzle_migrations" where created_at = ${pin.when}`);
      return row;
    });
    assert.ok(saved, "CSDL tổ chức đã áp 0247 trước khi bị bỏ khỏi sổ");

    // 6 · ACTIVE ⇒ lưu trữ: ĐÚNG cột trạng thái + nhật ký; mọi cửa vào từ chối.
    const r3 = await applyArchive(MA, { confirm: MA }, deps);
    assert.equal(r3.outcome, "DONE", r3.lines.join(" | "));
    assert.equal(await orgStatus(MA), "ARCHIVED");
    invalidateOrganizations();
    await assert.rejects(() => getDbFor({ code: MA, isHome: false }), OrganizationArchivedError, "getDbFor không mở (= migrate) tổ chức lưu trữ");
    await assert.rejects(() => withOrganization(MA, async () => 1), OrgContextError, "job / webhook / AI không vào được tổ chức lưu trữ");
    assert.ok(!fanOutOrganizationCodes(await listOrganizations()).includes(MA), "bộ lập lịch + bước kiểm deploy bỏ tổ chức lưu trữ");
    assert.deepEqual(await auditSubjects(MA, "ORG_ARCHIVE"), ["archive:start", "archive:done"]);
    assert.equal((await applyArchive(MA, { confirm: MA }, deps)).outcome, "NOOP", "đã lưu trữ ⇒ không làm gì");
    // Sổ đang tụt đúng một mục (đo qua handle CHỈ ĐỌC — không migrate).
    const insp = await getDbForInspection({ code: MA, isHome: false });
    assert.equal(await checkDb("kiểm thử (chỉ đọc)", insp, entries), 1, "CSDL lưu trữ thiếu đúng mục 0247");
    await releaseOrganizationDb(MA, { inspectionOnly: true });

    // 7 · đối chiếu không đạt ⇒ VẪN ARCHIVED (+ reactivate:stopped).
    const r5 = await applyReactivate(MA, { confirm: MA }, { verify: async () => ({ status: "MISSING", detail: "thiếu 1" }) });
    assert.equal(r5.outcome, "VERIFY_FAILED");
    assert.equal(await orgStatus(MA), "ARCHIVED", "đối chiếu không đạt ⇒ không phục vụ khách");
    assert.equal((await applyReactivate(MA, { confirm: "khac" }, { verify: okVerify })).outcome, "REFUSED");
    assert.deepEqual(await auditSubjects(MA, "ORG_REACTIVATE"), ["reactivate:start", "reactivate:stopped"]);

    // 8 · kích hoạt lại thật (migrate + checkDb). Hai nhánh, CẢ HAI đều là khẳng định về hành vi thật, không nhánh nào bỏ qua:
    //   · 0247 là mục CUỐI ⇒ drizzle áp lại nó ⇒ sổ khớp ⇒ về ĐÚNG trạng thái cũ (ACTIVE).
    //   · đã có migration SAU 0247 ⇒ drizzle KHÔNG áp lại mục có mốc cũ hơn mốc đã áp (bị bỏ qua vĩnh viễn) ⇒ checkDb MISSING ⇒ VẪN
    //     ARCHIVED. Rồi trả dòng sổ về đúng như cũ (không chạy SQL migration nào) và kích hoạt lại ⇒ ACTIVE.
    if (!pinIsLast) {
      const rSkip = await applyReactivate(MA, { confirm: MA }, { verify: realVerify });
      assert.equal(rSkip.outcome, "VERIFY_FAILED", "mục bị bỏ qua vĩnh viễn ⇒ đối chiếu không đạt ⇒ không bật");
      assert.equal(await orgStatus(MA), "ARCHIVED");
      // Ghi lại dòng sổ qua lối kích hoạt lại (handle GHI của chính tiến trình kiểm thử), đúng hash + mốc đã lưu.
      const w = await openForReactivation(MA);
      await w.execute(sql`insert into "drizzle"."__drizzle_migrations" (hash, created_at) values (${saved.hash}, ${saved.created_at})`);
      await releaseOrganizationDb(MA);
    }
    const r6 = await applyReactivate(MA, { confirm: MA }, { verify: realVerify });
    assert.ok(r6.outcome === "DONE" && r6.status === "ACTIVE" && !r6.fallback, r6.lines.join(" | "));
    assert.equal(await orgStatus(MA), "ACTIVE");
    invalidateOrganizations();
    assert.equal(await withOrganization(MA, async () => checkDb("kiểm thử sau kích hoạt", await getDb(), entries)), 0, "sổ migration đã khớp sau kích hoạt lại");
    const users = await withOrganization(MA, async () => (await getDb()).select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.email, EMAIL)));
    assert.equal(users.length, 1, "dữ liệu còn nguyên sau lưu trữ + kích hoạt lại");
    assert.equal((await applyReactivate(MA, { confirm: MA }, { verify: okVerify })).outcome, "REFUSED", "đang ACTIVE ⇒ không kích hoạt lại");

    // 9 · ĐÌNH CHỈ ⇒ lưu trữ ⇒ kích hoạt lại ⇒ VẪN ĐÌNH CHỈ (công tắc khẩn không bị gỡ lặng lẽ).
    await setStatus(MA, "SUSPENDED");
    assert.equal((await applyArchive(MA, { confirm: MA }, deps)).outcome, "DONE");
    const r7 = await applyReactivate(MA, { confirm: MA }, { verify: okVerify });
    assert.ok(r7.outcome === "DONE" && r7.status === "SUSPENDED" && !r7.fallback, r7.lines.join(" | "));
    assert.equal(await orgStatus(MA), "SUSPENDED", "đình chỉ trước khi lưu trữ ⇒ vẫn đình chỉ");

    // 10 · không đọc được trạng thái cũ ⇒ SUSPENDED (phía hẹp hơn) và nói ra.
    await setStatus(MA, "ACTIVE");
    assert.equal((await applyArchive(MA, { confirm: MA }, deps)).outcome, "DONE");
    await pdb.execute(sql`delete from platform_audit_log where target_org_code = ${MA} and action = 'ORG_ARCHIVE'`);
    // Nhật ký của tổ chức CŨ cùng mã (ghi TRƯỚC lúc tạo dòng tổ chức hiện tại) không được dùng làm trạng thái cũ.
    await pdb.insert(schema.platformAuditLog).values({ targetOrgCode: MA, action: "ORG_ARCHIVE", subject: "archive:done", before: { status: "ACTIVE" }, after: { status: "ARCHIVED" }, source: "TEST", at: new Date(Date.now() - 400 * 86_400_000) });
    const r8 = await applyReactivate(MA, { confirm: MA }, { verify: okVerify });
    assert.ok(r8.outcome === "DONE" && r8.status === "SUSPENDED" && r8.fallback, r8.lines.join(" | "));
    assert.ok(r8.lines.some((l) => l.includes("KHÔNG đọc được trạng thái trước khi lưu trữ")), "lùi về SUSPENDED phải được nói ra");
    assert.equal(await orgStatus(MA), "SUSPENDED");
  } finally {
    await cleanup();
  }
  console.log("  ✓ org-lifecycle (CSDL): từ chối khi thiếu sao lưu / diễn tập / còn hoá đơn MỞ / dựng hỏng · tiền về giữa lượt ⇒ hoàn tác + archive:stopped · lưu trữ đổi ĐÚNG cột trạng thái · getDbFor / withOrganization / fan-out từ chối · sổ migration tụt ⇒ kích hoạt lại migrate cho khớp ⇒ ACTIVE · đình chỉ ⇒ về đình chỉ · mất nhật ký (hoặc chỉ còn nhật ký của tổ chức cũ cùng mã) ⇒ SUSPENDED · dữ liệu còn nguyên");
}
