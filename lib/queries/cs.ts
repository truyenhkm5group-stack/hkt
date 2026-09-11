import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CS_BOT_ASSIGNEES, CS_ESCALATE_KINDS, CS_ESCALATE_WINDOW_HOURS, CS_KIND_LABEL, CS_STATUS_LABEL, CS_SURFACE_MODE, type CsKind, type CsStatus } from "@/lib/constants/cs";
import { CASE_SLA_HOURS } from "@/lib/constants/action-queue";
import { rowsOf } from "@/lib/sql-rows";
import type { ListParams } from "@/lib/search-params";

export const CS_SORTABLE = ["createdAt", "updatedAt", "status", "kind"];

function whereOf(params: ListParams) {
  const c = schema.csCases;
  const conds: (SQL | undefined)[] = [];
  if (params.period.from) conds.push(gte(c.createdAt, params.period.from));
  if (params.period.to) conds.push(lte(c.createdAt, params.period.to));
  if (params.filters.kind?.length) conds.push(inArray(c.kind, params.filters.kind));
  if (params.filters.status?.length) conds.push(inArray(c.status, params.filters.status));
  if (params.filters.assignee?.length) conds.push(inArray(c.assignee, params.filters.assignee));
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(or(ilike(c.title, like), ilike(c.detail, like), ilike(c.customerName, like), ilike(c.customerPhone, like), ilike(c.assignee, like)));
  }
  const defined = conds.filter((x): x is SQL => Boolean(x));
  return defined.length ? and(...defined) : undefined;
}

