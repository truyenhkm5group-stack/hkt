/**
 * VẬN HÀNH KHÁCH PILOT — vòng đời · sức khoẻ / hỗ trợ · công tắc khẩn (docs/platform/pilot-operations.md).
 *
 * Hai tổ chức THẬT (CSDL PGlite riêng, tự cấp, tự dọn): `pop-a` do NGƯỜI VẬN HÀNH tạo hộ qua ĐÚNG luồng /start (mẫu
 * bán sỉ), `pop-b` cấp thẳng để làm "tổ chức khác".
 *  1. THUẦN — chấm danh sách kiểm (chưa đo được ⇒ không đạt), luật chuyển giai đoạn (không nhảy, ghi đè cần lý do).
 *  2. VÒNG ĐỜI — /start ⇒ CREATED → CONFIGURING (máy, có nhật ký); nhảy bậc bị từ chối; checklist chưa đạt bị từ chối;
 *     ghi đè cần lý do ≥ 10 ký tự và nhật ký ghi cổng nào bị vượt; lùi cần lý do; đủ dữ liệu thật ⇒ qua KHÔNG ghi đè;
 *     UAT + bản sao lưu đêm đầu tiên ⇒ ACTIVE; lùi về dưới UAT xoá xác nhận UAT.
 *  3. SỨC KHOẺ — không chứa tên khách / số tiền đơn / giá trị field / email / câu lỗi đã gieo; MỖI lượt xem một dòng
 *     SUPPORT_VIEW; người không vận hành / tổ chức khác ⇒ FORBIDDEN, không dòng nào.
 *  4. ĐÌNH CHỈ — phiên đang mở bị chặn ở lượt request kế tiếp, job SKIPPED, webhook (withOrganization) từ chối, fan-out
 *     bỏ ra; bật lại chạy.
 *  5. TẠM DỪNG LUẬT — engine bỏ qua đúng tổ chức (con trỏ đứng, lượt chờ duyệt giữ nguyên), tổ chức khác vẫn chạy, bật
 *     lại chạy tiếp đúng một lần.
 *  6. TẮT KẾT NỐI — qua sổ kết nối (nhật ký của tổ chức mang người vận hành + lý do), không ghi thẳng bảng.
 *  7. Người không vận hành / tổ chức khác bị từ chối MỌI thao tác, không đổi một dòng.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseName, organizationDatabaseUrl, schema } from "@/db";
import { signSession, type SessionUser } from "@/lib/auth/session";
import { evaluatePilotChecklist, planPilotTransition, PILOT_CHECK_KEYS, type PilotFacts } from "@/lib/constants/pilot";
import { createCustomField } from "@/lib/metadata/fields";
import { saveCustomValues } from "@/lib/metadata/values";
import { createOrganizationFromSignup, type SignupActor } from "@/lib/onboarding/service";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { currentOrganization, OrgContextError, setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { disableOrgConnection, setOrganizationSuspended, setWorkflowsPaused } from "@/lib/platform/kill-switches";
import { invalidateOrgFlags } from "@/lib/platform/org-flags";
import { fanOutOrganizationCodes, getHomeOrganization, invalidateOrganizations, listOrganizations } from "@/lib/platform/organizations";
import { confirmPilotUat, loadPilotView, readPilotRecord, setPilotStage } from "@/lib/platform/pilot";
import { provisionOrganization } from "@/lib/platform/provision";
import { loadOrgSupport } from "@/lib/platform/support";
import { loadOrgDiagnostics } from "@/lib/queries/platform-org-diagnostics";
import { runJob } from "@/lib/sync/jobs";
import { runWorkflows } from "@/lib/workflow/engine";
import { saveRule, setRuleMode, setRuleStatus } from "@/lib/workflow/rules";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { CORE_MODULES } from "@/lib/onboarding/shared";

const A = "pop-a";
const B = "pop-b";
const ORGS = [A, B] as const;
const ADMIN_EMAIL = `quantri@${A}.local`;

/** Dữ liệu NGHIỆP VỤ gieo vào `pop-a` — không chuỗi nào được xuất hiện trong kết quả sức khoẻ / chẩn đoán. */
const BUSINESS = {
  customerName: "Nguyễn Thị Bí Mật POP",
  customerPhone: "0987001122",
  orderAmount: "98765432",
  fieldValue: "GIA-TRI-FIELD-POP-7788",
  eventPayload: "PAYLOAD-BIMAT-POP-4411",
  auditDetail: "CHI-TIET-NHAT-KY-POP-2299",
  jobError: "LOI-JOB-POP-khach.pop@example.com",
};

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "pop-user", email: "pop@local", name: "POP", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  await pdb.delete(schema.platformSignupAttempts).where(inArray(schema.platformSignupAttempts.organizationCode, [...ORGS]));
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateOrgFlags();
}

