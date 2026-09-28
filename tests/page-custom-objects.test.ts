/**
 * PHASE 6 × PHASE 4/5 · ĐỐI TƯỢNG TUỲ BIẾN LÀM NGUỒN CỦA TRANG ĐỘNG (docs/platform/phase-6-contracts.md §7).
 *
 * HAI TỔ CHỨC THẬT (`pco-a`, `pco-b` — hai CSDL PGlite riêng, `provisionOrganization`, tự dọn):
 *  · sổ hiệu lực = sổ tĩnh + đối tượng tuỳ biến ACTIVE; trình soạn chỉ mời người XEM được đối tượng;
 *  · trang có bảng + KPI tổng hợp (cộng field tiền tuỳ biến) + kanban (field trạng thái tuỳ biến) + biểu đồ nhóm + bộ lọc +
 *    dòng thời gian + form của `x_contract` ⇒ đúng số, đúng phạm vi (người SELF chỉ thấy bản ghi của mình);
 *  · bản ghi của ĐỐI TƯỢNG KHÁC cùng tổ chức (`x_other`, cùng bảng `custom_records`) không lọt vào bảng / KPI / kanban /
 *    dòng thời gian / form / hành động theo dòng — quên `recordScopeSql` thì bài này đỏ;
 *  · tổ chức B trỏ `x_contract` của A ⇒ không có (khoá không tồn tại ở B) — khối NOT_FOUND, xuất bản bị chặn đúng path;
 *  · đối tượng LƯU TRỮ ⇒ khối NOT_FOUND, module `apps` tắt ⇒ MODULE_DISABLED, trang không sập; thiếu `records:view` ⇒
 *    FORBIDDEN và 0 lượt gọi nguồn;
 *  · hành động theo dòng (mở bản ghi) + kéo thẻ kanban đi qua đúng cổng bản ghi; mẫu "Bàn làm việc khách hàng" gợi ý bảng
 *    của đối tượng liên kết tới khách;
 *  · liên kết ngược trên trang hệ thống (khách hàng) chỉ hiện bản ghi người xem xem được;
 *  · khung chọn khối của trình soạn: chỉ khung TRONG CÙNG chứa điểm bấm được chọn (khối con trong cột).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { frameOwnsClick } from "@/components/pages/editable-block-frame";
import type { SessionUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import { createCustomField } from "@/lib/metadata/fields";
import type { MetadataActor } from "@/lib/metadata/types";
import { archiveObject, createObject, restoreObject } from "@/lib/objects/objects";
import { createRecord, reverseRelations } from "@/lib/objects/records";
import { executePageAction } from "@/lib/pages/actions";
import { defaultPageCatalog, validatePageSchema } from "@/lib/pages/components";
import { effectivePageCatalog } from "@/lib/pages/custom-sources";
import { listDataSources, pageDataProbe, resolveBlock, resolvePage } from "@/lib/pages/data-sources";
import { createPage, createPageFromTemplate, getPageBySlug, getPageDraft, publishPage, savePageDraft } from "@/lib/pages/registry";
import type { BlockType, ChartData, KanbanData, KpiData, PageBlock, PageRenderContext, PageSchema, ResolvedBlock, TableData, TimelineData } from "@/lib/pages/types";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { pageEditorCatalog } from "@/lib/platform-ui/page-admin";

const A = "pco-a";
const B = "pco-b";

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function setModule(org: string, key: string, enabled: boolean) {
  const pdb = await getPlatformDb();
  const o = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, org) });
  assert.ok(o);
  const updated = await pdb
    .update(schema.platformOrganizationModules)
    .set({ enabled })
    .where(and(eq(schema.platformOrganizationModules.organizationId, o.id), eq(schema.platformOrganizationModules.moduleKey, key)))
    .returning();
  if (updated.length === 0) await pdb.insert(schema.platformOrganizationModules).values({ organizationId: o.id, moduleKey: key, enabled, features: {} });
  invalidateCapabilities();
}

async function adminOf(org: string): Promise<SessionUser> {
  return withOrganization(org, async () => {
    const u = await (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) });
    assert.ok(u, `quản trị của ${org}`);
    return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false } };
  });
}

function staff(id: string, org: string, permissions: string[], scope: SessionUser["scope"]): SessionUser {
  return { id, email: `${id}@${org}.local`, name: id, role: "VIEWER", permissions, scope, departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false } };
}

function block<T extends BlockType>(id: string, type: T, config: PageBlock<T>["config"], span: PageBlock["span"] = 12): PageBlock<T> {
  return { id, type, span, config };
}

const ctxOf = (searchParams: Record<string, string | undefined> = {}): PageRenderContext => ({ searchParams, period: "30d" });

function msg(r: unknown): string {
  return JSON.stringify(r).slice(0, 700);
}

async function ok<T>(p: Promise<{ ok: true; data: unknown } | { ok: false; issue: { code: string; message: string } }>, what: string): Promise<T> {
  const r = await p;
  assert.ok(r.ok, `${what}: ${r.ok ? "" : `${r.issue.code} — ${r.issue.message}`}`);
  return (r as { data: T }).data;
}

async function blockCode(p: Promise<{ ok: boolean; issue?: { code: string } }>): Promise<string> {
  const r = await p;
  return r.ok ? "OK" : String(r.issue?.code);
}

/** Khối phải bị từ chối với đúng mã, và KHÔNG gọi xuống nguồn dữ liệu nào. */
async function denied(p: () => Promise<{ ok: boolean; issue?: { code: string } }>, code: string, what: string) {
  const before = pageDataProbe.sourceCalls;
  const r = await p();
  assert.equal(r.ok, false, `${what}: phải bị từ chối`);
  assert.equal(r.issue?.code, code, `${what}: mã lỗi — ${msg(r)}`);
  assert.equal(pageDataProbe.sourceCalls, before, `${what}: 0 lượt gọi nguồn dữ liệu`);
}

