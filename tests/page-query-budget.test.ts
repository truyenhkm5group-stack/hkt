/**
 * PHASE 11 · H2 · NGÂN SÁCH CÂU TRUY VẤN CỦA TRANG ĐỘNG (docs/platform/phase-11-12-plan.md §H2).
 *
 * Câu hỏi DUY NHẤT của bài này: số câu truy vấn một lượt dựng có TĂNG THEO SỐ DÒNG không? N+1 là thứ không bao giờ
 * lộ ra trên bộ dữ liệu mười dòng của bài kiểm chức năng — nó chỉ lộ ra khi khách có hai mươi nghìn bản ghi, tức là
 * ở production, và khi đó thì trang đã chậm rồi.
 *
 * Cách đo: tổ chức THẬT `pqb-a` (CSDL PGlite riêng, `provisionOrganization`, tự dọn) được mở với `ERP_PERF_PROBE=1`
 * nên client của NÓ mang bộ đếm có sẵn của `db/index.ts` (`instrumentQueries` → `lib/perf/probe.ts`). Mỗi kịch bản
 * chạy HAI lượt: lượt làm nóng rồi lượt đếm, cả hai sau `clearMemo()` — KPI tổng hợp đọc qua `memo`, không xoá thì
 * lượt đếm ra 0 câu và "không tăng theo số dòng" đúng một cách vô nghĩa. Đếm ở 10 dòng, gieo thêm tới 200 dòng, đếm
 * lại: hai con số phải BẰNG NHAU, và số dòng thật sự hiện ra phải khác nhau (không thì bài không đo gì cả).
 *
 * Câu đi CSDL NHÀ (sổ module của mặt phẳng điều khiển) không được đếm — client nhà mở trước khi bật cờ. Chúng có
 * đệm riêng và không phụ thuộc số dòng của tổ chức.
 *
 * Kịch bản: bảng hệ thống (khách + field bổ sung) · bảng `x_contract` (quan hệ, nhiều-quan hệ, người, trạng thái) ·
 * kanban · KPI tổng hợp · biểu đồ nhóm + theo ngày · cả trang · danh sách `/o/<khoá>` · chi tiết `/o/<khoá>/<id>`
 * (quan hệ đi + liên kết ngược + dòng thời gian + ô chọn quan hệ) · `getCustomValues` nhiều bản ghi.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { createCustomField } from "@/lib/metadata/fields";
import type { MetadataActor } from "@/lib/metadata/types";
import { getCustomValues } from "@/lib/metadata/values";
import { createObject } from "@/lib/objects/objects";
import { loadRecordDetailPage } from "@/lib/objects/record-detail";
import { createRecord, listRecords, reverseRelations } from "@/lib/objects/records";
import { resolvePage } from "@/lib/pages/data-sources";
import type { BlockType, KanbanData, PageBlock, PageRenderContext, PageSchema, ResolvedBlock, TableData } from "@/lib/pages/types";
import { probe } from "@/lib/perf/probe";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { parseListParams } from "@/lib/search-params";

const ORG = "pqb-a";
const SMALL = 10;
const LARGE = 200;
/** Trần id của một field `relation_many` (RELATION_MANY_MAX) — nhiều-quan hệ của bản ghi trung tâm dừng ở đây. */
const MANY_CAP = 50;

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

function block<T extends BlockType>(id: string, type: T, config: PageBlock<T>["config"], span: PageBlock["span"] = 12): PageBlock<T> {
  return { id, type, span, config };
}

const ctx: PageRenderContext = { searchParams: {}, period: "all" };

function msg(r: unknown): string {
  return JSON.stringify(r).slice(0, 600);
}

function blocksOf(page: Awaited<ReturnType<typeof resolvePage>>): Map<string, ResolvedBlock> {
  const out = new Map<string, ResolvedBlock>();
  for (const s of page.sections) for (const b of s.blocks) out.set(b.block.id, b);
  return out;
}

function okData<T>(m: Map<string, ResolvedBlock>, id: string): T {
  const b = m.get(id);
  assert.ok(b && b.ok, `khối ${id}: ${b && !b.ok ? `${b.issue.code} — ${b.issue.message}` : "không có"}`);
  return b.data as T;
}

