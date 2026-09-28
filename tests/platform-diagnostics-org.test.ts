/**
 * PHASE 11 · H4 — CHẨN ĐOÁN MỘT TỔ CHỨC · GỠ DẤU VNX · NỐI HẠN MỨC (docs/platform/phase-11-12-plan.md §H4).
 *
 * Tổ chức THẬT `pdg-a` (CSDL PGlite riêng, tự cấp, tự dọn) trên gói siết `pdg-siet` (1 đối tượng · 2 bản ghi · 2 nháp
 * AI mỗi ngày), cộng tổ chức nhà:
 *  1. HẠN MỨC — tạo đối tượng / bản ghi / nháp AI qua ĐÚNG hàm dịch vụ mà server action gọi: tới trần ⇒ lỗi nghiệp vụ
 *     (không ném), nháp AI vượt gói ⇒ KHÔNG gọi AI lần nào; lưu trữ / xoá mềm giải phóng chỗ, khôi phục kiểm lại; bộ đếm
 *     đếm THẬT (/settings/plan nói số); tổ chức nhà không giới hạn, không đếm.
 *  2. CHẨN ĐOÁN — `loadOrgDiagnostics` đọc đúng số đã gieo (metadata, luật treo, kết nối, nháp AI, blueprint, migration,
 *     job, lỗi khối trang của CHÍNH tổ chức), không ghi dòng nào, không trả một bí mật / email / câu người dùng gõ nào đã
 *     gieo; người không phải người vận hành nền tảng ⇒ FORBIDDEN; mã lạ ⇒ NOT_FOUND.
 *  3. GỠ DẤU VNX — chữ của trang lõi cho tổ chức không-nhà không còn "Pancake" / "Viettel" / "VNX" (helper + quét mã
 *     nguồn các trang lõi, bỏ chú thích); tổ chức nhà nhận ĐÚNG chữ cũ; favicon / tiêu đề tab theo thương hiệu.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { FakeProvider } from "@/lib/ai/provider";
import { setBuilderAiForTests } from "@/lib/ai-builder/provider";
import { createDraft } from "@/lib/ai-builder/service";
import type { SessionUser } from "@/lib/auth/session";
import { brandCopy, CORE_TEXT, coreText, HOME_BRAND_PATTERN, HOME_COPY_CONTEXT, HOME_INTEGRATION_NAME, INTEGRATION_ROLES, initialIconDataUri, isHomeOrg, orgTabMetadata, type CoreTextKey } from "@/lib/branding/copy";
import { getBrandCopy } from "@/lib/branding/service";
import { checkEntitlement, getPlanUsage } from "@/lib/entitlements/check";
import { archiveObject, createObject, restoreObject } from "@/lib/objects/objects";
import { createRecord, deleteRecord } from "@/lib/objects/records";
import { recordFailure } from "@/lib/perf/registry";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { readJournalCount } from "@/lib/queries/platform-health";
import { loadOrgDiagnostics, type OrgDiagnostics } from "@/lib/queries/platform-org-diagnostics";

const ORG = "pdg-a";
const PLAN = "pdg-siet";

/** Mọi thứ đã gieo mà KHÔNG được xuất hiện trong kết quả chẩn đoán. */
const SEEDED_SECRETS = {
  secretBytes: "BIMAT-SECRETS-ENC-7731",
  secretHint: "••••WXYZ",
  setting: "SETTING-BIMAT-5510",
  testMessage: "MSG-BIMAT-8842",
  promptEmail: "khach.bimat@example.com",
  draftCreator: "nguoitao.bimat@example.com",
  blueprintEmail: "bp.bimat@example.com",
  jobError: "LOI-JOB-BIMAT-3301",
  jobDetailPhone: "0912345678",
  jobActor: "nguoibam.bimat@example.com",
  runError: "LOI-RUN-BIMAT-khach@example.com",
};