async function auditRows(code: string, action?: string) {
  const pdb = await getPlatformDb();
  const a = schema.platformAuditLog;
  return pdb.select().from(a).where(action ? and(eq(a.targetOrgCode, code), eq(a.action, action)) : eq(a.targetOrgCode, code));
}

async function stageOf(code: string) {
  return (await readPilotRecord(code))?.stage ?? null;
}

// ═══════════ 1 · THUẦN ═══════════

function testPure() {
  const full: PilotFacts = { doneInstalls: 1, activeAdmins: 1, activeUsers: 2, nonCoreModules: 3, suggestedIntegrations: 1, testedConnections: 1, publishedPages: 2, liveRules: 1, activeRules: 1, backupSucceeded: true, uatConfirmed: true };
  const all = evaluatePilotChecklist(full);
  assert.deepEqual(all.map((c) => c.key), [...PILOT_CHECK_KEYS]);
  assert.ok(all.every((c) => c.state === "PASS"), JSON.stringify(all));
  const na = evaluatePilotChecklist({ ...full, suggestedIntegrations: 0, testedConnections: 0, liveRules: 0, activeRules: 0 });
  assert.equal(na.find((c) => c.key === "CONNECTIONS_READY")?.state, "NOT_APPLICABLE", "mẫu không gợi ý kết nối ⇒ không áp dụng");
  assert.equal(na.find((c) => c.key === "RULES_ACTIVE")?.state, "NOT_APPLICABLE", "không có luật ⇒ không áp dụng");
  const unknown = evaluatePilotChecklist({ ...full, activeUsers: null, backupSucceeded: null });
  assert.equal(unknown.find((c) => c.key === "USERS_MIN")?.state, "UNKNOWN", "đo không được ⇒ UNKNOWN, không phải 0 / đạt");
  assert.equal(unknown.find((c) => c.key === "BACKUP_FIRST")?.state, "UNKNOWN");
  assert.equal(evaluatePilotChecklist({ ...full, activeUsers: 1 }).find((c) => c.key === "USERS_MIN")?.state, "FAIL", "1 người < trần 2");

  const t = (from: Parameters<typeof planPilotTransition>[0]["from"], to: Parameters<typeof planPilotTransition>[0]["to"], checks = all, override = false, reason = "") => planPilotTransition({ from, to, checks, override, reason });
  assert.ok(!t("CONFIGURING", "ACTIVE").ok, "không nhảy bậc");
  assert.ok(!t("CONFIGURING", "ACTIVE", all, true, "ghi đè để nhảy bậc cho nhanh").ok, "ghi đè cũng không nhảy bậc");
  assert.ok(!t("CONFIGURING", "READY_FOR_UAT", unknown).ok, "UNKNOWN chặn cổng");
  assert.ok(!t("CONFIGURING", "READY_FOR_UAT", unknown, true, "ngắn").ok, "ghi đè lý do ngắn bị từ chối");
  const ov = t("CONFIGURING", "READY_FOR_UAT", unknown, true, "khách chỉ có một người dùng");
  assert.ok(ov.ok && ov.override && ov.missing.some((m) => m.key === "USERS_MIN"));
  const fwd = t("CONFIGURING", "READY_FOR_UAT");
  assert.ok(fwd.ok && !fwd.override && fwd.direction === "FORWARD");
  assert.ok(!t("ACTIVE", "CONFIGURING").ok, "lùi cần lý do");
  assert.ok(t("ACTIVE", "CONFIGURING", all, false, "khách đổi quy trình").ok);
  assert.ok(!t(null, "CONFIGURING", all, false, "bắt đầu theo dõi").ok, "không theo dõi ⇒ chỉ bắt đầu ở CREATED");
  assert.ok(t(null, "CREATED", all, false, "bắt đầu theo dõi").ok);
  const same = t("ACTIVE", "ACTIVE");
  assert.ok(same.ok && same.direction === "SAME");
}

// ═══════════ 2 · VÒNG ĐỜI ═══════════