/** Một khối đứng riêng trên trang (để đếm câu của ĐÚNG khối đó). */
const single = (b: PageBlock): PageSchema => ({ version: 1, sections: [{ key: "s", blocks: [b] }] });

const BLOCKS = {
  customers: block("kh_bang", "table", { source: "customer", pageSize: 100, rowLink: true }),
  contracts: block("hd_bang", "table", {
    source: "x_contract",
    columns: ["system:title", "system:owner", "custom:gia_tri", "custom:trang_thai", "custom:khach", "custom:nguoi", "custom:viec", "custom:lien_quan", "custom:ngay"],
    pageSize: 100,
    rowLink: true,
    rowActions: [{ action: "open_record", label: "Mở" }],
  }),
  kanban: block("hd_kanban", "kanban", { objectKey: "x_contract", statusField: "custom:trang_thai", cardFields: ["system:owner", "custom:gia_tri", "custom:khach", "custom:nguoi"], allowMove: true, limit: 200 }),
  kpiSum: block("hd_tong", "kpi", { aggregate: { objectKey: "x_contract", fn: "sum", field: "custom:gia_tri" }, label: "Tổng giá trị" }, 4),
  kpiCount: block("hd_dem", "kpi", { aggregate: { objectKey: "x_contract", fn: "count" } }, 4),
  groupChart: block("hd_nhom", "chart", { aggregate: { objectKey: "x_contract", fn: "count" }, kind: "bar", groupBy: { ref: "custom:trang_thai" } }, 4),
  ownerChart: block("hd_nguoi", "chart", { aggregate: { objectKey: "x_contract", fn: "sum", field: "custom:gia_tri" }, kind: "bar", groupBy: { ref: "custom:nguoi" } }, 4),
  dayChart: block("hd_ngay", "chart", { aggregate: { objectKey: "x_contract", fn: "sum", field: "custom:gia_tri" }, kind: "line", groupBy: { bucket: "day", dateField: "custom:ngay" } }, 12),
};

const FULL_PAGE: PageSchema = {
  version: 1,
  sections: [
    { key: "loc", variant: "plain", blocks: [block("loc", "filter", { fields: [{ objectKey: "x_contract", ref: "custom:trang_thai", op: "eq", label: "Trạng thái" }], targets: ["hd_bang", "hd_kanban"] })] },
    { key: "so", blocks: [BLOCKS.kpiSum, BLOCKS.kpiCount, BLOCKS.groupChart, BLOCKS.ownerChart, BLOCKS.dayChart] },
    { key: "bang", blocks: [BLOCKS.customers, BLOCKS.contracts, BLOCKS.kanban] },
  ],
};

type Count = { queries: number; shapes: string };

/** Làm nóng một lượt, rồi đếm một lượt — cả hai sau `clearMemo()`. */
async function count<T>(label: string, fn: () => Promise<T>): Promise<{ value: T } & Count> {
  clearMemo();
  await fn();
  clearMemo();
  const { value, stats } = await probe(label, fn, { top: 500 });
  // Mọi hình dạng câu, đông nhất trước — thông điệp lỗi phải chỉ thẳng câu nào nhân lên.
  const shapes = [...stats.slowest].sort((a, b) => b.count - a.count).map((s) => `${s.count}× ${s.sql.slice(0, 140)}`);
  return { value, queries: stats.queries, shapes: shapes.join("\n    ") };
}