function user(over: Partial<SessionUser>): SessionUser {
  return { id: "pdg-user", email: "pdg@local", name: "PDG", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformPlans).where(eq(schema.platformPlans.key, PLAN));
  invalidateOrganizations();
  invalidateCapabilities();
}

async function orgAdmin(): Promise<SessionUser> {
  const db = await getDb();
  const row = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
  assert.ok(row, "quản trị của tổ chức thử");
  return user({ id: row.id, email: row.email, organization: { code: ORG, name: ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] });
}

function isLimit(r: unknown): boolean {
  return /hạn mức của gói «Siết H4»/.test(JSON.stringify(r));
}

// ═══════════ 1 · HẠN MỨC ═══════════

async function testEntitlements(admin: SessionUser) {
  // Đối tượng: trần 1.
  const o1 = await createObject(admin, { key: "x_hop_dong", label: "Hợp đồng", labelPlural: "Hợp đồng", icon: "file-text" });
  assert.ok(o1.ok, JSON.stringify(o1));
  const o2 = await createObject(admin, { key: "x_cong_trinh", label: "Công trình", labelPlural: "Công trình", icon: "box" });
  assert.ok(!o2.ok && o2.code === "INVALID" && isLimit(o2), `đối tượng thứ 2 vượt gói ⇒ lỗi nghiệp vụ: ${JSON.stringify(o2)}`);
  const db = await getDb();
  assert.equal((await db.select().from(schema.metaObjects)).length, 1, "lượt bị chặn không chèn dòng nào");
  // Lưu trữ giải phóng chỗ; khôi phục thì kiểm lại như một lượt tạo.
  assert.ok((await archiveObject(admin, "x_hop_dong")).ok);
  const o3 = await createObject(admin, { key: "x_cong_trinh", label: "Công trình", labelPlural: "Công trình", icon: "box" });
  assert.ok(o3.ok, `đối tượng đã lưu trữ không tính vào trần: ${JSON.stringify(o3)}`);
  const back = await restoreObject(admin, "x_hop_dong");
  assert.ok(!back.ok && isLimit(back), `khôi phục vượt gói ⇒ từ chối: ${JSON.stringify(back)}`);
  assert.equal((await db.select().from(schema.metaObjects).where(eq(schema.metaObjects.key, "x_hop_dong")))[0]?.status, "ARCHIVED", "khôi phục bị chặn không đổi trạng thái");

  // Đệm 60 giây của bộ đếm: lượt cho qua phải QUÊN số đệm. `audit()` của lượt tạo do NGƯỜI bấm đã xoá đệm, nhưng lượt
  // ghi trong job nền chỉ đánh dấu cũ (trả ngay số cũ) — mô phỏng bằng một dòng chèn thẳng, không qua audit.
  const e1 = await checkEntitlement("records", 1);
  assert.ok(e1.ok && e1.used === 0);
  const [direct] = await db.insert(schema.customRecords).values({ objectKey: "x_cong_trinh", title: "Chèn thẳng" }).returning();
  const e2 = await checkEntitlement("records", 1);
  assert.ok(e2.ok && e2.used === 1, `lượt kiểm sau một lượt cho qua đếm LẠI, không dùng số đệm 0: ${JSON.stringify(e2)}`);
  await db.delete(schema.customRecords).where(eq(schema.customRecords.id, direct.id));

  // Bản ghi: trần 2.
  const r1 = await createRecord("x_cong_trinh", { system: { title: "Toà nhà A" } }, admin);
  const r2 = await createRecord("x_cong_trinh", { system: { title: "Toà nhà B" } }, admin);
  assert.ok(r1.ok && r2.ok, JSON.stringify([r1, r2]));
  const r3 = await createRecord("x_cong_trinh", { system: { title: "Toà nhà C" } }, admin);
  assert.ok(!r3.ok && r3.code === "INVALID" && isLimit(r3), `bản ghi thứ 3 vượt gói: ${JSON.stringify(r3)}`);
  assert.equal((await db.select().from(schema.customRecords)).length, 2, "lượt bị chặn không chèn bản ghi");
  // Người KHÔNG được ghi nhận câu của cổng quyền, không phải câu hạn mức (cổng trước, hạn mức sau).
  const viewer = user({ id: "pdg-viewer", role: "VIEWER", permissions: ["records:view"], organization: admin.organization, modules: admin.modules });
  const denied = await createRecord("x_cong_trinh", { system: { title: "Toà nhà D" } }, viewer);
  assert.ok(!denied.ok && denied.code === "FORBIDDEN", JSON.stringify(denied));
  assert.ok((await deleteRecord("x_cong_trinh", (r1 as { id: string }).id, admin)).ok);
  assert.ok((await createRecord("x_cong_trinh", { system: { title: "Toà nhà C" } }, admin)).ok, "bản ghi đã xoá mềm không tính vào trần");

  // Nháp AI: trần 2 mỗi ngày; một nháp hôm nay + một nháp 3 ngày trước đã có.
  await db.insert(schema.aiBlueprintDrafts).values([
    { mode: "new", prompt: `Khách ${SEEDED_SECRETS.promptEmail} cần CRM`, status: "DRAFT", createdByEmail: SEEDED_SECRETS.draftCreator },
    { mode: "new", prompt: "Nháp cũ đã áp dụng", status: "APPLIED", installId: "install-cu-h4", createdAt: new Date(Date.now() - 3 * 86_400_000), createdByEmail: SEEDED_SECRETS.draftCreator },
  ]);
  const fake = new FakeProvider();
  setBuilderAiForTests({ provider: fake, source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
  try {
    const d1 = await createDraft(admin, { mode: "new", prompt: "Công ty dịch vụ bảo trì cần theo dõi hợp đồng" });
    assert.ok(d1.ok, `nháp thứ 2 hôm nay còn chỗ: ${JSON.stringify(d1)}`);
    assert.equal(fake.calls.length, 1);
    const d2 = await createDraft(admin, { mode: "new", prompt: "Công ty dịch vụ bảo trì cần thêm kho" });
    assert.ok(!d2.ok && isLimit(d2), `nháp thứ 3 hôm nay vượt gói: ${JSON.stringify(d2)}`);
    assert.equal(fake.calls.length, 1, "vượt gói ⇒ KHÔNG gọi AI (không tốn token)");
  } finally {
    setBuilderAiForTests(undefined);
  }

  // /settings/plan: ba loại đã có bộ đếm, số THẬT.
  const usage = await getPlanUsage();
  const used = (k: string) => usage.rows.find((r) => r.kind === k);
  assert.deepEqual([used("objects")?.used, used("records")?.used, used("aiDraftsPerDay")?.used], [1, 2, 2], "đối tượng chưa lưu trữ · bản ghi chưa xoá · nháp hôm nay");
  for (const k of ["objects", "records", "aiDraftsPerDay"]) assert.ok(used(k)?.measured && used(k)?.note && !/chưa có/.test(used(k)?.note ?? ""), `${k} khai nguồn đếm`);
}

async function testHomeUnlimited() {
  const home = await getHomeOrganization();
  await withOrganization(home.code, async () => {
    for (const kind of ["objects", "records", "aiDraftsPerDay"] as const) {
      const v = await checkEntitlement(kind, 1_000_000);
      assert.ok(v.ok && v.used === null && v.limit === null, `nhà: ${kind} không giới hạn, không đếm`);
    }
  });
}

// ═══════════ 2 · CHẨN ĐOÁN ═══════════

async function seedDiagnostics() {
  const db = await getDb();
  const past = new Date(Date.now() - 2 * 3_600_000);
  await db.insert(schema.metaCustomFields).values([
    { objectKey: "customer", fieldKey: "hang_thanh_vien", label: "Hạng", fieldType: "text" },
    { objectKey: "customer", fieldKey: "ma_cu", label: "Mã cũ", fieldType: "text", status: "ARCHIVED" },
  ]);
  await db.insert(schema.metaForms).values([{ objectKey: "customer", formKey: "create", published: { sections: [] }, publishedVersion: 1 }]);
  await db.insert(schema.metaListViews).values([{ objectKey: "customer", viewKey: "default", draft: { columns: [] } }]);
  await db.insert(schema.metaPages).values([
    { slug: "tong-quan-h4", name: "Tổng quan", moduleKey: "customers", published: { sections: [] }, publishedVersion: 1 },
    { slug: "nhap-h4", name: "Nháp", moduleKey: "customers" },
    { slug: "cu-h4", name: "Cũ", moduleKey: "customers", status: "ARCHIVED" },
  ]);
  const [rule] = await db
    .insert(schema.workflowRules)
    .values([
      { key: "duyet-h4", name: "Duyệt hợp đồng lớn", status: "ACTIVE", mode: "LIVE", trigger: { kind: "event", event: "custom_record.created" } },
      { key: "nhap-h4", name: "Luật nháp", trigger: { kind: "event", event: "custom_record.created" } },
    ])
    .returning();
  await db.insert(schema.workflowRuns).values({
    ruleId: rule.id,
    ruleVersion: 1,
    mode: "LIVE",
    triggerKind: "event",
    triggerRef: "ev-1",
    dedupeKey: "pdg-run-1",
    status: "PENDING",
    attempt: 1,
    leaseUntil: past,
    subjectType: "custom_record",
    subjectId: "x_cong_trinh:bi-mat",
    error: SEEDED_SECRETS.runError,
  });
  await db.insert(schema.orgConnections).values({
    orgCode: ORG,
    connectorKey: "lark-webhook",
    status: "ACTIVE",
    settings: { chat: SEEDED_SECRETS.setting },
    secretsEnc: Buffer.from(SEEDED_SECRETS.secretBytes),
    secretsKeyId: "k1",
    secretHints: { webhookUrl: SEEDED_SECRETS.secretHint },
    lastTestAt: past,
    lastTestOk: true,
    lastTestMessage: SEEDED_SECRETS.testMessage,
    activatedAt: past,
  });
  await db.insert(schema.blueprintInstalls).values([
    { blueprintKey: "service-business", version: "1.0.0", status: "DONE", installedAt: new Date(Date.now() - 86_400_000), installedByEmail: SEEDED_SECRETS.blueprintEmail },
    { blueprintKey: "service-business", version: "1.1.0", status: "FAILED", installedAt: past, installedByEmail: SEEDED_SECRETS.blueprintEmail, error: SEEDED_SECRETS.jobError },
  ]);
  await db.insert(schema.syncRuns).values({ source: "landing", job: "landing-sheet", status: "FAILED", actor: SEEDED_SECRETS.jobActor, detail: `SĐT ${SEEDED_SECRETS.jobDetailPhone}`, error: SEEDED_SECRETS.jobError, failed: 3 });
}

async function tableCounts(): Promise<Record<string, number>> {
  const db = await getDb();
  const out: Record<string, number> = {};
  for (const t of ["audit_logs", "workflow_runs", "org_connections", "ai_blueprint_drafts", "blueprint_installs", "sync_runs", "meta_pages", "custom_records"]) {
    const r = (await db.execute(sql.raw(`select count(*)::int as n from ${t}`))) as unknown as { rows?: { n: number }[] } | { n: number }[];
    out[t] = Number((Array.isArray(r) ? r : (r.rows ?? []))[0]?.n);
  }
  return out;
}

async function testDiagnostics(admin: SessionUser) {
  const home = await getHomeOrganization();
  const operator = user({ organization: { code: home.code, name: home.name, isHome: true } });

  // Quyền: người của tổ chức khác (kể cả ADMIN), người nhà thiếu platform:operate ⇒ FORBIDDEN, không đọc gì.
  const foreign = await loadOrgDiagnostics(admin, ORG);
  assert.ok(!foreign.ok && foreign.code === "FORBIDDEN", "ADMIN tổ chức khác không chẩn đoán được");
  const homeViewer = user({ role: "VIEWER", permissions: ["settings:manage"], organization: operator.organization });
  const hv = await loadOrgDiagnostics(homeViewer, ORG);
  assert.ok(!hv.ok && hv.code === "FORBIDDEN", "người nhà thiếu platform:operate ⇒ từ chối");
  const unknown = await loadOrgDiagnostics(operator, "khong-co-h4");
  assert.ok(!unknown.ok && unknown.code === "NOT_FOUND");
  const traversal = await loadOrgDiagnostics(operator, "../vnx");
  assert.ok(!traversal.ok && traversal.code === "NOT_FOUND", "mã sai hình ⇒ không tra sổ");

  const before = (await withOrganization(ORG, () => loadOrgDiagnostics(operator, ORG))) as { ok: true; value: OrgDiagnostics };
  assert.ok(before.ok);
  await withOrganization(ORG, seedDiagnostics);
  recordFailure("pageblock:table", ORG);
  recordFailure("pageblock:table", ORG);
  recordFailure("pageblock:kpi", "to-chuc-khac");

  const rowsBefore = await withOrganization(ORG, tableCounts);
  // Gọi từ ngữ cảnh NHÀ (như trang /platform): hàm tự mở CSDL tổ chức, không dựa vào ngữ cảnh phiên.
  const res = await withOrganization(home.code, () => loadOrgDiagnostics(operator, ORG));
  assert.ok(res.ok, JSON.stringify(res));
  const d = res.value;
  assert.deepEqual(await withOrganization(ORG, tableCounts), rowsBefore, "chẩn đoán KHÔNG ghi một dòng nào");

  const m = d.metadata.value;
  const m0 = before.value.metadata.value;
  assert.ok(m && m0, d.metadata.note ?? "");
  assert.deepEqual(
    {
      fieldsActive: m.fields.active - m0.fields.active,
      fieldsArchived: m.fields.archived - m0.fields.archived,
      forms: [m.forms.total - m0.forms.total, m.forms.published - m0.forms.published],
      lists: [m.lists.total - m0.lists.total, m.lists.published - m0.lists.published],
      pages: [m.pages.active - m0.pages.active, m.pages.published - m0.pages.published, m.pages.archived - m0.pages.archived],
      rules: [m.workflows.ACTIVE - m0.workflows.ACTIVE, m.workflows.DRAFT - m0.workflows.DRAFT],
    },
    { fieldsActive: 1, fieldsArchived: 1, forms: [1, 1], lists: [1, 0], pages: [2, 1, 1], rules: [1, 1] },
    "số metadata = đúng số đã gieo",
  );
  assert.deepEqual([m.objects.active, m.objects.archived, m.records.live, m.records.deleted], [1, 1, 2, 1], "đối tượng / bản ghi từ phần hạn mức");

  assert.equal(d.staleRuns.value?.total, 1, "lượt PENDING quá hạn giữ = treo");
  assert.equal(d.staleRuns.value?.byKind.LEASE_EXPIRED, 1);
  assert.equal(d.staleRuns.value?.rows[0]?.ruleName, "Duyệt hợp đồng lớn");

  assert.deepEqual(
    d.connections.value?.map((c) => [c.connectorKey, c.status, c.lastTestOk, Boolean(c.lastTestAt)]),
    [["lark-webhook", "ACTIVE", true, true]],
  );
  assert.deepEqual([d.aiDrafts.value?.total, d.aiDrafts.value?.today, d.aiDrafts.value?.applied], [3, 2, 1], "nháp AI: tổng · hôm nay · đã áp dụng");
  assert.ok(d.aiDrafts.value?.lastCreatedAt);
  assert.deepEqual(d.blueprints.value, [
    { blueprintKey: "service-business", installedVersion: "1.0.0", lastStatus: "FAILED", lastVersion: "1.1.0", lastAt: d.blueprints.value?.[0]?.lastAt, installs: 2 },
  ]);
  assert.equal(d.migrations.value?.applied, readJournalCount().count, "CSDL tổ chức áp đủ migration");
  assert.equal(d.migrations.value?.expected, readJournalCount().count);
  assert.deepEqual(d.jobs.value?.map((j) => [j.job, j.status, j.failed]), [["landing-sheet", "FAILED", 3]]);
  assert.deepEqual(d.blockFailures.rows.map((r) => [r.name, r.count]), [["pageblock:table", 2]], "lỗi khối trang CHỈ của tổ chức này");
  assert.equal(d.planKey, PLAN);
  assert.equal(d.plan.value?.plan?.name, "Siết H4");
  assert.ok(d.modules.enabled.some((x) => x.key === "apps"));

  // Không lộ: quét TOÀN BỘ kết quả (thứ trang render) tìm từng bí mật / email / câu gõ tự do đã gieo.
  const json = JSON.stringify(d);
  for (const [what, value] of Object.entries(SEEDED_SECRETS)) assert.ok(!json.includes(value), `chẩn đoán lộ ${what}`);
  assert.ok(!json.includes(`admin@${ORG}.local`), "không lộ email người dùng của tổ chức");
  assert.ok(!/@example\.com/.test(json), "không một email nào đã gieo");

  // Tổ chức nhà: chẩn đoán được (chỉ đọc), mặt phẳng điều khiển nguyên vẹn.
  const homeDiag = await loadOrgDiagnostics(operator, home.code);
  assert.ok(homeDiag.ok && homeDiag.value.organization.isHome && homeDiag.value.plan.value?.plan?.key === "internal");

  // Trang: kiểm quyền hai lần, liên kết từ /platform.
  const page = readFileSync("app/(dashboard)/platform/org/[code]/page.tsx", "utf8");
  assert.ok(page.includes('requirePermission("platform:operate")') && page.includes("platformOperatorDenial(user)"), "trang kiểm quyền trước khi đọc");
  assert.ok(readFileSync("app/(dashboard)/platform/page.tsx", "utf8").includes("/platform/org/${encodeURIComponent(o.code)}"), "danh sách /platform trỏ tới trang chẩn đoán");
  const src = readFileSync("lib/queries/platform-org-diagnostics.ts", "utf8");
  assert.ok(!/\.(insert|update|delete)\(/.test(src), "chẩn đoán không có đường ghi");
  assert.ok(!/secretsEnc|secretHints|lastTestMessage|\.prompt\b|createdByEmail|installedByEmail/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "không chọn cột bí mật / email / câu gõ");
}

// ═══════════ 3 · GỠ DẤU VNX ═══════════

/** Trang lõi được gỡ dấu — mọi chữ còn lại mang "Pancake" / "Viettel" / "VNX" phải có lý do ở `EXEMPT`. */
const CORE_PAGES = [
  "app/(dashboard)/customers/page.tsx",
  "app/(dashboard)/orders/page.tsx",
  "app/(dashboard)/products/page.tsx",
  "app/(dashboard)/inventory/page.tsx",
  "app/(dashboard)/returns/page.tsx",
  "app/(dashboard)/settings/data-model/page.tsx",
  "app/(dashboard)/settings/connections/page.tsx",
  "app/(dashboard)/layout.tsx",
];
const EXEMPT: Record<string, string> = {};

function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

async function testDebrand() {
  // Nhà: ĐÚNG chữ cũ, từng ký tự.
  const homeCopy = brandCopy(HOME_COPY_CONTEXT);
  assert.deepEqual(INTEGRATION_ROLES.map((r) => homeCopy.name(r)), ["Pancake", "Pancake POS", "Viettel Post"]);
  assert.equal(coreText("returns.title", HOME_COPY_CONTEXT), "Phiếu đổi / trả (Pancake)");
  assert.equal(coreText("returns.eyebrow", HOME_COPY_CONTEXT), "Bán hàng · nguồn Pancake");
  assert.match(coreText("connections.homeIntegrations", HOME_COPY_CONTEXT), /^Tích hợp đang chạy của tổ chức nhà \(Pancake, Viettel Post, Meta, SePay…\)/);
  assert.ok(isHomeOrg(null) && isHomeOrg({ organization: null }) && isHomeOrg({ organization: { isHome: true } }) && !isHomeOrg({ organization: { isHome: false } }), "phiên không mang tổ chức = nhà (như currentOrganization)");
  const home = await getHomeOrganization();
  const homeLive = await getBrandCopy(user({ organization: { code: home.code, name: home.name, isHome: true } }));
  assert.ok(homeLive.isHome && homeLive.name("SHIPPING") === HOME_INTEGRATION_NAME.SHIPPING);

  // Không-nhà: không một chữ nào mang dấu nhà — trung tính, và cả khi đã khai connector.
  for (const ctx of [{ isHome: false, declared: {} }, { isHome: false, declared: { ORDER_SOURCE: "Google Sheet đơn landing", POS: "Google Sheet đơn landing" } }, { isHome: false, declared: { SHIPPING: "Viettel Post (khai nhầm)" } }]) {
    const c = brandCopy(ctx);
    for (const r of INTEGRATION_ROLES) assert.ok(!HOME_BRAND_PATTERN.test(c.name(r)), `${r}: ${c.name(r)}`);
    for (const k of Object.keys(CORE_TEXT) as CoreTextKey[]) assert.ok(!HOME_BRAND_PATTERN.test(c.text(k)), `${k}: ${c.text(k)}`);
  }
  assert.equal(brandCopy({ isHome: false, declared: {} }).text("returns.title"), "Phiếu đổi / trả");

  // Ngữ cảnh thật của tổ chức thử: kết nối đang bật của chính nó được dùng; dòng mang mã khác bị bỏ.
  const orgUser = user({ organization: { code: ORG, name: ORG, isHome: false } });
  await withOrganization(ORG, async () => {
    const neutral = await getBrandCopy(orgUser);
    assert.deepEqual(INTEGRATION_ROLES.map((r) => neutral.name(r)), ["hệ thống bán hàng", "hệ thống bán hàng", "đơn vị vận chuyển"]);
    const db = await getDb();
    await db.insert(schema.orgConnections).values({ orgCode: ORG, connectorKey: "google-sheet-landing", status: "ACTIVE", lastTestOk: true, lastTestAt: new Date() });
    assert.equal((await getBrandCopy(orgUser)).name("ORDER_SOURCE"), "Google Sheet đơn landing", "nhãn connector đã khai + đang bật");
    await db.update(schema.orgConnections).set({ orgCode: "to-chuc-khac" }).where(eq(schema.orgConnections.connectorKey, "google-sheet-landing"));
    assert.equal((await getBrandCopy(orgUser)).name("ORDER_SOURCE"), "hệ thống bán hàng", "dòng mang mã tổ chức khác ⇒ không dùng");
    await db.delete(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "google-sheet-landing"));
  });

  // Quét mã nguồn trang lõi (bỏ chú thích): chữ mang dấu nhà chỉ còn qua helper.
  for (const f of CORE_PAGES) {
    const hits = stripComments(readFileSync(f, "utf8")).match(/Pancake|Viettel|VNX/g) ?? [];
    if (hits.length) assert.ok(EXEMPT[f], `${f} còn chữ của nhà ngoài helper: ${hits.join(", ")}`);
    assert.ok(f.endsWith("layout.tsx") || /getBrandCopy\(/.test(readFileSync(f, "utf8")), `${f} đọc chữ qua getBrandCopy`);
  }

  // Tab + favicon: logo của tổ chức ⇒ favicon; không logo ⇒ chữ cái đầu (không phải /icon.svg mang nhãn VNXcommerce).
  const withLogo = orgTabMetadata({ name: "Minh An Sỉ", logoUrl: "/api/branding/logo?v=abcd1234" });
  assert.deepEqual(withLogo.icons.icon, [{ url: "/api/branding/logo?v=abcd1234" }]);
  assert.deepEqual(withLogo.title, { absolute: "Minh An Sỉ", template: "%s · Minh An Sỉ" });
  const noLogo = orgTabMetadata({ name: "đông á", logoUrl: null });
  assert.ok(noLogo.icons.icon[0].url.startsWith("data:image/svg+xml,") && decodeURIComponent(noLogo.icons.icon[0].url).includes(">Đ</text>"));
  assert.ok(!HOME_BRAND_PATTERN.test(JSON.stringify([withLogo, noLogo])), "metadata tổ chức khác không mang dấu nhà");
  assert.ok(decodeURIComponent(initialIconDataUri("<script>")).includes(">•</text>"), "ký tự lạ không vào SVG");
  // Favicon: `app/favicon.ico` bị Next chèn trước mọi icon ⇒ phải nằm ở public/ và khai ở bố cục gốc (nhà giữ đúng hai thẻ).
  assert.ok(!existsSync("app/favicon.ico") && existsSync("public/favicon.ico"), "favicon.ico ở public/, không ở app/");
  const root = readFileSync("app/layout.tsx", "utf8");
  assert.ok(root.includes('{ url: "/favicon.ico", type: "image/x-icon", sizes: "16x16" }, { url: "/icon.svg" }'), "nhà giữ nguyên bộ biểu tượng");
  assert.ok(root.includes('default: "VNXcommerce ERP"'), "tiêu đề của nhà không đổi");
  const dash = readFileSync("app/(dashboard)/layout.tsx", "utf8");
  assert.ok(dash.includes("if (!user?.organization || user.organization.isHome) return {};") && dash.includes("orgTabMetadata("), "nhà trả {} — chỉ tổ chức khác đổi tab / favicon");

  // Điểm tạo gọi hạn mức (mã nguồn) — cùng khuôn với bài Phase 10.
  for (const [f, needle] of [
    ["lib/objects/objects.ts", 'checkEntitlement("objects"'],
    ["lib/objects/records.ts", 'checkEntitlement("records"'],
    ["lib/ai-builder/service.ts", 'checkEntitlement("aiDraftsPerDay"'],
  ]) {
    assert.ok(readFileSync(f, "utf8").includes(needle), `${f} phải gọi ${needle}`);
  }
}

export async function testPlatformDiagnosticsOrg() {
  await cleanup();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  const pdb = await getPlatformDb();
  await pdb.insert(schema.platformPlans).values({ key: PLAN, name: "Siết H4", limits: { users: 5, pages: 10, objects: 1, records: 2, workflows: 10, aiDraftsPerDay: 2, storageMb: 10 }, position: 99 });
  await provisionOrganization({ code: ORG, name: "Tổ chức thử chẩn đoán", plan: PLAN, modules: ["customers", "apps"], admin: { email: `admin@${ORG}.local`, name: "QT PDG", password: "Pdg@123456" }, source: "TEST", actor: null });
  try {
    const admin = await withOrganization(ORG, orgAdmin);
    await withOrganization(ORG, () => testEntitlements(admin));
    await testHomeUnlimited();
    await testDiagnostics(admin);
    await testDebrand();
  } finally {
    setBuilderAiForTests(undefined);
    await cleanup();
  }
  console.log("✓ Phase 11 · H4: chẩn đoán một tổ chức (đúng số, chỉ đọc, không lộ bí mật, chỉ người vận hành), hạn mức đối tượng / bản ghi / nháp AI, gỡ dấu VNX + favicon theo thương hiệu");
}
