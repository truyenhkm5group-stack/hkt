/**
 * ═══════════ BÀI CHẤP NHẬN PHASE 12 — NĂM LỖI SẢN PHẨM ═══════════
 *
 * Báo cáo E2E (máy thử 28/09/2026) tìm ra năm lỗi; bài này khoá cả năm:
 *
 *  1. (CHẶN) Tổ chức không bật «Cần xử lý» (module ấy cần «Đơn hàng») KHÔNG duyệt được lời duyệt của luật tự động ⇒
 *     lượt chạy treo mãi. Nay trang Duyệt `/approvals` thuộc LÕI, cổng `approvals:decide`; mọi lối "mở để duyệt" (sổ
 *     lượt chạy, nguồn việc APPROVAL trên `/work`, buồng lái) trỏ về đó. Trang Cần xử lý của tổ chức nhà vẫn hiện mục
 *     duyệt như cũ — CÙNG component, CÙNG action, không có đường duyệt thứ hai.
 *  2. Menu của quản trị tổ chức KHÔNG-nhà có mục `/platform` — nay cùng luật với `can()` (`homeOrgPermissionDenied`).
 *  3. Trang không tìm thấy mang câu "chưa được đồng bộ về ERP" ở tổ chức khác — nay qua `lib/branding/copy.ts`.
 *  4. Yêu cầu duyệt của luật in "chưa rõ số tiền" dù hợp đồng có field tiền — nay đọc field tiền của chủ thể.
 *  5. Nhóm menu mang tên một module TẮT vẫn hiện (bán sỉ có nhóm «Sản xuất», dịch vụ có «Đối soát COD») — nay nhóm dời,
 *     và BỘ QUÉT: với mỗi module tắt, không mục menu nào thuộc tuyến của nó (hay đọc số liệu của nó) hiện ra.
 *
 * HAI TỔ CHỨC THẬT (`ap-svc` cài mẫu service-business thật, `ap-si` mang bộ module của mẫu bán sỉ) — CSDL PGlite riêng,
 * tự cấp và tự dọn. Đăng ký trong `tests/sync-fixtures.test.ts` (cần CSDL thử của bộ kiểm).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { allowedNavItems, visibleGroups, type NavUserLike } from "@/components/app-sidebar";
import { decideApprovalCore } from "@/lib/approvals/service";
import { homeOrgPermissionDenied } from "@/lib/auth/permissions";
import { can, type SessionUser } from "@/lib/auth/session";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { BLUEPRINT_TEMPLATES } from "@/lib/blueprints/templates";
import { SERVICE_BUSINESS_BLUEPRINT } from "@/lib/blueprints/templates/service-business";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { coreText, HOME_BRAND_PATTERN, HOME_COPY_CONTEXT } from "@/lib/branding/copy";
import { APPROVALS_HREF } from "@/lib/constants/approval";
import { NAV_MODULES, ZONE_MODULE, type ModuleZone } from "@/lib/constants/department-modules";
import { OWNER_DECISION_KIND_SPEC } from "@/lib/constants/owner-decisions";
import { MODULE_KEYS, moduleDef, moduleOfPath, PLATFORM_MODULES, resolveEnabledModules, type ModuleKey } from "@/lib/constants/platform-modules";
import { WORK_SOURCE_SPEC } from "@/lib/constants/work-sources";
import { createRecord } from "@/lib/objects/records";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { APPROVAL_QUEUE_HREF } from "@/lib/platform-ui/workflow-admin-shared";
import { listApprovalSectionItems } from "@/lib/queries/approvals";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { runWorkflows } from "@/lib/workflow/engine";
import { listRules, setRuleMode, setRuleStatus } from "@/lib/workflow/rules";
import { approvalAmountOf, conditionFieldRefs } from "@/lib/workflow/subject";

const SVC = "ap-svc";
const SI = "ap-si";
const goc = path.resolve(__dirname, "..");
const doc = (f: string) => readFileSync(path.join(goc, f), "utf8");

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function adminOf(code: string): Promise<SessionUser> {
  const db = await getDb();
  const row = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${code}.local`) });
  assert.ok(row, `thiếu quản trị của ${code}`);
  return { id: row.id, email: row.email, name: row.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: code, isHome: false }, modules: [...(await getEnabledModules(code))] };
}

/** Người xem menu dựng tay: ADMIN của một tổ chức với tập module đã phân giải. */
function navUser(modules: readonly string[], opts: { isHome?: boolean; role?: SessionUser["role"]; permissions?: string[] } = {}): NavUserLike {
  return { role: opts.role ?? "ADMIN", permissions: opts.permissions ?? [], modules, organization: { isHome: opts.isHome === true } };
}

