import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { chayKhongJit, getDb, schema, type Db } from "@/db";
import { vanDonDaiDien } from "@/lib/constants/shipment-pick";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { REVENUE_RECOGNIZED_ON_DELIVERY } from "@/lib/queries/manual-order-sql";
import { OPEN_OUTCOMES_SQL, RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { pctOrNull, toDate } from "@/lib/format";
import { noCodPaymentState } from "@/lib/constants/no-cod-payment";
import type { ListParams } from "@/lib/search-params";

export const CUSTOMER_SORTABLE = ["orderCount", "purchasedAmount", "lastOrderAt", "name", "insertedAt"];

const c = schema.customers;
const o = schema.orders;

/** Ngày tạo khách: theo Pancake, hoặc ngày tạo trong ERP nếu khách được tạo tự động từ đơn */
const customerCreatedAt = sql<Date>`coalesce(${c.insertedAt}, ${c.createdAt})`;

/** Tổng hợp đơn hàng phía ERP theo khách — MỘT phép gom, nối MỘT lần (không câu con tương quan theo từng dòng). */
function orderAggregate(db: Db) {
  return db
    .select({
      customerId: o.customerId,
      ordersErp: sql<number>`count(*) filter (where ${o.stage} not in ('CANCELLED','DELETED'))`.as("orders_erp"),
      // Giao thành công / hoàn theo KẾT QUẢ THẬT của đơn (COD thực thu), không theo trạng thái Pancake.
      succeedErp: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')`.as("succeed_erp"),
      returnedErp: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))`.as("returned_erp"),
      revenueErp: sql<number>`coalesce(sum(case when ${o.stage} not in ('CANCELLED','DELETED') then ${o.totalPriceAfterDiscount} else 0 end), 0)`.as("revenue_erp"),
      lastOrderErp: sql<Date | string | null>`max(${o.insertedAt})`.as("last_order_erp"),
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG: đơn nhiều lần gửi không được cộng tiền nhiều lần (xem PRIMARY_ATTEMPT).
    .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, o.id), PRIMARY_ATTEMPT))
    .where(isNotNull(o.customerId))
    .groupBy(o.customerId)
    .as("agg");
}

type Agg = ReturnType<typeof orderAggregate>;

/**
 * Biểu thức "hiệu lực" của danh sách khách — CHỈ số của ERP.
 *
 * Bản trước lấy `greatest(bộ đếm Pancake, số ERP)` cho số đơn / thành công / hoàn / tổng mua: trạng
 * thái Pancake "Đã nhận" nâng được số giao thành công lên trên số mà `ORDER_OUTCOME` chứng minh được
 * (AGENTS §0.2 · §3.1, ORDER_OUTCOME.md mục 10), và nhóm "Có đơn hoàn" lọc theo số hoàn của Pancake.
 * Nay cùng luật với trang chi tiết (`getCustomerDetail`): bộ đếm Pancake không tham gia số, lọc, sắp xếp.
 * `lastOrderAt` vẫn lấy mốc muộn hơn — đó là một MỐC THỜI GIAN, không phải kết quả đơn.
 */
function effective(agg: Agg) {
  return {
    orders: sql<number>`coalesce(${agg.ordersErp}, 0)`,
    succeed: sql<number>`coalesce(${agg.succeedErp}, 0)`,
    returned: sql<number>`coalesce(${agg.returnedErp}, 0)`,
    amount: sql<number>`coalesce(${agg.revenueErp}, 0)`,
    lastOrderAt: sql<Date | string | null>`greatest(${c.lastOrderAt}, ${agg.lastOrderErp})`,
  };
}

export function customerSearchCondition(q: string): SQL | undefined {
  const term = q.trim();
  if (!term) return undefined;
  const like = `%${term}%`;
  const digits = term.replace(/\D/g, "");
  return or(ilike(c.name, like), ilike(c.phone, like), sql`array_to_string(${c.phones}, ',') ilike ${like}`, digits.length >= 4 ? ilike(c.phone, `%${digits}%`) : undefined, ilike(c.pancakeId, like));
}

/**
 * `extra`: điều kiện bổ sung do TẦNG METADATA dựng (bộ lọc mặc định của field custom trong danh sách
 * đã xuất bản — `customValuesFilterSql`). Vắng mặt ⇒ đúng điều kiện như trước Phase 2.
 */
export function customerListWhere(params: ListParams, agg: Agg, skip: string[] = [], extra?: SQL) {
  const conds: (SQL | undefined)[] = [extra];
  const { period, filters, q } = params;
  const eff = effective(agg);
  if (period.from) conds.push(gte(customerCreatedAt, period.from));
  if (period.to) conds.push(lte(customerCreatedAt, period.to));
  if (!skip.includes("province") && filters.province?.length) conds.push(inArray(c.province, filters.province));
  const tier = skip.includes("tier") ? undefined : filters.tier?.[0];
  if (tier === "repeat") conds.push(sql`${eff.orders} >= 3`);
  else if (tier === "once") conds.push(sql`${eff.orders} = 1`);
  else if (tier === "returned") conds.push(sql`${eff.returned} >= 1`);
  else if (tier === "none") conds.push(sql`${eff.orders} = 0`);
  conds.push(customerSearchCondition(q));
  const defined = conds.filter((x): x is SQL => Boolean(x));
  return defined.length ? and(...defined) : undefined;
}

/** `orderCount` / `succeedOrderCount` / `returnedOrderCount` / `purchasedAmount`: số của ERP (`effective`), KHÔNG phải cột Pancake cùng tên. */
export type CustomerListRow = {
  id: string;
  name: string;
  phone: string | null;
  phones: string[];
  level: string | null;
  tags: string[];
  province: string;
  address: string;
  isBlock: boolean;
  orderCount: number;
  succeedOrderCount: number;
  returnedOrderCount: number;
  purchasedAmount: number;
  lastOrderAt: Date | null;
  insertedAt: Date | null;
  lastSource: string | null;
};

export async function listCustomers(params: ListParams, extra?: SQL) {
  const db = await getDb();
  const agg = orderAggregate(db);
  const eff = effective(agg);
  const where = customerListWhere(params, agg, [], extra);
  const sortMap: Record<string, SQL | AnyPgColumn> = { orderCount: eff.orders, purchasedAmount: eff.amount, lastOrderAt: eff.lastOrderAt, name: c.name, insertedAt: customerCreatedAt };
  const sortExpr = sortMap[params.sort] ?? eff.lastOrderAt;
  const orderBy = params.dir === "asc" ? sql`${sortExpr} asc nulls first` : sql`${sortExpr} desc nulls last`;

  /*
    TẮT JIT — ĐO ĐƯỢC (ops perf-probe run 35889901709, 23/09/2026): câu lấy danh sách này, JIT bật
    7.463 ms [7.600 · 7.163 · 7.463], JIT tắt 100 ms [97 · 100 · 113] ⇒ 99 % là Postgres BIÊN DỊCH câu
    lệnh. Đường ứng dụng thật đo được 8.262 ms (`listCustomers`, trang /customers).

    Câu ĐẾM bên cạnh KHÔNG được EXPLAIN riêng — nói thẳng. Nó dùng ĐÚNG cùng phép nối, cùng bảng
    tổng hợp `agg` mang biểu thức kết quả đơn, và hai câu chạy SONG SONG: trang chờ câu CHẬM HƠN.
    Chỉ tắt JIT câu đã đo thì câu đếm vẫn giữ trang ở ~7 giây và bản vá không có tác dụng gì thấy
    được. `chayKhongJit` không đổi kết quả, nên bọc cả hai; mỗi câu một giao dịch riêng để giữ song song.
  */
  const [rows, [{ total }]] = await Promise.all([
    chayKhongJit(db, (tx) => tx
      .select({
        id: c.id,
        name: c.name,
        phone: c.phone,
        phones: c.phones,
        level: c.level,
        tags: c.tags,
        province: c.province,
        address: c.address,
        isBlock: c.isBlock,
        orderCount: eff.orders,
        succeedOrderCount: eff.succeed,
        returnedOrderCount: eff.returned,
        purchasedAmount: eff.amount,
        lastOrderAt: eff.lastOrderAt,
        insertedAt: customerCreatedAt,
      })
      .from(c)
      .leftJoin(agg, eq(agg.customerId, c.id))
      .where(where)
      .orderBy(orderBy, asc(c.name), asc(c.id))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize)),
    chayKhongJit(db, (tx) => tx.select({ total: count() }).from(c).leftJoin(agg, eq(agg.customerId, c.id)).where(where)),
  ]);

  const ids = rows.map((r) => r.id);
  const sources = ids.length
    ? await db.selectDistinctOn([o.customerId], { customerId: o.customerId, source: o.source }).from(o).where(inArray(o.customerId, ids)).orderBy(o.customerId, desc(o.insertedAt))
    : [];
  const sourceMap = Object.fromEntries(sources.map((s) => [s.customerId ?? "", s.source]));

  const mapped: CustomerListRow[] = rows.map((r) => ({
    ...r,
    orderCount: Number(r.orderCount ?? 0),
    succeedOrderCount: Number(r.succeedOrderCount ?? 0),
    returnedOrderCount: Number(r.returnedOrderCount ?? 0),
    purchasedAmount: Number(r.purchasedAmount ?? 0),
    lastOrderAt: toDate(r.lastOrderAt),
    insertedAt: toDate(r.insertedAt),
    lastSource: sourceMap[r.id] ?? null,
  }));
  return { rows: mapped, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

/** Số khách theo tỉnh / nhóm (cho bộ lọc) */
export async function customerFacets(params: ListParams, extra?: SQL) {
  const db = await getDb();
  const agg = orderAggregate(db);
  const eff = effective(agg);
  const base = customerListWhere({ ...params, filters: {} }, agg, [], extra);
  /*
    TẮT JIT — suy từ HÌNH DẠNG, chưa EXPLAIN riêng: cả hai câu nối đúng bảng tổng hợp `agg`
    (`ORDER_OUTCOME_FAST` trên mọi đơn có khách) mà câu danh sách `listCustomers` đã đo JIT bật
    7.463 ms ↔ tắt 100 ms. Trang chạy chúng song song với câu danh sách, nên còn một câu chưa tắt
    JIT là trang vẫn chờ nó. Lệnh đo sau deploy: docs/perf/vong-va-2026-09-24.md.
  */
  const [provinces, [tiers]] = await Promise.all([
    chayKhongJit(db, (tx) => tx
      .select({ value: c.province, count: count() })
      .from(c)
      .leftJoin(agg, eq(agg.customerId, c.id))
      .where(and(base, sql`${c.province} <> ''`))
      .groupBy(c.province)
      .orderBy(desc(count()), asc(c.province))
      .limit(64)),
    chayKhongJit(db, (tx) => tx
      .select({
        repeat: sql<number>`count(*) filter (where ${eff.orders} >= 3)`,
        once: sql<number>`count(*) filter (where ${eff.orders} = 1)`,
        returned: sql<number>`count(*) filter (where ${eff.returned} >= 1)`,
        none: sql<number>`count(*) filter (where ${eff.orders} = 0)`,
      })
      .from(c)
      .leftJoin(agg, eq(agg.customerId, c.id))
      .where(base)),
  ]);
  return {
    provinces: provinces.map((p) => ({ value: p.value, label: p.value, count: Number(p.count) })),
    tiers: [
      { value: "repeat", label: "Mua ≥3 lần", count: Number(tiers?.repeat ?? 0) },
      { value: "once", label: "Mua 1 lần", count: Number(tiers?.once ?? 0) },
      { value: "returned", label: "Có đơn hoàn", count: Number(tiers?.returned ?? 0) },
      { value: "none", label: "Chưa có đơn", count: Number(tiers?.none ?? 0) },
    ],
  };
}

export async function customerSummary(params: ListParams, extra?: SQL) {
  const db = await getDb();
  const agg = orderAggregate(db);
  const eff = effective(agg);
  const where = customerListWhere(params, agg, [], extra);
  const newSince = params.period.from ?? new Date(Date.now() - 30 * 86_400_000);
  const newUntil = params.period.to;
  // TẮT JIT — cùng lý do với `customerFacets` ngay trên: nối bảng tổng hợp `agg` mang kết quả đơn.
  const [row] = await chayKhongJit(db, (tx) => tx
    .select({
      total: count(),
      newInPeriod: sql<number>`count(*) filter (where ${customerCreatedAt} >= ${newSince}${newUntil ? sql` and ${customerCreatedAt} <= ${newUntil}` : sql``})`,
      repeat: sql<number>`count(*) filter (where ${eff.orders} >= 2)`,
      withOrders: sql<number>`count(*) filter (where ${eff.orders} >= 1)`,
      orders: sql<number>`coalesce(sum(${eff.orders}), 0)`,
      returned: sql<number>`coalesce(sum(${eff.returned}), 0)`,
      // Mẫu số tỷ lệ hoàn: đơn ĐÃ KẾT THÚC (thành công + hoàn), không phải mọi đơn đã lên.
      finished: sql<number>`coalesce(sum(${eff.succeed} + ${eff.returned}), 0)`,
      amount: sql<number>`coalesce(sum(${eff.amount}), 0)`,
    })
    .from(c)
    .leftJoin(agg, eq(agg.customerId, c.id))
    .where(where));
  return {
    total: Number(row?.total ?? 0),
    newInPeriod: Number(row?.newInPeriod ?? 0),
    newLabel: params.period.from ? params.period.label.toLowerCase() : "30 ngày qua",
    repeat: Number(row?.repeat ?? 0),
    withOrders: Number(row?.withOrders ?? 0),
    orders: Number(row?.orders ?? 0),
    returned: Number(row?.returned ?? 0),
    finished: Number(row?.finished ?? 0),
    amount: Number(row?.amount ?? 0),
  };
}

// ───────────────────────── Chi tiết khách hàng ─────────────────────────

const notCancelled = notInArray(o.stage, ["CANCELLED", "DELETED"]);

/**
 * MỘT câu gom cho mọi đơn của MỘT khách (dùng chỉ mục `orders_customer_idx`) — trang chi tiết khách và khối
 * «Khách hàng» của trang chi tiết đơn đọc CÙNG câu này, nên hai màn hình không thể nói hai số khác nhau.
 */
function customerOrderAggregate(db: Db, customerId: string) {
  return db
    .select({
      orders: sql<number>`count(*) filter (where ${notCancelled})`,
      allOrders: count(),
      succeed: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')`,
      returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))`,
      // CHƯA KẾT THÚC (danh sách sinh từ `OUTCOME_GROUP`, không gõ lại) — đứng NGOÀI mẫu số tỷ lệ.
      open: sql<number>`count(*) filter (where ${notCancelled} and ${ORDER_OUTCOME_FAST} in (${sql.raw(OPEN_OUTCOMES_SQL)}))`,
      // "Đang giao" là khẳng định về VỊ TRÍ kiện hàng ⇒ chỉ đúng kết quả `IN_TRANSIT` (đã có chứng từ bàn giao).
      inTransit: sql<number>`count(*) filter (where ${notCancelled} and ${ORDER_OUTCOME_FAST} = 'IN_TRANSIT')`,
      cancelled: sql<number>`count(*) filter (where ${o.stage} in ('CANCELLED','DELETED'))`,
      revenue: sql<number>`coalesce(sum(case when ${notCancelled} then ${o.totalPriceAfterDiscount} else 0 end), 0)`,
      // Doanh thu thành công chỉ khi "giao" mang chứng cứ tiền — đơn tay giao bằng phiếu đứng ngoài (G-ORDER).
      successRevenue: sql<number>`coalesce(sum(case when ${ORDER_OUTCOME_FAST} = 'DELIVERED' and ${REVENUE_RECOGNIZED_ON_DELIVERY} then ${o.totalPriceAfterDiscount} else 0 end), 0)`,
      firstOrderAt: sql<Date | string | null>`min(${o.insertedAt})`,
      lastOrderAt: sql<Date | string | null>`max(${o.insertedAt})`,
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG: đơn nhiều lần gửi không được cộng tiền nhiều lần (xem PRIMARY_ATTEMPT).
    .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, o.id), PRIMARY_ATTEMPT))
    .where(eq(o.customerId, customerId));
}

type CustomerOrderAgg = Awaited<ReturnType<typeof customerOrderAggregate>>[number] | undefined;

/**
 * Kết quả đơn của khách theo `ORDER_OUTCOME` — số duy nhất được gọi là "thành công / hoàn" (AGENTS §0.2 · §3.1).
 * Tỷ lệ trên đơn ĐÃ KẾT THÚC; chưa đơn nào kết thúc ⇒ `null` («—»), không phải 0% (AGENTS mục 42).
 */
function outcomeStatsOf(agg: CustomerOrderAgg) {
  const succeed = Number(agg?.succeed ?? 0);
  const returned = Number(agg?.returned ?? 0);
  const finished = succeed + returned;
  return {
    orders: Number(agg?.orders ?? 0),
    succeed,
    returned,
    finished,
    open: Number(agg?.open ?? 0),
    inTransit: Number(agg?.inTransit ?? 0),
    successRate: pctOrNull(succeed, finished),
    returnRate: pctOrNull(returned, finished),
  };
}

export type CustomerOutcomeStats = ReturnType<typeof outcomeStatsOf>;

/** Số đơn / thành công / hoàn của MỘT khách theo ERP — một câu gom, cho trang chi tiết đơn. */
export async function customerOutcomeStats(customerId: string): Promise<CustomerOutcomeStats> {
  const db = await getDb();
  const [agg] = await customerOrderAggregate(db, customerId);
  return outcomeStatsOf(agg);
}

export async function getCustomerDetail(id: string) {
  const db = await getDb();
  const customer = await db.query.customers.findFirst({ where: or(eq(c.id, id), eq(c.pancakeId, id)) });
  if (!customer) return null;

  const [[agg], orders, topProducts] = await Promise.all([
    customerOrderAggregate(db, customer.id),
    db.query.orders.findMany({
      where: eq(o.customerId, customer.id),
      orderBy: [desc(o.insertedAt)],
      limit: 100,
      columns: { id: true, systemId: true, source: true, stage: true, statusName: true, totalPriceAfterDiscount: true, shippingFee: true, moneyToCollect: true, prepaid: true, transferMoney: true, itemsCount: true, totalQuantity: true, insertedAt: true },
      with: { attempts: { columns: { id: true, attemptNo: true, direction: true, createdAt: true, vtpOrderNumber: true, trackingCode: true, stage: true, carrier: true, vtpStatusName: true, codStatus: true } }, items: { columns: { productName: true, variationDetail: true, quantity: true }, limit: 3 } },
    }),
    db
      .select({
        productId: schema.orderItems.productId,
        productName: schema.orderItems.productName,
        quantity: sql<number>`sum(${schema.orderItems.quantity})`,
        revenue: sql<number>`sum(${schema.orderItems.lineTotal})`,
        orders: sql<number>`count(distinct ${o.id})`,
        image: sql<string | null>`max(${schema.orderItems.image})`,
        lastAt: sql<Date | string | null>`max(${o.insertedAt})`,
      })
      .from(schema.orderItems)
      .innerJoin(o, eq(schema.orderItems.orderId, o.id))
      .where(and(eq(o.customerId, customer.id), notCancelled))
      .groupBy(schema.orderItems.productId, schema.orderItems.productName)
      .orderBy(desc(sql`sum(${schema.orderItems.quantity})`), desc(sql`sum(${schema.orderItems.lineTotal})`))
      .limit(8),
  ]);

  const lastCandidates = [toDate(customer.lastOrderAt), toDate(agg?.lastOrderAt)].filter((d): d is Date => Boolean(d));
  /*
    KẾT QUẢ ĐƠN CHỈ ĐI MỘT ĐƯỜNG: `ORDER_OUTCOME` (AGENTS §0.2 · §3.1). Bản trước lấy
    `Math.max(bộ đếm Pancake, số ERP)` cho số đơn / thành công / hoàn / tổng mua — tức trạng thái
    Pancake "Đã nhận" NÂNG được số giao thành công lên trên số mà chứng từ ĐVVC + luật tiền chứng
    minh được, đúng điều đặc tả mục 10 cấm. Bộ đếm Pancake vẫn trả ra, nhưng ở `pancake` riêng để
    trang in thành dòng "tham khảo" — không bao giờ trộn vào số của ERP.

    Tỷ lệ đặt trên đơn ĐÃ KẾT THÚC (thành công + hoàn): đơn đang giao / chưa gửi chưa có kết quả,
    đưa vào mẫu số là kéo tỷ lệ của khách vừa đặt đơn thứ hai xuống 50% một cách vô cớ. Chưa đơn nào
    kết thúc ⇒ `null` (in «—»), không phải 0% (AGENTS mục 42).
  */
  const outcome = outcomeStatsOf(agg);
  const orderCount = outcome.orders;
  const amount = Number(agg?.revenue ?? 0);
  const stats = {
    ...outcome,
    cancelled: Number(agg?.cancelled ?? 0),
    allOrders: Number(agg?.allOrders ?? 0),
    amount,
    successRevenue: Number(agg?.successRevenue ?? 0),
    firstOrderAt: toDate(agg?.firstOrderAt),
    lastOrderAt: lastCandidates.length ? new Date(Math.max(...lastCandidates.map((d) => d.getTime()))) : null,
    // Chưa có đơn (không huỷ) nào ⇒ CHƯA BIẾT, không phải 0 ₫.
    aov: orderCount > 0 ? Math.round(amount / orderCount) : null,
    /** Bộ đếm của Pancake — CHỈ để tham khảo, không tham gia phép tính nào ở trên. */
    pancake: { orders: customer.orderCount, succeed: customer.succeedOrderCount, returned: customer.returnedOrderCount, amount: customer.purchasedAmount },
  };

  return {
    ...customer,
    stats,
    // Một đơn có thể nhiều lần gửi — chọn lần ĐẠI DIỆN bằng đúng luật `PRIMARY_ATTEMPT` mà cột tiền dùng.
    orders: orders.map((d) => ({ ...d, shipment: vanDonDaiDien(d.attempts), noCodPayment: noCodPaymentState(d) })),
    topProducts: topProducts.map((p) => ({ ...p, quantity: Number(p.quantity ?? 0), revenue: Number(p.revenue ?? 0), orders: Number(p.orders ?? 0), lastAt: toDate(p.lastAt) })),
  };
}

export type CustomerDetail = NonNullable<Awaited<ReturnType<typeof getCustomerDetail>>>;
