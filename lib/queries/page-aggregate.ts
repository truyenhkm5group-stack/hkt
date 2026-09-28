import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import type { AnyObjectDef as ObjectDef } from "@/lib/constants/object-registry";
import { FIELD_KEY_PATTERN, type CustomFieldDef, type SystemFieldDef } from "@/lib/metadata/types";
import type { AggregateFn, TimeBucket } from "@/lib/pages/types";
import { pageObjectTable } from "@/lib/queries/page-data";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ TỔNG HỢP THEO FIELD CỦA TRANG ĐỘNG (Phase 5) — CHỈ MÁY CHỦ ═══════════
 *
 * Đếm / cộng / trung bình / min / max trên CỘT THẬT của sổ đối tượng hoặc trên giá trị field tuỳ biến
 * (`custom_values.values` jsonb, nối trái theo `object_key` + `record_id`). Không công thức nghiệp vụ nào ở đây:
 * cột nào được cộng do sổ đối tượng khai (`aggregatable`) và trình phân giải (`lib/pages/data-sources.ts`) kiểm
 * TRƯỚC khi gọi — field tiền của đơn / vận đơn / hàng hoàn không bao giờ tới được tệp này.
 *
 * Quyền, module, phạm vi: KHÔNG kiểm ở đây — `where` đã mang bộ lọc + mệnh đề phạm vi (`andScope`). `getDb()` là
 * CSDL của tổ chức hiện hành (silo).
 *
 * CHƯA BIẾT ≠ 0 (luật 42): đếm không có bản ghi là 0 thật; cộng / trung bình / min / max khi không bản ghi nào CÓ
 * giá trị là `null`, không phải 0.
 */

/** Một field đã phân giải — hệ thống (cột thật) hoặc tuỳ biến (khoá trong jsonb). */
export type AggregateFieldRef = { kind: "system"; field: SystemFieldDef } | { kind: "custom"; field: CustomFieldDef };

/** Khoảng kỳ trên MỘT field ngày: mốc tuyệt đối (field ngày giờ) + khoá ngày VN (field ngày). */
export type AggregatePeriod = { field: AggregateFieldRef; from: Date | null; to: Date | null; fromKey: string | null; toKey: string | null };

export type AggregateBase = {
  def: ObjectDef;
  /** Bộ lọc + phạm vi trên bảng gốc của đối tượng. */
  where: SQL | undefined;
  fn: AggregateFn;
  field: AggregateFieldRef | null;
  period?: AggregatePeriod | null;
};

const VN_TZ = "Asia/Ho_Chi_Minh";
/** Alias của `custom_values` nối trái — khác `cv` mà `customValuesFilterSql` dùng trong câu con của nó. */
const CV = sql.raw("pcv");

function column(def: ObjectDef, f: SystemFieldDef): PgColumn {
  const c = pageObjectTable(def).columns[f.column];
  if (!c) throw new Error(`Bảng "${def.table}" không có cột "${f.column}".`);
  return c;
}

function customKey(f: CustomFieldDef): SQL {
  if (!FIELD_KEY_PATTERN.test(f.key)) throw new Error(`Khoá field tuỳ biến không hợp lệ: "${f.key}".`);
  return sql`${f.key}::text`;
}

const DATE_PREFIX = "^[0-9]{4}-[0-9]{2}-[0-9]{2}";

/** Giá trị SỐ (float8) — jsonb không phải số ⇒ NULL (không ép chữ thành số). */
function numericExpr(def: ObjectDef, r: AggregateFieldRef): SQL {
  if (r.kind === "system") return sql`${column(def, r.field)}::float8`;
  const k = customKey(r.field);
  return sql`(case when jsonb_typeof(${CV}.values -> ${k}) = 'number' then (${CV}.values ->> ${k})::float8 end)`;
}

/** "Có giá trị" — dùng cho `count(field)`. JSON null đếm như không có. */
function presenceExpr(def: ObjectDef, r: AggregateFieldRef): SQL {
  if (r.kind === "system") return sql`${column(def, r.field)}`;
  return sql`nullif(${CV}.values -> ${customKey(r.field)}, 'null'::jsonb)`;
}

/** Khoá nhóm dạng chữ (select / trạng thái / có-không / người dùng). */
function keyExpr(def: ObjectDef, r: AggregateFieldRef): SQL {
  if (r.kind === "system") return sql`${column(def, r.field)}::text`;
  return sql`(${CV}.values ->> ${customKey(r.field)})`;
}