/** Tập module đã phân giải (lõi luôn bật, đóng dưới phụ thuộc) từ một danh sách khai. */
function resolved(keys: readonly string[]): ModuleKey[] {
  return [...resolveEnabledModules({ moduleDefault: "DISABLED" }, keys.map((k) => ({ moduleKey: k, enabled: true, features: {} }) as never))];
}

const hrefsOf = (u: NavUserLike) => allowedNavItems(u).map((i) => i.href);

/* ═══════════ 1 · BỘ QUÉT MENU × MODULE TẮT (lỗi #5) + /platform (lỗi #2) — HÀM THUẦN ═══════════ */

/**
 * Với MỘT tập module bật: mọi mục menu hiện ra phải (a) có module sở hữu đường dẫn đang bật, (b) có mọi module nguồn
 * số liệu (`requires`) đang bật, và (c) nằm trong nhóm KHÔNG mang tên một module tắt. Trả danh sách vi phạm (rỗng = đạt).
 */
function menuViolations(modules: readonly ModuleKey[], isHome: boolean): string[] {
  const on = new Set<string>(modules);
  const out: string[] = [];
  const specOf = new Map(NAV_MODULES.map((m) => [m.href as string, m]));
  for (const g of visibleGroups(navUser(modules, { isHome }))) {
    const bound = ZONE_MODULE[g.zone as ModuleZone];
    if (bound && !on.has(bound.module)) out.push(`nhóm ${g.zone} mang tên module «${bound.module}» đang tắt`);
    for (const item of g.items) {
      const owner = moduleOfPath(item.href);
      if (owner && !on.has(owner)) out.push(`${item.href} thuộc module «${owner}» đang tắt`);
      for (const r of (specOf.get(item.href) as { requires?: readonly ModuleKey[] } | undefined)?.requires ?? []) if (!on.has(r)) out.push(`${item.href} đọc số liệu của «${r}» đang tắt`);
      if (item.href === "/platform" && !isHome) out.push("/platform hiện ở tổ chức không-nhà");
    }
  }
  return out;
}

