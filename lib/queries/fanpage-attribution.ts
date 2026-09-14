/**
 * ═══════════ BÁO CÁO QUY KẾT FANPAGE → MARKETER ═══════════
 *
 * Hợp đồng ở `lib/constants/fanpage-attribution.ts`; máy tính ở `lib/attribution/fanpage.ts`. Tệp
 * này CHỈ ĐỌC ảnh chụp `order_attributions` — nó không tự quy kết lại điều gì.
 *
 * ─── DOANH THU Ở ĐÂY LÀ DOANH THU MARKETING, VÀ CHỈ THẾ ───
 *
 * `Doanh thu xác nhận` = `orders.total_price_after_discount` của đơn có `stage ∈ CONFIRMED_STAGES`
 * — CÙNG phạm vi đơn mà Tổng quan / Lợi nhuận / Lương / Quảng cáo đang dùng, nên hai màn hình không
 * bao giờ nói hai con số cho cùng một kỳ.
 *
 * KHÔNG đọc COD, không đọc bảng kê Viettel Post, không đọc `ORDER_OUTCOME`. Đó là chỉ số LOGISTICS
 * và trả lời một câu hỏi khác hẳn (AGENTS.md mục 3). Trộn hai thứ vào một cột là chấm marketer bằng
 * việc shipper có giao được hàng hay không.
 *
 * ─── MỘT ĐƠN THUỘC ĐÚNG MỘT NHÓM ───
 *
 * Kể cả nhóm "chưa quy kết được". Nên cộng mọi nhóm phải ra đúng con số khi không chia nhóm nào —
 * `tests/fanpage-attribution.test.ts` khoá điều đó. Không chia một đơn cho hai người, không bỏ rơi
 * đơn không quy kết được.
 */