async function testLifecycle(op: SessionUser, outsiders: SessionUser[]) {
  // Tạo hộ qua ĐÚNG luồng /start (người vận hành: không cần cờ).
  const home = await getHomeOrganization();
  const opActor: SignupActor = { kind: "operator", ip: "10.88.0.1", actor: { orgCode: home.code, userId: op.id, email: op.email } };
  const created = await createOrganizationFromSignup(
    {
      invite: null,
      org: { name: "Bán sỉ Pilot POP", code: A },
      admin: { name: "Quản trị POP", email: ADMIN_EMAIL, password: "PilotPop@2026!" },
      plan: { businessType: "wholesale", templateKey: "wholesale", modules: WHOLESALE_BLUEPRINT.modules.filter((m) => !CORE_MODULES.includes(m)) },
      planKey: "standard",
    },
    opActor,
  );
  assert.ok("ok" in created && created.created, JSON.stringify(created));
  assert.equal(await stageOf(A), "CONFIGURING", "cài mẫu xong ⇒ CONFIGURING");
  const auto = (await auditRows(A, "PILOT_STAGE")).map((r) => (r.after as { stage: string }).stage);
  assert.deepEqual(auto.sort(), ["CONFIGURING", "CREATED"], "hai bước tự động của /start đều có nhật ký");

  const stageAudits = async () => (await auditRows(A, "PILOT_STAGE")).length;
  const before = await stageAudits();

  // Nhảy bậc ⇒ từ chối, không ghi.
  const skip = await setPilotStage(op, { orgCode: A, stage: "ACTIVE", reason: "nhảy thẳng cho nhanh", override: true });
  assert.ok("error" in skip && /nhảy/.test(skip.error), JSON.stringify(skip));
  // Checklist chưa đạt (chỉ có một người dùng) ⇒ từ chối.
  const early = await setPilotStage(op, { orgCode: A, stage: "READY_FOR_UAT", reason: "", override: false });
  assert.ok("error" in early && /người dùng/.test(early.error), JSON.stringify(early));
  // Ghi đè với lý do ngắn ⇒ từ chối.
  const shortOv = await setPilotStage(op, { orgCode: A, stage: "READY_FOR_UAT", reason: "gấp", override: true });
  assert.ok("error" in shortOv, JSON.stringify(shortOv));
  assert.equal(await stageOf(A), "CONFIGURING");
  assert.equal(await stageAudits(), before, "lượt bị từ chối không để lại dòng nhật ký nào");
  // Người ngoài ⇒ từ chối.
  for (const u of outsiders) assert.ok("error" in (await setPilotStage(u, { orgCode: A, stage: "READY_FOR_UAT", reason: "tôi muốn vượt cổng này", override: true })), `${u.email} không đổi được giai đoạn`);
  assert.equal(await stageOf(A), "CONFIGURING");

  // Ghi đè có lý do ⇒ qua, nhật ký ghi cổng bị vượt.
  const ov = await setPilotStage(op, { orgCode: A, stage: "READY_FOR_UAT", reason: "Khách thử với một tài khoản trước", override: true });
  assert.ok("ok" in ov && ov.changed && ov.override, JSON.stringify(ov));
  const ovRow = (await auditRows(A, "PILOT_STAGE")).find((r) => (r.after as { override?: boolean }).override === true);
  assert.ok(ovRow && ovRow.actorEmail === op.email && ovRow.reason === "Khách thử với một tài khoản trước", JSON.stringify(ovRow));
  assert.ok(((ovRow.after as { missing: string[] }).missing ?? []).includes("USERS_MIN"), "nhật ký ghi ĐÚNG cổng đã bị vượt");

  // Lùi cần lý do.
  assert.ok("error" in (await setPilotStage(op, { orgCode: A, stage: "CONFIGURING", reason: "", override: false })));
  const back = await setPilotStage(op, { orgCode: A, stage: "CONFIGURING", reason: "Làm cho đúng cổng", override: false });
  assert.ok("ok" in back && back.stage === "CONFIGURING");

  // Đủ dữ liệu THẬT ⇒ qua KHÔNG cần ghi đè: thêm một người dùng, một kết nối đã kiểm đạt, lưu trữ các luật nháp của mẫu.
  await withOrganization(A, async () => {
    const db = await getDb();
    await db.insert(schema.users).values({ email: `nhanvien@${A}.local`, name: "Nhân viên POP", passwordHash: "x", role: "CS", active: true });
    await db.insert(schema.orgConnections).values({ orgCode: A, connectorKey: "lark-webhook", status: "DRAFT", lastTestOk: true, lastTestAt: new Date() });
    await db.update(schema.workflowRules).set({ status: "ARCHIVED" });
  });
  const view = await loadPilotView((await listOrganizations()).find((o) => o.code === A)!);
  assert.ok(view && view.missingNext.length === 0, `mọi mục của «Sẵn sàng UAT» phải đạt: ${JSON.stringify(view?.checks)}`);
  const fwd = await setPilotStage(op, { orgCode: A, stage: "READY_FOR_UAT", reason: "", override: false });
  assert.ok("ok" in fwd && fwd.changed && !fwd.override, JSON.stringify(fwd));

  // Sang ACTIVE: thiếu UAT + sao lưu (máy thử không mount thư mục sao lưu ⇒ CHƯA ĐO ĐƯỢC ⇒ không đạt).
  const noUat = await setPilotStage(op, { orgCode: A, stage: "ACTIVE", reason: "", override: false });
  assert.ok("error" in noUat && /UAT/.test(noUat.error) && /sao lưu/.test(noUat.error), JSON.stringify(noUat));
  for (const u of outsiders) assert.ok("error" in (await confirmPilotUat(u, { orgCode: A, note: "tôi xác nhận hộ khách" })), `${u.email} không xác nhận được UAT`);
  assert.ok("error" in (await confirmPilotUat(op, { orgCode: A, note: "ok" })), "ghi chú UAT quá ngắn");
  assert.ok("ok" in (await confirmPilotUat(op, { orgCode: A, note: "Kế toán + kho chạy thử 3 ngày: đạt" })));
  assert.equal((await readPilotRecord(A))?.uat?.byEmail, op.email);
  assert.equal((await auditRows(A, "PILOT_UAT")).length, 1);

  // Bản sao lưu đêm đầu tiên của ĐÚNG CSDL tổ chức. `erp-backup.sh` chỉ phủ CSDL tên `erp_org_*` trên Postgres chung;
  // CSDL PGlite của bộ kiểm thử mang tên khác ⇒ trước hết: thư mục có lời khai mà tên không thuộc phạm vi sao lưu thì
  // mục KHÔNG đạt (không có bản nào phủ CSDL này). Rồi mượn TÊN kiểu production (chỉ tên — mọi handle CSDL đã mở sẵn)
  // để chứng minh lời khai của đúng CSDL làm mục đạt.
  const statusDir = path.join(tmpdir(), `pop-backup-${process.pid}`);
  const prevDir = process.env.ERP_BACKUP_STATUS_DIR;
  const prevUrl = process.env.DATABASE_URL;
  process.env.ERP_BACKUP_STATUS_DIR = statusDir;
  try {
    mkdirSync(statusDir, { recursive: true });
    const pgliteName = await setPilotStage(op, { orgCode: A, stage: "ACTIVE", reason: "", override: false });
    assert.ok("error" in pgliteName && /sao lưu/.test(pgliteName.error), `CSDL ngoài phạm vi sao lưu ⇒ chưa đạt: ${JSON.stringify(pgliteName)}`);
    process.env.DATABASE_URL = "postgres://pop:pop@127.0.0.1:5432/erp";
    const dbName = organizationDatabaseName(A);
    assert.equal(dbName, "erp_org_pop_a");
    // Lời khai của CSDL KHÁC nằm sai chỗ không phải căn cứ.
    const orgDir = path.join(statusDir, "orgs", dbName);
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(path.join(orgDir, "last-success.json"), JSON.stringify({ schema: 1, kind: "org-backup", database: "erp_org_khac", result: "OK", trigger: "cron", finishedAt: new Date().toISOString() }));
    assert.ok("error" in (await setPilotStage(op, { orgCode: A, stage: "ACTIVE", reason: "", override: false })), "lời khai của CSDL khác không làm mục đạt");
    writeFileSync(path.join(orgDir, "last-success.json"), JSON.stringify({ schema: 1, kind: "org-backup", database: dbName, result: "OK", trigger: "cron", finishedAt: new Date().toISOString() }));
    const live = await setPilotStage(op, { orgCode: A, stage: "ACTIVE", reason: "", override: false });
    assert.ok("ok" in live && live.stage === "ACTIVE" && !live.override, JSON.stringify(live));
  } finally {
    process.env.DATABASE_URL = prevUrl;
    if (prevDir === undefined) delete process.env.ERP_BACKUP_STATUS_DIR;
    else process.env.ERP_BACKUP_STATUS_DIR = prevDir;
    rmSync(statusDir, { recursive: true, force: true });
  }

  // Lùi về dưới UAT ⇒ xoá xác nhận UAT cũ.
  assert.ok("ok" in (await setPilotStage(op, { orgCode: A, stage: "CONFIGURING", reason: "Khách đổi quy trình duyệt" })));
  assert.equal((await readPilotRecord(A))?.uat, null, "lùi về dưới UAT ⇒ UAT cũ bị xoá");
  // Tổ chức nhà không có vòng đời pilot.
  assert.ok("error" in (await setPilotStage(op, { orgCode: home.code, stage: "CREATED", reason: "thử với nhà" })));
}

