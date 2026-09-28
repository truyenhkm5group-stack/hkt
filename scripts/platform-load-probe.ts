/**
 * ═══════════ ĐO TẢI NỀN TẢNG TRANG ĐỘNG (Phase 11 · H2) — CHẠY TAY, KHÔNG NẰM TRONG `npm test` ═══════════
 *
 * Chạy:
 *   npx tsx --tsconfig tsconfig.json scripts/platform-load-probe.ts [--records=20000] [--peer-records=5000]
 *        [--orders=5000] [--rounds=15] [--index=none|all|gin|sort|created] [--shapes] [--keep]
 *   Postgres thật (CHỈ máy thử, cần quyền CREATEDB): DATABASE_URL=postgres://… … --postgres
 *
 * Dựng năm tổ chức THẬT (`lprobe-1` … `lprobe-5`, `provisionOrganization`, mỗi tổ chức một CSDL): tổ chức 1 gieo
 * `--records` hợp đồng `x_contract` (tiền · trạng thái · quan hệ tới khách · người · ngày) + 5.000 bản ghi của một
 * đối tượng khác CÙNG bảng `custom_records` (để khoá đối tượng phải lọc thật) + `--orders` đơn + 2.000 khách; bốn tổ
 * chức còn lại gieo `--peer-records`. Rồi đo p50 / p95 và SỐ CÂU của: `resolvePage` trang 20 khối, `listRecords`
 * trang 1 / trang 100, bộ lọc jsonb (bằng trạng thái · lớn hơn trên tiền), tổng hợp nhóm theo ngày, kanban 200 thẻ,
 * KPI tổng hợp, và 5 tổ chức × dựng trang SONG SONG.
 *
 * `--index=…`: `gin` dựng thử index ứng viên trên tổ chức 1, đo, rồi GỠ; `sort` / `created` là hai index ĐÃ vào
 * migration 0171 — gỡ tạm, đo, dựng lại. Probe không để lại trạng thái nào. Index chỉ vào `db/schema.ts` khi con số
 * ở đây nói nó cần (docs/platform/phase-11-12-plan.md §H2).
 *
 * GIỚI HẠN TRUNG THỰC (memory `do-hieu-nang-erp-hai-cai-bay`):
 *  · PGlite là Postgres biên dịch sang WASM, MỘT luồng, chạy chung luồng Node với mọi tổ chức khác ⇒ "5 tổ chức song
 *    song" trên PGlite là XẾP HÀNG, không song song. Con số tuyệt đối không phải VPS; so sánh được là SỐ CÂU, tỷ lệ
 *    giữa các kịch bản, và TRƯỚC / SAU index trên cùng máy.
 *  · Mỗi lượt đo xoá `memo` trước (đo đường LẠNH — KPI / biểu đồ tổng hợp có đệm 60 giây trên đường thật).
 *  · PGlite từng trả MẢNG RỖNG cho mọi câu ở quy mô lớn (scripts/bench/ads.ts) ⇒ đếm lại số dòng TRƯỚC khi đo; sai thì
 *    dừng, không in con số đẹp của những câu không trả về gì.
 *  · Cột "câu" đếm CẢ câu vào CSDL nhà (sổ module, đệm 5 giây) — lệch ±1 giữa hai lượt là đệm ấy hết hạn, không phải
 *    N+1. Bài kiểm `tests/page-query-budget.test.ts` chỉ đếm CSDL tổ chức nên không có độ lệch đó.
 *  · Bể kết nối KHÔNG chỉnh ở đây: nhà `PGPOOL_MAX` = 5, tổ chức `PGPOOL_MAX_ORG` = 2 — quyết định đã đo (db/index.ts).
 */
import { rmSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const flag = (name: string) => args.includes(`--${name}`);

const RECORDS = Math.max(100, Number(arg("records", "20000")) || 20000);
const PEER_RECORDS = Math.max(100, Number(arg("peer-records", "5000")) || 5000);
const ORDERS = Math.max(0, Number(arg("orders", "5000")) || 0);
const CUSTOMERS = 2000;
const OTHER_RECORDS = 5000;
const USERS = 20;
const ROUNDS = Math.max(3, Number(arg("rounds", "15")) || 15);
const WARMUP = 2;
const INDEX = arg("index", "none");
const ORGS = ["lprobe-1", "lprobe-2", "lprobe-3", "lprobe-4", "lprobe-5"];
const usePostgres = flag("postgres");

// ── CSDL: PGlite riêng của lượt đo, trừ khi người chạy CHỦ ĐỘNG chọn Postgres (không đọc .env — một .env trỏ
//    production không được biến lượt đo thành năm CSDL mới trên production).
const dataDir = path.join("data", `pglite-loadprobe-${process.pid}`);
if (usePostgres) {
  if (!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "")) {
    console.error("--postgres cần DATABASE_URL=postgres://… (máy thử có quyền CREATEDB).");
    process.exit(2);
  }
} else {
  rmSync(dataDir, { recursive: true, force: true });
  process.env.DATABASE_URL = `pglite://${dataDir}`;
}
process.env.ERP_PERF_PROBE = "1";
delete process.env.ERP_READ_ONLY;

type Stat = { name: string; p50: number; p95: number; min: number; queries: number; rows: string };

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