function flat(resolved: Awaited<ReturnType<typeof resolvePage>>): Map<string, ResolvedBlock> {
  const out = new Map<string, ResolvedBlock>();
  for (const s of resolved.sections) for (const b of s.blocks) out.set(b.block.id, b);
  return out;
}

function dataOf<T>(m: Map<string, ResolvedBlock>, id: string): T {
  const b = m.get(id);
  assert.ok(b, `khối ${id}`);
  assert.ok(b.ok, `khối ${id}: ${b.ok ? "" : `${b.issue.code} — ${b.issue.message}`}`);
  return b.data as T;
}

/** Khung chọn khối: chỉ khung TRONG CÙNG chứa điểm bấm được chọn (lỗi cũ: bấm khối con trong cột chọn cả cột). */
function testFrameSelection() {
  const column = { name: "cot" };
  const child = { name: "con" };
  const inChild = { closest: () => child };
  const onColumnPadding = { closest: () => column };
  assert.equal(frameOwnsClick(inChild, column), false, "bấm trong khối con: khung CỘT không được giành lượt chọn");
  assert.equal(frameOwnsClick(inChild, child), true, "bấm trong khối con: khung CON chọn");
  assert.equal(frameOwnsClick(onColumnPadding, column), true, "bấm vào phần của cột (ngoài mọi khối con): cột chọn");
  assert.equal(frameOwnsClick(null, column), true, "không xác định được đích ⇒ khung đang bắt chọn (hành vi cũ)");
  console.log("✓ Trình soạn · khung chọn khối: khối con trong cột chọn được — khung ngoài không chặn lượt bấm của khung trong");
}

const SCHEMA = (slug: string): PageSchema => ({
  version: 1,
  sections: [
    {
      key: "loc",
      variant: "plain",
      blocks: [block("loc", "filter", { fields: [{ objectKey: "x_contract", ref: "custom:trang_thai", op: "eq", label: "Trạng thái" }], targets: ["hd_bang"] })],
    },
    {
      key: "so",
      blocks: [
        block("hd_tong", "kpi", { aggregate: { objectKey: "x_contract", fn: "sum", field: "custom:gia_tri" }, label: "Tổng giá trị hợp đồng" }, 4),
        block("hd_dem", "kpi", { aggregate: { objectKey: "x_contract", fn: "count" } }, 4),
        block("hd_nhom", "chart", { aggregate: { objectKey: "x_contract", fn: "count" }, kind: "bar", groupBy: { ref: "custom:trang_thai" } }, 4),
      ],
    },
    {
      key: "bang",
      title: slug,
      blocks: [
        block("hd_bang", "table", { source: "x_contract", columns: ["system:title", "custom:gia_tri", "custom:khach", "system:owner"], rowLink: true, pageSize: 20, rowActions: [{ action: "open_record", label: "Mở" }] }),
        block("hd_kanban", "kanban", { objectKey: "x_contract", statusField: "custom:trang_thai", cardFields: ["custom:gia_tri"], allowMove: true }),
      ],
    },
  ],
});