/**
 * Mốc thời gian của một field ngày, theo giờ VN: field ngày giờ ⇒ `timestamp` (đã quy về giờ VN); field ngày ⇒
 * `date`. Chuỗi không mang dạng ngày ⇒ NULL (không ép).
 */
function localTimeExpr(def: ObjectDef, r: AggregateFieldRef): SQL {
  if (r.kind === "system") {
    const c = column(def, r.field);
    return r.field.type === "date" ? sql`${c}::date` : sql`(${c} at time zone ${VN_TZ})`;
  }
  const k = customKey(r.field);
  const raw = sql`(${CV}.values ->> ${k})`;
  const ok = sql`jsonb_typeof(${CV}.values -> ${k}) = 'string' and ${raw} ~ ${DATE_PREFIX}`;
  return r.field.type === "date" ? sql`(case when ${ok} then left(${raw}, 10)::date end)` : sql`(case when ${ok} then (${raw}::timestamptz at time zone ${VN_TZ}) end)`;
}

function periodCond(def: ObjectDef, p: AggregatePeriod): SQL | undefined {
  const parts: SQL[] = [];
  const isDate = p.field.field.type === "date";
  if (isDate) {
    const d = localTimeExpr(def, p.field);
    if (p.fromKey) parts.push(sql`${d} >= ${p.fromKey}::date`);
    if (p.toKey) parts.push(sql`${d} <= ${p.toKey}::date`);
  } else if (p.field.kind === "system") {
    const c = column(def, p.field.field);
    if (p.from) parts.push(sql`${c} >= ${p.from.toISOString()}::timestamptz`);
    if (p.to) parts.push(sql`${c} <= ${p.to.toISOString()}::timestamptz`);
  } else {
    const k = customKey(p.field.field);
    const raw = sql`(${CV}.values ->> ${k})`;
    const ts = sql`(case when jsonb_typeof(${CV}.values -> ${k}) = 'string' and ${raw} ~ ${DATE_PREFIX} then ${raw}::timestamptz end)`;
    if (p.from) parts.push(sql`${ts} >= ${p.from.toISOString()}::timestamptz`);
    if (p.to) parts.push(sql`${ts} <= ${p.to.toISOString()}::timestamptz`);
  }
  return parts.length ? sql.join(parts, sql` and `) : undefined;
}

function usesCustom(b: AggregateBase, extra: (AggregateFieldRef | null | undefined)[]): boolean {
  return [b.field, b.period?.field, ...extra].some((r) => r?.kind === "custom");
}

/** `from <bảng> [left join custom_values pcv] where …` — mọi phép tổng hợp dùng chung khung này. */
function fromWhere(b: AggregateBase, extra: (AggregateFieldRef | null | undefined)[] = []): SQL {
  const { table, id } = pageObjectTable(b.def);
  const join = usesCustom(b, extra) ? sql` left join ${schema.customValues} ${CV} on ${CV}.object_key = ${b.def.key} and ${CV}.record_id = ${id}::text` : sql``;
  const conds = [b.where, b.period ? periodCond(b.def, b.period) : undefined].filter((x): x is SQL => x !== undefined);
  const where = conds.length ? sql` where ${sql.join(conds.map((c) => sql`(${c})`), sql` and `)}` : sql``;
  return sql`from ${table}${join}${where}`;
}

/** Năm cột dựng được MỌI phép (đếm · đếm có giá trị · tổng · min · max) — gộp nhóm "Khác" không cần chạy lại. */
function measureCols(b: AggregateBase): SQL {
  const v = b.field ? (b.fn === "count" ? presenceExpr(b.def, b.field) : numericExpr(b.def, b.field)) : sql`null::float8`;
  const num = b.field && b.fn !== "count" ? v : sql`null::float8`;
  return sql`count(*)::int as n, count(${v})::int as nv, sum(${num})::float8 as s, min(${num})::float8 as mn, max(${num})::float8 as mx`;
}

type Measure = { n: number; nv: number; s: number | null; mn: number | null; mx: number | null };

const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** Giá trị của phép theo năm cột. Đếm: số thật (0 là 0). Còn lại: không bản ghi nào có giá trị ⇒ `null`. */
export function measureValue(fn: AggregateFn, hasField: boolean, m: Measure): number | null {
  if (fn === "count") return hasField ? m.nv : m.n;
  if (m.nv === 0) return null;
  if (fn === "sum") return m.s;
  if (fn === "avg") return m.s === null ? null : m.s / m.nv;
  if (fn === "min") return m.mn;
  return m.mx;
}