// ═══════════ 3 · SỨC KHOẺ / HỖ TRỢ ═══════════

async function seedBusiness() {
  await withOrganization(A, async () => {
    const db = await getDb();
    const [c] = await db.insert(schema.customers).values({ name: BUSINESS.customerName, phone: BUSINESS.customerPhone }).returning({ id: schema.customers.id });
    await db.insert(schema.orders).values({ id: "POP-ORDER-1", insertedAt: new Date(), billFullName: BUSINESS.customerName, billPhone: BUSINESS.customerPhone, totalPrice: Number(BUSINESS.orderAmount), customerId: c.id });
    const admin = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN_EMAIL) });
    assert.ok(admin);
    const f = await createCustomField("customer", { key: "pop_ghi_chu", label: "Ghi chú POP", type: "text" }, { id: admin.id, email: admin.email });
    assert.ok(f.ok, JSON.stringify(f));
    const viewer = sessionUser({ id: admin.id, email: admin.email });
    assert.ok((await saveCustomValues("customer", c.id, { pop_ghi_chu: BUSINESS.fieldValue }, viewer)).ok);
    await db.insert(schema.domainEvents).values({ name: "customer.touched", subjectType: "customer", subjectId: c.id, payload: { note: BUSINESS.eventPayload }, actorKind: "SYSTEM", source: "TEST", occurredAt: new Date() });
    await db.insert(schema.auditLogs).values({ userEmail: admin.email, action: "POP_SEED", entity: "customer", entityId: c.id, detail: { note: BUSINESS.auditDetail } });
    await db.insert(schema.syncRuns).values({ source: "pop", job: "pop-seed", status: "FAILED", error: BUSINESS.jobError, detail: BUSINESS.customerPhone, actor: "khach.pop@example.com", finishedAt: new Date() });
  });
}