async function main() {
  const { getDb, getPlatformDb, organizationDatabaseName, organizationDatabaseUrl, schema } = await import("@/db");
  const { ensureMigrated } = await import("@/db/migrate");
  const { and, count, eq, sql } = await import("drizzle-orm");
  const { clearMemo } = await import("@/lib/cache");
  const { createCustomField } = await import("@/lib/metadata/fields");
  const { createObject } = await import("@/lib/objects/objects");
  const { listRecords } = await import("@/lib/objects/records");
  const { resolvePage } = await import("@/lib/pages/data-sources");
  const { probe } = await import("@/lib/perf/probe");
  const { invalidateCapabilities } = await import("@/lib/platform/capabilities");
  const { withOrganization } = await import("@/lib/platform/context");
  const { invalidateOrganizations } = await import("@/lib/platform/organizations");
  const { provisionOrganization } = await import("@/lib/platform/provision");
  const { parseListParams } = await import("@/lib/search-params");
  type SessionUser = import("@/lib/auth/session").SessionUser;
  type PageBlock = import("@/lib/pages/types").PageBlock;
  type PageSchema = import("@/lib/pages/types").PageSchema;
  type ResolvedPage = Awaited<ReturnType<typeof resolvePage>>;

  await ensureMigrated();
  const pdb = await getPlatformDb();

  const cleanup = async (code: string, dropDatabase: boolean) => {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    if (usePostgres) {
      // Chỉ CSDL mang tiền tố của chính probe (`…_org_lprobe_N`), và chỉ trước khi tiến trình này mở nó.
      if (dropDatabase) await pdb.execute(sql.raw(`drop database if exists "${organizationDatabaseName(code)}" with (force)`));
    } else rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    invalidateOrganizations();
    invalidateCapabilities();
  };

  type BlockOf<T extends PageBlock["type"]> = import("@/lib/pages/types").PageBlock<T>;
  const b = <T extends PageBlock["type"]>(id: string, type: T, config: BlockOf<T>["config"], span: PageBlock["span"] = 12): PageBlock => ({ id, type, span, config }) as unknown as PageBlock;
  const contractCols = ["system:title", "system:owner", "custom:gia_tri", "custom:trang_thai", "custom:khach", "custom:nguoi", "custom:ngay", "custom:khu_vuc"] as const;
  const BLOCKS = {
    filter: b("loc", "filter", { fields: [{ objectKey: "x_contract", ref: "custom:trang_thai", op: "eq", label: "Trạng thái" }], targets: ["hd_bang", "hd_kanban"] }),
    kpiSum: b("k_tong", "kpi", { aggregate: { objectKey: "x_contract", fn: "sum", field: "custom:gia_tri" }, label: "Tổng giá trị" }, 3),
    kpiCount: b("k_dem", "kpi", { aggregate: { objectKey: "x_contract", fn: "count" } }, 3),
    kpiAvg: b("k_tb", "kpi", { aggregate: { objectKey: "x_contract", fn: "avg", field: "custom:gia_tri" } }, 3),
    kpiFiltered: b("k_hl", "kpi", { aggregate: { objectKey: "x_contract", fn: "count", filters: [{ ref: "custom:trang_thai", op: "eq", value: "hieu_luc" }] }, label: "Đang hiệu lực" }, 3),
    kpiPeriod: b("k_nam", "kpi", { aggregate: { objectKey: "x_contract", fn: "sum", field: "custom:gia_tri" }, dateField: "custom:ngay", period: "year", label: "Giá trị ký trong năm" }, 3),
    kpiCustomers: b("k_khach", "kpi", { aggregate: { objectKey: "customer", fn: "count" } }, 3),
    kpiOrders: b("k_don", "kpi", { aggregate: { objectKey: "order", fn: "count" } }, 3),
    groupStatus: b("c_tt", "chart", { aggregate: { objectKey: "x_contract", fn: "count" }, kind: "bar", groupBy: { ref: "custom:trang_thai" } }, 4),
    groupUser: b("c_nguoi", "chart", { aggregate: { objectKey: "x_contract", fn: "sum", field: "custom:gia_tri" }, kind: "bar", groupBy: { ref: "custom:nguoi" } }, 4),
    groupRegion: b("c_vung", "chart", { aggregate: { objectKey: "x_contract", fn: "count" }, kind: "pie", groupBy: { ref: "custom:khu_vuc" } }, 4),
    byDay: b("c_ngay", "chart", { aggregate: { objectKey: "x_contract", fn: "sum", field: "custom:gia_tri" }, kind: "line", groupBy: { bucket: "day", dateField: "custom:ngay" } }, 12),
    byMonth: b("c_thang", "chart", { aggregate: { objectKey: "x_contract", fn: "count" }, kind: "bar", groupBy: { bucket: "month", dateField: "custom:ngay" } }, 6),
    orderStage: b("c_don", "chart", { aggregate: { objectKey: "order", fn: "count" }, kind: "bar", groupBy: { ref: "system:stage" } }, 6),
    contracts: b("hd_bang", "table", { source: "x_contract", columns: [...contractCols], pageSize: 50, rowLink: true, rowActions: [{ action: "open_record", label: "Mở" }] }),
    customers: b("kh_bang", "table", { source: "customer", pageSize: 25, rowLink: true }),
    orders: b("don_bang", "table", { source: "order", pageSize: 25, rowLink: true }),
    kanban: b("hd_kanban", "kanban", { objectKey: "x_contract", statusField: "custom:trang_thai", cardFields: ["system:owner", "custom:gia_tri", "custom:khach"], allowMove: true, limit: 200 }),
    text: b("chu", "text", { heading: "Bàn hợp đồng", body: "Trang đo tải." }),
    bigDeals: b("hd_lon", "table", { source: "x_contract", columns: ["system:title", "custom:gia_tri", "custom:khach"], filters: [{ ref: "custom:gia_tri", op: "gte", value: 90_000_000 }], pageSize: 25 }),
  };
  const PAGE: PageSchema = {
    version: 1,
    sections: [
      { key: "loc", variant: "plain", blocks: [BLOCKS.filter] },
      { key: "kpi", blocks: [BLOCKS.kpiSum, BLOCKS.kpiCount, BLOCKS.kpiAvg, BLOCKS.kpiFiltered, BLOCKS.kpiPeriod, BLOCKS.kpiCustomers, BLOCKS.kpiOrders] },
      { key: "bieu-do", blocks: [BLOCKS.groupStatus, BLOCKS.groupUser, BLOCKS.groupRegion, BLOCKS.byDay, BLOCKS.byMonth, BLOCKS.orderStage] },
      { key: "bang", blocks: [BLOCKS.contracts, BLOCKS.customers, BLOCKS.orders, BLOCKS.kanban, BLOCKS.text, BLOCKS.bigDeals] },
    ],
  };
  const single = (blk: PageBlock): PageSchema => ({ version: 1, sections: [{ key: "s", blocks: [blk] }] });
  const ctx = { searchParams: {}, period: "all" as const };
  const failures = (p: ResolvedPage) => p.sections.flatMap((s) => s.blocks).filter((x) => !x.ok);

  // ─── Gieo ───
  const admins = new Map<string, SessionUser>();
  const seed = async (code: string, records: number, orders: number) => {
    const t0 = performance.now();
    await provisionOrganization({ code, name: `Đo tải ${code}`, modules: ["customers", "products", "orders", "apps"], admin: { email: `admin@${code}.local`, name: "QT", password: "LoadProbe@12345" }, source: "TEST", actor: null });
    await withOrganization(code, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${code}.local`) });
      if (!u) throw new Error(`Không có quản trị của ${code}`);
      const qt: SessionUser = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: code, isHome: false } };
      admins.set(code, qt);
      const actor = { id: qt.id, email: qt.email };
      for (const [key, label] of [
        ["x_contract", "Hợp đồng"],
        ["x_task", "Công việc"],
      ] as const) {
        const r = await createObject(qt, { key, label, labelPlural: label, icon: "file-text" });
        if (!r.ok) throw new Error(`${code} ${key}: ${JSON.stringify(r)}`);
      }
      const fields: [string, Record<string, unknown>][] = [
        ["x_contract", { key: "gia_tri", label: "Giá trị", type: "currency", filterable: true }],
        ["x_contract", { key: "trang_thai", label: "Trạng thái", type: "status", filterable: true, options: ["nhap", "cho_duyet", "hieu_luc", "het_han"].map((v) => ({ value: v, label: v })), transitions: {} }],
        ["x_contract", { key: "khach", label: "Khách", type: "relation", relationObject: "customer", filterable: true }],
        ["x_contract", { key: "nguoi", label: "Người bán", type: "user", filterable: true }],
        ["x_contract", { key: "ngay", label: "Ngày ký", type: "date", filterable: true }],
        ["x_contract", { key: "khu_vuc", label: "Khu vực", type: "select", filterable: true, options: ["bac", "trung", "nam"].map((v) => ({ value: v, label: v })) }],
        ["x_task", { key: "gia_tri", label: "Giá trị", type: "currency" }],
      ];
      for (const [objectKey, input] of fields) {
        const r = await createCustomField(objectKey, input, actor);
        if (!r.ok) throw new Error(`${code} ${objectKey}.${String(input.key)}: ${JSON.stringify(r)}`);
      }
      const chunk = async <T>(rows: T[], insert: (part: T[]) => Promise<unknown>) => {
        for (let i = 0; i < rows.length; i += 1000) await insert(rows.slice(i, i + 1000));
      };
      const range = (n: number) => Array.from({ length: n }, (_, i) => i);
      const userIds = range(USERS).map((i) => `lp-u${i}`);
      await db.insert(schema.users).values(userIds.map((id, i) => ({ id, email: `u${i}@${code}.local`, name: `NV ${i}`, passwordHash: "x", role: "VIEWER" as const, active: true })));
      await chunk(range(CUSTOMERS), (p) => db.insert(schema.customers).values(p.map((i) => ({ id: `lp-cus${i}`, name: `Khách ${i}` }))));
      const day0 = Date.UTC(2025, 9, 1);
      const dayKey = (i: number) => new Date(day0 + ((i * 7919) % 365) * 86_400_000).toISOString().slice(0, 10);
      const statuses = ["nhap", "cho_duyet", "hieu_luc", "het_han"];
      await chunk(range(records), (p) => db.insert(schema.customRecords).values(p.map((i) => ({ id: `lp-c${i}`, objectKey: "x_contract", title: `HĐ ${i}`, ownerId: userIds[i % USERS], createdAt: new Date(day0 + i * 60_000), updatedAt: new Date(day0 + i * 60_000) }))));
      await chunk(range(records), (p) =>
        db.insert(schema.customValues).values(
          p.map((i) => ({
            objectKey: "x_contract",
            recordId: `lp-c${i}`,
            values: { gia_tri: ((i * 104_729) % 100) * 1_000_000, trang_thai: statuses[i % 4], khach: `lp-cus${i % CUSTOMERS}`, nguoi: userIds[(i * 7) % USERS], ngay: dayKey(i), khu_vuc: ["bac", "trung", "nam"][i % 3] },
          })),
        ),
      );
      await chunk(range(OTHER_RECORDS), (p) => db.insert(schema.customRecords).values(p.map((i) => ({ id: `lp-t${i}`, objectKey: "x_task", title: `Việc ${i}`, ownerId: userIds[i % USERS] }))));
      await chunk(range(OTHER_RECORDS), (p) => db.insert(schema.customValues).values(p.map((i) => ({ objectKey: "x_task", recordId: `lp-t${i}`, values: { gia_tri: i } }))));
      const stages = ["NEW", "WAITING", "CONFIRMED"] as const;
      await chunk(range(orders), (p) =>
        db.insert(schema.orders).values(p.map((i) => ({ id: `lp-o${i}`, stage: stages[i % 3], customerId: `lp-cus${i % CUSTOMERS}`, billFullName: `Khách ${i % CUSTOMERS}`, totalPriceAfterDiscount: 100_000 + (i % 50) * 10_000, insertedAt: new Date(day0 + i * 3_600_000) }))),
      );
      // Thống kê cho bộ lập kế hoạch (Postgres thật có autovacuum; PGlite thì không) — hai phía đo cùng điều kiện.
      await db.execute(sql`analyze`);
      // Canh: dữ liệu ĐỌC ĐƯỢC (xem đầu tệp).
      const [c] = await db.select({ n: count() }).from(schema.customRecords).where(and(eq(schema.customRecords.objectKey, "x_contract")));
      const [o] = await db.select({ n: count() }).from(schema.orders);
      if (Number(c?.n) !== records || Number(o?.n) !== orders) throw new Error(`${code}: đọc lại ${String(c?.n)} hợp đồng / ${String(o?.n)} đơn — kỳ vọng ${records} / ${orders}. Dừng: đo trên dữ liệu không đọc được là in số giả.`);
    });
    console.log(`  gieo ${code}: ${records.toLocaleString("vi-VN")} hợp đồng + ${OTHER_RECORDS.toLocaleString("vi-VN")} việc + ${orders.toLocaleString("vi-VN")} đơn + ${CUSTOMERS.toLocaleString("vi-VN")} khách — ${Math.round(performance.now() - t0)} ms`);
  };

  // ─── Đo ───
  const measure = async (code: string, name: string, run: () => Promise<string>): Promise<Stat> =>
    withOrganization(code, async () => {
      const times: number[] = [];
      let queries = 0;
      let rows = "";
      for (let i = 0; i < WARMUP + ROUNDS; i += 1) {
        clearMemo();
        const t = performance.now();
        const { value, stats } = await probe(name, run);
        const ms = performance.now() - t;
        if (i >= WARMUP) times.push(ms);
        queries = stats.queries;
        rows = value;
      }
      return { name, p50: round1(quantile(times, 0.5)), p95: round1(quantile(times, 0.95)), min: round1(Math.min(...times)), queries, rows };
    });

  const MAIN = ORGS[0];
  const pageRun = (code: string, schemaIn: PageSchema) => async () => {
    const page = await resolvePage(schemaIn, admins.get(code)!, ctx, "load-probe");
    const bad = failures(page);
    if (bad.length) throw new Error(`${code}: khối hỏng ${JSON.stringify(bad.map((x) => (x.ok ? "" : `${x.block.id}:${x.issue.code}:${x.issue.message}`)))}`);
    const blocks = page.sections.flatMap((s) => s.blocks);
    return `${blocks.length} khối`;
  };
  const blockRun = (blk: PageBlock, describe: (data: unknown) => string) => async () => {
    const page = await resolvePage(single(blk), admins.get(MAIN)!, ctx, "load-probe");
    const r = page.sections[0].blocks[0];
    if (!r.ok) throw new Error(`${blk.id}: ${r.issue.code} — ${r.issue.message}`);
    return describe(r.data);
  };
  const listRun = (params: Record<string, string>, extra: { fieldEq?: Record<string, string> } = {}) => async () => {
    const r = await listRecords("x_contract", parseListParams(params, { maxPageSize: 200 }), admins.get(MAIN)!, extra);
    if (!r.ok) throw new Error(`listRecords: ${JSON.stringify(r)}`);
    return `${r.rows.length}/${r.total.toLocaleString("vi-VN")}`;
  };

  const SCENARIOS: Record<string, { tag: string[]; run: () => Promise<string> }> = {
    "resolvePage · trang 20 khối": { tag: ["page"], run: pageRun(MAIN, PAGE) },
    "listRecords · trang 1 (50 dòng)": { tag: ["sort"], run: listRun({ pageSize: "50", page: "1" }) },
    "listRecords · trang 100 (50 dòng)": { tag: ["sort"], run: listRun({ pageSize: "50", page: "100" }) },
    "listRecords · lọc jsonb trạng thái = hieu_luc": { tag: ["gin", "sort"], run: listRun({ pageSize: "50" }, { fieldEq: { trang_thai: "hieu_luc" } }) },
    "listRecords · lọc jsonb khách = một khách (chọn lọc)": { tag: ["gin"], run: listRun({ pageSize: "50" }, { fieldEq: { khach: "lp-cus7" } }) },
    "bảng · lọc jsonb giá trị ≥ 90 triệu": { tag: ["gin"], run: blockRun(BLOCKS.bigDeals, (d) => `${(d as { rows: unknown[]; total: number }).rows.length}/${(d as { total: number }).total}`) },
    "KPI · đếm trạng thái = hieu_luc": { tag: ["gin"], run: blockRun(BLOCKS.kpiFiltered, (d) => String((d as { value: number }).value)) },
    "biểu đồ · tổng theo ngày": { tag: [], run: blockRun(BLOCKS.byDay, (d) => `${(d as { points: unknown[] }).points.length} mốc`) },
    "biểu đồ · nhóm theo người": { tag: [], run: blockRun(BLOCKS.groupUser, (d) => `${(d as { points: unknown[] }).points.length} nhóm`) },
    "KPI · tổng giá trị": { tag: [], run: blockRun(BLOCKS.kpiSum, (d) => String((d as { value: number }).value)) },
    "bảng x_contract · trang 1 (50 dòng, xếp theo ngày tạo)": { tag: ["created"], run: blockRun(BLOCKS.contracts, (d) => `${(d as { rows: unknown[]; total: number }).rows.length}/${(d as { total: number }).total}`) },
    "kanban · 200 thẻ": { tag: ["created"], run: blockRun(BLOCKS.kanban, (d) => `${(d as { columns: { cards: unknown[] }[] }).columns.reduce((n, c) => n + c.cards.length, 0)} thẻ`) },
  };

  // ─── Index: `trial` = dựng thử, đo, gỡ · `adopted` = index ĐÃ vào migration (0171) — GỠ thử, đo, dựng lại. Cả hai
  //     chiều chỉ chạm tổ chức 1 và trả nó về đúng trạng thái migration để lại.
  const CANDIDATES: Record<string, { tag: string; kind: "trial" | "adopted"; create: string; drop: string }> = {
    gin: { tag: "gin", kind: "trial", create: "create index if not exists custom_values_values_gin on custom_values using gin (values jsonb_path_ops)", drop: "drop index if exists custom_values_values_gin" },
    sort: {
      tag: "sort",
      kind: "adopted",
      create: `create index if not exists "custom_records_live_updated_idx" on "custom_records" ("object_key", "updated_at" desc nulls last, "id") where "deleted_at" is null`,
      drop: `drop index if exists "custom_records_live_updated_idx"`,
    },
    created: {
      tag: "created",
      kind: "adopted",
      create: `create index if not exists "custom_records_live_created_idx" on "custom_records" ("object_key", "created_at" desc nulls last, "id" desc) where "deleted_at" is null`,
      drop: `drop index if exists "custom_records_live_created_idx"`,
    },
  };

  const print = (title: string, list: Stat[]) => {
    console.log(`\n${title}`);
    console.log(`  ${"kịch bản".padEnd(48)} ${"p50 ms".padStart(9)} ${"p95 ms".padStart(9)} ${"min ms".padStart(9)} ${"câu".padStart(5)}  dòng`);
    for (const s of list) console.log(`  ${s.name.padEnd(48)} ${String(s.p50).padStart(9)} ${String(s.p95).padStart(9)} ${String(s.min).padStart(9)} ${String(s.queries).padStart(5)}  ${s.rows}`);
  };

  const keep = flag("keep");
  console.log(`Đo tải trang động — ${usePostgres ? "Postgres" : "PGlite"} · ${ROUNDS} lượt đo + ${WARMUP} lượt làm nóng mỗi kịch bản · memo xoá trước từng lượt`);
  for (const code of ORGS) await cleanup(code, true);
  try {
    for (const code of ORGS) await seed(code, code === MAIN ? RECORDS : PEER_RECORDS, code === MAIN ? ORDERS : Math.min(ORDERS, 1000));

    const base: Stat[] = [];
    for (const [name, s] of Object.entries(SCENARIOS)) base.push(await measure(MAIN, name, s.run));
    print(`TỔ CHỨC ${MAIN} (${RECORDS.toLocaleString("vi-VN")} hợp đồng)`, base);
    if (flag("shapes")) {
      // Mọi hình dạng câu của MỘT lượt dựng trang 20 khối — để thấy câu nào lặp theo số khối.
      const shapes = await withOrganization(MAIN, async () => {
        clearMemo();
        return (await probe("shapes", SCENARIOS["resolvePage · trang 20 khối"].run, { top: 500 })).stats.slowest;
      });
      console.log(`
HÌNH DẠNG CÂU — resolvePage 20 khối (${shapes.reduce((n, x) => n + x.count, 0)} câu, ${shapes.length} hình dạng)`);
      for (const x of [...shapes].sort((a, c) => c.count - a.count)) console.log(`  ${String(x.count).padStart(3)}× ${String(x.ms).padStart(8)} ms  ${x.sql.slice(0, 200)}`);
    }

    // 5 tổ chức × dựng trang SONG SONG: đo thời gian TƯỜNG của cả lượt (khối chậm nhất của tổ chức chậm nhất).
    const walls: number[] = [];
    const perOrg = new Map<string, number[]>();
    for (let i = 0; i < WARMUP + ROUNDS; i += 1) {
      clearMemo();
      const t = performance.now();
      const each = await Promise.all(
        ORGS.map((code) =>
          withOrganization(code, async () => {
            const s = performance.now();
            await pageRun(code, PAGE)();
            return performance.now() - s;
          }),
        ),
      );
      if (i >= WARMUP) {
        walls.push(performance.now() - t);
        ORGS.forEach((code, k) => perOrg.set(code, [...(perOrg.get(code) ?? []), each[k]]));
      }
    }
    print("5 TỔ CHỨC × resolvePage 20 khối SONG SONG", [
      { name: "thời gian tường cả lượt", p50: round1(quantile(walls, 0.5)), p95: round1(quantile(walls, 0.95)), min: round1(Math.min(...walls)), queries: 0, rows: `${ORGS.length} tổ chức` },
      ...ORGS.map((code) => {
        const t = perOrg.get(code) ?? [];
        return { name: `  ${code}`, p50: round1(quantile(t, 0.5)), p95: round1(quantile(t, 0.95)), min: round1(Math.min(...t)), queries: 0, rows: code === MAIN ? `${RECORDS} hợp đồng` : `${PEER_RECORDS} hợp đồng` };
      }),
    ]);

    const wanted = INDEX === "all" ? Object.keys(CANDIDATES) : INDEX === "none" ? [] : INDEX.split(",");
    const exec = (text: string) => withOrganization(MAIN, async () => {
      const db = await getDb();
      await db.execute(sql.raw(text));
      await db.execute(sql`analyze custom_values`);
      await db.execute(sql`analyze custom_records`);
    });
    for (const key of wanted) {
      const c = CANDIDATES[key];
      if (!c) throw new Error(`Không có index "${key}" (${Object.keys(CANDIDATES).join(", ")}).`);
      const targets = Object.entries(SCENARIOS).filter(([, s]) => s.tag.includes(c.tag));
      const other: Stat[] = [];
      await exec(c.kind === "trial" ? c.create : c.drop);
      try {
        for (const [name, s] of targets) other.push(await measure(MAIN, name, s.run));
      } finally {
        await exec(c.kind === "trial" ? c.drop : c.create);
      }
      const base0 = base.filter((x) => targets.some(([n]) => n === x.name));
      if (c.kind === "trial") {
        print(`INDEX THỬ "${key}": KHÔNG CÓ`, base0);
        print(`INDEX THỬ "${key}": CÓ  (${c.create})`, other);
      } else {
        print(`INDEX ĐÃ THÊM "${key}": KHÔNG CÓ (gỡ tạm)`, other);
        print(`INDEX ĐÃ THÊM "${key}": CÓ  (${c.create})`, base0);
      }
    }
  } finally {
    if (!keep) {
      for (const code of ORGS) await cleanup(code, false);
      if (!usePostgres) rmSync(dataDir, { recursive: true, force: true });
      else console.log(`\nCSDL tổ chức còn lại trên Postgres (probe tự xoá ở lượt sau): ${ORGS.map(organizationDatabaseName).join(", ")}`);
    }
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
