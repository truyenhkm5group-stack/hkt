/**
 * PHASE 7 · BLUEPRINT + MẪU NGÀNH — `lib/blueprints/*`, `/settings/templates`.
 *
 * Ba lớp:
 *  1. THUẦN — mỗi mẫu qua `validateBlueprint` (trang qua `validatePageSchema` với module của gói), năm mẫu khác nhau
 *     thật về module, không mang thứ chỉ-VNX; đối tượng tuỳ biến tự kéo `apps`, field quan hệ phải trỏ đích có thật
 *     (sổ hoặc gói), `unique` chỉ cho `relation`; vai trò có
 *     `users:manage` ⇒ lỗi gắn đúng mục ⇒ kế hoạch BỊ CHẶN; băm ổn định theo thứ tự khoá.
 *  2. MÃ NGUỒN — không tệp nào trong `lib/blueprints/*` ghi thẳng bảng, trừ sổ cài (`ledger.ts`) và sổ chỉ ghi hai
 *     bảng của chính nó.
 *  3. TỔ CHỨC THẬT `bp-a` / `bp-b` (CSDL riêng, tự cấp, tự dọn): cài `wholesale` ⇒ module đúng + field / form / danh sách
 *     / trang (xuất bản) / luật (NHÁP) / vai trò / ngữ cảnh AI; cài lại ⇒ toàn UNCHANGED; sửa trang + lưu trữ field ⇒
 *     nâng phiên bản ⇒ SKIP_CUSTOMIZED / SKIP_DELETED, mục chưa sửa UPDATE (vào NHÁP, không xuất bản); ghi đè theo lựa
 *     chọn; hỏng giữa chừng ⇒ dừng + FAILED, chạy lại đi tiếp; B không thấy sổ cài của A; thiếu quyền ⇒ BLOCKED.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema as dbSchema } from "@/db";
import { visible, type NavUserLike } from "@/components/app-sidebar";
import type { SessionUser } from "@/lib/auth/session";
import { NAV_MODULES } from "@/lib/constants/department-modules";
import { MODULE_KEYS, moduleDef, moduleOfPath, type ModuleKey } from "@/lib/constants/platform-modules";
import { archiveCustomField, listFields } from "@/lib/metadata/fields";
import { getPublishedForm } from "@/lib/metadata/forms";
import { getListViewDraft, getPublishedListView } from "@/lib/metadata/lists";
import { getPageBySlug, getPageDraft, listPages, savePageDraft } from "@/lib/pages/registry";
import type { PageSchema } from "@/lib/pages/types";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { actorOf } from "@/lib/platform-ui/metadata-admin";
import { listAccessRoles } from "@/lib/queries/access";
import { getSettingJson } from "@/lib/settings";
import { listRules } from "@/lib/workflow/rules";
import { blueprintAdminDenial, installTemplate, loadTemplateCatalog, previewTemplate, sanitizeResolutions } from "@/lib/blueprints/admin";
import { stableHash, stableStringify } from "@/lib/blueprints/hash";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { installHistory, installedVersion } from "@/lib/blueprints/ledger";
import { orderModules, planBlueprint, type OrgState } from "@/lib/blueprints/plan";
import { BLUEPRINT_TEMPLATES, templateBlueprint } from "@/lib/blueprints/templates";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { AI_PROFILE_SETTING_KEY, BLUEPRINT_ITEM_KINDS, type Blueprint, type BlueprintPlan, type PlanAction } from "@/lib/blueprints/types";
import { blueprintModuleSet, validateBlueprint } from "@/lib/blueprints/validate";
import { SERVICE_BUSINESS_BLUEPRINT } from "@/lib/blueprints/templates/service-business";
import { resolveObject } from "@/lib/metadata/object-resolver";
import { toggleOwnModule } from "@/lib/platform-ui/module-toggle";

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "bp-user", email: "bp@local", name: "BP", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: "nha", name: "Nhà", isHome: true }, modules: [...MODULE_KEYS], ...over };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function actionOf(plan: BlueprintPlan, kind: string, key: string): PlanAction | undefined {
  return plan.steps.find((s) => s.kind === kind && s.key === key)?.action;
}

// ═══════════ 1 · THUẦN ═══════════

function testTemplatesPure() {
  assert.equal(BLUEPRINT_TEMPLATES.length, 7, "bảy mẫu tham chiếu (§4 + thực phẩm đóng gói 0180 + hải sản Seafood OS)");
  const keys = BLUEPRINT_TEMPLATES.map((t) => t.key);
  assert.deepEqual([...keys].sort(), ["fashion-commerce", "food-commerce", "general-ecommerce", "manufacturing", "seafood-commerce", "service-business", "wholesale"]);
  // Hai mẫu (b) dùng đối tượng tuỳ biến; mẫu dịch vụ có quan hệ tới khách từ HAI đối tượng.
  const svc = templateBlueprint("service-business")!;
  assert.deepEqual(svc.objects?.map((o) => o.key), ["x_contract", "x_project"]);
  for (const o of ["x_contract", "x_project"]) assert.ok(svc.fields?.some((f) => f.objectKey === o && f.type === "relation" && f.relation?.objectKey === "customer"), `${o} có quan hệ tới khách`);
  assert.ok(templateBlueprint("manufacturing")!.objects?.some((o) => o.key === "x_work_center"));
  assert.ok(svc.workflows?.some((w) => w.gate?.kind === "approval" && w.trigger.objectKey === "x_contract"), "luật hợp đồng > ngưỡng ⇒ duyệt ⇒ việc");
  for (const bp of BLUEPRINT_TEMPLATES) {
    const v = validateBlueprint(bp);
    assert.ok(v.ok, `${bp.key}: ${JSON.stringify(v.errors)}`);
    assert.equal(templateBlueprint(bp.key), bp);
    // Mỗi mẫu có đủ phần chứng minh (§4): module, field, form, danh sách, MỘT trang, MỘT luật, ngữ cảnh AI.
    assert.ok(bp.modules.length >= 5, `${bp.key}: module`);
    assert.ok((bp.fields ?? []).length >= 2, `${bp.key}: field tuỳ biến`);
    assert.ok((bp.forms ?? []).length >= 1, `${bp.key}: form`);
    assert.ok((bp.listViews ?? []).length >= 1, `${bp.key}: danh sách`);
    assert.ok((bp.pages ?? []).length >= 1, `${bp.key}: trang`);
    assert.ok((bp.workflows ?? []).length >= 1, `${bp.key}: luật`);
    assert.ok((bp.ai?.businessProfile.length ?? 0) > 40, `${bp.key}: ngữ cảnh AI`);
    // Không connector / phòng Tech trong module (credential của tổ chức nhà) — connector chỉ ở "gợi ý".
    for (const m of bp.modules) assert.ok(!moduleDef(m)?.requiresHomeCredentials, `${bp.key}: «${m}» cần credential nhà — không được vào module của mẫu`);
    // Không thứ gì chỉ đúng với VNX (vnx-specific-rules.md): tên, connector cụ thể, ngưỡng COD.
    const text = JSON.stringify(bp).toLowerCase();
    for (const bad of ["vnx", "pancake", "viettel", "glovico", "hải an", "return_rule", "order_outcome"]) assert.ok(!text.includes(bad), `${bp.key}: chứa «${bad}» — thứ chỉ-VNX không được vào mẫu`);
    // Ngưỡng COD của VNX (50K / 100K / 499K) — so NGUYÊN SỐ, không so chuỗi con (5.000.000 chứa "50000").
    for (const n of text.match(/\d+/g) ?? []) assert.ok(!["50000", "100000", "499000", "25000"].includes(n), `${bp.key}: mang ngưỡng / giá của VNX (${n})`);
  }
  // Mẫu KHÁC nhau thật về module.
  const sets = BLUEPRINT_TEMPLATES.map((t) => [...t.modules].sort().join(","));
  assert.equal(new Set(sets).size, sets.length, "hai mẫu cùng bộ module");
  const wholesale = new Set(WHOLESALE_BLUEPRINT.modules);
  for (const m of ["marketing", "production", "logistics"] as ModuleKey[]) assert.ok(!wholesale.has(m), `bán sỉ không có ${m}`);
  assert.ok(templateBlueprint("fashion-commerce")!.modules.includes("production"));
  assert.ok(!templateBlueprint("general-ecommerce")!.modules.includes("production"));
  assert.equal(templateBlueprint("khong-co"), null);

  // Thứ tự module: phụ thuộc trước.
  const ordered = orderModules(["logistics", "orders", "customers", "products"]);
  assert.ok(ordered.indexOf("customers") < ordered.indexOf("orders") && ordered.indexOf("orders") < ordered.indexOf("logistics"), ordered.join(","));
  assert.deepEqual([...BLUEPRINT_ITEM_KINDS].slice(0, 3), ["module", "role", "object"], "thứ tự ghi: module → vai trò → đối tượng …");

  // Băm ổn định: thứ tự khoá không đổi băm; thứ tự MẢNG thì có (thứ tự cột / khối có nghĩa).
  assert.equal(stableHash({ a: 1, b: { d: [1, 2], c: null } }), stableHash({ b: { c: null, d: [1, 2] }, a: 1 }));
  assert.notEqual(stableHash({ a: [1, 2] }), stableHash({ a: [2, 1] }));
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
}

function testRejections() {
  const base = clone(WHOLESALE_BLUEPRINT);
  // Đối tượng tuỳ biến: CHƯA hỗ trợ — từ chối rõ ràng.
  // Đối tượng tuỳ biến: `apps` TỰ vào tập module (gói không khai vẫn hợp lệ); biểu tượng ngoài tập đóng bị từ chối.
  const withObjects: Blueprint = { ...clone(base), objects: [{ key: "x_contract", label: "Hợp đồng", labelPlural: "Hợp đồng", icon: "file-text", moduleKey: "customers", titleLabel: "Số" }] };
  assert.ok(!withObjects.modules.includes("apps"));
  assert.ok(validateBlueprint(withObjects).ok, JSON.stringify(validateBlueprint(withObjects).errors));
  assert.ok(blueprintModuleSet(withObjects).has("apps"), "gói có đối tượng ⇒ apps là điều kiện cần");
  assert.ok(!validateBlueprint({ ...clone(withObjects), objects: [{ ...withObjects.objects![0], icon: "khong-co" }] }).ok, "biểu tượng ngoài tập đóng");
  // Field quan hệ: đích phải có thật (sổ hoặc gói); `unique` chỉ cho `relation`; field trên x_ không khai ⇒ lỗi.
  const rel = (f: NonNullable<Blueprint["fields"]>[number]) => validateBlueprint({ ...clone(withObjects), fields: [...(base.fields ?? []), f] });
  assert.ok(rel({ objectKey: "x_contract", key: "khach", label: "Khách", type: "relation", relation: { objectKey: "customer", unique: true } }).ok);
  assert.ok(rel({ objectKey: "customer", key: "hd", label: "HĐ", type: "relation_many", relation: { objectKey: "x_contract" } }).ok);
  assert.ok(rel({ objectKey: "customer", key: "hd", label: "HĐ", type: "relation_many", relation: { objectKey: "x_contract", unique: true } }).errors.some((e) => e.path.endsWith("relation.unique")), "unique chỉ cho relation");
  assert.ok(rel({ objectKey: "customer", key: "hd", label: "HĐ", type: "relation", relation: { objectKey: "x_khong_khai" } }).errors.some((e) => e.path.endsWith("relation.objectKey")), "đích x_ không khai trong gói");
  assert.ok(rel({ objectKey: "customer", key: "hd", label: "HĐ", type: "relation" }).errors.some((e) => e.path.endsWith(".relation")), "relation thiếu đích");
  assert.ok(rel({ objectKey: "x_khong_khai", key: "ghi_chu", label: "Ghi chú", type: "text" }).errors.some((e) => e.path.endsWith("objectKey")), "field trên đối tượng không khai");
  // Luật event + objectKey chỉ cho sự kiện của bản ghi metadata.
  const evBad = clone(SERVICE_BUSINESS_BLUEPRINT);
  evBad.workflows![0] = { ...evBad.workflows![0], trigger: { kind: "event", event: "model.registered", objectKey: "x_contract" } };
  assert.ok(validateBlueprint(evBad).errors.some((e) => e.path.startsWith("workflows.0.trigger")), "sự kiện miền khác không lọc theo đối tượng");
  // Trang của gói trỏ đối tượng tuỳ biến KHAI TRONG GÓI ⇒ qua (sổ nguồn của gói); trỏ `x_…` không khai ⇒ chặn.
  const pageOwn = clone(SERVICE_BUSINESS_BLUEPRINT);
  pageOwn.pages = [
    {
      slug: "hop-dong-cua-goi",
      name: "Hợp đồng",
      moduleKey: "apps",
      nav: { enabled: false, label: "", zone: null, order: 0 },
      schema: { version: 1, sections: [{ key: "main", blocks: [{ id: "bang_hd", type: "table", span: 12, config: { source: "x_contract", pageSize: 20 } }] }] },
    },
  ] as typeof pageOwn.pages;
  const vOwn = validateBlueprint(pageOwn);
  assert.ok(vOwn.ok, `trang trỏ x_contract của gói phải hợp lệ: ${JSON.stringify(vOwn.errors)}`);
  const pageForeign = clone(pageOwn) as unknown as { pages: { schema: { sections: { blocks: { config: { source: string } }[] }[] } }[] };
  pageForeign.pages[0].schema.sections[0].blocks[0].config.source = "x_khong_khai";
  assert.ok(!validateBlueprint(pageForeign).ok, "trang trỏ đối tượng không khai trong gói bị chặn");

  // Vai trò có users:manage ⇒ lỗi gắn đúng mục (luật 31); nền ADMIN ⇒ sai hình.
  const escalate = clone(base);
  escalate.roles = [{ ...escalate.roles![0], permissions: ["customers:view", "users:manage"] }];
  const ve = validateBlueprint(escalate);
  assert.ok(!ve.ok && ve.errors.some((e) => e.path === "roles.0.permissions"), JSON.stringify(ve.errors));
  const adminBase = clone(base) as unknown as { roles: { base: string }[] };
  adminBase.roles[0].base = "ADMIN";
  assert.ok(!validateBlueprint(adminBase).ok, "nền ADMIN bị từ chối");

  // Module thiếu phụ thuộc; trang trỏ nguồn của module không có trong gói; khoá lạ; cài đặt ngoài danh sách an toàn.
  const noDeps = clone(base);
  noDeps.modules = noDeps.modules.filter((m) => m !== "customers");
  assert.ok(validateBlueprint(noDeps).errors.some((e) => e.path.startsWith("modules.")), "module thiếu phụ thuộc");
  const badPage = clone(base);
  (badPage.pages![0].schema as PageSchema).sections[0].blocks[0] = { id: "ty_le", type: "kpi", span: 3, config: { metric: "return_rate" } };
  assert.ok(validateBlueprint(badPage).errors.some((e) => e.path.startsWith("pages.0.schema")), "khối của module không có trong gói ⇒ lỗi tại trang");
  assert.ok(!validateBlueprint({ ...clone(base), bogus: 1 }).ok, "khoá lạ bị từ chối");
  assert.ok(!validateBlueprint({ ...clone(base), settings: [{ key: "profit.assumptions", value: {} }] }).ok, "khoá cài đặt ngoài danh sách an toàn");
  const noField = clone(base);
  noField.workflows![0] = { ...noField.workflows![0], trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "khong_co", to: ["x"] } };
  assert.ok(validateBlueprint(noField).errors.some((e) => e.path.startsWith("workflows.0")), "luật trỏ field không có trong gói");

  // Kế hoạch THUẦN: lỗi của mục ⇒ mục đó BỊ CHẶN, kế hoạch không cài được.
  const fresh: OrgState = { enabledModules: ["core", "work"], orgIsHome: false, installedVersion: null, installed: {}, entities: {}, customDefs: {} };
  const plan = planBlueprint(escalate, { orgState: fresh, can: () => true });
  assert.equal(actionOf(plan, "role", "ke_toan_cong_no"), "BLOCKED");
  assert.equal(plan.ok, false);
  assert.equal(actionOf(plan, "field", "customer.han_muc_cong_no"), "CREATE", "mục khác vẫn được lập kế hoạch");
  const noPerm = planBlueprint(base, { orgState: fresh, can: (p) => p !== "modules:manage" });
  assert.equal(actionOf(noPerm, "module", "customers"), "BLOCKED", "thiếu modules:manage ⇒ bước bật module bị chặn");
  const ok = planBlueprint(base, { orgState: fresh, can: () => true });
  assert.ok(ok.ok, JSON.stringify(ok.steps.filter((s) => s.action === "BLOCKED")));
  assert.equal(actionOf(ok, "module", "core"), "UNCHANGED");
  assert.equal(actionOf(ok, "page", "cong-no-khach-hang"), "CREATE");
  assert.ok(ok.steps.find((s) => s.kind === "page")?.publish, "lần cài đầu với publish: true ⇒ xuất bản");
  assert.deepEqual(sanitizeResolutions({ "page:cong-no-khach-hang": "overwrite", "x y": "overwrite", "field:a.b": "xoa" }), { "page:cong-no-khach-hang": "overwrite" });
}

function testNoDirectWrites() {
  const dir = path.join(process.cwd(), "lib/blueprints");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".ts")) files.push(path.join(d, e.name));
    }
  };
  walk(dir);
  assert.ok(files.length >= 10, `đọc hụt lib/blueprints (${files.length} tệp)`);
  // Lời ghi của drizzle: `db.insert(…)` / `tx.update(…)` / `.delete(schema.x)`, SQL thô, `execute`. (`Map.delete`,
  // `hash.update` không phải ghi CSDL — biểu thức nhắm đúng người nhận của drizzle.)
  const WRITE = /\b(?:db|tx|pdb|odb)\s*\.\s*(?:insert|update|delete)\s*\(|\.(?:insert|update|delete)\(\s*schema\.|\bsql\.raw\s*\(|\.execute\s*\(/;
  const pham: string[] = [];
  for (const f of files) {
    const rel = path.relative(process.cwd(), f).split(path.sep).join("/");
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Miễn trừ DUY NHẤT: sổ cài ghi hai bảng của chính nó (không bảng metadata nào).
    if (rel === "lib/blueprints/ledger.ts") {
      for (const m of src.matchAll(/\.(insert|update)\(\s*([^)]+)\)/g)) if (!/schema\.blueprint(Installs|Items)/.test(m[2])) pham.push(`${rel}: ghi ${m[2]}`);
      if (/\.delete\s*\(/.test(src)) pham.push(`${rel}: sổ cài không xoá dòng nào`);
      continue;
    }
    if (WRITE.test(src)) pham.push(rel);
  }
  assert.deepEqual(pham, [], "lib/blueprints/* không được ghi thẳng bảng — đi qua dịch vụ sẵn có (X1, X3)");
}

function testMenu() {
  const item = NAV_MODULES.find((m) => m.href === "/settings/templates");
  assert.ok(item, "sổ menu phải có /settings/templates");
  assert.equal(item.zone, "SYSTEM");
  assert.equal("permission" in item ? item.permission : null, "metadata:manage");
  assert.equal(moduleOfPath("/settings/templates"), "core");
  const manager: NavUserLike = { role: "MANAGER", permissions: ["dashboard:view"], modules: [...MODULE_KEYS] };
  assert.equal(visible(item, manager), false);
  assert.equal(visible(item, { ...manager, permissions: ["metadata:manage"] }), true);
  assert.match(blueprintAdminDenial(sessionUser({ role: "MANAGER", permissions: ["modules:manage"] })) ?? "", /quyền/);
  assert.match(blueprintAdminDenial(sessionUser({ organization: undefined })) ?? "", /tổ chức/);
}

// ═══════════ 3 · TỔ CHỨC THẬT ═══════════

const ORG_A = "bp-a";
const ORG_B = "bp-b";

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
  // Gói «standard»: bài này cài NHIỀU mẫu vào cùng một tổ chức (bp-c: dịch vụ 2 đối tượng + sản xuất 1 đối tượng) — gói
  // mặc định `trial` (2 đối tượng) chặn đúng lượt thứ ba từ khi hạn mức đối tượng được nối (Phase 11 · H4). Hạn mức gói
  // có bài riêng (tests/platform-diagnostics-org.test.ts); ở đây nó không phải thứ đang được kiểm.
  await provisionOrganization({ code, name: `Tổ chức thử mẫu ${code}`, plan: "standard", modules: [], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Mau@12345" }, source: "TEST", actor: null });
}

async function adminOf(code: string): Promise<SessionUser> {
  const db = await getDb();
  const row = await db.query.users.findFirst({ where: eq(dbSchema.users.email, `admin@${code}.local`) });
  assert.ok(row, `thiếu quản trị của ${code}`);
  return sessionUser({ id: row.id, email: row.email, name: row.name, organization: { code, name: code, isHome: false }, modules: [...(await getEnabledModules(code))] });
}

async function testOrgA() {
  await withOrganization(ORG_A, async () => {
    let admin = await adminOf(ORG_A);
    assert.deepEqual([...(await getEnabledModules(ORG_A))].sort(), ["core", "work"], "tổ chức mới chỉ có lõi — mẫu không tự cài (luật 23)");
    const catalog = await loadTemplateCatalog(admin);
    assert.ok(catalog.ok && catalog.value.templates.length === 7 && catalog.value.history.length === 0);
    assert.ok(catalog.value.templates.every((t) => t.installedVersion === null && !t.updateAvailable));

    // ── Xem trước = kế hoạch, không ghi ──
    const pre = await previewTemplate(admin, "wholesale");
    assert.ok(pre.ok, JSON.stringify(pre));
    const plan = pre.value.plan;
    assert.ok(plan.ok, JSON.stringify(plan.steps.filter((s) => s.action === "BLOCKED")));
    assert.equal(actionOf(plan, "module", "customers"), "CREATE");
    assert.equal(actionOf(plan, "module", "core"), "UNCHANGED");
    assert.equal(plan.counts.BLOCKED, 0);
    assert.deepEqual([...(await getEnabledModules(ORG_A))].sort(), ["core", "work"], "xem trước KHÔNG bật module nào");
    assert.equal((await installHistory()).length, 0, "xem trước KHÔNG ghi sổ cài");

    // ── Kế hoạch lệch bản đã xem ⇒ từ chối ──
    const stale = await installTemplate(admin, "wholesale", { planHash: "khac", resolutions: {} });
    assert.ok(!stale.ok && stale.errors[0].path === "planHash" && stale.installId === null);

    // ── Cài ──
    const done = await installTemplate(admin, "wholesale", { planHash: plan.planHash, resolutions: {} });
    assert.ok(done.ok, JSON.stringify(done));
    admin = await adminOf(ORG_A);
    const enabled = [...(await getEnabledModules(ORG_A))].sort();
    assert.deepEqual(enabled, [...WHOLESALE_BLUEPRINT.modules].sort(), "module sau khi cài đúng bằng module của mẫu");
    assert.ok(!enabled.includes("marketing") && !enabled.includes("production"));

    const fields = await listFields("customer");
    assert.deepEqual(fields.custom.map((f) => f.key).sort(), ["han_muc_cong_no", "ma_so_thue", "so_ngay_no", "tinh_trang_cong_no"]);
    const form = await getPublishedForm("customer", "profile");
    assert.equal(form.isDefault, false, "form được xuất bản ở lần cài đầu");
    assert.equal(form.version, 1);
    const list = await getPublishedListView("customer", "default");
    assert.equal(list.version, 1);
    assert.equal(list.schema.defaultSort?.ref, "custom:han_muc_cong_no");
    const page = await getPageBySlug("cong-no-khach-hang");
    assert.ok(page, "trang của mẫu đã xuất bản — mở được ở /p/cong-no-khach-hang");
    assert.equal(page.page.publishedVersion, 1);
    assert.equal(page.page.nav.enabled, true);
    const rules = await listRules();
    const rule = rules.find((r) => r.key === "nhac_cong_no_qua_han");
    assert.ok(rule);
    assert.equal(rule.status, "DRAFT", "luật của mẫu sinh ở NHÁP (luật 23)");
    assert.equal(rule.mode, "DRY_RUN", "và CHẠY THỬ (luật 25)");
    const role = (await listAccessRoles()).find((r) => r.code === "KE_TOAN_CONG_NO");
    assert.ok(role && role.baseRole === "ACCOUNTANT" && !role.permissions.includes("users:manage"));
    const ai = await getSettingJson<{ businessProfile?: string } | null>(AI_PROFILE_SETTING_KEY, null);
    assert.ok(ai?.businessProfile?.includes("bán sỉ"), "ngữ cảnh AI của tổ chức");
    assert.equal(await installedVersion("wholesale"), "1.0.0");
    const db = await getDb();
    const steps = await db.select().from(dbSchema.auditLogs).where(and(eq(dbSchema.auditLogs.action, "BLUEPRINT_STEP"), eq(dbSchema.auditLogs.correlationId, done.installId)));
    assert.equal(steps.length, done.outcomes.filter((o) => o.status === "DONE").length, "mỗi bước ghi có một dòng nhật ký nối bằng lượt cài");
    assert.ok(steps.every((s) => s.userId === admin.id), "nhật ký mang khoá tài khoản người bấm (luật 34)");

    // ── Cài lại ⇒ toàn UNCHANGED, không ghi gì mới ──
    const again = await planForOrg(WHOLESALE_BLUEPRINT, admin);
    assert.equal(again.counts.UNCHANGED, again.steps.length, JSON.stringify(again.steps.filter((s) => s.action !== "UNCHANGED").map((s) => [s.kind, s.key, s.action, s.reason])));
    const reinstall = await installBlueprint(WHOLESALE_BLUEPRINT, admin, { expectedPlanHash: again.planHash });
    assert.ok(reinstall.ok);
    assert.equal(reinstall.outcomes.filter((o) => o.status === "DONE").length, 0, "cài lại không ghi thực thể nào");
    assert.equal((await getPageBySlug("cong-no-khach-hang"))?.page.publishedVersion, 1, "cài lại không xuất bản lại");

    // ── Tổ chức tuỳ biến: sửa trang, lưu trữ một field ──
    const pageDraft = await getPageDraft(page.page.id);
    const custom: PageSchema = { ...pageDraft.draft, sections: [...pageDraft.draft.sections, { key: "ghi_chu", title: "Ghi chú", blocks: [{ id: "ghi_chu_noi_bo", type: "text", span: 12, config: { body: "Trang đã được tổ chức sửa." } }] }] };
    assert.ok((await savePageDraft(page.page.id, custom, actorOf(admin))).ok);
    assert.ok((await archiveCustomField("customer", "ma_so_thue", actorOf(admin))).ok);

    // ── Nâng mẫu 1.1.0: đổi trang, đổi nhãn hai field, thêm cột danh sách ──
    const v2 = clone(WHOLESALE_BLUEPRINT);
    v2.version = "1.1.0";
    (v2.pages![0].schema as PageSchema).sections[0].title = "Bán hàng 30 ngày gần nhất";
    v2.fields = v2.fields!.map((f) => (f.key === "han_muc_cong_no" ? { ...f, label: "Hạn mức nợ tối đa" } : f.key === "ma_so_thue" ? { ...f, label: "MST" } : f));
    v2.listViews![0].schema.columns.push({ ref: "system:last_order_at", visible: true });
    const up = await planForOrg(v2, admin);
    assert.equal(up.installedVersion, "1.0.0");
    assert.equal(actionOf(up, "page", "cong-no-khach-hang"), "SKIP_CUSTOMIZED", "trang tổ chức đã sửa ⇒ giữ bản tổ chức");
    assert.ok(up.steps.find((s) => s.kind === "page")!.diff.length > 0, "SKIP_CUSTOMIZED kèm khác biệt để người quyết");
    assert.equal(actionOf(up, "field", "customer.han_muc_cong_no"), "UPDATE", "field chưa sửa ⇒ cập nhật");
    assert.equal(actionOf(up, "field", "customer.ma_so_thue"), "SKIP_DELETED", "field đã lưu trữ ⇒ không dựng lại");
    assert.equal(actionOf(up, "list", "customer.default"), "UPDATE");
    assert.equal(actionOf(up, "workflow", "nhac_cong_no_qua_han"), "UNCHANGED", "luật mẫu không đổi ⇒ không đụng");
    assert.ok(up.ok);
    const upDone = await installBlueprint(v2, admin, { expectedPlanHash: up.planHash });
    assert.ok(upDone.ok, JSON.stringify(upDone));
    assert.equal((await listFields("customer")).custom.find((f) => f.key === "han_muc_cong_no")?.label, "Hạn mức nợ tối đa");
    assert.equal((await listFields("customer", { includeArchived: true })).custom.find((f) => f.key === "ma_so_thue")?.status, "ARCHIVED", "field đã lưu trữ vẫn lưu trữ");
    const afterPage = await getPageDraft(page.page.id);
    assert.ok(afterPage.draft.sections.some((s) => s.key === "ghi_chu"), "trang đã tuỳ biến không bị đè");
    assert.ok((await getListViewDraft("customer", "default")).columns.some((c) => c.ref === "system:last_order_at" && c.visible), "danh sách cập nhật vào NHÁP");
    assert.ok(!(await getPublishedListView("customer", "default")).schema.columns.some((c) => c.ref === "system:last_order_at"), "…nhưng KHÔNG tự xuất bản (xuất bản là việc của người)");
    assert.equal((await getPublishedListView("customer", "default")).version, 1);

    // ── Người chọn GHI ĐÈ trang đã tuỳ biến ──
    const over = await planForOrg(v2, admin, { "page:cong-no-khach-hang": "overwrite" });
    assert.equal(actionOf(over, "page", "cong-no-khach-hang"), "UPDATE");
    assert.equal(actionOf(over, "field", "customer.han_muc_cong_no"), "UNCHANGED", "mục vừa cập nhật ⇒ không đổi");
    assert.ok((await installBlueprint(v2, admin, { expectedPlanHash: over.planHash, resolutions: { "page:cong-no-khach-hang": "overwrite" } })).ok);
    const overwritten = await getPageDraft(page.page.id);
    assert.ok(!overwritten.draft.sections.some((s) => s.key === "ghi_chu"), "ghi đè theo lựa chọn ⇒ nháp trang = bản mẫu");
    assert.equal(overwritten.draft.sections[0].title, "Bán hàng 30 ngày gần nhất");
    const history = await installHistory({ blueprintKeys: ["wholesale"] });
    assert.deepEqual(history.map((h) => h.version), ["1.1.0", "1.1.0", "1.0.0", "1.0.0"]);
    assert.ok(history.every((h) => h.status === "DONE"));
    const cat2 = await loadTemplateCatalog(admin);
    assert.ok(cat2.ok && cat2.value.templates.find((t) => t.key === "wholesale")?.installedVersion === "1.1.0");

    // ── Vai trò có users:manage ⇒ BLOCKED, không ghi gì ──
    const escalate = clone(WHOLESALE_BLUEPRINT);
    escalate.roles = [{ ...escalate.roles![0], key: "tu_nang", permissions: ["users:manage"] }];
    const blocked = await planForOrg(escalate, admin);
    assert.equal(actionOf(blocked, "role", "tu_nang"), "BLOCKED");
    const refused = await installBlueprint(escalate, admin);
    assert.ok(!refused.ok && refused.installId === null, "kế hoạch có bước bị chặn ⇒ không có lượt cài nào");
    assert.equal((await installHistory({ blueprintKeys: ["wholesale"] })).length, 4);
    assert.ok(!(await listAccessRoles()).some((r) => r.code === "TU_NANG"));
  });
}

async function testOrgB() {
  await withOrganization(ORG_B, async () => {
    const admin = await adminOf(ORG_B);
    // Cô lập: B không thấy sổ cài, thực thể hay phiên bản của A.
    assert.equal((await installHistory()).length, 0, "tổ chức B không thấy lịch sử cài của A");
    assert.equal(await installedVersion("wholesale"), null);
    assert.ok(!(await listPages({ includeArchived: true })).some((p) => p.slug === "cong-no-khach-hang"));
    const fresh = await planForOrg(WHOLESALE_BLUEPRINT, admin);
    assert.equal(actionOf(fresh, "page", "cong-no-khach-hang"), "CREATE", "B lập kế hoạch như tổ chức mới");

    // Thiếu quyền bật module ⇒ bước module BỊ CHẶN (quyền của từng bước).
    const manager = sessionUser({ ...admin, role: "MANAGER", permissions: ["metadata:manage", "workflow:manage", "settings:manage", "users:manage"] });
    const noModule = await planForOrg(WHOLESALE_BLUEPRINT, manager);
    assert.equal(actionOf(noModule, "module", "customers"), "BLOCKED");
    assert.ok(!noModule.ok);

    // Hỏng giữa chừng: phòng Kế toán tắt ⇒ bộ kiểm luật có CSDL từ chối ở bước luật ⇒ DỪNG, FAILED.
    const db = await getDb();
    await db.update(dbSchema.departments).set({ active: false }).where(eq(dbSchema.departments.code, "FINANCE"));
    const failed = await installBlueprint(WHOLESALE_BLUEPRINT, admin, { expectedPlanHash: fresh.planHash });
    assert.ok(!failed.ok && failed.installId, JSON.stringify(failed));
    assert.equal(failed.failedStep?.kind, "workflow");
    assert.ok(failed.outcomes.some((o) => o.kind === "ai" && o.status === "NOT_RUN"), "bước sau bước hỏng không chạy");
    assert.equal((await installHistory())[0].status, "FAILED");
    assert.ok(await getPageBySlug("cong-no-khach-hang"), "bước đã xong trước khi hỏng vẫn còn");

    // Chạy lại sau khi sửa: bước đã xong ⇒ UNCHANGED, đi tiếp từ bước hỏng — không nhân đôi.
    await db.update(dbSchema.departments).set({ active: true }).where(eq(dbSchema.departments.code, "FINANCE"));
    const retry = await planForOrg(WHOLESALE_BLUEPRINT, admin);
    assert.equal(actionOf(retry, "page", "cong-no-khach-hang"), "UNCHANGED");
    assert.equal(actionOf(retry, "field", "customer.han_muc_cong_no"), "UNCHANGED");
    assert.equal(actionOf(retry, "workflow", "nhac_cong_no_qua_han"), "CREATE");
    assert.equal(actionOf(retry, "ai", "businessProfile"), "CREATE");
    assert.ok((await installBlueprint(WHOLESALE_BLUEPRINT, admin, { expectedPlanHash: retry.planHash })).ok);
    assert.equal((await listPages()).filter((p) => p.slug === "cong-no-khach-hang").length, 1);

    // Mẫu thứ hai cùng tổ chức: trùng thứ có sẵn KHÔNG do mẫu này sinh ra ⇒ CONFLICT (mặc định bỏ qua).
    const ge = templateBlueprint("general-ecommerce")!;
    const gePlan = await planForOrg(ge, admin);
    assert.ok(gePlan.ok, JSON.stringify(gePlan.steps.filter((s) => s.action === "BLOCKED")));
    assert.equal(actionOf(gePlan, "form", "customer.profile"), "CONFLICT", "form khách đã do mẫu Bán sỉ dựng ⇒ CONFLICT kèm khác biệt");
    assert.ok(gePlan.steps.find((s) => s.kind === "form")!.diff.length > 0);
    const geDone = await installBlueprint(ge, admin, { expectedPlanHash: gePlan.planHash });
    assert.ok(geDone.ok, JSON.stringify(geDone));
    assert.ok((await getPublishedForm("customer", "profile")).schema.sections.some((s) => s.key === "cong_no"), "CONFLICT không ghi đè form của mẫu kia");
    assert.ok(await getPageBySlug("don-theo-trang-thai"), "trang đơn theo trạng thái đã xuất bản");
    assert.ok((await listRules()).some((r) => r.key === "don_lon_can_duyet" && r.status === "DRAFT" && r.gate?.kind === "approval"));
    const presets = await getSettingJson<{ presets?: unknown[] } | null>("care.notePresets", null);
    assert.equal(presets?.presets?.length, 4, "cài đặt an toàn được ghi");

    // Mẫu thời trang: kế hoạch cài được (nhiều module nhất).
    const fashion = await planForOrg(templateBlueprint("fashion-commerce")!, admin);
    assert.ok(fashion.ok, JSON.stringify(fashion.steps.filter((s) => s.action === "BLOCKED")));
    assert.ok(fashion.steps.some((s) => s.kind === "module" && s.key === "production" && s.action === "CREATE"));
  });
}

const ORG_C = "bp-c";

async function testOrgC() {
  await withOrganization(ORG_C, async () => {
    let admin = await adminOf(ORG_C);
    assert.ok(!(await getEnabledModules(ORG_C)).has("apps"), "tổ chức mới chưa bật Ứng dụng tuỳ biến");

    // ── service-business: apps tự bật (CREATE ở bước module, trước bước đối tượng) ──
    const plan = await planForOrg(SERVICE_BUSINESS_BLUEPRINT, admin);
    assert.ok(plan.ok, JSON.stringify(plan.steps.filter((s) => s.action === "BLOCKED")));
    assert.equal(actionOf(plan, "module", "apps"), "CREATE");
    const iApps = plan.steps.findIndex((s) => s.kind === "module" && s.key === "apps");
    const iObj = plan.steps.findIndex((s) => s.kind === "object");
    const iField = plan.steps.findIndex((s) => s.kind === "field" && s.key === "x_contract.khach_hang");
    assert.ok(iApps < iObj && iObj < iField, "thứ tự: module → đối tượng → field");
    const done = await installBlueprint(SERVICE_BUSINESS_BLUEPRINT, admin, { expectedPlanHash: plan.planHash });
    assert.ok(done.ok, JSON.stringify(done));
    admin = await adminOf(ORG_C);
    assert.ok((await getEnabledModules(ORG_C)).has("apps"));

    const contract = await resolveObject("x_contract");
    assert.ok(contract?.custom && contract.custom.status === "ACTIVE" && contract.label === "Hợp đồng" && contract.custom.menuModule === "customers", "đối tượng Hợp đồng đã tạo qua createObject");
    assert.equal(contract.custom.viewPermission, "records:view");
    assert.ok((await resolveObject("x_project"))?.custom, "đối tượng Dự án");
    const cf = (await listFields("x_contract")).custom;
    assert.equal(cf.find((f) => f.key === "khach_hang")?.relationObject, "customer", "quan hệ hợp đồng → khách");
    assert.equal(cf.find((f) => f.key === "du_an")?.type, "relation_many");
    assert.equal(cf.find((f) => f.key === "du_an")?.relationObject, "x_project", "quan hệ nhiều-nhiều tới đối tượng tuỳ biến khác");
    const pf = (await listFields("x_project")).custom;
    assert.equal(pf.find((f) => f.key === "hop_dong_chinh")?.validation.unique, true, "một-một");
    assert.equal(pf.find((f) => f.key === "khach_hang")?.relationObject, "customer");
    assert.equal((await getPublishedForm("x_contract", "create")).version, 1, "form tạo hợp đồng xuất bản");
    assert.equal((await getPublishedListView("x_project", "default")).version, 1);
    assert.ok(await getPageBySlug("khach-hang-dich-vu"), "trang của mẫu đã xuất bản");
    const rule = (await listRules()).find((r) => r.key === "hop_dong_lon_can_duyet");
    assert.ok(rule && rule.status === "DRAFT" && rule.mode === "DRY_RUN" && rule.gate?.kind === "approval");
    assert.deepEqual(rule.trigger, { kind: "event", event: "custom_record.created", objectKey: "x_contract" });

    // ── Cài lại ⇒ toàn UNCHANGED ──
    const again = await planForOrg(SERVICE_BUSINESS_BLUEPRINT, admin);
    assert.equal(again.counts.UNCHANGED, again.steps.length, JSON.stringify(again.steps.filter((s) => s.action !== "UNCHANGED").map((s) => [s.kind, s.key, s.action, s.reason])));
    // Một gói KHÁC khoá mang đúng nội dung ấy: đối tượng / field có sẵn giống hệt ⇒ nhận làm của gói (UNCHANGED), không
    // CONFLICT — phép chiếu đích (mặc định quyền, nhóm menu…) phải khớp đúng thứ `createObject` đã ghi.
    const copy = await planForOrg({ ...clone(SERVICE_BUSINESS_BLUEPRINT), key: "dich-vu-ban-sao" }, admin);
    for (const [kind, key] of [["object", "x_contract"], ["object", "x_project"], ["field", "x_contract.khach_hang"], ["field", "x_project.hop_dong_chinh"], ["form", "x_contract.create"], ["page", "khach-hang-dich-vu"]] as const) {
      assert.equal(actionOf(copy, kind, key), "UNCHANGED", `${kind} ${key}: ${JSON.stringify(copy.steps.find((s) => s.kind === kind && s.key === key)?.diff)}`);
    }

    // ── Mẫu sản xuất cùng tổ chức: quan hệ từ đối tượng HỆ THỐNG (sản phẩm, lệnh sản xuất) tới x_work_center ──
    const mf = templateBlueprint("manufacturing")!;
    const mfPlan = await planForOrg(mf, admin);
    assert.ok(mfPlan.ok, JSON.stringify(mfPlan.steps.filter((s) => s.action === "BLOCKED")));
    assert.equal(actionOf(mfPlan, "module", "apps"), "UNCHANGED");
    assert.ok((await installBlueprint(mf, admin, { expectedPlanHash: mfPlan.planHash })).ok);
    admin = await adminOf(ORG_C);
    assert.equal((await listFields("production_order")).custom.find((f) => f.key === "chuyen_san_xuat")?.relationObject, "x_work_center");
    assert.ok(await getPageBySlug("ke-hoach-san-xuat"));
    assert.ok((await listRules()).some((r) => r.key === "chuyen_bao_tri" && r.status === "DRAFT"));

    // ── Tổ chức TẮT apps sau khi cài ⇒ không tự bật lại: module SKIP_DELETED, đối tượng + field của nó BỊ CHẶN ──
    const off = await toggleOwnModule(admin, { moduleKey: "apps", enabled: false, reason: "thử tắt" });
    assert.ok("ok" in off, JSON.stringify(off));
    admin = await adminOf(ORG_C);
    const blocked = await planForOrg(SERVICE_BUSINESS_BLUEPRINT, admin);
    assert.equal(actionOf(blocked, "module", "apps"), "SKIP_DELETED");
    assert.equal(actionOf(blocked, "object", "x_contract"), "BLOCKED");
    assert.equal(actionOf(blocked, "field", "x_contract.gia_tri"), "BLOCKED");
    assert.equal(blocked.ok, false);
    const refused = await installBlueprint(SERVICE_BUSINESS_BLUEPRINT, admin);
    assert.ok(!refused.ok && refused.installId === null, "không ghi gì khi còn bước bị chặn");
    assert.ok(!(await getEnabledModules(ORG_C)).has("apps"), "máy không tự bật lại module tổ chức đã tắt");
  });
}

export async function testBlueprints() {
  testTemplatesPure();
  testRejections();
  testNoDirectWrites();
  testMenu();
  await provision(ORG_A);
  await provision(ORG_B);
  await provision(ORG_C);
  try {
    await testOrgA();
    await testOrgB();
    await testOrgC();
  } finally {
    await cleanupOrg(ORG_A);
    await cleanupOrg(ORG_B);
    await cleanupOrg(ORG_C);
  }
  console.log(
    "✓ Phase 7 · blueprint + mẫu ngành: 5 mẫu qua validateBlueprint (trang qua validatePageSchema theo module của gói), khác nhau về module, không mang thứ chỉ-VNX; đối tượng tuỳ biến kéo apps, quan hệ phải trỏ đích có thật, unique chỉ cho relation; users:manage ⇒ BLOCKED; lib/blueprints không ghi thẳng bảng (trừ sổ cài); bp-a: cài wholesale ⇒ module đúng + field/form/danh sách/trang xuất bản/luật NHÁP/vai trò/AI, cài lại ⇒ toàn UNCHANGED, sửa trang + lưu trữ field ⇒ 1.1.0: SKIP_CUSTOMIZED/SKIP_DELETED, mục chưa sửa UPDATE vào nháp, ghi đè theo lựa chọn; bp-b: không thấy sổ của A, thiếu quyền ⇒ BLOCKED, hỏng giữa chừng ⇒ FAILED rồi chạy lại đi tiếp, CONFLICT không đè mẫu kia; bp-c: service-business ⇒ apps tự bật, x_contract/x_project qua createObject, quan hệ tới khách + một-một + nhiều-nhiều, luật custom_record.created NHÁP có cửa duyệt, cài lại toàn UNCHANGED, manufacturing quan hệ sản phẩm/lệnh → x_work_center; tắt apps ⇒ đối tượng BLOCKED, không tự bật lại",
  );
}