async function testSupport(op: SessionUser, outsiders: SessionUser[]) {
  await seedBusiness();
  const views = async () => (await auditRows(A, "SUPPORT_VIEW")).length;
  const v0 = await views();
  const r1 = await loadOrgSupport(op, A);
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.equal(await views(), v0 + 1, "một lượt xem = một dòng SUPPORT_VIEW");
  const r2 = await loadOrgSupport(op, A);
  assert.ok(r2.ok);
  assert.equal(await views(), v0 + 2, "MỖI lượt xem đều có vết");
  const row = (await auditRows(A, "SUPPORT_VIEW")).at(-1)!;
  assert.ok(row.actorEmail === op.email && row.actorOrgCode === op.organization!.code && row.at instanceof Date, JSON.stringify(row));

  const s = r1.value;
  assert.equal(s.users.value?.active, 2, "đếm đúng người dùng đang hoạt động");
  assert.equal(s.users.value?.admins, 1);
  assert.ok(s.lastActivity.value?.audit && s.lastActivity.value.event, "hoạt động cuối: mốc + loại");
  assert.ok((s.errors.value?.failedJobs7d ?? 0) >= 1, "job lỗi 7 ngày đếm được");
  assert.ok(s.aiUsage.value, `ô Dùng AI đọc được sổ: ${s.aiUsage.note}`);
  assert.equal(s.aiUsage.value.requestsMonth, 0, "chưa lượt AI nào ⇒ 0 lượt (đếm THẬT)");
  assert.equal(s.aiUsage.value.costUsdMonth, null, "chưa lượt nào định giá được ⇒ tiền CHƯA BIẾT, không phải 0");
  assert.ok(s.storage.value && s.storage.value.fileCount === 0);

  // KHÔNG dữ liệu nghiệp vụ — quét cả kết quả sức khoẻ lẫn chẩn đoán H4 hiện trên cùng trang.
  const diag = await loadOrgDiagnostics(op, A);
  assert.ok(diag.ok);
  for (const [what, json] of [
    ["sức khoẻ", JSON.stringify(s)],
    ["chẩn đoán", JSON.stringify(diag.value)],
  ] as const) {
    for (const [k, v] of Object.entries(BUSINESS)) assert.ok(!json.includes(v), `${what} lộ dữ liệu nghiệp vụ «${k}»`);
    assert.ok(!/@example\.com/.test(json), `${what} lộ email`);
  }

  // Người ngoài ⇒ FORBIDDEN, không một dòng nhật ký, không một câu vào CSDL khách.
  const v2 = await views();
  for (const u of outsiders) {
    const r = await loadOrgSupport(u, A);
    assert.ok(!r.ok && r.code === "FORBIDDEN", `${u.email}: ${JSON.stringify(r)}`);
  }
  assert.equal(await views(), v2, "lượt bị từ chối không ghi SUPPORT_VIEW");
  const missing = await loadOrgSupport(op, "pop-khong-co");
  assert.ok(!missing.ok && missing.code === "NOT_FOUND");

  // Trang gọi loadOrgSupport (ghi vết) TRƯỚC khi đọc chẩn đoán.
  const page = readFileSync("app/(dashboard)/platform/org/[code]/page.tsx", "utf8");
  assert.ok(page.indexOf("loadOrgSupport(user, code)") > 0 && page.indexOf("loadOrgSupport(user, code)") < page.indexOf("loadOrgDiagnostics(user, code)"), "trang ghi vết trước khi đọc");
  const src = readFileSync("lib/platform/support.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\b(?:u|schema\.users)\.(?:email|name)\b|auditLogs\.(?:userEmail|detail|entityId)|domainEvents\.(?:payload|subjectId)|\b(?:s|schema\.syncRuns)\.(?:error|detail|actor)\b/.test(src), "sức khoẻ không chọn cột email / tên / payload / detail / câu lỗi");
}

// ═══════════ 4 · ĐÌNH CHỈ ═══════════

async function testSuspend(op: SessionUser, outsiders: SessionUser[]) {
  const admin = await withOrganization(A, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, ADMIN_EMAIL) }));
  assert.ok(admin);
  const token = await signSession({ id: admin.id, email: admin.email, name: admin.name, role: admin.role, orgCode: A });
  setSessionTokenSourceForTests(async () => token);
  try {
    assert.equal((await currentOrganization()).code, A, "phiên đang mở của pop-a");
    for (const u of outsiders) assert.ok("error" in (await setOrganizationSuspended(u, { orgCode: A, suspend: true, reason: "tôi muốn khoá tổ chức này" })), `${u.email} không đình chỉ được`);
    assert.ok("error" in (await setOrganizationSuspended(op, { orgCode: A, suspend: true, reason: "" })), "thiếu lý do ⇒ từ chối");
    assert.ok("error" in (await setOrganizationSuspended(op, { orgCode: (await getHomeOrganization()).code, suspend: true, reason: "khoá nhà thử xem" })), "không đình chỉ được tổ chức nhà");
    assert.equal((await currentOrganization()).code, A, "các lượt bị từ chối không đổi gì");

    const off = await setOrganizationSuspended(op, { orgCode: A, suspend: true, reason: "Nghi lộ mật khẩu quản trị" });
    assert.ok("ok" in off && off.changed, JSON.stringify(off));
    // Lượt request KẾ TIẾP của phiên đang mở ⇒ ORG_INACTIVE.
    await assert.rejects(() => currentOrganization(), (e: unknown) => e instanceof OrgContextError && e.code === "ORG_INACTIVE");
    await assert.rejects(() => getDb(), (e: unknown) => e instanceof OrgContextError && e.code === "ORG_INACTIVE", "phiên bị chặn cả ở tầng CSDL");
  } finally {
    setSessionTokenSourceForTests(null);
  }
  // Job ⇒ SKIPPED, webhook / việc nền (withOrganization) ⇒ từ chối, fan-out bỏ ra.
  const job = (await runJob("creative-loop", { trigger: "CRON", actor: "pop-test", org: A })) as { skipped?: string };
  assert.equal(job.skipped, "ORG_INACTIVE", JSON.stringify(job));
  await assert.rejects(() => withOrganization(A, async () => 1), (e: unknown) => e instanceof OrgContextError && e.code === "ORG_INACTIVE");
  assert.ok(!fanOutOrganizationCodes(await listOrganizations()).includes(A), "lịch fan-out bỏ tổ chức đình chỉ");
  const st = (await auditRows(A, "ORG_STATUS")).find((r) => r.subject === "kill_switch.suspend");
  assert.ok(st && st.reason === "Nghi lộ mật khẩu quản trị" && (st.after as { status: string }).status === "SUSPENDED" && st.actorEmail === op.email);
  // Tắt kết nối của tổ chức đình chỉ ⇒ từ chối rõ ràng (không kết nối nào chạy).
  assert.ok("error" in (await disableOrgConnection(op, { orgCode: A, connectorKey: "lark-webhook", reason: "khoá luôn kết nối" })));

  // Bật lại ⇒ chạy.
  assert.ok("error" in (await setOrganizationSuspended(outsiders[0], { orgCode: A, suspend: false, reason: "mở lại hộ khách" })));
  const on = await setOrganizationSuspended(op, { orgCode: A, suspend: false, reason: "Đã đổi mật khẩu, mở lại" });
  assert.ok("ok" in on && on.changed);
  assert.equal(await withOrganization(A, async () => 1), 1);
  const job2 = (await runJob("creative-loop", { trigger: "CRON", actor: "pop-test", org: A })) as { skipped?: string };
  assert.ok(job2.skipped && job2.skipped !== "ORG_INACTIVE", `bật lại ⇒ qua cổng tổ chức (bị bỏ vì lý do KHÁC): ${JSON.stringify(job2)}`);
  assert.ok(fanOutOrganizationCodes(await listOrganizations()).includes(A));
  const again = await setOrganizationSuspended(op, { orgCode: A, suspend: false, reason: "bấm lại lần hai" });
  assert.ok("ok" in again && !again.changed, "bấm lại không ghi thêm");
}

