/**
 * PHASE 11 · H3 · XUẤT / KHÔI PHỤC CẤU HÌNH TỔ CHỨC — `lib/blueprints/export.ts`, `lib/blueprints/import-file.ts`,
 * `app/api/metadata/blueprint-export/route.ts`, `/settings/export`, «Cài từ tệp JSON» ở `/settings/templates`.
 *
 * VÒNG TRÒN trên hai tổ chức THẬT `ox-a` / `ox-b` (CSDL riêng, tự cấp, tự dọn):
 *   A cài mẫu `service-business` + tuỳ biến thêm (field trên đối tượng hệ thống và tuỳ biến, trang của mẫu SỬA TAY rồi
 *   xuất bản lại, một trang tay mới, một trang chỉ có nháp, luật tay, vai trò tuỳ chỉnh, module bật thêm + override trạng thái đơn + danh sách đơn sửa tay) + dữ liệu
 *   và bí mật KHÔNG được đi theo (bản ghi có giá trị dễ nhận, khoá cài đặt mang chuỗi bí mật)
 *   ⇒ xuất ⇒ `validateBlueprint` ok ⇒ tệp JSON ⇒ B (trống) cài từ tệp (xem trước → cài, cùng bộ cài) ⇒ xuất B
 *   ⇒ HAI GÓI BẰNG NHAU sau khi bỏ phần đầu (khoá / phiên bản / tên / mô tả) — so băm ỔN ĐỊNH và so từng mục.
 * Quét chuỗi: gói không chứa email, bí mật, giá trị bản ghi, id nội bộ (uuid). Tổ chức B không xuất được của A: phiên A
 * trong ngữ cảnh B bị từ chối; route với phiên B trả cấu hình của B. Route: attachment + nosniff + no-store.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema as dbSchema } from "@/db";
import { GET as blueprintExportGET } from "@/app/api/metadata/blueprint-export/route";
import { saveAccessRoleCore } from "@/lib/auth/access-roles";
import { setRequestPathSourceForTests, type SessionUser } from "@/lib/auth/session";
import { MODULE_KEYS } from "@/lib/constants/platform-modules";
import { env } from "@/lib/env";
import { createCustomField } from "@/lib/metadata/fields";
import { getFormDraft, publishForm, saveFormDraft } from "@/lib/metadata/forms";
import { getListViewDraft, publishListView, saveListViewDraft } from "@/lib/metadata/lists";
import { saveStatusOverrides } from "@/lib/metadata/statuses";
import { toggleOwnModule } from "@/lib/platform-ui/module-toggle";
import type { FormSchema } from "@/lib/metadata/types";
import { createRecord } from "@/lib/objects/records";
import { createPage, getPageBySlug, listPages, publishPage, savePageDraft } from "@/lib/pages/registry";
import type { PageSchema } from "@/lib/pages/types";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { actorOf } from "@/lib/platform-ui/metadata-admin";
import { setSettingJson } from "@/lib/settings";
import { saveRule } from "@/lib/workflow/rules";
import { stableHash, stableStringify } from "@/lib/blueprints/hash";
import { installBlueprint } from "@/lib/blueprints/install";
import { blueprintContentHash, comparableBlueprint, exportDenial, exportFileName, exportForUser, exportKeyOf, exportOrgBlueprint, exportVersionOf, type OrgExport } from "@/lib/blueprints/export";
import { BLUEPRINT_FILE_MAX_BYTES, installBlueprintFile, parseBlueprintFile, previewBlueprintFile } from "@/lib/blueprints/import-file";
import { SERVICE_BUSINESS_BLUEPRINT } from "@/lib/blueprints/templates/service-business";
import { validateBlueprint } from "@/lib/blueprints/validate";

const A = "ox-a";
const B = "ox-b";
const PASSWORD = "XuatCauHinh@98765";
/** Chuỗi nhận dạng: nếu xuất hiện trong gói là rò. */
const SECRET_SETTING = "bi-mat-ket-noi-cua-to-chuc-a-5f4e3d2c1b";
const SECRET_URL = "https://open.larksuite.com/open-apis/bot/v2/hook/abcd1234-ox-a-secret";
const RECORD_TITLE = "HD-BAN-GHI-RIENG-7788";
const RECORD_VALUE = "GIA-TRI-BAN-GHI-XYZ-4321";
const HAND_EDIT = "Sửa tay trên tổ chức A — đoạn này phải đi theo gói";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "ox-user", email: "ox@local", name: "OX", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: "nha", name: "Nhà", isHome: true }, modules: [...MODULE_KEYS], ...over };
}