function testMenuSweep() {
  const all = [...MODULE_KEYS];
  // Với MỖI module không-lõi: tắt nó (và mọi module phụ thuộc vào nó — đóng dưới phụ thuộc) ⇒ không vi phạm nào.
  let quet = 0;
  for (const m of PLATFORM_MODULES.filter((d) => !d.core)) {
    const set = resolved(all.filter((k) => k !== m.key));
    assert.ok(!set.includes(m.key));
    for (const isHome of [true, false]) {
      assert.deepEqual(menuViolations(set, isHome), [], `tắt «${m.key}» (${isHome ? "nhà" : "không-nhà"})`);
      // Và không mục nào thuộc TUYẾN của module tắt hiện ra — nói thẳng, không qua hàm vi phạm.
      const lo = hrefsOf(navUser(set, { isHome })).filter((h) => moduleOfPath(h) === m.key);
      assert.deepEqual(lo, [], `mục thuộc tuyến của «${m.key}» vẫn hiện khi nó tắt`);
      quet += 1;
    }
  }
  // Mọi bộ module của mẫu ngành + bộ chỉ-lõi.
  const bo: [string, ModuleKey[]][] = [["chỉ lõi", resolved([])], ...BLUEPRINT_TEMPLATES.map((b) => [b.key, resolved(b.modules)] as [string, ModuleKey[]])];
  for (const [ten, set] of bo) for (const isHome of [true, false]) assert.deepEqual(menuViolations(set, isHome), [], `mẫu ${ten} (${isHome ? "nhà" : "không-nhà"})`);

  // Tổ chức bật ĐỦ module (tổ chức nhà) ⇒ không nhóm nào dời: menu y như sổ khai (không đổi hành vi của nhà).
  const nha = visibleGroups(navUser(all, { isHome: true }));
  for (const g of nha) {
    const khai = NAV_MODULES.filter((m) => m.zone === g.zone).map((m) => m.href as string);
    assert.deepEqual(g.items.map((i) => i.href), khai, `nhà: nhóm ${g.zone} giữ nguyên thứ tự khai`);
  }
  assert.ok(hrefsOf(navUser(all, { isHome: true })).includes("/platform"), "nhà: ADMIN vẫn thấy «Vận hành nền tảng»");
  assert.ok(hrefsOf(navUser(all, { isHome: true })).includes("/alerts"), "nhà: «Cần xử lý» vẫn ở menu");

  // Bán sỉ (lỗi #5 như báo cáo): không nhóm «Sản xuất»; ba trang mở được của nó DỜI sang «Kho», không mất lối vào.
  const si = visibleGroups(navUser(resolved(WHOLESALE_BLUEPRINT.modules)));
  assert.ok(!si.some((g) => g.zone === "PRODUCTION"), "bán sỉ: không có nhóm «Sản xuất»");
  const kho = si.find((g) => g.zone === "WAREHOUSE")?.items.map((i) => i.href) ?? [];
  for (const h of ["/inventory/shortage", "/inventory/decisions", "/products/performance"]) assert.ok(kho.includes(h), `bán sỉ: ${h} dời sang «Kho»`);
  assert.equal(kho[0], "/inventory/packing", "mục dời đứng SAU mục vốn có của «Kho»");

  // Dịch vụ (lỗi #5 + #2): không «Đối soát COD», không `/platform`, không nhóm module tắt; CÓ «Duyệt».
  const dv = resolved(SERVICE_BUSINESS_BLUEPRINT.modules);
  const dvHrefs = hrefsOf(navUser(dv));
  assert.ok(!dvHrefs.includes("/cod"), "dịch vụ: không «Đối soát COD» (không bật Vận chuyển)");
  assert.ok(!dvHrefs.includes("/platform"), "dịch vụ: quản trị KHÔNG thấy «Vận hành nền tảng»");
  assert.ok(!dvHrefs.includes("/alerts"), "dịch vụ: không «Cần xử lý» (module tắt)");
  assert.ok(dvHrefs.includes("/approvals"), "dịch vụ: CÓ «Duyệt» (lõi)");
  assert.ok(dvHrefs.includes("/finance"), "dịch vụ: Tài chính vẫn còn");
  assert.ok(!visibleGroups(navUser(dv)).some((g) => g.zone === "PRODUCTION" || g.zone === "LOGISTICS" || g.zone === "MARKETING"));

  // «Duyệt» chỉ hiện với người có `approvals:decide`.
  assert.ok(!hrefsOf(navUser(dv, { role: "VIEWER", permissions: ["dashboard:view", "work:view"] })).includes("/approvals"), "không có quyền duyệt ⇒ không thấy «Duyệt»");
  assert.ok(hrefsOf(navUser(dv, { role: "VIEWER", permissions: ["approvals:decide"] })).includes("/approvals"), "có quyền duyệt ⇒ thấy «Duyệt»");
  // `/platform`: có khoá `platform:operate` mà ở tổ chức khác vẫn không thấy (kể cả không phải ADMIN) — cùng luật với can().
  assert.ok(!hrefsOf(navUser(resolved(all), { role: "MANAGER", permissions: ["platform:operate"] })).includes("/platform"));
  assert.ok(hrefsOf(navUser(resolved(all), { role: "MANAGER", permissions: ["platform:operate"], isHome: true })).includes("/platform"));
  assert.ok(homeOrgPermissionDenied({ organization: null }, "platform:operate"), "phiên không mang tổ chức ⇒ từ chối (hỏng về phía hẹp)");
  assert.ok(!homeOrgPermissionDenied({ organization: { isHome: false } }, "approvals:decide"));
  console.log(`  · bộ quét menu × module tắt: ${quet} lượt (mỗi module không-lõi × nhà/không-nhà) + ${bo.length} bộ mẫu — 0 vi phạm`);
}