// ═══════════ 5 · TẠM DỪNG LUẬT ═══════════

async function setupRules(code: string, withGate: boolean) {
  return withOrganization(code, async () => {
    const db = await getDb();
    const admin = (await db.query.users.findFirst({ where: eq(schema.users.role, "ADMIN") }))!;
    const actor = { id: admin.id, email: admin.email };
    const two = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ];
    assert.ok((await createCustomField("customer", { key: "pop_stage", label: "Giai đoạn POP", type: "status", options: two }, actor)).ok);
    if (withGate) assert.ok((await createCustomField("customer", { key: "pop_gate", label: "Cổng POP", type: "status", options: two }, actor)).ok);
    const live = async (input: Record<string, unknown>) => {
      const s = await saveRule(input, actor);
      assert.ok(s.ok, JSON.stringify(s));
      assert.ok((await setRuleStatus(s.rule.id, "ACTIVE", actor)).ok);
      assert.ok((await setRuleMode(s.rule.id, "LIVE", actor)).ok);
      return s.rule.id;
    };
    const direct = await live({ key: "pop_direct", name: "POP chạy ngay", trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "pop_stage", to: ["b"] }, actions: [{ kind: "create_task", title: "POP việc" }] });
    const gated = withGate
      ? await live({ key: "pop_gated", name: "POP cần duyệt", trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "pop_gate", to: ["b"] }, actions: [{ kind: "notify", message: "POP duyệt" }], gate: { kind: "approval", reason: "Quản lý xác nhận" } })
      : null;
    const [c1] = await db.insert(schema.customers).values({ name: "Khách luật POP" }).returning({ id: schema.customers.id });
    assert.equal((await runWorkflows()).events, 0, "lượt đầu khởi tạo con trỏ");
    return { direct, gated, customer: c1.id, viewer: sessionUser({ id: admin.id, email: admin.email }) };
  });
}