export async function testPageCustomObjects() {
  testFrameSelection();

  for (const c of [A, B]) {
    await cleanupOrg(c);
    rmSync(organizationDatabaseUrl({ code: c, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    await provisionOrganization({ code: c, name: `Tổ chức ${c}`, modules: ["customers", "apps"], admin: { email: `admin@${c}.local`, name: `QT ${c}`, password: "PageObj@12345" }, source: "TEST", actor: null });
  }
  clearMemo();
  try {
    const qtA = await adminOf(A);
    const qtB = await adminOf(B);
    const actorA: MetadataActor = { id: qtA.id, email: qtA.email };
    const actorB: MetadataActor = { id: qtB.id, email: qtB.email };
    const nv1 = staff("pco-a-nv1", A, ["records:view", "records:write", "customers:view"], "SELF");
    const khongQuyen = staff("pco-a-nv2", A, ["customers:view"], "ALL");
    const ids: Record<string, string> = {};

    // ══════════ TỔ CHỨC A ══════════
    await withOrganization(A, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values([{ id: "pco-a-cus1", name: "Khách A1" }]);
      await db.insert(schema.users).values([
        { id: nv1.id, email: nv1.email, name: "NV1", passwordHash: "x", role: "VIEWER", active: true },
        { id: khongQuyen.id, email: khongQuyen.email, name: "NV2", passwordHash: "x", role: "VIEWER", active: true },
      ]);

      // Sổ hiệu lực TRƯỚC khi có đối tượng: đúng sổ tĩnh.
      const before = await effectivePageCatalog();
      assert.equal(before.lists.length, defaultPageCatalog().lists.length, "chưa có đối tượng tuỳ biến ⇒ sổ hiệu lực = sổ tĩnh");

      for (const [key, label] of [
        ["x_contract", "Hợp đồng"],
        ["x_other", "Việc khác"],
      ] as const) {
        const r = await createObject(qtA, { key, label, labelPlural: label, icon: "file-text" });
        assert.ok(r.ok, msg(r));
      }
      const field = async (objectKey: string, input: Record<string, unknown>) => {
        const r = await createCustomField(objectKey, input, actorA);
        assert.ok(r.ok, `${objectKey}.${String(input.key)}: ${msg(r)}`);
      };
      await field("x_contract", { key: "gia_tri", label: "Giá trị", type: "currency", filterable: true });
      await field("x_contract", { key: "trang_thai", label: "Trạng thái", type: "status", filterable: true, options: [{ value: "nhap", label: "Nháp" }, { value: "hieu_luc", label: "Hiệu lực" }], transitions: { nhap: ["hieu_luc"] } });
      await field("x_contract", { key: "khach", label: "Khách", type: "relation", relationObject: "customer", filterable: true });
      await field("x_other", { key: "gia_tri", label: "Giá trị", type: "currency" });

      const rec = async (objectKey: string, title: string, custom: Record<string, unknown>, who: SessionUser, owner?: string) => {
        const r = await createRecord(objectKey, { system: { title, ...(owner ? { owner } : {}) }, custom }, who);
        assert.ok(r.ok, `${objectKey} «${title}»: ${msg(r)}`);
        return r.id;
      };
      ids.c1 = await rec("x_contract", "HĐ-01", { gia_tri: 10_000_000, trang_thai: "nhap", khach: "pco-a-cus1" }, qtA);
      ids.c2 = await rec("x_contract", "HĐ-02", { gia_tri: 20_000_000, trang_thai: "hieu_luc" }, qtA);
      // Quản trị giao cho NV1 (người phạm vi SELF không tự liên kết được tới khách mình không xem được).
      ids.c3 = await rec("x_contract", "HĐ-NV1", { gia_tri: 5_000_000, trang_thai: "nhap", khach: "pco-a-cus1" }, qtA, nv1.id);
      // Đối tượng KHÁC cùng tổ chức, cùng bảng `custom_records`, cùng khoá field `gia_tri` — không được lọt vào đâu cả.
      ids.o1 = await rec("x_other", "Việc lạ", { gia_tri: 999_000_000 }, qtA);

      // ── 1. Sổ hiệu lực + trình soạn ──
      const eff = await effectivePageCatalog();
      const lc = eff.lists.find((l) => l.objectKey === "x_contract");
      assert.ok(lc && lc.module === "apps" && lc.permissions?.includes("records:view"), `x_contract vào sổ danh sách: ${msg(lc)}`);
      assert.ok(eff.timelines.some((t) => t.key === "custom_record_x_contract" && t.recordObject === "x_contract"), "dòng thời gian custom_record_x_contract");
      assert.equal(eff.lists.length, defaultPageCatalog().lists.length + 2, "sổ tĩnh GIỮ NGUYÊN, đối tượng tuỳ biến nối thêm");
      assert.ok(listDataSources(qtA, eff).lists.some((l) => l.objectKey === "x_contract"), "quản trị: trình soạn mời x_contract");
      assert.ok(!listDataSources(khongQuyen, eff).lists.some((l) => l.objectKey.startsWith("x_")), "thiếu records:view ⇒ trình soạn không mời đối tượng tuỳ biến");
      assert.ok(!listDataSources(khongQuyen, eff).timelines.some((t) => t.key === "custom_record_x_contract"));
      const editor = await pageEditorCatalog(qtA);
      const eo = editor.objects.find((o) => o.key === "x_contract");
      assert.ok(eo && eo.catalog.some((f) => f.ref === "custom:gia_tri") && eo.forms.some((f) => f.key === "create"), `trình soạn có field + form của x_contract: ${msg(eo)}`);

      // ── 2. Lưu nháp + xuất bản (sổ hiệu lực là mặc định của registry) ──
      const created = await createPage({ slug: "hop-dong", name: "Hợp đồng", moduleKey: "apps" }, actorA);
      assert.ok(created.ok, msg(created));
      const pageId = created.page.id;
      const saved = await savePageDraft(pageId, SCHEMA("Hợp đồng"), actorA);
      assert.ok(saved.ok, msg(saved));
      const pub = await publishPage(pageId, actorA);
      assert.ok(pub.ok, msg(pub));
      // Validator thuần với sổ TĨNH không biết x_contract; với sổ hiệu lực thì biết — cùng MỘT hàm.
      const modules = new Set<ModuleKey>(["core", "customers", "apps"]);
      assert.equal(validatePageSchema(SCHEMA("x"), { modules, moduleIssues: "error" }).ok, false, "sổ tĩnh: x_contract không có");
      assert.deepEqual(validatePageSchema(SCHEMA("x"), { modules, catalog: eff, moduleIssues: "error" }).errors, [], "sổ hiệu lực: hợp lệ");
      // Kanban trên field KHÔNG phải trạng thái của đối tượng tuỳ biến ⇒ lỗi đúng path (registry đối chiếu field thật).
      const badKanban: PageSchema = { version: 1, sections: [{ key: "k", blocks: [block("kb", "kanban", { objectKey: "x_contract", statusField: "custom:gia_tri", cardFields: [], allowMove: false })] }] };
      const bk = await savePageDraft(pageId, badKanban, actorA);
      assert.ok(!bk.ok && bk.errors.some((e) => e.path === "sections.0.blocks.0.config.statusField" && /trạng thái/.test(e.message)), msg(bk));
      // Trỏ đối tượng không tồn tại ⇒ xuất bản bị chặn ĐÚNG path.
      const ghost = await createPage({ slug: "ma", name: "Ma", moduleKey: "apps", draft: { version: 1, sections: [{ key: "a", blocks: [block("t", "table", { source: "x_khong_co" })] }] } }, actorA);
      assert.equal(ghost.ok, false);
      assert.ok(!ghost.ok && ghost.errors.some((e) => e.path === "sections.0.blocks.0.config.source" && /x_khong_co/.test(e.message)), msg(ghost));
      await savePageDraft(pageId, SCHEMA("Hợp đồng"), actorA);

      // ── 3. Trang đã xuất bản, người xem QUẢN TRỊ (phạm vi toàn bộ) ──
      const published = await getPageBySlug("hop-dong");
      assert.ok(published);
      const all = flat(await resolvePage(published.schema, qtA, ctxOf(), "hop-dong"));
      const table = dataOf<TableData>(all, "hd_bang");
      assert.equal(table.total, 3, `bảng: đúng 3 hợp đồng — không có bản ghi của x_other: ${msg(table.rows.map((r) => r.id))}`);
      assert.deepEqual(new Set(table.rows.map((r) => r.id)), new Set([ids.c1, ids.c2, ids.c3]));
      assert.ok(!table.rows.some((r) => r.id === ids.o1), "id của đối tượng khác không lọt");
      assert.equal(table.rows.find((r) => r.id === ids.c1)?.href, `/o/x_contract/${ids.c1}`, "liên kết dòng = trang /o/…");
      assert.equal(table.rows.find((r) => r.id === ids.c1)?.cells["custom:khach"], "Khách A1", "quan hệ: tên đích người xem xem được");
      assert.equal(table.rows.find((r) => r.id === ids.c2)?.cells["custom:gia_tri"], 20_000_000);
      const ownerCell = table.rows.find((r) => r.id === ids.c3)?.cells["system:owner"];
      assert.equal(ownerCell, "NV1", `người phụ trách in TÊN theo khoá tài khoản, không in id thô: ${String(ownerCell)}`);
      assert.ok(table.rowActions?.[0]?.enabled, `hành động theo dòng bật: ${msg(table.rowActions)}`);
      const sum = dataOf<KpiData>(all, "hd_tong");
      assert.equal(sum.value, 35_000_000, "KPI: cộng field tiền tuỳ biến — 999 triệu của x_other KHÔNG cộng vào");
      assert.equal(sum.format, "vnd");
      assert.equal(dataOf<KpiData>(all, "hd_dem").value, 3);
      const chart = dataOf<ChartData>(all, "hd_nhom");
      assert.deepEqual(Object.fromEntries(chart.points.map((p) => [p.x, p.y])), { Nháp: 2, "Hiệu lực": 1 }, "biểu đồ nhóm theo trạng thái tuỳ biến, nhãn theo tuỳ chọn");
      const kanban = dataOf<KanbanData>(all, "hd_kanban");
      assert.deepEqual(Object.fromEntries(kanban.columns.map((c) => [c.value, c.cards.map((x) => x.id).sort()])), { nhap: [ids.c1, ids.c3].sort(), hieu_luc: [ids.c2] });
      assert.ok(kanban.allowMove && kanban.columns.find((c) => c.value === "nhap")!.cards.every((c) => c.moveTargets.includes("hieu_luc") && c.href?.startsWith("/o/x_contract/")));

      // Bộ lọc của người xem áp lên bảng cùng đối tượng.
      const filtered = flat(await resolvePage(published.schema, qtA, ctxOf({ pf_loc_0: "hieu_luc" }), "hop-dong"));
      assert.deepEqual(dataOf<TableData>(filtered, "hd_bang").rows.map((r) => r.id), [ids.c2], "lọc trạng thái tuỳ biến");

      // ── 4. Người SELF chỉ thấy bản ghi mình là chủ ──
      const mine = flat(await resolvePage(published.schema, nv1, ctxOf(), "hop-dong"));
      assert.deepEqual(dataOf<TableData>(mine, "hd_bang").rows.map((r) => r.id), [ids.c3], "SELF: bảng chỉ bản ghi của mình");
      assert.equal(dataOf<KpiData>(mine, "hd_tong").value, 5_000_000, "SELF: KPI chỉ cộng bản ghi của mình");
      assert.equal(dataOf<KanbanData>(mine, "hd_kanban").columns.flatMap((c) => c.cards).length, 1, "SELF: kanban một thẻ");

      // ── 5. Thiếu records:view ⇒ FORBIDDEN, 0 lượt gọi nguồn ──
      await denied(() => resolveBlock(block("t", "table", { source: "x_contract" }), khongQuyen, ctxOf()), "FORBIDDEN", "bảng x_contract khi thiếu records:view");
      await denied(() => resolveBlock(block("k", "kpi", { aggregate: { objectKey: "x_contract", fn: "sum", field: "custom:gia_tri" } }), khongQuyen, ctxOf()), "FORBIDDEN", "KPI tổng hợp khi thiếu records:view");
      await denied(() => resolveBlock(block("t", "table", { source: "x_khong_co" }), qtA, ctxOf()), "NOT_FOUND", "khoá đối tượng không tồn tại");

      // ── 6. Dòng thời gian + form: bản ghi của đối tượng khác / ngoài phạm vi ⇒ không tồn tại ──
      const tl = block("dong", "timeline", { source: "custom_record_x_contract", recordParam: "id" });
      const entries = await ok<TimelineData>(resolveBlock(tl, qtA, ctxOf({ id: ids.c1 })), "dòng thời gian hợp đồng");
      assert.ok(entries.entries.length >= 1, `dòng thời gian có mốc tạo: ${msg(entries)}`);
      assert.equal(await blockCode(resolveBlock(tl, qtA, ctxOf({ id: ids.o1 }))), "NOT_FOUND", "id của x_other trên dòng thời gian x_contract");
      assert.equal(await blockCode(resolveBlock(tl, nv1, ctxOf({ id: ids.c1 }))), "NOT_FOUND", "SELF: dòng thời gian bản ghi người khác");
      const fv = block("xem", "form", { objectKey: "x_contract", formKey: "edit", mode: "view", recordParam: "id" });
      const form = await ok<{ props: { values: { system: Record<string, unknown>; custom: Record<string, unknown> } } }>(resolveBlock(fv, qtA, ctxOf({ id: ids.c2 })), "form xem hợp đồng");
      assert.equal(form.props.values.system.title, "HĐ-02");
      assert.equal(form.props.values.custom.gia_tri, 20_000_000);
      assert.equal(await blockCode(resolveBlock(fv, qtA, ctxOf({ id: ids.o1 }))), "NOT_FOUND", "form: id của đối tượng khác");
      assert.equal(await blockCode(resolveBlock(block("tao", "form", { objectKey: "x_contract", formKey: "create", mode: "create" }), staff("pco-a-nv1", A, ["records:view"], "ALL"), ctxOf())), "FORBIDDEN", "form tạo khi thiếu records:write");

      // ── 7. Hành động theo dòng + kéo thẻ kanban: cùng cổng bản ghi ──
      const load = (slug: string) => getPageBySlug(slug);
      const open = await executePageAction("hop-dong", "hd_bang", {}, qtA, { loadPublished: load, recordId: ids.c1, actionIndex: 0 });
      assert.deepEqual(open, { ok: true, redirectTo: `/o/x_contract/${ids.c1}` });
      assert.equal((await executePageAction("hop-dong", "hd_bang", {}, qtA, { loadPublished: load, recordId: ids.o1, actionIndex: 0 })).ok, false, "dòng mang id của x_other ⇒ không tồn tại");
      assert.equal((await executePageAction("hop-dong", "hd_bang", {}, nv1, { loadPublished: load, recordId: ids.c1, actionIndex: 0 })).ok, false, "SELF: dòng của người khác ⇒ không tồn tại");
      const moved = await executePageAction("hop-dong", "hd_kanban", { recordId: ids.c1, value: "hieu_luc" }, qtA, { loadPublished: load });
      assert.ok(moved.ok, msg(moved));
      const [cv] = await db.select().from(schema.customValues).where(and(eq(schema.customValues.objectKey, "x_contract"), eq(schema.customValues.recordId, ids.c1)));
      assert.equal((cv.values as Record<string, unknown>).trang_thai, "hieu_luc", "kéo thẻ ghi qua saveCustomValues");
      assert.equal((await executePageAction("hop-dong", "hd_kanban", { recordId: ids.o1, value: "hieu_luc" }, qtA, { loadPublished: load })).ok, false, "kéo thẻ với id của x_other ⇒ từ chối");

      // ── 8. Mẫu trang gợi ý bảng của đối tượng tuỳ biến liên kết tới khách ──
      const tpl = await createPageFromTemplate("customer-workspace", actorA, { slug: "ban-khach" });
      assert.ok(tpl.ok, msg(tpl));
      const tplDraft = await getPageDraft(tpl.page.id);
      const appTable = tplDraft.draft.sections.flatMap((s) => s.blocks).find((b) => b.id === "app_records_table");
      assert.equal((appTable?.config as { source?: string } | undefined)?.source, "x_contract", `mẫu gợi ý bảng x_contract (có field liên kết khách): ${msg(tplDraft.draft)}`);

      // ── 9. Liên kết ngược trên trang khách hàng: chỉ hiện khi xem được ──
      const rev = await reverseRelations("customer", "pco-a-cus1", qtA);
      assert.deepEqual(rev.map((g) => [g.objectKey, g.fieldKey, g.records.map((r) => r.id).sort()]), [["x_contract", "khach", [ids.c1, ids.c3].sort()]]);
      assert.deepEqual(await reverseRelations("customer", "pco-a-cus1", khongQuyen), [], "thiếu records:view ⇒ không nhóm nào (trang không vẽ khung rỗng)");
      const revMine = await reverseRelations("customer", "pco-a-cus1", nv1);
      assert.deepEqual(revMine.flatMap((g) => g.records.map((r) => r.id)), [ids.c3], "SELF: chỉ bản ghi của mình");

      // ── 10. Lưu trữ đối tượng / tắt module: khối hỏng riêng, trang không sập ──
      assert.ok((await archiveObject(qtA, "x_contract")).ok);
      const archived = flat(await resolvePage(published.schema, qtA, ctxOf(), "hop-dong"));
      for (const id of ["hd_bang", "hd_tong", "hd_kanban", "hd_nhom"]) {
        const b = archived.get(id)!;
        assert.ok(!b.ok && b.issue.code === "NOT_FOUND", `${id} khi đối tượng lưu trữ: ${msg(b)}`);
      }
      assert.ok(!(await effectivePageCatalog()).lists.some((l) => l.objectKey === "x_contract"), "đối tượng lưu trữ rời sổ hiệu lực");
      assert.equal(await blockCode(resolveBlock(tl, qtA, ctxOf({ id: ids.c1 }))), "NOT_FOUND", "dòng thời gian khi đối tượng lưu trữ");
      assert.ok((await restoreObject(qtA, "x_contract")).ok);
    });

    await setModule(A, "apps", false);
    await withOrganization(A, async () => {
      const published = await getPageBySlug("hop-dong");
      assert.ok(published);
      const off = flat(await resolvePage(published.schema, qtA, ctxOf(), "hop-dong"));
      const t = off.get("hd_bang")!;
      assert.ok(!t.ok && t.issue.code === "MODULE_DISABLED", `module apps tắt: ${msg(t)}`);
      assert.deepEqual(await reverseRelations("customer", "pco-a-cus1", qtA), [], "module apps tắt ⇒ không liên kết ngược nào");
    });
    await setModule(A, "apps", true);

    // ══════════ TỔ CHỨC B: khoá `x_contract` của A không tồn tại ở đây ══════════
    await withOrganization(B, async () => {
      assert.equal(await blockCode(resolveBlock(block("t", "table", { source: "x_contract" }), qtB, ctxOf())), "NOT_FOUND", "B đọc bảng x_contract ⇒ không có");
      assert.equal(await blockCode(resolveBlock(block("k", "kpi", { aggregate: { objectKey: "x_contract", fn: "count" } }), qtB, ctxOf())), "NOT_FOUND");
      assert.equal(await blockCode(resolveBlock(block("dong", "timeline", { source: "custom_record_x_contract", recordParam: "id" }), qtB, ctxOf({ id: ids.c1 }))), "NOT_FOUND");
      const page = await createPage({ slug: "hop-dong", name: "Hợp đồng", moduleKey: "apps" }, actorB);
      assert.ok(page.ok, msg(page));
      const s = await savePageDraft(page.page.id, SCHEMA("B"), actorB);
      assert.ok(!s.ok && s.errors.some((e) => e.path === "sections.1.blocks.0.config.aggregate.objectKey" && /x_contract/.test(e.message)), `B lưu trang trỏ x_contract của A ⇒ lỗi đúng path: ${msg(s)}`);
      assert.ok(!(await effectivePageCatalog()).lists.some((l) => l.objectKey === "x_contract"), "sổ hiệu lực của B không có x_contract");
      assert.equal(await getPageBySlug("hop-dong"), null, "trang của A không tồn tại ở B");
    });
    console.log("✓ Trang động × đối tượng tuỳ biến: bảng / KPI tổng hợp / kanban / biểu đồ / lọc / dòng thời gian / form / hành động theo dòng trên x_contract — đúng số, đúng phạm vi SELF, x_other không lọt, B không thấy khoá của A, lưu trữ / tắt module ⇒ khối hỏng riêng, liên kết ngược chỉ khi xem được");
  } finally {
    clearMemo();
    for (const c of [A, B]) {
      await cleanupOrg(c);
      rmSync(organizationDatabaseUrl({ code: c, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    }
  }
}