function toMeasure(r: Record<string, unknown>): Measure {
  return { n: Number(r.n ?? 0), nv: Number(r.nv ?? 0), s: num(r.s), mn: num(r.mn), mx: num(r.mx) };
}

/** MỘT con số (KPI tổng hợp). */
export async function pageAggregateTotal(b: AggregateBase): Promise<{ value: number | null; records: number }> {
  const db = await getDb();
  const [r] = rowsOf<Record<string, unknown>>(await db.execute(sql`select ${measureCols(b)} ${fromWhere(b)}`));
  const m = toMeasure(r ?? {});
  return { value: measureValue(b.fn, b.field !== null, m), records: m.n };
}

/**
 * Nhóm theo MỘT field (biểu đồ nhóm). `maxGroups` nhóm đông nhất (theo số bản ghi) đứng riêng, phần còn lại gộp
 * MỘT dòng `other` — gộp trong SQL để min / max / trung bình của "Khác" vẫn đúng. Khoá `null` = bản ghi chưa có giá
 * trị (nơi gọi đặt nhãn "Chưa đặt").
 */
export async function pageAggregateGroups(b: AggregateBase & { group: AggregateFieldRef; maxGroups: number }): Promise<{ key: string | null; other: boolean; value: number | null; records: number }[]> {
  const db = await getDb();
  const max = Math.max(1, Math.floor(b.maxGroups));
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with g as (select ${keyExpr(b.def, b.group)} as k, ${measureCols(b)} ${fromWhere(b, [b.group])} group by 1),
      r as (select g.*, row_number() over (order by g.n desc, g.k asc nulls first) as rn from g)
      select (r.rn > ${max}) as other, case when r.rn > ${max} then null else r.k end as k,
        sum(r.n)::int as n, sum(r.nv)::int as nv, sum(r.s)::float8 as s, min(r.mn)::float8 as mn, max(r.mx)::float8 as mx, min(r.rn) as ord
      from r group by 1, 2 order by ord`),
  );
  return rows.map((r) => {
    const m = toMeasure(r);
    return { key: r.k === null || r.k === undefined ? null : String(r.k), other: r.other === true || r.other === "t", value: measureValue(b.fn, b.field !== null, m), records: m.n };
  });
}

const BUCKET_FORMAT: Record<TimeBucket, string> = { day: "YYYY-MM-DD", week: "YYYY-MM-DD", month: "YYYY-MM" };

/**
 * Chuỗi thời gian theo ngày / tuần (thứ Hai) / tháng, giờ VN. Trả tối đa `limit` mốc GẦN NHẤT (`truncated`) và số
 * bản ghi KHÔNG có mốc (`undated` — không vẽ được, nhưng không được biến mất khỏi lời giải thích).
 */
export async function pageAggregateBuckets(
  b: AggregateBase & { dateField: AggregateFieldRef; bucket: TimeBucket; limit: number },
): Promise<{ buckets: { key: string; value: number | null; records: number }[]; undated: number; truncated: boolean }> {
  const db = await getDb();
  const t = localTimeExpr(b.def, b.dateField);
  // `timestamp` KHÔNG múi giờ: mốc đã quy về giờ VN, cắt ngày / tuần / tháng không được trôi theo múi giờ của phiên.
  const key = sql`to_char(date_trunc(${b.bucket}::text, (${t})::timestamp), ${BUCKET_FORMAT[b.bucket]}::text)`;
  const limit = Math.max(1, Math.floor(b.limit));
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with g as (select ${key} as k, ${measureCols(b)} ${fromWhere(b, [b.dateField])} group by 1)
      select * from ((select * from g where k is not null order by k desc limit ${limit + 1}) union all (select * from g where k is null)) x`),
  );
  const dated = rows.filter((r) => r.k !== null && r.k !== undefined);
  const undated = rows.filter((r) => r.k === null || r.k === undefined).reduce((n, r) => n + Number(r.n ?? 0), 0);
  const truncated = dated.length > limit;
  const kept = dated.slice(0, limit).reverse();
  return { buckets: kept.map((r) => ({ key: String(r.k), value: measureValue(b.fn, b.field !== null, toMeasure(r)), records: Number(r.n ?? 0) })), undated, truncated };
}