export async function testPageQueryBudget() {
  await cleanupOrg(ORG);
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  // Client của tổ chức được bọc bộ đếm LÚC MỞ (db/index.ts `instrumentQueries`) — bật cờ quanh đúng lượt cấp tổ chức
  // rồi trả lại như cũ: tổ chức của bài khác mở sau đó không mang lớp bọc.
  const before = process.env.ERP_PERF_PROBE;
  process.env.ERP_PERF_PROBE = "1";
  try {
    await provisionOrganization({ code: ORG, name: "Ngân sách truy vấn", modules: ["customers", "apps"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "QueryBudget@12345" }, source: "TEST", actor: null });
  } finally {
    if (before === undefined) delete process.env.ERP_PERF_PROBE;
    else process.env.ERP_PERF_PROBE = before;
  }
  clearMemo();
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u, "quản trị của tổ chức thử");
      const qt: SessionUser = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false } };
      const actor: MetadataActor = { id: qt.id, email: qt.email };

      // Bộ đếm phải THẬT SỰ bắt được câu của tổ chức này — không thì mọi so sánh bên dưới là 0 = 0.
      const sanity = await probe("sanity", async () => (await getDb()).select({ id: schema.users.id }).from(schema.users).limit(1));
      assert.equal(sanity.stats.queries, 1, "bộ đếm câu truy vấn bắt được câu của CSDL tổ chức thử");

      for (const [key, label] of [
        ["x_contract", "Hợp đồng"],
        ["x_other", "Việc"],
      ] as const) {
        const r = await createObject(qt, { key, label, labelPlural: label, icon: "file-text" });
        assert.ok(r.ok, msg(r));
      }
      const field = async (objectKey: string, input: Record<string, unknown>) => {
        const r = await createCustomField(objectKey, input, actor);
        assert.ok(r.ok, `${objectKey}.${String(input.key)}: ${msg(r)}`);
      };
      await field("customer", { key: "hang", label: "Hạng", type: "select", filterable: true, options: [{ value: "vang", label: "Vàng" }, { value: "bac", label: "Bạc" }] });
      await field("customer", { key: "cham_soc", label: "Người chăm", type: "user" });
      await field("x_contract", { key: "gia_tri", label: "Giá trị", type: "currency", filterable: true });
      await field("x_contract", { key: "trang_thai", label: "Trạng thái", type: "status", filterable: true, options: [{ value: "nhap", label: "Nháp" }, { value: "hieu_luc", label: "Hiệu lực" }], transitions: { nhap: ["hieu_luc"] } });
      await field("x_contract", { key: "khach", label: "Khách", type: "relation", relationObject: "customer", filterable: true });
      await field("x_contract", { key: "nguoi", label: "Người bán", type: "user", filterable: true });
      await field("x_contract", { key: "viec", label: "Việc", type: "relation", relationObject: "x_other" });
      await field("x_contract", { key: "lien_quan", label: "Việc liên quan", type: "relation_many", relationObject: "x_other" });
      await field("x_contract", { key: "ngay", label: "Ngày ký", type: "date", filterable: true });
      await field("x_other", { key: "hop_dong", label: "Hợp đồng", type: "relation", relationObject: "x_contract" });
      await field("x_other", { key: "khach", label: "Khách", type: "relation", relationObject: "customer" });

      // Bản ghi TRUNG TÂM tạo qua dịch vụ thật (có dòng thời gian): mọi việc trỏ về nó (liên kết ngược), nó trỏ tới
      // nhiều việc (nhiều-quan hệ). Số dòng ở hai chiều ấy lớn lên cùng N.
      const hub = await createRecord("x_contract", { system: { title: "HĐ trung tâm" }, custom: { gia_tri: 1, trang_thai: "nhap" } }, qt);
      assert.ok(hub.ok, msg(hub));
      const hubId = hub.id;

      // Người dùng để field `user` có N giá trị khác nhau (tên in theo khoá tài khoản, một câu cho cả lô).
      let seeded = 0;
      const grow = async (n: number) => {
        const idx = Array.from({ length: n - seeded }, (_, i) => seeded + i);
        if (!idx.length) return;
        await db.insert(schema.users).values(idx.map((i) => ({ id: `pqb-u${i}`, email: `u${i}@${ORG}.local`, name: `NV ${i}`, passwordHash: "x", role: "VIEWER" as const, active: true })));
        await db.insert(schema.customers).values(idx.map((i) => ({ id: `pqb-cus${i}`, name: `Khách ${String(i).padStart(3, "0")}` })));
        await db.insert(schema.customValues).values(idx.map((i) => ({ objectKey: "customer", recordId: `pqb-cus${i}`, values: { hang: i % 2 ? "vang" : "bac", cham_soc: `pqb-u${i}` } })));
        await db.insert(schema.customRecords).values(idx.map((i) => ({ id: `pqb-o${i}`, objectKey: "x_other", title: `Việc ${i}`, ownerId: `pqb-u${i}` })));
        await db.insert(schema.customValues).values(idx.map((i) => ({ objectKey: "x_other", recordId: `pqb-o${i}`, values: { hop_dong: hubId, khach: "pqb-cus0" } })));
        await db.insert(schema.customRecords).values(idx.map((i) => ({ id: `pqb-c${i}`, objectKey: "x_contract", title: `HĐ ${String(i).padStart(3, "0")}`, ownerId: `pqb-u${i}` })));
        await db.insert(schema.customValues).values(
          idx.map((i) => ({
            objectKey: "x_contract",
            recordId: `pqb-c${i}`,
            values: { gia_tri: 1_000_000 + i, trang_thai: i % 3 ? "nhap" : "hieu_luc", khach: `pqb-cus${i}`, nguoi: `pqb-u${i}`, viec: `pqb-o${i}`, lien_quan: [`pqb-o${i}`], ngay: `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, "0")}` },
          })),
        );
        seeded = n;
        const many = Array.from({ length: Math.min(n, MANY_CAP) }, (_, i) => `pqb-o${i}`);
        await db
          .update(schema.customValues)
          .set({ values: { gia_tri: 1, trang_thai: "nhap", lien_quan: many } })
          .where(and(eq(schema.customValues.objectKey, "x_contract"), eq(schema.customValues.recordId, hubId)));
      };

      /** Đúng hàm trang /o/<khoá>/<id> gọi (app/(dashboard)/o/[object]/[id]/page.tsx → loadRecordDetailPage). */
      const detail = async (objectKey: string, id: string) => {
        const r = await loadRecordDetailPage(objectKey, id, qt);
        assert.ok(r.ok, msg(r));
        return r.data;
      };

      const scenarios: { name: string; run: () => Promise<number> }[] = [
        {
          name: "bảng hệ thống (khách + field bổ sung)",
          run: async () => okData<TableData>(blocksOf(await resolvePage(single(BLOCKS.customers), qt, ctx, "pqb")), "kh_bang").rows.length,
        },
        {
          name: "bảng x_contract (quan hệ · nhiều-quan hệ · người · trạng thái)",
          run: async () => okData<TableData>(blocksOf(await resolvePage(single(BLOCKS.contracts), qt, ctx, "pqb")), "hd_bang").rows.length,
        },
        {
          name: "kanban x_contract (tới 200 thẻ)",
          run: async () => okData<KanbanData>(blocksOf(await resolvePage(single(BLOCKS.kanban), qt, ctx, "pqb")), "hd_kanban").columns.reduce((n, c) => n + c.cards.length, 0),
        },
        {
          name: "KPI tổng hợp (cộng + đếm)",
          run: async () => {
            const m = blocksOf(await resolvePage({ version: 1, sections: [{ key: "k", blocks: [BLOCKS.kpiSum, BLOCKS.kpiCount] }] }, qt, ctx, "pqb"));
            return Number(okData<{ value: number }>(m, "hd_dem").value);
          },
        },
        {
          name: "biểu đồ nhóm (trạng thái · người) + theo ngày",
          run: async () => {
            const m = blocksOf(await resolvePage({ version: 1, sections: [{ key: "c", blocks: [BLOCKS.groupChart, BLOCKS.ownerChart, BLOCKS.dayChart] }] }, qt, ctx, "pqb"));
            return okData<{ points: unknown[] }>(m, "hd_nguoi").points.length;
          },
        },
        {
          name: "cả trang (thanh lọc + 8 khối)",
          run: async () => okData<TableData>(blocksOf(await resolvePage(FULL_PAGE, qt, ctx, "pqb")), "hd_bang").rows.length,
        },
        {
          name: "danh sách /o/x_contract (trang 200 dòng)",
          run: async () => {
            const r = await listRecords("x_contract", parseListParams({ pageSize: "200" }, { maxPageSize: 200 }), qt);
            assert.ok(r.ok, msg(r));
            return r.rows.length;
          },
        },
        {
          name: "chi tiết /o/x_contract/<trung tâm> (quan hệ đi + liên kết ngược + dòng thời gian)",
          run: async () => {
            const d = await detail("x_contract", hubId);
            assert.ok(d.timeline.length >= 1, "dòng thời gian của bản ghi trung tâm có mốc tạo");
            return Object.keys(d.detail.relationLabels.lien_quan ?? {}).length + d.reverse.reduce((n, g) => n + g.records.length, 0);
          },
        },
        {
          name: "liên kết ngược trên trang khách (mọi việc trỏ về một khách)",
          run: async () => (await reverseRelations("customer", "pqb-cus0", qt)).reduce((n, g) => n + g.records.length, 0),
        },
        {
          name: "getCustomValues nhiều bản ghi",
          run: async () => {
            const ids = [...Array.from({ length: seeded }, (_, i) => `pqb-c${i}`)];
            return (await getCustomValues("x_contract", ids, qt)).size;
          },
        },
      ];

      const measure = async () => {
        const out = new Map<string, { value: number } & Count>();
        for (const s of scenarios) out.set(s.name, await count(s.name, s.run));
        return out;
      };

      await grow(SMALL);
      const small = await measure();
      await grow(LARGE);
      const large = await measure();

      const lines: string[] = [];
      for (const s of scenarios) {
        const a = small.get(s.name)!;
        const b = large.get(s.name)!;
        lines.push(`${s.name}: ${a.queries} câu @${a.value} dòng · ${b.queries} câu @${b.value} dòng`);
        assert.equal(b.queries, a.queries, `${s.name}: số câu TĂNG theo số dòng (${a.queries} → ${b.queries}) — N+1.\n  10 dòng:\n    ${a.shapes}\n  200 dòng:\n    ${b.shapes}`);
      }
      // Bài chỉ có nghĩa khi số dòng HIỆN RA thật sự lớn lên (không thì 10 = 10 chẳng chứng minh gì).
      const grew = (name: string, min: number) => assert.ok(large.get(name)!.value >= min && small.get(name)!.value < min, `${name}: dòng hiện ra phải lớn lên (${small.get(name)!.value} → ${large.get(name)!.value})`);
      grew("bảng hệ thống (khách + field bổ sung)", 100);
      grew("bảng x_contract (quan hệ · nhiều-quan hệ · người · trạng thái)", 100);
      grew("kanban x_contract (tới 200 thẻ)", 200);
      grew("danh sách /o/x_contract (trang 200 dòng)", 200);
      grew("getCustomValues nhiều bản ghi", 200);
      grew("liên kết ngược trên trang khách (mọi việc trỏ về một khách)", 50);
      grew("chi tiết /o/x_contract/<trung tâm> (quan hệ đi + liên kết ngược + dòng thời gian)", MANY_CAP + 50);
      assert.equal(large.get("KPI tổng hợp (cộng + đếm)")!.value, LARGE + 1, "KPI đếm đủ 200 hợp đồng gieo + bản ghi trung tâm");
      // N+1 theo SỐ KHỐI (không theo số dòng): trước H2 mỗi khối tự đọc lại `meta_objects` / `meta_custom_fields` của CÙNG
      // đối tượng — cả trang 59 câu, chi tiết /o 28 câu. Một lượt dựng nay là MỘT phạm vi đọc metadata
      // (lib/metadata/read-scope.ts): 32 và 21. Trần tuyệt đối để ai gỡ phạm vi ấy thì bài này đỏ.
      const cap = (name: string, max: number) => {
        const got = large.get(name)!;
        assert.ok(got.queries <= max, `${name}: ${got.queries} câu — vượt trần ${max} (metadata đọc lại theo từng khối?)\n    ${got.shapes}`);
      };
      cap("cả trang (thanh lọc + 8 khối)", 36);
      cap("chi tiết /o/x_contract/<trung tâm> (quan hệ đi + liên kết ngược + dòng thời gian)", 23);
      console.log(`✓ Ngân sách truy vấn trang động: số câu KHÔNG tăng theo số dòng (10 → 200) ở ${scenarios.length} kịch bản\n    ${lines.join("\n    ")}`);
    });
  } finally {
    clearMemo();
    await cleanupOrg(ORG);
    rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
}