/* ═══════════ 2 · LỐI DUYỆT, CHỮ, SỐ TIỀN — HÀM THUẦN + MÃ NGUỒN ═══════════ */

function testPureContracts() {
  // Lỗi #1: trang Duyệt thuộc LÕI; mọi lối "mở để duyệt" trỏ về đó.
  assert.equal(moduleOfPath("/approvals"), "core");
  assert.equal(moduleDef("core")?.core, true);
  assert.equal(APPROVALS_HREF, "/approvals");
  assert.equal(APPROVAL_QUEUE_HREF, APPROVALS_HREF, "link «Mở hàng đợi duyệt» của sổ lượt chạy");
  assert.equal(OWNER_DECISION_KIND_SPEC.APPROVAL.home, APPROVALS_HREF, "buồng lái: «Mở để duyệt»");
  assert.deepEqual([...OWNER_DECISION_KIND_SPEC.APPROVAL.requires], ["approvals:decide"], "buồng lái không đòi khoá của module «Cần xử lý»");
  const nav = NAV_MODULES.find((m) => m.href === "/approvals");
  assert.ok(nav && nav.permission === "approvals:decide" && nav.zone === "EVERYONE", "mục menu «Duyệt» gác bằng approvals:decide");
  // Blueprint: luật tạo việc hiện được ở `/work` — nguồn WORKFLOW_TASK thuộc module `work` (lõi, luôn bật).
  const coTaoViec = BLUEPRINT_TEMPLATES.filter((b) => (b.workflows ?? []).some((w) => w.actions.some((a) => a.kind === "create_task")));
  assert.ok(coTaoViec.some((b) => b.key === "service-business"), "mẫu dịch vụ có luật tạo việc");
  assert.equal(moduleOfPath("/work"), "work");
  assert.equal(moduleDef("work")?.core, true, "hàng đợi /work là LÕI ⇒ việc do luật tạo luôn hiện được");
  assert.ok(WORK_SOURCE_SPEC.WORKFLOW_TASK, "nguồn việc WORKFLOW_TASK có khai");
  assert.deepEqual([...WORK_SOURCE_SPEC.APPROVAL.actions], ["OPEN_SOURCE"], "việc chờ duyệt chỉ có nút MỞ (luật 19)");

  // Một đường duyệt: trang Duyệt và trang Cần xử lý dùng CÙNG component; component dùng CÙNG action.
  const trangDuyet = doc("app/(dashboard)/approvals/page.tsx");
  assert.match(trangDuyet, /requirePermission\("approvals:decide"\)/, "trang Duyệt gác bằng approvals:decide");
  assert.match(trangDuyet, /<ApprovalSection standalone \/>/);
  assert.match(doc("app/(dashboard)/alerts/page.tsx"), /<ApprovalSection \/>/, "trang Cần xử lý của nhà GIỮ mục duyệt như cũ");
  assert.match(doc("app/(dashboard)/alerts/approval-actions.tsx"), /decideApproval\(id, dongY/, "nút duyệt gọi đúng server action cũ");
  assert.ok(!/decideApprovalCore|approvalRequests/.test(trangDuyet), "trang Duyệt không có đường ghi riêng");
  assert.match(doc("lib/actions/approvals.ts"), /revalidatePath\("\/approvals"\)/, "duyệt xong làm mới trang Duyệt");

  // Lỗi #3: chữ trang không tìm thấy.
  assert.equal(coreText("notFound.body", HOME_COPY_CONTEXT), "Bản ghi không tồn tại hoặc chưa được đồng bộ về ERP.", "nhà giữ NGUYÊN câu cũ");
  const khac = coreText("notFound.body", { isHome: false, declared: {} });
  assert.ok(!/đồng bộ/.test(khac) && !HOME_BRAND_PATTERN.test(khac), `tổ chức khác không nhận câu đồng bộ của nhà: ${khac}`);
  assert.match(doc("app/(dashboard)/not-found.tsx"), /copy\.text\("notFound\.body"\)/);

  // Lỗi #4: số tiền của yêu cầu duyệt — hàm thuần.
  const cond = { all: [{ field: "custom:ten" as const, op: "contains" as const, value: "x" }, { field: "custom:gia_tri" as const, op: "gte" as const, value: 20_000_000 }] };
  assert.deepEqual(conditionFieldRefs(cond), ["custom:ten", "custom:gia_tri"]);
  const tien = ["custom:dat_coc", "custom:gia_tri"];
  assert.equal(approvalAmountOf(cond, { "custom:gia_tri": 25_000_000, "custom:dat_coc": 1_000_000 }, tien), 25_000_000, "field tiền mà điều kiện tham chiếu thắng field tiền đầu tiên");
  assert.equal(approvalAmountOf(null, { "custom:gia_tri": 25_000_000, "custom:dat_coc": 1_000_000 }, tien), 1_000_000, "không điều kiện ⇒ field tiền đầu tiên");
  assert.equal(approvalAmountOf(cond, { "custom:gia_tri": null, "custom:dat_coc": 3_000 }, tien), 3_000, "field tham chiếu chưa có giá trị ⇒ field tiền kế tiếp có giá trị");
  assert.equal(approvalAmountOf(cond, { "custom:gia_tri": null, "custom:dat_coc": null }, tien), null, "không field tiền nào có giá trị ⇒ CHƯA BIẾT, không phải 0 (luật 42)");
  assert.equal(approvalAmountOf(cond, { "custom:gia_tri": 0 }, tien), 0, "0 THẬT vẫn là 0");
  assert.equal(approvalAmountOf({ field: "custom:so_luong", op: "gte", value: 5 }, { "custom:so_luong": 9 }, []), null, "field số KHÔNG phải tiền ⇒ không lấy làm số tiền");
  assert.equal(approvalAmountOf(null, { "system:total": "150000.00" }, ["system:total"]), 150_000, "cột tiền numeric dạng chuỗi");
}

/* ═══════════ 3 · HAI TỔ CHỨC THẬT ═══════════ */

async function testRealOrgs() {
  for (const c of [SVC, SI]) await cleanupOrg(c);
  await provisionOrganization({ code: SVC, name: "Dịch vụ thử duyệt", plan: "standard", modules: [], admin: { email: `admin@${SVC}.local`, name: "QT dịch vụ", password: "Duyet@12345" }, source: "TEST", actor: null });
  await provisionOrganization({ code: SI, name: "Bán sỉ thử duyệt", plan: "standard", modules: WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "core" && m !== "work"), admin: { email: `admin@${SI}.local`, name: "QT bán sỉ", password: "Duyet@12345" }, source: "TEST", actor: null });
  try {
    let reqId = "";
    await withOrganization(SVC, async () => {
      // Cài ĐÚNG mẫu service-business (như /start): không bật thêm module nào.
      let admin = await adminOf(SVC);
      const plan = await planForOrg(SERVICE_BUSINESS_BLUEPRINT, admin);
      assert.ok(plan.ok, JSON.stringify(plan.steps.filter((s) => s.action === "BLOCKED")));
      const done = await installBlueprint(SERVICE_BUSINESS_BLUEPRINT, admin, { expectedPlanHash: plan.planHash });
      assert.ok(done.ok, JSON.stringify(done).slice(0, 800));
      admin = await adminOf(SVC);
      const mods = admin.modules ?? [];
      assert.deepEqual([...mods].sort(), [...SERVICE_BUSINESS_BLUEPRINT.modules].sort(), "đúng bộ module của mẫu");
      assert.ok(!mods.includes("alerts") && !mods.includes("orders"), "không «Cần xử lý», không «Đơn hàng»");
      assert.ok(can(admin, "approvals:decide"), "quản trị có quyền duyệt (khoá của lõi)");
      assert.ok(!can(admin, "alerts:view"), "nhưng không vào được «Cần xử lý» — đó chính là lỗi #1");
      assert.ok(!can(admin, "platform:operate"), "ADMIN tổ chức khác không vận hành nền tảng");
      const menu = hrefsOf(admin);
      assert.ok(menu.includes("/approvals") && !menu.includes("/platform") && !menu.includes("/cod"), `menu thật của tổ chức dịch vụ: ${menu.join(" ")}`);
      assert.deepEqual(menuViolations(mods as ModuleKey[], false), []);

      // Luật của mẫu: Nháp · Chạy thử ⇒ Bật + Chạy thật.
      const rule = (await listRules()).find((r) => r.key === "hop_dong_lon_can_duyet");
      assert.ok(rule && rule.status === "DRAFT" && rule.mode === "DRY_RUN", "luật của mẫu sinh ở NHÁP + CHẠY THỬ");
      const actor = { id: admin.id, email: admin.email };
      assert.ok((await setRuleStatus(rule.id, "ACTIVE", actor)).ok);
      assert.ok((await setRuleMode(rule.id, "LIVE", actor)).ok);
      await runWorkflows(); // lượt đầu chỉ khởi tạo con trỏ — không xử lý lịch sử

      const db = await getDb();
      const hd25 = await createRecord("x_contract", { system: { title: "HĐ-DUYET-25TR" }, custom: { gia_tri: 25_000_000 } }, admin);
      assert.ok(hd25.ok, JSON.stringify(hd25));
      const hd5 = await createRecord("x_contract", { system: { title: "HĐ-DUYET-5TR" }, custom: { gia_tri: 5_000_000 } }, admin);
      assert.ok(hd5.ok, JSON.stringify(hd5));

      const w1 = await runWorkflows();
      assert.equal(w1.waiting, 1, `chỉ hợp đồng 25 tr xin duyệt: ${JSON.stringify(w1)}`);
      const viecLuat = async () => (await db.select().from(schema.workItems).where(eq(schema.workItems.sourceType, "WORKFLOW_TASK"))).length;
      assert.equal(await viecLuat(), 0, "chưa duyệt ⇒ 0 việc");

      // Trang Duyệt đọc được yêu cầu — CÙNG đường đọc với mục duyệt của trang Cần xử lý — kèm SỐ TIỀN (lỗi #4).
      const items = await listApprovalSectionItems({ id: admin.id, canDecide: can(admin, "approvals:decide") }, new Date());
      assert.equal(items.length, 1, JSON.stringify(items));
      assert.equal(items[0].group, "WORKFLOW");
      assert.equal(items[0].amount, 25_000_000, "yêu cầu duyệt mang số tiền của hợp đồng, không «chưa rõ số tiền»");
      assert.ok(items[0].canDecide, "quản trị duyệt được (người xin là máy)");
      reqId = items[0].id;

      // Việc chờ duyệt trên /work trỏ trang Duyệt (lõi), không trỏ /alerts.
      const work = await collectWorkItems({});
      const choDuyet = work.items.filter((i) => i.sourceType === "APPROVAL");
      assert.equal(choDuyet.length, 1);
      assert.equal(choDuyet[0].sourceUrl, "/approvals", "nguồn của việc chờ duyệt = trang Duyệt");
      assert.match(choDuyet[0].evidence.detail, /25\.000\.000/, "bằng chứng của việc in số tiền");

      // Duyệt qua lõi của CHÍNH action trang Duyệt gọi (quyền tính bằng can()).
      const kq = await decideApprovalCore(db, { id: admin.id, email: admin.email, canDecide: can(admin, "approvals:decide") }, reqId, true, "Đủ điều kiện");
      assert.ok("ok" in kq, JSON.stringify(kq));
      const w2 = await runWorkflows();
      assert.equal(w2.executed, 1, "duyệt xong ⇒ luật chạy đúng một lần");
      assert.equal(await viecLuat(), 1, "đúng MỘT việc");
      await runWorkflows();
      await runWorkflows();
      assert.equal(await viecLuat(), 1, "chạy thêm vẫn MỘT việc");
      const viec = (await collectWorkItems({})).items.filter((i) => i.sourceType === "WORKFLOW_TASK");
      assert.equal(viec.length, 1, "việc do luật tạo hiện ở /work");
      assert.equal(viec[0].title, "Chuẩn bị triển khai hợp đồng giá trị lớn");
      assert.equal((await listApprovalSectionItems({ id: admin.id, canDecide: true }, new Date())).length, 0, "trang Duyệt rỗng sau khi duyệt");
      const [req] = await db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.id, reqId), eq(schema.approvalRequests.group, "WORKFLOW")));
      assert.ok(req && req.status !== "PENDING" && req.decidedBy === admin.id && req.executedAt, `lời duyệt đã quyết, mang khoá tài khoản người duyệt (luật 34), đã thanh toán: ${JSON.stringify({ status: req?.status, by: req?.decidedBy, executedAt: req?.executedAt })}`);
    });

    await withOrganization(SI, async () => {
      const admin = await adminOf(SI);
      const mods = admin.modules ?? [];
      assert.ok(mods.includes("purchasing") && !mods.includes("production"), `bộ module bán sỉ: ${mods.join(",")}`);
      // Menu thật của tổ chức bán sỉ: không nhóm «Sản xuất», không `/platform`.
      const groups = visibleGroups(admin);
      assert.ok(!groups.some((g) => g.zone === "PRODUCTION"), `bán sỉ: ${groups.map((g) => g.zone).join(",")}`);
      assert.ok(!hrefsOf(admin).includes("/platform"));
      assert.deepEqual(menuViolations(mods as ModuleKey[], false), []);
      // Cô lập: B không thấy / không duyệt được yêu cầu của A.
      assert.equal((await listApprovalSectionItems({ id: admin.id, canDecide: true }, new Date())).length, 0, "bán sỉ không thấy yêu cầu của tổ chức dịch vụ");
      const chiem = await decideApprovalCore(await getDb(), { id: admin.id, email: admin.email, canDecide: true }, reqId, false, "chiếm");
      assert.ok("error" in chiem, "duyệt id của tổ chức khác ⇒ không tồn tại");
    });
  } finally {
    for (const c of [SVC, SI]) await cleanupOrg(c);
  }
}

export async function testApprovalsCore() {
  testPureContracts();
  testMenuSweep();
  await testRealOrgs();
  console.log(
    "✓ Phase 12 · năm lỗi chấp nhận: trang Duyệt LÕI (/approvals, approvals:decide) — tổ chức dịch vụ cài mẫu thật ⇒ luật 25 tr xin duyệt ⇒ trang Duyệt thấy 25.000.000 ₫ ⇒ duyệt ⇒ đúng MỘT việc ở /work, chạy thêm vẫn một · mọi lối «mở để duyệt» trỏ /approvals, /alerts của nhà giữ mục duyệt (cùng component, cùng action) · /platform chỉ ở tổ chức nhà · not-found theo thương hiệu · bộ quét menu × module tắt 0 vi phạm · bán sỉ không nhóm «Sản xuất», dịch vụ không «Đối soát COD» · cô lập tổ chức",
  );
}