export async function listCsCases(params: ListParams) {
  const db = await getDb();
  const c = schema.csCases;
  const where = whereOf(params);
  const sortCol = params.sort === "updatedAt" ? c.updatedAt : params.sort === "status" ? c.status : params.sort === "kind" ? c.kind : c.createdAt;
  const [rows, [{ total }]] = await Promise.all([
    db.query.csCases.findMany({
      where,
      orderBy: [params.dir === "asc" ? asc(sortCol) : desc(sortCol), desc(c.createdAt)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      with: { order: { columns: { id: true, systemId: true, pageId: true, conversationId: true, stage: true, totalPriceAfterDiscount: true, shipAddress: true, billPhone: true } } },
    }),
    db.select({ total: count() }).from(c).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}
export type CsCaseRow = Awaited<ReturnType<typeof listCsCases>>["rows"][number];

export async function csFacets(params: ListParams) {
  const db = await getDb();
  const c = schema.csCases;
  const base = whereOf({ ...params, filters: {} });
  const [kinds, statuses, assignees] = await Promise.all([
    db.select({ value: c.kind, count: count() }).from(c).where(base).groupBy(c.kind),
    db.select({ value: c.status, count: count() }).from(c).where(base).groupBy(c.status),
    db.select({ value: c.assignee, count: count() }).from(c).where(and(base, sql`${c.assignee} <> ''`)).groupBy(c.assignee),
  ]);
  return {
    kinds: kinds.map((k) => ({ value: k.value, label: CS_KIND_LABEL[k.value as CsKind] ?? k.value, count: Number(k.count) })),
    statuses: statuses.map((k) => ({ value: k.value, label: CS_STATUS_LABEL[k.value as CsStatus] ?? k.value, count: Number(k.count) })),
    assignees: assignees.map((k) => ({ value: k.value, label: k.value, count: Number(k.count) })),
  };
}

export async function csSummary() {
  const db = await getDb();
  const c = schema.csCases;
  const rows = await db.select({ kind: c.kind, status: c.status, count: count() }).from(c).where(isNull(c.resolvedAt)).groupBy(c.kind, c.status);
  const open = rows.filter((r) => r.status === "OPEN" || r.status === "IN_PROGRESS");
  const byKind: Record<string, number> = {};
  for (const r of open) byKind[r.kind] = (byKind[r.kind] ?? 0) + Number(r.count);
  return { open: open.reduce((a, r) => a + Number(r.count), 0), new: rows.filter((r) => r.status === "OPEN").reduce((a, r) => a + Number(r.count), 0), byKind };
}

/** Case đang mở (cho cảnh báo) */
export async function openCsCases() {
  const db = await getDb();
  return db.select().from(schema.csCases).where(inArray(schema.csCases.status, ["OPEN"])).orderBy(desc(schema.csCases.createdAt)).limit(500);
}

/** Hạn xử lý của một case CSKH (giờ) — cùng một số với hàng đợi việc, không gõ lại. */
export const CS_CASE_SLA_HOURS = CASE_SLA_HOURS.CS_CASE ?? 4;

export type CsCaseForAlert = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  customerName: string;
  customerPhone: string;
  assignee: string;
  orderId: string | null;
  createdAt: Date;
  updatedAt: Date | null;
};

/**
 * CASE NÀO LÊN HÀNG ĐỢI RIÊNG — luật ở lib/constants/cs.ts, đây chỉ là chỗ áp dụng.
 *
 * Trả về đúng những case cần một dòng việc riêng: loại `EACH`, xác nhận SĐT mà bot không gửi được,
 * case khách-đang-chờ đã quá hạn và còn trong cửa sổ cứu, hoặc case đã có NGƯỜI nhận mà quá hạn.
 */
export async function csCasesToSurface(): Promise<CsCaseForAlert[]> {
  const db = await getDb();
  const c = schema.csCases;
  const rows = await db
    .select({ id: c.id, kind: c.kind, title: c.title, detail: c.detail, customerName: c.customerName, customerPhone: c.customerPhone, assignee: c.assignee, orderId: c.orderId, createdAt: c.createdAt, updatedAt: c.updatedAt })
    .from(c)
    .where(eq(c.status, "OPEN"))
    .orderBy(desc(c.createdAt))
    .limit(2000);
  const now = Date.now();
  return rows.filter((r) => {
    const kind = r.kind as CsKind;
    if ((CS_SURFACE_MODE[kind] ?? "GROUP") === "EACH") return true;
    if (kind === "PHONE_VERIFY" && r.title.startsWith("⛔")) return true;
    const ageHours = (now - new Date(r.createdAt).getTime()) / 3_600_000;
    const overdue = ageHours > CS_CASE_SLA_HOURS;
    if (!overdue) return false;
    if (r.assignee && !CS_BOT_ASSIGNEES.includes(r.assignee)) return true;
    return CS_ESCALATE_KINDS.includes(kind) && ageHours <= CS_ESCALATE_WINDOW_HOURS;
  });
}

export type CsOpenGroup = {
  kind: string;
  assignee: string;
  count: number;
  overdue: number;
  oldestHours: number;
  withOrder: number;
  /** Tổng giá trị các ĐƠN gắn vào case của nhóm — tiền đang có nguy cơ, nếu xác định được. */
  value: number;
};

/**
 * TỒN ĐỌNG CASE THEO (LOẠI · NGƯỜI PHỤ TRÁCH) — nguồn cho việc tổng hợp và cho bảng điều hành.
 *
 * `excludeIds`: case đã có dòng việc riêng thì không đếm vào nhóm nữa (không đếm hai lần).
 */
export async function openCsGroups(excludeIds: string[] = []): Promise<CsOpenGroup[]> {
  const db = await getDb();
  const ex = excludeIds.length ? sql`and c.id not in ${excludeIds}` : sql``;
  const rows = rowsOf<{ kind: string; assignee: string; n: number; overdue: number; oldest: number; with_order: number; value: number }>(
    await db.execute(sql`
      select c.kind, coalesce(c.assignee, '') as assignee,
             count(*)::int as n,
             count(*) filter (where c.created_at < now() - (${CS_CASE_SLA_HOURS} * interval '1 hour'))::int as overdue,
             coalesce(max(extract(epoch from (now() - c.created_at)) / 3600), 0) as oldest,
             count(*) filter (where c.order_id is not null)::int as with_order,
             coalesce(sum(o.total_price_after_discount), 0) as value
        from cs_cases c
        left join orders o on o.id = c.order_id
       where c.status = 'OPEN' ${ex}
       group by 1, 2
       order by 3 desc`),
  );
  return rows.map((r) => ({ kind: r.kind, assignee: r.assignee, count: Number(r.n), overdue: Number(r.overdue), oldestHours: Number(r.oldest), withOrder: Number(r.with_order), value: Number(r.value) }));
}

/** Khoá nhóm dùng làm `entity_id` của việc tổng hợp — một chỗ định nghĩa, hai chỗ đọc (cảnh báo và hàng đợi). */
export function csGroupKey(kind: string, assignee: string) {
  return `${kind}|${assignee}`;
}
export function parseCsGroupKey(key: string): { kind: string; assignee: string } {
  const i = key.indexOf("|");
  return i < 0 ? { kind: key, assignee: "" } : { kind: key.slice(0, i), assignee: key.slice(i + 1) };
}

/** Tiền đơn liên quan của từng nhóm case (cho hàng đợi việc). */
export async function csGroupValues(keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!keys.length) return out;
  const groups = await openCsGroups();
  for (const g of groups) out.set(csGroupKey(g.kind, g.assignee), g.value);
  return out;
}

export async function findOrderForCase(term: string) {
  const db = await getDb();
  const o = schema.orders;
  const num = Number(term);
  return db
    .select({ id: o.id, systemId: o.systemId, name: o.billFullName, phone: o.billPhone, customerId: o.customerId, total: o.totalPriceAfterDiscount })
    .from(o)
    .where(or(Number.isInteger(num) ? eq(o.systemId, num) : undefined, eq(o.id, term), ilike(o.billPhone, `%${term}%`)))
    .orderBy(desc(o.insertedAt))
    .limit(8);
}
