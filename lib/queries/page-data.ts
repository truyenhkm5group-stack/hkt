import { count, desc, eq, getTableColumns, is, sql, type SQL } from "drizzle-orm";
import { PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { chayKhongJit, getDb, schema } from "@/db";
import type { AnyObjectDef as ObjectDef } from "@/lib/constants/object-registry";
import { addDays, vnDateKey } from "@/lib/format";
import { filterShapeOk } from "@/lib/metadata/list-schema";
import type { ListFilter, SystemFieldDef } from "@/lib/metadata/types";
import { bookedInPeriod, factMetrics, metricScope, orderMetricFacts } from "@/lib/queries/metrics";
import { availableStockExpr, splitSignedStock, stockKnownExpr, erpStockExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ TRUY VẤN CỦA TRANG ĐỘNG (Phase 4) — CHỈ MÁY CHỦ ═══════════
 *
 * Không công thức nào mới ở đây. Chuỗi đơn theo ngày đọc `orderMetricFacts` + `factMetrics` (cùng bảng dẫn xuất,
 * cùng population `confirmed`, cùng `metricScope` với `orderKpis` của Tổng quan) nên cộng các ngày ra ĐÚNG số
 * của thẻ KPI cùng kỳ. Tồn khả dụng đọc `availableStockExpr` + `stockKnownExpr` + `splitSignedStock` của sổ kho.
 * Bảng theo đối tượng chỉ chọn CỘT THẬT mà sổ đối tượng khai — không cột tính ra nào.
 *
 * Quyền, module, phạm vi: KHÔNG kiểm ở đây — trình phân giải (`lib/pages/data-sources.ts`) kiểm trước khi gọi.
 * `getDb()` là CSDL của tổ chức hiện hành (silo): không hàm nào nhận hay ghép mã tổ chức.
 */

const DAY_FILL_MAX = 400;

/** Đơn lên / doanh thu lên đơn theo ngày (giờ VN). Kỳ có hai đầu ⇒ lấp ngày trống bằng 0 THẬT (đếm được là 0). */
export async function pageOrderSeriesByDay(period: Period, measure: "count" | "revenue"): Promise<{ x: string; y: number }[]> {
  const db = await getDb();
  const facts = orderMetricFacts(db, metricScope(period, "confirmed"));
  const m = factMetrics(facts);
  const rows = await chayKhongJit(db, (tx) =>
    tx.select({ day: facts.day, orders: m.countBooked, revenue: m.bookedRevenue }).from(facts).groupBy(facts.day).orderBy(facts.day),
  );
  const byDay = new Map(rows.map((r) => [String(r.day), measure === "count" ? Number(r.orders ?? 0) : Number(r.revenue ?? 0)]));
  if (!period.from || !period.to) return [...byDay.entries()].map(([x, y]) => ({ x, y }));
  const out: { x: string; y: number }[] = [];
  const last = vnDateKey(period.to);
  for (let d = vnDateKey(period.from), i = 0; d <= last && i < DAY_FILL_MAX; d = addDays(d, 1), i += 1) out.push({ x: d, y: byDay.get(d) ?? 0 });
  return out;
}

/** Số đơn theo `orders.stage` (nhãn Pancake — KHÔNG phải kết quả đơn) trong kỳ ngày lên đơn. */
export async function pageOrderStageCounts(period: Period): Promise<{ stage: string; n: number }[]> {
  const db = await getDb();
  const o = schema.orders;
  const rows = await db.select({ stage: o.stage, n: count() }).from(o).where(bookedInPeriod(period.from, period.to)).groupBy(o.stage);
  return rows.map((r) => ({ stage: String(r.stage), n: Number(r.n) }));
}

/**
 * TỒN KHẢ DỤNG TỔNG theo sổ kho (luật 10). Cùng tập mẫu mã với kế hoạch sản xuất (mẫu mã và sản phẩm chưa
 * xoá), cùng biểu thức từng mẫu, cùng phép tách dấu của trang chủ (`splitSignedStock`: chỉ cộng phần DƯƠNG;
 * mẫu chưa có phiếu RECEIPT là CHƯA BIẾT — không cộng). Không mẫu nào biết tồn ⇒ `available = null`.
 */
export async function pageAvailableStock(): Promise<{ available: number | null; knownVariants: number; unknownVariants: number; oversoldRows: number }> {
  const db = await getDb();
  const pv = schema.productVariants;
  const p = schema.products;
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const rows = await chayKhongJit(db, (tx) =>
    tx
      .select({ stockKnown: stockKnownExpr(receipts), stock: erpStockExpr(sales, receipts), available: availableStockExpr(sales, receipts) })
      .from(pv)
      .innerJoin(p, eq(p.id, pv.productId))
      .leftJoin(sales, eq(sales.variantId, pv.id))
      .leftJoin(receipts, eq(receipts.variantId, pv.id))
      .where(sql`${pv.isRemoved} = false and ${p.isRemoved} = false`),
  );
  const list = rows.map((r) => ({ stockKnown: Boolean(r.stockKnown), stock: Number(r.stock ?? 0), available: Number(r.available ?? 0) }));
  const known = list.filter((r) => r.stockKnown).length;
  const signed = splitSignedStock(list);
  return { available: known ? signed.availablePositive : null, knownVariants: known, unknownVariants: list.length - known, oversoldRows: signed.oversoldRows };
}

// ─────────────────────────── Bảng theo đối tượng ───────────────────────────

/** Bảng drizzle + cột thật của một đối tượng trong sổ. Sổ trỏ bảng / cột không có ⇒ ném (lỗi lập trình). */
export function pageObjectTable(def: ObjectDef): { table: PgTable; columns: Record<string, PgColumn>; id: PgColumn } {
  const table = (schema as unknown as Record<string, unknown>)[def.table];
  if (!is(table, PgTable)) throw new Error(`Sổ đối tượng trỏ bảng "${def.table}" không có trong lược đồ.`);
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  const id = columns[def.idColumn];
  if (!id) throw new Error(`Bảng "${def.table}" không có cột "${def.idColumn}".`);
  return { table, columns, id };
}

const NUMERIC_TYPES = new Set<SystemFieldDef["type"]>(["number", "currency"]);
const TIME_TYPES = new Set<SystemFieldDef["type"]>(["date", "datetime"]);

function pageScalarOk(field: SystemFieldDef, v: unknown): boolean {
  if (NUMERIC_TYPES.has(field.type)) return typeof v === "number" && Number.isFinite(v);
  if (field.type === "boolean") return typeof v === "boolean";
  if (TIME_TYPES.has(field.type)) return typeof v === "string" && !Number.isNaN(new Date(v).getTime());
  return typeof v === "string" || typeof v === "number";
}

function pageScalarSql(field: SystemFieldDef, v: unknown): SQL {
  if (NUMERIC_TYPES.has(field.type)) return sql`${Number(v)}`;
  if (field.type === "boolean") return sql`${v === true}`;
  if (TIME_TYPES.has(field.type)) return sql`${new Date(String(v)).toISOString()}::timestamptz`;
  return sql`${String(v)}`;
}

/**
 * Điều kiện SQL của MỘT bộ lọc trên field HỆ THỐNG. Mọi giá trị đi qua tham số; cột lấy từ sổ đối tượng. Trả
 * `null` khi bộ lọc sai hình hoặc sai kiểu với field — nơi gọi biến nó thành `INVALID_CONFIG` (một bộ lọc hỏng
 * mà vẫn chạy thì bảng rỗng và người đọc tưởng "không có bản ghi nào").
 *
 * `neq` / `empty` GỒM cả dòng CHƯA BIẾT (`null`) — chưa biết không bằng giá trị nào.
 */
export function pageSystemFilterSql(field: SystemFieldDef, column: PgColumn, f: ListFilter): SQL | null {
  if (!filterShapeOk(f)) return null;
  const numeric = NUMERIC_TYPES.has(field.type) || TIME_TYPES.has(field.type) || field.type === "boolean";
  const col = numeric ? sql`${column}` : sql`${column}::text`;
  switch (f.op) {
    case "eq":
      return pageScalarOk(field, f.value) ? sql`${col} = ${pageScalarSql(field, f.value)}` : null;
    case "neq":
      return pageScalarOk(field, f.value) ? sql`${col} is distinct from ${pageScalarSql(field, f.value)}` : null;
    case "in": {
      const list = f.value as unknown[];
      if (!list.every((v) => pageScalarOk(field, v))) return null;
      return sql`${col} in (${sql.join(list.map((v) => pageScalarSql(field, v)), sql`, `)})`;
    }
    case "contains":
      if (numeric) return null;
      return sql`${col} ilike ${`%${String(f.value).replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`;
    case "gte":
    case "lte": {
      if (!NUMERIC_TYPES.has(field.type) && !TIME_TYPES.has(field.type)) return null;
      if (!pageScalarOk(field, f.value)) return null;
      return f.op === "gte" ? sql`${col} >= ${pageScalarSql(field, f.value)}` : sql`${col} <= ${pageScalarSql(field, f.value)}`;
    }
    case "empty":
      return numeric ? sql`${column} is null` : sql`(${column} is null or ${column}::text = '')`;
    case "not_empty":
      return numeric ? sql`${column} is not null` : sql`(${column} is not null and ${column}::text <> '')`;
    default:
      return null;
  }
}

/** Một trang dòng của đối tượng: id + cột hệ thống được chọn + tổng. `where` đã gồm bộ lọc + phạm vi. */
export async function pageObjectRows(
  def: ObjectDef,
  opts: { fields: readonly SystemFieldDef[]; where: SQL | undefined; sort: { field: SystemFieldDef; dir: "asc" | "desc" } | null; limit: number; offset: number },
): Promise<{ rows: { id: string; values: Record<string, unknown> }[]; total: number }> {
  const { table, columns, id } = pageObjectTable(def);
  const db = await getDb();
  const pick: Record<string, PgColumn | SQL> = { __id: sql<string>`${id}::text` };
  for (const f of opts.fields) {
    const c = columns[f.column];
    if (c) pick[f.key] = c;
  }
  const sortCol = opts.sort ? columns[opts.sort.field.column] : null;
  const order = sortCol ? [opts.sort!.dir === "asc" ? sql`${sortCol} asc nulls last` : sql`${sortCol} desc nulls last`, desc(id)] : [desc(id)];
  const [rows, [{ total }]] = await Promise.all([
    db
      .select(pick as Record<string, PgColumn>)
      .from(table)
      .where(opts.where)
      .orderBy(...order)
      .limit(opts.limit)
      .offset(opts.offset),
    db.select({ total: count() }).from(table).where(opts.where),
  ]);
  return {
    rows: (rows as Record<string, unknown>[]).map((r) => {
      const { __id, ...values } = r;
      return { id: String(__id), values };
    }),
    total: Number(total),
  };
}

/** Sắp xếp mặc định của bảng đối tượng: field ngày giờ đầu tiên giảm dần, không có thì theo id. */
export function pageDefaultSort(def: ObjectDef): { field: SystemFieldDef; dir: "asc" | "desc" } | null {
  const t = def.fields.find((f) => TIME_TYPES.has(f.type));
  return t ? { field: t, dir: "desc" } : null;
}