async function testWorkflowPause(op: SessionUser, outsiders: SessionUser[]) {
  const a = await setupRules(A, true);
  const b = await setupRules(B, false);
  const tasks = (code: string) => withOrganization(code, async () => Number((await (await getDb()).select({ n: sql<number>`count(*)` }).from(schema.workItems).where(eq(schema.workItems.sourceType, "WORKFLOW_TASK")))[0].n));
  const runsOf = (code: string, ruleId: string) => withOrganization(code, async () => (await getDb()).select().from(schema.workflowRuns).where(eq(schema.workflowRuns.ruleId, ruleId)));

  // Lượt chờ duyệt có TRƯỚC khi dừng.
  await withOrganization(A, async () => {
    assert.ok((await saveCustomValues("customer", a.customer, { pop_gate: "b" }, a.viewer)).ok);
    assert.equal((await runWorkflows()).waiting, 1);
  });
  for (const u of outsiders) assert.ok("error" in (await setWorkflowsPaused(u, { orgCode: A, paused: true, reason: "tắt luật của khách" })), `${u.email} không tạm dừng được`);
  assert.ok("error" in (await setWorkflowsPaused(op, { orgCode: A, paused: true, reason: "" })), "thiếu lý do");
  const p = await setWorkflowsPaused(op, { orgCode: A, paused: true, reason: "Luật gửi tin lặp vô hạn" });
  assert.ok("ok" in p && p.changed, JSON.stringify(p));
  const flagRow = (await auditRows(A, "FLAG_SET")).find((r) => r.subject === "workflows.paused");
  assert.ok(flagRow && flagRow.reason === "Luật gửi tin lặp vô hạn" && (flagRow.after as { enabled: boolean }).enabled === true);

  // pop-a: sự kiện mới trong lúc dừng ⇒ engine bỏ qua, ghi lý do; lượt chờ duyệt GIỮ NGUYÊN.
  await withOrganization(A, async () => {
    assert.ok((await saveCustomValues("customer", a.customer, { pop_stage: "b" }, a.viewer)).ok);
    const r = await runWorkflows();
    assert.ok(r.paused && /tạm dừng/.test(r.paused.reason), JSON.stringify(r));
    assert.equal(r.events, 0, "không xét sự kiện nào");
  });
  assert.equal(await tasks(A), 0, "không việc nào được tạo khi dừng");
  assert.equal((await runsOf(A, a.direct)).length, 0, "không lượt chạy nào được ghi khi dừng");
  assert.deepEqual((await runsOf(A, a.gated!)).map((r) => r.status), ["WAITING_APPROVAL"], "lượt chờ duyệt giữ nguyên");

  // pop-b: vẫn chạy.
  await withOrganization(B, async () => {
    assert.ok((await saveCustomValues("customer", b.customer, { pop_stage: "b" }, b.viewer)).ok);
    const r = await runWorkflows();
    assert.ok(!r.paused && r.executed === 1, `tổ chức khác vẫn chạy: ${JSON.stringify(r)}`);
  });
  assert.equal(await tasks(B), 1);

  // Bật lại ⇒ chạy tiếp từ chỗ dừng, đúng một lần.
  const resume = await setWorkflowsPaused(op, { orgCode: A, paused: false, reason: "Đã sửa luật gửi tin" });
  assert.ok("ok" in resume && resume.changed);
  await withOrganization(A, async () => {
    const r1 = await runWorkflows();
    assert.ok(!r1.paused && r1.executed === 1, JSON.stringify(r1));
    await runWorkflows();
  });
  assert.equal(await tasks(A), 1, "bật lại: sự kiện trong lúc dừng được xử lý ĐÚNG MỘT lần");
  assert.equal((await runsOf(A, a.direct)).length, 1, "không nhân đôi lượt chạy");
  assert.deepEqual((await runsOf(A, a.gated!)).map((r) => r.status), ["WAITING_APPROVAL"], "lượt chờ duyệt vẫn chờ người duyệt");
}