import { and, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { CONFIRMED_STAGES } from "@/lib/constants/pancake";
import { ATTRIBUTION_STATUSES, DUPLICATE_SIGNALS, type AttributionStatus, type DuplicateSignal } from "@/lib/constants/fanpage-attribution";
import { marketerLabel, marketerNames } from "@/lib/queries/order-marketer";
import type { ListParams, Period } from "@/lib/search-params";

const O = schema.orders;
const OA = schema.orderAttributions;
const OI = schema.orderItems;
const F = schema.fanpages;

/** Đơn ĐÃ XÁC NHẬN trên Pancake — cùng danh sách với mọi KPI quản trị khác. */
const CONFIRMED = sql`${O.stage} in (${sql.join(CONFIRMED_STAGES.map((s) => sql`${s}`), sql`, `)})`;

/**
 * GIÁ TRỊ ĐƠN — tên riêng chứ không mượn tên của trang Chất lượng dữ liệu: hai chỗ dùng CÙNG một
 * cột nhưng trả lời hai câu hỏi khác nhau, và hai hằng số trùng tên là thứ làm người đọc tin rằng
 * sửa một chỗ là sửa cả hai. `coalesce` an toàn ở đây: cột `NOT NULL DEFAULT 0`, không có "chưa biết".
 */
const CONFIRMED_ORDER_VALUE = sql<number>`coalesce(${O.totalPriceAfterDiscount}, 0)`;

export type AttributionFilters = {
  /** Id nhân sự. `__unattributed__` = nhóm chưa quy kết được. */
  marketerId?: string | null;
  /** Facebook Page ID (khoá tự nhiên), không phải id nội bộ. */
  pageId?: string | null;
  /** Lọc theo mã hàng: khớp `order_items.sku` hoặc `product_id`. */
  sku?: string | null;
};

/** Khoá nhóm của đơn chưa quy kết được — LUÔN hiện, không bao giờ bị lọc mất. */
export const ATTR_UNATTRIBUTED = "__unattributed__" as const;
export const ATTR_UNATTRIBUTED_LABEL = "Chưa quy kết được";

function periodConds(period: Period): SQL[] {
  const conds: SQL[] = [];
  // Mốc lọc là MỐC ĐƠN PHÁT SINH TẠI NGUỒN, không phải mốc ERP ghi dòng quy kết: một lượt đối soát
  // chạy hôm nay không được làm đơn tháng trước nhảy sang kỳ này.
  if (period.from) conds.push(gte(OA.sourceOrderAt, period.from));
  if (period.to) conds.push(lte(OA.sourceOrderAt, period.to));
  return conds;
}

function filterConds(f: AttributionFilters): SQL[] {
  const conds: SQL[] = [];
  if (f.marketerId === ATTR_UNATTRIBUTED) conds.push(sql`${OA.marketerId} is null`);
  else if (f.marketerId) conds.push(sql`${OA.marketerId} = ${f.marketerId}`);
  if (f.pageId) conds.push(sql`${OA.sourcePageId} = ${f.pageId}`);
  if (f.sku) {
    const needle = f.sku.trim();
    if (needle) conds.push(sql`exists (select 1 from ${OI} where ${OI.orderId} = ${OA.orderId} and (${OI.sku} ilike ${`%${needle}%`} or ${OI.productId} = ${needle}))`);
  }
  return conds;
}

export type MarketerAttributionRow = {
  marketerId: string | null;
  label: string;
  /** Đơn được quy kết cho người này (mọi trạng thái Pancake, KỂ CẢ chưa xác nhận). */
  attributedOrders: number;
  /** Trong số đó, bao nhiêu đơn đã XÁC NHẬN trên Pancake. */
  confirmedOrders: number;
  /** Doanh thu của phần đã xác nhận. Đơn chưa xác nhận đóng góp 0 — "chưa chốt" không phải "chốt rồi mà 0đ". */
  confirmedRevenue: number;
  /** Số fanpage có đơn quy kết cho người này trong kỳ. */
  pages: number;
};

export type AttributionReport = {
  rows: MarketerAttributionRow[];
  /** Đếm theo tình trạng trên TOÀN BỘ đơn trong kỳ — tổng của nó bằng tổng đơn của kỳ. */
  byStatus: Record<AttributionStatus, number>;
  /** Đơn bị loại vì trùng, và doanh thu ĐÃ XÁC NHẬN mà chúng mang theo (phần KHÔNG được tính cho ai). */
  duplicates: { orders: number; revenue: number };
  totalOrders: number;
  totalConfirmedOrders: number;
  totalConfirmedRevenue: number;
  /** Đơn trong kỳ CHƯA có dòng quy kết ⇒ báo cáo đang thiếu đơn, phải chạy lại đối soát. */
  missing: number;
};

/**
 * BÁO CÁO THEO MARKETER.
 *
 * Nhóm "Chưa quy kết được" là một dòng THẬT trong bảng, không phải phần dư bị giấu đi: nó gom
 * `NO_PAGE` và `NO_ASSIGNMENT` — hai lỗ hổng có cách sửa khác nhau nhưng cùng một hệ quả, là doanh
 * thu ấy chưa thuộc về ai. Đơn `DUPLICATE` KHÔNG nằm trong dòng nào cả: chúng không phải một lần
 * bán, và đếm riêng ở `duplicates`.
 */
export async function getMarketerAttributionReport(period: Period, filters: AttributionFilters = {}): Promise<AttributionReport> {
  const key = `fanpageAttr:${period.fromKey ?? "-"}:${period.toKey ?? "-"}:${filters.marketerId ?? ""}:${filters.pageId ?? ""}:${filters.sku ?? ""}`;
  return memo(key, 120_000, async () => {
    const db = await getDb();
    const where = and(...periodConds(period), ...filterConds(filters));

    const rows = await db
      .select({
        marketerId: OA.marketerId,
        status: OA.status,
        orders: sql<number>`count(*)::int`,
        confirmedOrders: sql<number>`count(*) filter (where ${CONFIRMED})::int`,
        confirmedRevenue: sql<number>`coalesce(sum(${CONFIRMED_ORDER_VALUE}) filter (where ${CONFIRMED}), 0)::bigint`,
        pages: sql<number>`count(distinct ${OA.sourcePageId})::int`,
      })
      .from(OA)
      .innerJoin(O, sql`${O.id} = ${OA.orderId}`)
      .where(where)
      .groupBy(OA.marketerId, OA.status);

    const byStatus = Object.fromEntries(ATTRIBUTION_STATUSES.map((s) => [s, 0])) as Record<AttributionStatus, number>;
    const acc = new Map<string | null, MarketerAttributionRow>();
    const duplicates = { orders: 0, revenue: 0 };
    let totalOrders = 0;
    let totalConfirmedOrders = 0;
    let totalConfirmedRevenue = 0;

    const names = await marketerNames();
    for (const r of rows) {
      const status = r.status as AttributionStatus;
      const orders = Number(r.orders);
      const confirmedOrders = Number(r.confirmedOrders);
      const revenue = Number(r.confirmedRevenue);
      byStatus[status] = (byStatus[status] ?? 0) + orders;
      totalOrders += orders;
      if (status === "DUPLICATE") {
        duplicates.orders += orders;
        duplicates.revenue += revenue;
        continue; // trùng đơn không thuộc dòng nào và không vào tổng doanh thu
      }
      totalConfirmedOrders += confirmedOrders;
      totalConfirmedRevenue += revenue;
      const id = r.marketerId;
      const row = acc.get(id) ?? { marketerId: id, label: id ? marketerLabel(id, names) : ATTR_UNATTRIBUTED_LABEL, attributedOrders: 0, confirmedOrders: 0, confirmedRevenue: 0, pages: 0 };
      row.attributedOrders += orders;
      row.confirmedOrders += confirmedOrders;
      row.confirmedRevenue += revenue;
      row.pages = Math.max(row.pages, Number(r.pages));
      acc.set(id, row);
    }

    const [missingRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(O)
      .where(and(sql`not exists (select 1 from ${OA} where ${OA.orderId} = ${O.id})`, ...(period.from ? [gte(O.insertedAt, period.from)] : []), ...(period.to ? [lte(O.insertedAt, period.to)] : [])));

    const list = [...acc.values()].sort((a, b) => (a.marketerId === null ? 1 : b.marketerId === null ? -1 : b.confirmedRevenue - a.confirmedRevenue || b.attributedOrders - a.attributedOrders));
    return { rows: list, byStatus, duplicates, totalOrders, totalConfirmedOrders, totalConfirmedRevenue, missing: Number(missingRow?.n ?? 0) };
  });
}

/**
 * Khoá dấu hiệu → nhãn đọc được. Khoá lạ (dòng do một phiên bản luật cũ ghi) được GIỮ NGUYÊN chứ
 * không bị bỏ đi: một căn cứ không đọc được vẫn là một căn cứ, giấu nó đi mới là mất dấu.
 */
function signalLabels(reason: string | null): string[] {
  if (!reason) return [];
  return reason
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => DUPLICATE_SIGNALS[k as DuplicateSignal]?.label ?? k);
}

export type AttributionOrderRow = {
  orderId: string;
  systemId: number | null;
  sourceOrderAt: Date;
  pageId: string | null;
  pageName: string;
  marketerId: string | null;
  marketerLabel: string;
  status: AttributionStatus;
  duplicateOfOrderId: string | null;
  /** Các dấu hiệu đã dùng để kết luận trùng đơn, đã dịch sang nhãn đọc được. `[]` với đơn không trùng. */
  duplicateSignals: string[];
  duplicateScore: number | null;
  stage: string;
  confirmed: boolean;
  revenue: number;
  customer: string;
  phone: string;
  skus: string;
};

const ATTRIBUTION_SORTABLE = ["sourceOrderAt", "revenue", "status", "marketer", "page"] as const;

/**
 * DANH SÁCH ĐƠN ĐỂ SOI — mỗi dòng nói đủ: đơn nào · page nào · ai · lúc nào tại NGUỒN · Pancake đã
 * xác nhận chưa · bao nhiêu tiền · nếu bị loại thì loại vì trùng với đơn nào.
 *
 * Một báo cáo quy kết mà không mở ra được tới từng đơn là một báo cáo không kiểm chứng được, và một
 * con số không kiểm chứng được thì không dùng để trả lương cho ai.
 */
export async function listAttributionOrders(params: ListParams, filters: AttributionFilters & { status?: string | null } = {}): Promise<{ rows: AttributionOrderRow[]; total: number; pageCount: number }> {
  const db = await getDb();
  const conds = [...periodConds(params.period), ...filterConds(filters)];
  if (filters.status && (ATTRIBUTION_STATUSES as readonly string[]).includes(filters.status)) conds.push(sql`${OA.status} = ${filters.status}`);
  if (params.q?.trim()) {
    const q = `%${params.q.trim()}%`;
    conds.push(sql`(${O.billPhone} ilike ${q} or ${O.shipPhone} ilike ${q} or ${O.billFullName} ilike ${q} or ${O.shipFullName} ilike ${q} or ${O.id} = ${params.q.trim()})`);
  }
  const where = and(...conds);

  const sortKey = (ATTRIBUTION_SORTABLE as readonly string[]).includes(params.sort) ? params.sort : "sourceOrderAt";
  const dir = params.dir === "asc" ? sql`asc` : sql`desc`;
  const orderBy =
    sortKey === "revenue"
      ? sql`${CONFIRMED_ORDER_VALUE} ${dir}`
      : sortKey === "status"
        ? sql`${OA.status} ${dir}`
        : sortKey === "marketer"
          ? sql`${OA.marketerId} ${dir} nulls last`
          : sortKey === "page"
            ? sql`${OA.sourcePageId} ${dir} nulls last`
            : sql`${OA.sourceOrderAt} ${dir}`;

  const [countRow] = await db.select({ n: sql<number>`count(*)::int` }).from(OA).innerJoin(O, sql`${O.id} = ${OA.orderId}`).where(where);
  const total = Number(countRow?.n ?? 0);

  const rows = await db
    .select({
      orderId: OA.orderId,
      systemId: O.systemId,
      sourceOrderAt: OA.sourceOrderAt,
      pageId: OA.sourcePageId,
      pageName: sql<string>`coalesce(${F.name}, '')`,
      marketerId: OA.marketerId,
      status: OA.status,
      duplicateOfOrderId: OA.duplicateOfOrderId,
      duplicateScore: OA.duplicateScore,
      duplicateReason: OA.duplicateReason,
      stage: sql<string>`${O.stage}::text`,
      confirmed: sql<boolean>`(${CONFIRMED})`,
      revenue: sql<number>`${CONFIRMED_ORDER_VALUE}::bigint`,
      customer: sql<string>`coalesce(nullif(${O.shipFullName}, ''), ${O.billFullName})`,
      phone: sql<string>`coalesce(nullif(${O.shipPhone}, ''), ${O.billPhone})`,
      skus: sql<string>`coalesce((select string_agg(distinct nullif(oi.sku, ''), ', ') from order_items oi where oi.order_id = ${OA.orderId}), '')`,
    })
    .from(OA)
    .innerJoin(O, sql`${O.id} = ${OA.orderId}`)
    .leftJoin(F, sql`${F.id} = ${OA.fanpageId}`)
    .where(where)
    .orderBy(orderBy, sql`${OA.orderId} desc`)
    .limit(params.pageSize)
    .offset((params.page - 1) * params.pageSize);

  const names = await marketerNames();
  return {
    total,
    pageCount: Math.max(1, Math.ceil(total / params.pageSize)),
    rows: rows.map((r) => ({
      orderId: r.orderId,
      systemId: r.systemId,
      sourceOrderAt: new Date(r.sourceOrderAt),
      pageId: r.pageId,
      pageName: r.pageName,
      marketerId: r.marketerId,
      marketerLabel: r.marketerId ? marketerLabel(r.marketerId, names) : ATTR_UNATTRIBUTED_LABEL,
      status: r.status as AttributionStatus,
      duplicateOfOrderId: r.duplicateOfOrderId,
      duplicateSignals: signalLabels(r.duplicateReason),
      duplicateScore: r.duplicateScore,
      stage: r.stage,
      confirmed: Boolean(r.confirmed),
      revenue: Number(r.revenue),
      customer: r.customer,
      phone: r.phone,
      skus: r.skus,
    })),
  };
}

/** Fanpage có đơn trong kỳ — dựng bộ lọc. Khoá là Page ID, nhãn là tên nếu đọc được. */
export async function listAttributionPages(period: Period): Promise<{ id: string; label: string }[]> {
  const db = await getDb();
  const rows = await db
    .select({ pageId: OA.sourcePageId, name: sql<string>`coalesce(max(${F.name}), '')`, orders: sql<number>`count(*)::int` })
    .from(OA)
    .leftJoin(F, sql`${F.id} = ${OA.fanpageId}`)
    .where(and(sql`${OA.sourcePageId} is not null`, ...periodConds(period)))
    .groupBy(OA.sourcePageId)
    .orderBy(sql`count(*) desc`);
  return rows.filter((r) => r.pageId).map((r) => ({ id: r.pageId as string, label: r.name ? `${r.name} · ${r.pageId}` : String(r.pageId) }));
}

/** Marketer có đơn quy kết trong kỳ — dựng bộ lọc. */
export async function listAttributionMarketers(period: Period): Promise<{ id: string; label: string }[]> {
  const db = await getDb();
  const rows = await db
    .select({ marketerId: OA.marketerId })
    .from(OA)
    .where(and(sql`${OA.marketerId} is not null`, ...periodConds(period)))
    .groupBy(OA.marketerId);
  const names = await marketerNames();
  return rows
    .filter((r) => r.marketerId)
    .map((r) => ({ id: r.marketerId as string, label: marketerLabel(r.marketerId, names) }))
    .sort((a, b) => a.label.localeCompare(b.label, "vi"));
}

/** Các đơn trong CÙNG chuỗi trùng đơn với một đơn cho trước — để đối chiếu bằng mắt trước khi tin. */
export async function listDuplicateSiblings(orderId: string): Promise<AttributionOrderRow[]> {
  const db = await getDb();
  const [self] = await db.select({ dedupeKey: OA.dedupeKey }).from(OA).where(sql`${OA.orderId} = ${orderId}`).limit(1);
  if (!self?.dedupeKey) return [];
  const rows = await db
    .select({
      orderId: OA.orderId,
      systemId: O.systemId,
      sourceOrderAt: OA.sourceOrderAt,
      pageId: OA.sourcePageId,
      pageName: sql<string>`coalesce(${F.name}, '')`,
      marketerId: OA.marketerId,
      status: OA.status,
      duplicateOfOrderId: OA.duplicateOfOrderId,
      duplicateScore: OA.duplicateScore,
      duplicateReason: OA.duplicateReason,
      stage: sql<string>`${O.stage}::text`,
      confirmed: sql<boolean>`(${CONFIRMED})`,
      revenue: sql<number>`${CONFIRMED_ORDER_VALUE}::bigint`,
      customer: sql<string>`coalesce(nullif(${O.shipFullName}, ''), ${O.billFullName})`,
      phone: sql<string>`coalesce(nullif(${O.shipPhone}, ''), ${O.billPhone})`,
      skus: sql<string>`coalesce((select string_agg(distinct nullif(oi.sku, ''), ', ') from order_items oi where oi.order_id = ${OA.orderId}), '')`,
    })
    .from(OA)
    .innerJoin(O, sql`${O.id} = ${OA.orderId}`)
    .leftJoin(F, sql`${F.id} = ${OA.fanpageId}`)
    .where(sql`${OA.dedupeKey} = ${self.dedupeKey}`)
    .orderBy(sql`${OA.sourceOrderAt} asc`);
  const names = await marketerNames();
  return rows.map((r) => ({
    orderId: r.orderId,
    systemId: r.systemId,
    sourceOrderAt: new Date(r.sourceOrderAt),
    pageId: r.pageId,
    pageName: r.pageName,
    marketerId: r.marketerId,
    marketerLabel: r.marketerId ? marketerLabel(r.marketerId, names) : ATTR_UNATTRIBUTED_LABEL,
    status: r.status as AttributionStatus,
    duplicateOfOrderId: r.duplicateOfOrderId,
    duplicateSignals: signalLabels(r.duplicateReason),
    duplicateScore: r.duplicateScore,
    stage: r.stage,
    confirmed: Boolean(r.confirmed),
    revenue: Number(r.revenue),
    customer: r.customer,
    phone: r.phone,
    skus: r.skus,
  }));
}

export { ATTRIBUTION_SORTABLE };

/**
 * Nhân sự có thể nhận một fanpage.
 *
 * KHÔNG lọc cứng theo phòng "Marketing": shop nhỏ thì một người có thể vừa chốt đơn vừa chạy page,
 * và một bộ lọc cứng sẽ làm người đó biến mất khỏi ô chọn mà không nói vì sao. Phòng ban trả kèm để
 * màn hình xếp nhóm — xếp nhóm khác hẳn với chặn.
 */
export async function listMarketerOptions(): Promise<{ id: string; label: string; department: string }[]> {
  const { listEmployees } = await import("@/lib/queries/payroll");
  const employees = await listEmployees();
  return employees
    .filter((e) => e.active)
    .map((e) => ({ id: e.id, label: e.shortName || e.name, department: e.department }))
    .sort((a, b) => a.label.localeCompare(b.label, "vi"));
}

/** Đếm nhanh đơn chưa có dòng quy kết trong TOÀN BỘ dữ liệu (không theo kỳ). */
export async function countOrdersMissingAttribution(): Promise<number> {
  const db = await getDb();
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(O).where(sql`not exists (select 1 from ${OA} where ${OA.orderId} = ${O.id})`);
  return Number(row?.n ?? 0);
}