function msg(v: unknown): string {
  return JSON.stringify(v).slice(0, 800);
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(dbSchema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(dbSchema.platformOrganizationModules).where(eq(dbSchema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(dbSchema.platformOrganizations).where(eq(dbSchema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function provision(code: string) {
  await cleanupOrg(code);
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  await provisionOrganization({ code, name: `Tổ chức xuất ${code}`, modules: [], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: PASSWORD }, source: "TEST", actor: null });
}

async function adminOf(code: string): Promise<SessionUser> {
  const db = await getDb();
  const row = await db.query.users.findFirst({ where: eq(dbSchema.users.email, `admin@${code}.local`) });
  assert.ok(row, `thiếu quản trị của ${code}`);
  return sessionUser({ id: row.id, email: row.email, name: row.name, organization: { code, name: code, isHome: false }, modules: [...(await getEnabledModules(code))] });
}

async function tokenOf(org: string, u: { id: string; email: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: u.email, name: "Quản trị", role: "ADMIN", org, lgn: now })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(u.id)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(new TextEncoder().encode(env.authSecret));
}

async function download(token: string): Promise<{ status: number; headers: Headers; body: string }> {
  const reqPath = "/api/metadata/blueprint-export";
  setSessionTokenSourceForTests(async () => token);
  setRequestPathSourceForTests(() => reqPath);
  try {
    const res = await blueprintExportGET();
    return { status: res.status, headers: res.headers, body: await res.text() };
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
  }
}

/**
 * Quét chuỗi của gói: không email, không bí mật, không giá trị bản ghi, không mật khẩu, không id nội bộ. Trả danh sách
 * chỗ rò (rỗng = sạch) — bài kiểm đột biến dựa vào đúng hàm này.
 */
export function leaksOf(bp: unknown, forbidden: readonly string[]): string[] {
  const text = JSON.stringify(bp);
  const out: string[] = [];
  for (const s of forbidden) if (text.includes(s)) out.push(`chứa «${s}»`);
  const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  if (emails) out.push(`có email: ${[...new Set(emails)].join(", ")}`);
  const uuid = UUID.exec(text);
  if (uuid) out.push(`có id nội bộ ${uuid[0]}`);
  return out;
}

function testPure() {
  assert.equal(exportKeyOf("bp-a"), "org-bp-a");
  assert.equal(exportKeyOf("VNX"), "org-vnx");
  assert.equal(exportVersionOf(new Date("2026-09-28T07:05:00Z")), "2026.928.705");
  assert.equal(exportFileName({ key: "org-bp-a", version: "2026.928.705" }), "org-bp-a-2026-928-705.blueprint.json");
  // Phần đầu KHÔNG vào băm nội dung.
  const a = { ...SERVICE_BUSINESS_BLUEPRINT, key: "org-x", version: "1.0.0", name: "X", description: "x" };
  const b = { ...SERVICE_BUSINESS_BLUEPRINT, key: "org-y", version: "9.9.9", name: "Y", description: "y" };
  assert.equal(blueprintContentHash(a), blueprintContentHash(b));
  assert.ok(!("key" in comparableBlueprint(a)) && !("version" in comparableBlueprint(a)));
  assert.notEqual(blueprintContentHash(a), blueprintContentHash({ ...a, modules: [...a.modules, "orders"] }));
  // Quyền: cần CẢ hai khoá quản trị + tổ chức trong phiên.
  assert.equal(exportDenial(sessionUser({})), null);
  assert.match(exportDenial(sessionUser({ role: "VIEWER", permissions: ["metadata:manage"] })) ?? "", /cấu hình hệ thống/);
  assert.match(exportDenial(sessionUser({ role: "VIEWER", permissions: ["settings:manage"] })) ?? "", /cấu hình dữ liệu/);
  assert.match(exportDenial(sessionUser({ organization: undefined })) ?? "", /tổ chức/);
  // Tệp tải lên: rỗng / hỏng / không phải đối tượng / sai định dạng / khoá mẫu / quá trần ⇒ từ chối, không ném.
  assert.ok(!parseBlueprintFile("").ok);
  assert.ok(!parseBlueprintFile("{khong phai json").ok);
  assert.ok(!parseBlueprintFile("[1,2]").ok);
  assert.ok(!parseBlueprintFile(JSON.stringify({ format: "khac" })).ok);
  const tpl = parseBlueprintFile(JSON.stringify(SERVICE_BUSINESS_BLUEPRINT));
  assert.ok(!tpl.ok && tpl.errors[0].path === "key", "khoá trùng mẫu ngành ⇒ từ chối");
  assert.ok(parseBlueprintFile(`﻿${JSON.stringify({ ...SERVICE_BUSINESS_BLUEPRINT, key: "org-khac" })}`).ok, "BOM đầu tệp không làm hỏng");
  assert.ok(!parseBlueprintFile(" ".repeat(BLUEPRINT_FILE_MAX_BYTES + 1)).ok, "quá trần ⇒ từ chối");
}

const HAND_PAGE: PageSchema = {
  version: 1,
  sections: [
    {
      key: "hop_dong",
      title: "Hợp đồng",
      blocks: [
        { id: "gioi_thieu", type: "text", span: 12, config: { heading: "Bảng hợp đồng", body: "Trang dựng tay trên tổ chức A." } },
        { id: "bang_hd", type: "table", span: 12, title: "Hợp đồng", config: { source: "x_contract", columns: ["system:title", "custom:gia_tri", "custom:ma_noi_bo"], pageSize: 20, rowLink: true } },
      ],
    },
  ],
};

async function customizeA(admin: SessionUser) {
  const actor = actorOf(admin);
  // ── Field thêm: trên đối tượng tuỳ biến (có kiểm độ dài) và trên đối tượng hệ thống (chọn) ──
  const f1 = await createCustomField("x_contract", { key: "ma_noi_bo", label: "Mã nội bộ", type: "text", validation: { maxLength: 40 }, filterable: true, helpText: "Mã quản lý nội bộ" }, actor);
  assert.ok(f1.ok, msg(f1));
  const f2 = await createCustomField("customer", { key: "hang_khach", label: "Hạng khách", type: "select", filterable: true, options: [{ value: "vang", label: "Vàng", color: "amber" }, { value: "bac", label: "Bạc" }] }, actor);
  assert.ok(f2.ok, msg(f2));

  // ── Trang của MẪU sửa tay rồi xuất bản lại ──
  const tplPage = await getPageBySlug("khach-hang-dich-vu");
  assert.ok(tplPage, "trang của mẫu đã xuất bản");
  const edited = JSON.parse(JSON.stringify(tplPage.schema)) as PageSchema;
  const text = edited.sections[0].blocks.find((b) => b.type === "text");
  assert.ok(text);
  (text.config as { body: string }).body = HAND_EDIT;
  const sd = await savePageDraft(tplPage.page.id, edited, actor);
  assert.ok(sd.ok, msg(sd));
  const sp = await publishPage(tplPage.page.id, actor);
  assert.ok(sp.ok, msg(sp));

  // ── Trang tay mới (xuất bản) + trang chỉ có nháp (KHÔNG đi theo gói) ──
  const hand = await createPage({ slug: "bang-hop-dong", name: "Bảng hợp đồng", moduleKey: "apps", nav: { enabled: true, label: "Bảng hợp đồng", zone: null, order: 20 }, draft: HAND_PAGE }, actor);
  assert.ok(hand.ok, msg(hand));
  const hp = await publishPage(hand.page.id, actor);
  assert.ok(hp.ok, msg(hp));
  const draftOnly = await createPage({ slug: "nhap-chua-xuat", name: "Nháp chưa xuất bản", moduleKey: "apps", draft: HAND_PAGE }, actor);
  assert.ok(draftOnly.ok, msg(draftOnly));

  // ── Luật tay ──
  const rule = await saveRule(
    {
      key: "hop_dong_moi_bao",
      name: "Hợp đồng mới ⇒ báo nhóm",
      trigger: { kind: "event", event: "custom_record.created", objectKey: "x_contract" },
      conditions: { field: "custom:ma_noi_bo", op: "not_empty" },
      actions: [{ kind: "notify", message: "Có hợp đồng mới cần rà điều khoản." }],
    },
    actor,
  );
  assert.ok(rule.ok, msg(rule));

  // ── Vai trò tuỳ chỉnh ──
  const role = await saveAccessRoleCore(admin, { id: "", code: "KE_TOAN_HD", name: "Kế toán hợp đồng", description: "Xem khách và hợp đồng", baseRole: "ACCOUNTANT", permissions: ["customers:view", "records:view"], defaultScope: "ALL", active: true });
  assert.ok(!("error" in role), msg(role));

  // ── Form của mẫu sửa tay: thêm ô «Mã nội bộ» vào form tạo hợp đồng rồi xuất bản ──
  const form = await getFormDraft("x_contract", "create");
  const withCode: FormSchema = { ...form, sections: form.sections.map((sec, i) => (i === 0 ? { ...sec, fields: sec.fields.map((f) => (f.ref === "custom:ma_noi_bo" ? { ...f, visible: true } : f)) } : sec)) };
  if (!withCode.sections.some((sec) => sec.fields.some((f) => f.ref === "custom:ma_noi_bo"))) withCode.sections[0].fields.push({ ref: "custom:ma_noi_bo", visible: true, readOnly: false, required: false });
  const fd = await saveFormDraft("x_contract", "create", withCode, actor);
  assert.ok(fd.ok, msg(fd));
  const fp = await publishForm("x_contract", "create", actor);
  assert.ok(fp.ok, msg(fp));

  // ── Bật thêm Sản phẩm + Đơn hàng, đổi nhãn / ẩn trạng thái HỆ THỐNG của đơn, xuất bản danh sách đơn đã sửa ──
  for (const moduleKey of ["products", "orders"]) {
    const t = await toggleOwnModule(admin, { moduleKey, enabled: true, reason: "thử xuất cấu hình" });
    assert.ok("ok" in t, msg(t));
  }
  const st = await saveStatusOverrides(
    "order",
    "stage",
    [
      { value: "NEW", label: "Đơn mới nhận", position: 0, active: true },
      { value: "DELETED", label: "", position: 12, active: false },
    ],
    actor,
  );
  assert.ok(st.ok, msg(st));
  const list = await getListViewDraft("order", "default");
  const lv = await saveListViewDraft("order", "default", { ...list, columns: list.columns.map((c, i) => (i === 1 ? { ...c, visible: false } : c)) }, actor);
  assert.ok(lv.ok, msg(lv));
  const lp = await publishListView("order", "default", actor);
  assert.ok(lp.ok, msg(lp));

  // ── Dữ liệu + bí mật: KHÔNG được đi theo gói ──
  const rec = await createRecord("x_contract", { system: { title: RECORD_TITLE }, custom: { gia_tri: 123_456_789, ma_noi_bo: RECORD_VALUE } }, admin);
  assert.ok(rec.ok, msg(rec));
  await setSettingJson("lark.webhookUrl", SECRET_URL);
  await setSettingJson("integrations.apiToken", { token: SECRET_SETTING });
}

function forbiddenStrings(code: string): string[] {
  return [SECRET_SETTING, SECRET_URL, RECORD_TITLE, RECORD_VALUE, "123456789", PASSWORD, `admin@${code}.local`];
}

function assertExportA(ex: OrgExport) {
  assert.ok(ex.validation.ok, `gói xuất phải hợp lệ: ${msg(ex.validation.errors)}`);
  assert.ok(validateBlueprint(JSON.parse(JSON.stringify(ex.blueprint))).ok, "qua JSON vẫn hợp lệ");
  const bp = ex.blueprint;
  assert.equal(bp.key, "org-ox-a");
  for (const m of SERVICE_BUSINESS_BLUEPRINT.modules) assert.ok(bp.modules.includes(m), `module ${m}`);
  assert.deepEqual(bp.objects?.map((o) => o.key), ["x_contract", "x_project"]);
  const fieldKeys = (bp.fields ?? []).map((f) => `${f.objectKey}.${f.key}`);
  for (const f of SERVICE_BUSINESS_BLUEPRINT.fields ?? []) assert.ok(fieldKeys.includes(`${f.objectKey}.${f.key}`), `field của mẫu ${f.objectKey}.${f.key}`);
  assert.ok(fieldKeys.includes("x_contract.ma_noi_bo") && fieldKeys.includes("customer.hang_khach"), "field thêm tay");
  assert.deepEqual(bp.fields?.find((f) => f.key === "ma_noi_bo")?.validation, { maxLength: 40 });
  assert.deepEqual(bp.fields?.find((f) => f.objectKey === "x_project" && f.key === "hop_dong_chinh")?.relation, { objectKey: "x_contract", unique: true }, "một-một đi theo");
  // Trang: của mẫu (bản SỬA TAY đã xuất bản), trang tay; trang chỉ có nháp nằm ở `omitted`.
  assert.deepEqual(bp.pages?.map((p) => p.slug), ["bang-hop-dong", "khach-hang-dich-vu"]);
  assert.ok(JSON.stringify(bp.pages?.find((p) => p.slug === "khach-hang-dich-vu")).includes(HAND_EDIT), "trang mang bản ĐÃ SỬA TAY");
  assert.ok(ex.omitted.some((o) => o.kind === "page" && o.key === "nhap-chua-xuat"), `trang nháp phải được nói ra: ${msg(ex.omitted)}`);
  assert.ok(bp.pages?.every((p) => p.publish === true));
  // Luật: của mẫu + tay. Vai trò. Trạng thái hệ thống không có override ⇒ không có mục.
  assert.deepEqual(bp.workflows?.map((w) => w.key), ["hop_dong_lon_can_duyet", "hop_dong_moi_bao"]);
  assert.ok(bp.roles?.some((r) => r.key === "ke_toan_hd" && r.base === "ACCOUNTANT" && r.permissions.includes("records:view")));
  const contractForm = bp.forms?.find((f) => f.objectKey === "x_contract" && f.formKey === "create");
  assert.ok(contractForm && JSON.stringify(contractForm.schema).includes("custom:ma_noi_bo"), "form sửa tay đi theo gói");
  assert.ok(bp.listViews?.some((l) => l.objectKey === "x_project"));
  assert.ok(bp.modules.includes("orders") && bp.modules.includes("products"), "module bật tay đi theo");
  assert.deepEqual(bp.statuses, [
    {
      objectKey: "order",
      field: "stage",
      options: [
        { value: "DELETED", label: "", position: 12, active: false },
        { value: "NEW", label: "Đơn mới nhận", position: 0, active: true },
      ],
    },
  ]);
  assert.ok(bp.listViews?.some((l) => l.objectKey === "order" && l.listKey === "default"), "danh sách đơn đã xuất bản đi theo");
  assert.ok(bp.ai && bp.ai.businessProfile.length > 10, "ngữ cảnh AI");
  // Không một chuỗi bị cấm, không email, không id nội bộ.
  assert.deepEqual(leaksOf(bp, forbiddenStrings(A)), [], "gói không mang bí mật / bản ghi / người dùng / id");
  assert.ok(!("settings" in bp) || bp.settings!.every((s) => s.key === "care.notePresets"), "chỉ khoá cài đặt an toàn");
}

export async function testOrgExport() {
  testPure();
  await provision(A);
  await provision(B);
  try {
    // ═══ A: cài mẫu + tuỳ biến + dữ liệu/bí mật ⇒ xuất ═══
    const exA = await withOrganization(A, async () => {
      let admin = await adminOf(A);
      const inst = await installBlueprint(SERVICE_BUSINESS_BLUEPRINT, admin);
      assert.ok(inst.ok, msg(inst));
      admin = await adminOf(A);
      await customizeA(admin);
      const ex = await exportOrgBlueprint({ now: new Date("2026-09-28T07:05:00Z") });
      assertExportA(ex);
      // Xuất hai lần ⇒ cùng nội dung (ổn định, không phụ thuộc thứ tự đọc).
      const again = await exportOrgBlueprint({ now: new Date("2026-09-29T08:00:00Z") });
      assert.equal(again.contentHash, ex.contentHash, "xuất lại không đổi nội dung");
      assert.notEqual(again.blueprint.version, ex.blueprint.version);
      // Route: phiên A ⇒ 200, tải xuống an toàn, đúng nội dung.
      const tokA = await tokenOf(A, admin);
      const res = await download(tokA);
      assert.equal(res.status, 200, res.body.slice(0, 300));
      assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="org-ox-a-[0-9-]+\.blueprint\.json"$/);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("cache-control"), "private, no-store");
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      const fromRoute = JSON.parse(res.body);
      assert.equal(blueprintContentHash(fromRoute), ex.contentHash, "route trả đúng gói của A");
      const logged = await (await getDb()).select().from(dbSchema.auditLogs).where(eq(dbSchema.auditLogs.action, "BLUEPRINT_EXPORT"));
      assert.equal(logged.length, 1, "một dòng nhật ký cho một lượt tải");
      assert.ok(!JSON.stringify(logged[0]).includes(RECORD_VALUE), "nhật ký không chứa nội dung");
      return ex;
    });

    // ═══ B: trống ⇒ xuất (khác A) ⇒ cài TỪ TỆP của A ⇒ xuất lại ⇒ BẰNG A ═══
    await withOrganization(B, async () => {
      let admin = await adminOf(B);
      const empty = await exportOrgBlueprint();
      assert.notEqual(empty.contentHash, exA.contentHash, "B trống khác A");
      assert.equal(empty.blueprint.pages, undefined, "B chưa có trang nào của A");

      // Tổ chức B KHÔNG xuất được của A: phiên A trong ngữ cảnh B ⇒ từ chối, không trả cấu hình của B cho người của A.
      const cross = await exportForUser(sessionUser({ organization: { code: A, name: A, isHome: false } }));
      assert.ok(!cross.ok && /tổ chức khác/.test(cross.error), msg(cross));

      const file = JSON.stringify(exA.blueprint, null, 2);
      const pre = await previewBlueprintFile(admin, file);
      assert.ok(pre.ok, msg(pre));
      assert.ok(pre.value.plan.ok, `kế hoạch cài từ tệp: ${msg(pre.value.plan.steps.filter((s) => s.action === "BLOCKED"))}`);
      assert.equal(pre.value.plan.counts.CONFLICT, 0, msg(pre.value.plan.steps.filter((s) => s.action === "CONFLICT")));
      const stale = await installBlueprintFile(admin, file, { planHash: "khac", resolutions: {} });
      assert.ok(!stale.ok && stale.installId === null, "planHash lệch ⇒ không ghi");
      const done = await installBlueprintFile(admin, file, { planHash: pre.value.plan.planHash, resolutions: {} });
      assert.ok(done.ok, msg(done));
      admin = await adminOf(B);

      const exB = await exportOrgBlueprint({ now: new Date("2026-09-28T09:00:00Z") });
      assert.ok(exB.validation.ok, msg(exB.validation.errors));
      assert.equal(exB.blueprint.key, "org-ox-b");
      assert.deepEqual(comparableBlueprint(exB.blueprint), comparableBlueprint(exA.blueprint), "cấu hình B sau khôi phục = cấu hình A");
      assert.equal(stableHash(comparableBlueprint(exB.blueprint)), stableHash(comparableBlueprint(exA.blueprint)));
      assert.equal(exB.contentHash, exA.contentHash, "băm ổn định bằng nhau");
      assert.equal(stableStringify(comparableBlueprint(exB.blueprint)), stableStringify(comparableBlueprint(exA.blueprint)));
      // Trang và luật đi theo đúng trạng thái: trang ĐÃ XUẤT BẢN, luật ở NHÁP.
      const pages = await listPages();
      assert.ok(pages.some((p) => p.slug === "bang-hop-dong" && p.publishedVersion > 0));
      assert.ok(!pages.some((p) => p.slug === "nhap-chua-xuat"), "trang nháp của A không sang B");
      assert.ok(JSON.stringify((await getPageBySlug("khach-hang-dich-vu"))?.schema).includes(HAND_EDIT));
      // Không dữ liệu nào của A sang B.
      assert.deepEqual(leaksOf(exB.blueprint, forbiddenStrings(A)), []);
      assert.equal((await (await getDb()).select().from(dbSchema.customRecords)).length, 0, "không bản ghi nào của A sang B");
      // Cài lại cùng tệp ⇒ không còn gì để ghi.
      const again = await previewBlueprintFile(admin, file);
      assert.ok(again.ok && again.value.plan.counts.CREATE + again.value.plan.counts.UPDATE === 0, msg(again.ok ? again.value.plan.counts : again));
      // Route với phiên B ⇒ cấu hình của B (khoá org-ox-b), không phải của A.
      const res = await download(await tokenOf(B, admin));
      assert.equal(res.status, 200, res.body.slice(0, 300));
      assert.equal(JSON.parse(res.body).key, "org-ox-b");
      // Sửa một trang ở B ⇒ băm khác A (phép so không mù).
      const p = await getPageBySlug("bang-hop-dong");
      assert.ok(p);
      const changed = JSON.parse(JSON.stringify(p.schema)) as PageSchema;
      (changed.sections[0].blocks[0].config as { body: string }).body = "B sửa khác";
      assert.ok((await savePageDraft(p.page.id, changed, actorOf(admin))).ok);
      assert.ok((await publishPage(p.page.id, actorOf(admin))).ok);
      assert.notEqual((await exportOrgBlueprint()).contentHash, exA.contentHash, "B sửa trang ⇒ băm khác");
    });

    // Người thiếu `settings:manage` ⇒ route 403 (đọc CẢ cấu hình cần hai khoá). Dựng tài khoản VIEWER thật trong A.
    await withOrganization(A, async () => {
      const db = await getDb();
      const [viewer] = await db.insert(dbSchema.users).values({ email: "xem@ox-a.local", name: "Người xem", role: "VIEWER", passwordHash: "x" }).returning({ id: dbSchema.users.id, email: dbSchema.users.email });
      const res = await download(await tokenOf(A, viewer));
      assert.equal(res.status, 403, `VIEWER ⇒ 403, nhận ${res.status}`);
      assert.equal(res.headers.get("content-disposition"), null);
    });
  } finally {
    await cleanupOrg(A);
    await cleanupOrg(B);
  }
  console.log(
    "✓ Phase 11 · H3 · xuất / khôi phục cấu hình: ox-a cài service-business + field tay (đối tượng hệ thống lẫn tuỳ biến) + trang mẫu sửa tay + trang tay + luật tay + vai trò ⇒ xuất hợp lệ, trang nháp nói ra ở «không đi theo», không email / bí mật / giá trị bản ghi / id; route tải: attachment + nosniff + no-store + một dòng nhật ký, VIEWER ⇒ 403; ox-b trống cài TỪ TỆP (xem trước → planHash → cài) ⇒ xuất lại BẰNG A (băm ổn định), cài lại ⇒ không còn gì để ghi, phiên A trong ngữ cảnh B bị từ chối, route phiên B trả cấu hình B",
  );
}