// ═══════════ 6 · TẮT KẾT NỐI ═══════════

async function testConnectionDisable(op: SessionUser, outsiders: SessionUser[]) {
  const status = () => withOrganization(A, async () => (await (await getDb()).query.orgConnections.findFirst({ where: eq(schema.orgConnections.connectorKey, "lark-webhook") }))?.status);
  assert.equal(await status(), "DRAFT");
  for (const u of outsiders) assert.ok("error" in (await disableOrgConnection(u, { orgCode: A, connectorKey: "lark-webhook", reason: "tắt kết nối của khách" })));
  assert.ok("error" in (await disableOrgConnection(op, { orgCode: A, connectorKey: "lark-webhook", reason: "" })));
  assert.equal(await status(), "DRAFT", "lượt bị từ chối không đổi gì");
  const r = await disableOrgConnection(op, { orgCode: A, connectorKey: "lark-webhook", reason: "Webhook trả 401 liên tục" });
  assert.ok("ok" in r && r.changed, JSON.stringify(r));
  assert.equal(await status(), "DISABLED");
  const orgLog = await withOrganization(A, async () => (await getDb()).select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "ORG_CONNECTION_DISABLE")));
  assert.ok(orgLog.length === 1 && orgLog[0].userId === null && orgLog[0].userEmail.includes(op.email) && /vận hành nền tảng/.test(orgLog[0].userEmail) && orgLog[0].reason === "Webhook trả 401 liên tục", JSON.stringify(orgLog));
  assert.equal((await auditRows(A, "CONNECTION_DISABLE")).length, 1);
  const again = await disableOrgConnection(op, { orgCode: A, connectorKey: "lark-webhook", reason: "bấm lại lần hai" });
  assert.ok("ok" in again && !again.changed);
  assert.equal((await auditRows(A, "CONNECTION_DISABLE")).length, 1, "bấm lại không ghi thêm");
  // Không ghi thẳng bảng kết nối từ lớp công tắc.
  assert.ok(!/orgConnections|org_connections/.test(readFileSync("lib/platform/kill-switches.ts", "utf8")), "công tắc đi qua sổ kết nối, không chạm bảng");
}

export async function testPilotOps() {
  testPure();
  await cleanup();
  for (const code of ORGS) rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  const home = await getHomeOrganization();
  const op = sessionUser({ id: "pop-op", email: "op@pop.local", organization: { code: home.code, name: home.name, isHome: true } });
  const homeViewer = sessionUser({ id: "pop-viewer", email: "xem@pop.local", role: "VIEWER", permissions: ["dashboard:view"], organization: op.organization });
  const otherAdmin = sessionUser({ id: "pop-khac", email: "qt@pop-b.local", permissions: ["platform:operate"], organization: { code: B, name: B, isHome: false } });
  const outsiders = [homeViewer, otherAdmin];
  await provisionOrganization({ code: B, name: "Tổ chức khác POP", modules: ["customers"], admin: { email: `admin@${B}.local`, name: "QT B", password: "PopB@123456" }, source: "TEST", actor: null });
  try {
    await testLifecycle(op, outsiders);
    await testSupport(op, outsiders);
    await testSuspend(op, outsiders);
    await testWorkflowPause(op, outsiders);
    await testConnectionDisable(op, outsiders);
    // pop-b (tổ chức khác) không bị công tắc nào của pop-a chạm tới.
    assert.equal((await auditRows(B)).filter((r) => ["ORG_STATUS", "FLAG_SET", "CONNECTION_DISABLE", "SUPPORT_VIEW"].includes(r.action)).length, 0);
  } finally {
    setSessionTokenSourceForTests(null);
    await cleanup();
    for (const code of ORGS) rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  console.log(
    "✓ Vận hành khách pilot: /start ⇒ CREATED → CONFIGURING có nhật ký; không nhảy bậc, checklist chưa đạt bị chặn, ghi đè cần lý do và ghi cổng bị vượt, đủ dữ liệu thật thì qua không ghi đè, UAT + sao lưu đêm đầu ⇒ ACTIVE; trang sức khoẻ không lộ tên khách / tiền đơn / giá trị field và MỖI lượt xem có vết; đình chỉ chặn phiên + job + webhook rồi bật lại chạy; tạm dừng luật bỏ qua đúng tổ chức, lượt chờ duyệt giữ nguyên, bật lại không nhân đôi; tắt kết nối qua sổ kết nối; người ngoài bị từ chối mọi thao tác",
  );
}
