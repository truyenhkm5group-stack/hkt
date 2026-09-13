import { listKey, memo } from "@/lib/cache";
import { and, count, desc, eq, exists, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME, SHIPMENT_DELIVERED, SHIPMENT_RETURNED } from "@/lib/queries/return-rate";
import type { CodStatus, ShipmentStage } from "@/db/schema";
import { COD_STATUS_LABEL, SHIPMENT_STAGE_LABEL, SHIPMENT_STAGE_ORDER } from "@/lib/constants/viettelpost";
import { CARE_STATUS_LABEL } from "@/lib/constants/care";
import type { ListParams } from "@/lib/search-params";
import { orderHasProductCode, variantIdsOfCodes } from "@/lib/queries/product-code";

export const SHIPMENT_SORTABLE = ["createdAt", "vtpStatusDate", "codAmount", "deliveredAt"];

/** Giá trị bộ lọc `final` / `linked` (đơn chọn) */
export const SHIPMENT_FINAL_OPTIONS = [
  { value: "active", label: "Đang theo dõi" },
  { value: "done", label: "Đã kết thúc" },
];
export const SHIPMENT_LINKED_OPTIONS = [
  { value: "pancake", label: "Có đơn Pancake" },
  { value: "external", label: "Ngoài Pancake" },
];

/** Sắp xếp theo cột, đẩy NULL xuống cuối ở cả hai chiều */
export function orderByNullsLast(column: AnyPgColumn, dir: "asc" | "desc") {
  return dir === "asc" ? sql`${column} asc nulls last` : sql`${column} desc nulls last`;
}

/** Tìm theo mã vận đơn / mã VTP / SĐT, tên người nhận / mã đơn Pancake */
export function shipmentSearchCondition(q: string): SQL | undefined {
  const term = q.trim();
  if (!term) return undefined;
  const like = `%${term}%`;
  const conds: SQL[] = [
    eq(schema.shipments.id, term),
    ilike(schema.shipments.trackingCode, like),
    ilike(schema.shipments.vtpOrderNumber, like),
    ilike(schema.shipments.orderReference, like),
    ilike(schema.shipments.receiverPhone, like),
    ilike(schema.shipments.receiverName, like),
    exists(sql`(select 1 from ${schema.orders} o where o.id = ${schema.shipments.orderId} and (o.bill_phone ilike ${like} or o.bill_full_name ilike ${like}))`),
  ];
  const numeric = Number(term.replace(/^#/, ""));
  if (Number.isFinite(numeric) && numeric > 0 && Number.isInteger(numeric)) {
    conds.push(exists(sql`(select 1 from ${schema.orders} o where o.id = ${schema.shipments.orderId} and o.system_id = ${numeric})`));
  }
  return or(...conds);
}

/**
 * Điều kiện lọc chung cho danh sách vận đơn (kỳ tính theo NGÀY TẠO VẬN ĐƠN).
 *
 * ─── MÃ HÀNG ĐI QUA QUAN HỆ, KHÔNG QUA CHUỖI ───
 *
 * Xem `lib/queries/product-code.ts`: SKU của bốn mã hàng đang bán có bốn quy ước đặt tên khác
 * nhau, và `sku ilike '%Q002%'` trả về 0 dòng cho chính mã bán chạy nhất. Ở đây mã hàng được
 * phân giải thành danh sách MẪU MÃ rồi hỏi `exists` trên `order_items` — không nhân dòng, và
 * không phụ thuộc vào cách ai đó gõ tên SKU.
 *
 * Hàm thành `async` vì phải tra danh mục mã hàng. Danh mục được đệm 5 phút nên hầu hết lượt gọi
 * không chạm CSDL.
 */
export async function shipmentListWhere(params: ListParams) {
  const conds: (SQL | undefined)[] = [];
  const { period, filters, q } = params;
  if (period.from) conds.push(gte(schema.shipments.createdAt, period.from));
  if (period.to) conds.push(lte(schema.shipments.createdAt, period.to));
  if (filters.stage?.length) conds.push(inArray(schema.shipments.stage, filters.stage as ShipmentStage[]));
  if (filters.carrier?.length) conds.push(inArray(schema.shipments.carrier, filters.carrier));
  if (filters.cod?.length) conds.push(inArray(schema.shipments.codStatus, filters.cod as CodStatus[]));
  if (filters.final?.includes("active")) conds.push(eq(schema.shipments.isFinal, false));
  else if (filters.final?.includes("done")) conds.push(eq(schema.shipments.isFinal, true));
  if (filters.linked?.includes("pancake")) conds.push(isNotNull(schema.shipments.orderId));
  else if (filters.linked?.includes("external")) conds.push(isNull(schema.shipments.orderId));
  /*
    MÃ HÀNG. Mã không tồn tại trong danh mục ⇒ `false`, tức KHÔNG DÒNG NÀO — đúng nghĩa "không có
    hàng nào mang mã này", khác hẳn với việc bỏ qua bộ lọc và trả về cả kho.
  */
  if (filters.product?.length) {
    const { variantIds } = await variantIdsOfCodes(filters.product);
    conds.push(orderHasProductCode(sql`${schema.shipments.orderId}`, variantIds));
  }

  // TRẠNG THÁI CHĂM SÓC — đọc từ `shipment_care`; vận đơn chưa có ca nào coi như `NEW`.
  if (filters.care?.length) {
    const muon = filters.care;
    const coNew = muon.includes("NEW");
    const khop = sql`exists (select 1 from ${schema.shipmentCare} sc where sc.shipment_id = ${schema.shipments.id} and sc.care_status in ${muon})`;
    conds.push(coNew ? or(khop, sql`not exists (select 1 from ${schema.shipmentCare} sc where sc.shipment_id = ${schema.shipments.id})`) : khop);
  }

  // NGƯỜI XỬ LÝ. `none` = chưa ai nhận.
  if (filters.owner?.length) {
    const ids = filters.owner.filter((x) => x !== "none");
    const coTrong = filters.owner.includes("none");
    const parts: SQL[] = [];
    if (ids.length) parts.push(sql`exists (select 1 from ${schema.shipmentCare} sc where sc.shipment_id = ${schema.shipments.id} and sc.owner_id in ${ids})`);
    if (coTrong) parts.push(sql`not exists (select 1 from ${schema.shipmentCare} sc where sc.shipment_id = ${schema.shipments.id} and sc.owner_id is not null)`);
    if (parts.length) conds.push(or(...parts));
  }

  // NGUỒN ĐƠN (Pancake `orders.source`).
  if (filters.source?.length) {
    conds.push(sql`exists (select 1 from ${schema.orders} o where o.id = ${schema.shipments.orderId} and o.source in ${filters.source})`);
  }

  conds.push(shipmentSearchCondition(q));
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

const orderColumns = { id: true, systemId: true, billFullName: true, billPhone: true, source: true, totalPriceAfterDiscount: true, stage: true, prepaid: true, transferMoney: true } as const;

export async function listShipments(params: ListParams) {
  const db = await getDb();
  const where = await shipmentListWhere(params);
  const sortMap: Record<string, AnyPgColumn> = {
    createdAt: schema.shipments.createdAt,
    vtpStatusDate: schema.shipments.vtpStatusDate,
    codAmount: schema.shipments.codAmount,
    deliveredAt: schema.shipments.deliveredAt,
  };
  const sortColumn = sortMap[params.sort] ?? schema.shipments.createdAt;

  const [rows, [{ total }]] = await Promise.all([
    db.query.shipments.findMany({
      where,
      orderBy: [orderByNullsLast(sortColumn, params.dir), desc(schema.shipments.id)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      columns: {
        id: true,
        orderId: true,
        carrier: true,
        trackingCode: true,
        vtpOrderNumber: true,
        orderReference: true,
        // Lần gửi thứ mấy và chiều nào — nếu không nạp thì bảng không thể hiện được, và người vận
        // hành nhìn ba dòng cùng một đơn mà không biết chúng liên quan với nhau thế nào.
        attemptNo: true,
        direction: true,
        stage: true,
        vtpStatusName: true,
        vtpStatusDate: true,
        vtpLocation: true,
        codAmount: true,
        codCollected: true,
        codStatementRef: true,
        shippingFee: true,
        codStatus: true,
        receiverName: true,
        receiverPhone: true,
        receiverAddress: true,
        pickedUpAt: true,
        deliveredAt: true,
        returnedAt: true,
        isFinal: true,
        lastVtpSyncAt: true,
        createdAt: true,
      },
      with: { order: { columns: orderColumns } },
    }),
    db.select({ total: count() }).from(schema.shipments).where(where),
  ]);

  // MỘT nguồn kết luận duy nhất: dùng đúng biểu thức ORDER_OUTCOME mà mọi báo cáo dùng, thay vì
  // tính lại theo tiền ở phía trình duyệt. Trước đây trang Vận đơn có bộ luật riêng nên cùng một
  // vận đơn hiện "hoàn" ở đây mà "giao thành công" ở báo cáo (ca thật PKE1508909064).
  const ids = rows.map((r) => r.id);
  const outcomeRows = ids.length
    ? await db
        .select({ id: schema.shipments.id, outcome: ORDER_OUTCOME })
        .from(schema.shipments)
        .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
        .where(inArray(schema.shipments.id, ids))
    : [];
  const outcomeById = new Map(outcomeRows.map((r) => [r.id, r.outcome]));
  const withOutcome = rows.map((r) => ({ ...r, outcome: outcomeById.get(r.id) ?? null }));
  return { rows: withOutcome, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type ShipmentListRow = Awaited<ReturnType<typeof listShipments>>["rows"][number];

/** Số vận đơn theo giai đoạn / ĐVVC / trạng thái COD trong kỳ (cho bộ lọc) */
export async function shipmentFacets(params: ListParams) {
  return memo(`shipmentFacets:${listKey(params, false)}`, 30_000, () => shipmentFacetsUncached(params));
}

async function shipmentFacetsUncached(params: ListParams) {
  const db = await getDb();
  const base = await shipmentListWhere({ ...params, filters: {} });
  const [stages, carriers, cods, finals, linked] = await Promise.all([
    db.select({ value: schema.shipments.stage, count: count() }).from(schema.shipments).where(base).groupBy(schema.shipments.stage),
    db.select({ value: schema.shipments.carrier, count: count() }).from(schema.shipments).where(base).groupBy(schema.shipments.carrier).orderBy(desc(count())),
    db.select({ value: schema.shipments.codStatus, count: count() }).from(schema.shipments).where(base).groupBy(schema.shipments.codStatus),
    db.select({ value: schema.shipments.isFinal, count: count() }).from(schema.shipments).where(base).groupBy(schema.shipments.isFinal),
    db
      .select({ value: sql<boolean>`${schema.shipments.orderId} is null`, count: count() })
      .from(schema.shipments)
      .where(base)
      .groupBy(sql`${schema.shipments.orderId} is null`),
  ]);
  const stageCount = Object.fromEntries(stages.map((s) => [s.value, Number(s.count)]));
  const codCount = Object.fromEntries(cods.map((s) => [s.value, Number(s.count)]));
  const finalCount = { active: 0, done: 0 };
  for (const f of finals) finalCount[f.value ? "done" : "active"] += Number(f.count);
  const linkedCount = { pancake: 0, external: 0 };
  for (const l of linked) linkedCount[l.value ? "external" : "pancake"] += Number(l.count);
  /*
    MÃ HÀNG. Đếm theo VẬN ĐƠN (`count(distinct s.id)`), không theo dòng hàng: một đơn ba dòng Q002
    vẫn là một vận đơn. Danh mục chỉ có 6 mã nên truy vấn này rẻ, và nó chạy trên CÙNG mệnh đề nền
    với các mặt khác để con số trong ô chọn khớp với con số trong bảng.
  */
  const productRows = await db
    .select({ value: schema.products.customId, name: schema.products.name, count: sql<number>`count(distinct ${schema.shipments.id})::int` })
    .from(schema.shipments)
    .innerJoin(schema.orderItems, sql`${schema.orderItems.orderId} = ${schema.shipments.orderId} and ${schema.orderItems.isBonus} = false`)
    .innerJoin(schema.productVariants, sql`${schema.productVariants.id} = ${schema.orderItems.variantId}`)
    .innerJoin(schema.products, sql`${schema.products.id} = ${schema.productVariants.productId} and coalesce(${schema.products.customId}, '') <> ''`)
    .where(base)
    .groupBy(schema.products.customId, schema.products.name)
    .orderBy(desc(sql`count(distinct ${schema.shipments.id})`));

  const careRows = await db
    .select({ value: schema.shipmentCare.careStatus, count: count() })
    .from(schema.shipments)
    .innerJoin(schema.shipmentCare, sql`${schema.shipmentCare.shipmentId} = ${schema.shipments.id}`)
    .where(base)
    .groupBy(schema.shipmentCare.careStatus);

  const ownerRows = await db
    .select({ value: schema.shipmentCare.ownerId, name: schema.users.name, count: count() })
    .from(schema.shipments)
    .innerJoin(schema.shipmentCare, sql`${schema.shipmentCare.shipmentId} = ${schema.shipments.id} and ${schema.shipmentCare.ownerId} is not null`)
    .leftJoin(schema.users, sql`${schema.users.id} = ${schema.shipmentCare.ownerId}`)
    .where(base)
    .groupBy(schema.shipmentCare.ownerId, schema.users.name)
    .orderBy(desc(count()));

  const [chuaAiNhan] = await db
    .select({ count: count() })
    .from(schema.shipments)
    .where(and(base, sql`not exists (select 1 from ${schema.shipmentCare} sc where sc.shipment_id = ${schema.shipments.id} and sc.owner_id is not null)`));

  const sourceRows = await db
    .select({ value: schema.orders.source, count: count() })
    .from(schema.shipments)
    .innerJoin(schema.orders, sql`${schema.orders.id} = ${schema.shipments.orderId}`)
    .where(base)
    .groupBy(schema.orders.source)
    .orderBy(desc(count()));

  const codOrder: CodStatus[] = ["PENDING", "COLLECTED", "RECONCILED", "PAID_TO_BANK", "DISPUTED", "NOT_APPLICABLE"];
  return {
    products: productRows.filter((r) => r.value).map((r) => ({ value: r.value as string, label: `${r.value} · ${r.name}`, count: Number(r.count) })),
    careStatuses: careRows.map((r) => ({ value: r.value, label: CARE_STATUS_LABEL[r.value as keyof typeof CARE_STATUS_LABEL] ?? r.value, count: Number(r.count) })),
    owners: [
      ...(Number(chuaAiNhan?.count ?? 0) > 0 ? [{ value: "none", label: "Chưa ai nhận", count: Number(chuaAiNhan!.count) }] : []),
      ...ownerRows.filter((r) => r.value).map((r) => ({ value: r.value as string, label: r.name ?? "(không rõ)", count: Number(r.count) })),
    ],
    sources: sourceRows.filter((r) => r.value).map((r) => ({ value: r.value as string, label: r.value as string, count: Number(r.count) })),
    stages: SHIPMENT_STAGE_ORDER.map((stage) => ({ value: stage, label: SHIPMENT_STAGE_LABEL[stage], count: stageCount[stage] ?? 0 })).filter((s) => s.count > 0 || params.filters.stage?.includes(s.value)),
    carriers: carriers.filter((c) => c.value).map((c) => ({ value: c.value, label: c.value, count: Number(c.count) })),
    codStatuses: codOrder.map((status) => ({ value: status, label: COD_STATUS_LABEL[status], count: codCount[status] ?? 0 })).filter((s) => s.count > 0 || params.filters.cod?.includes(s.value)),
    finals: SHIPMENT_FINAL_OPTIONS.map((o) => ({ ...o, count: finalCount[o.value as keyof typeof finalCount] })),
    linked: SHIPMENT_LINKED_OPTIONS.map((o) => ({ ...o, count: linkedCount[o.value as keyof typeof linkedCount] })),
  };
}

export async function shipmentSummary(params: ListParams) {
  return memo(`shipmentSummary:${listKey(params)}`, 30_000, () => shipmentSummaryUncached(params));
}

async function shipmentSummaryUncached(params: ListParams) {
  const db = await getDb();
  const where = await shipmentListWhere(params);
  const s = schema.shipments;
  const [row] = await db
    .select({
      total: count(),
      codPending: sql<number>`coalesce(sum(case when ${s.codStatus} = 'PENDING' then ${s.codAmount} else 0 end), 0)`,
      codPendingCount: sql<number>`coalesce(sum(case when ${s.codStatus} = 'PENDING' then 1 else 0 end), 0)`,
      delivering: sql<number>`coalesce(sum(case when ${s.stage} in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY') then 1 else 0 end), 0)`,
      // Giao thành công / hoàn tính theo DOANH THU COD (>100K là thành công, ≤100K là hàng hoàn) chứ không chỉ theo trạng thái VTP:
      // vận đơn chiều về và đơn khách trả hàng đều được Viettel Post ghi "Giao thành công" nhưng không thu được tiền.
      delivered: sql<number>`coalesce(sum(case when ${SHIPMENT_DELIVERED} then 1 else 0 end), 0)`,
      failed: sql<number>`coalesce(sum(case when ${s.stage} = 'DELIVERY_FAILED' then 1 else 0 end), 0)`,
      returning: sql<number>`coalesce(sum(case when ${SHIPMENT_RETURNED} then 1 else 0 end), 0)`,
    })
    .from(s)
    .leftJoin(schema.orders, eq(schema.orders.id, s.orderId))
    .where(where);
  return {
    total: Number(row?.total ?? 0),
    codPending: Number(row?.codPending ?? 0),
    codPendingCount: Number(row?.codPendingCount ?? 0),
    delivering: Number(row?.delivering ?? 0),
    delivered: Number(row?.delivered ?? 0),
    failed: Number(row?.failed ?? 0),
    returning: Number(row?.returning ?? 0),
  };
}

/** Chi tiết vận đơn theo id ERP, mã VTP hoặc mã vận đơn */
export async function getShipmentDetail(id: string) {
  const db = await getDb();
  const shipment = await db.query.shipments.findFirst({
    where: or(eq(schema.shipments.id, id), eq(schema.shipments.vtpOrderNumber, id), eq(schema.shipments.trackingCode, id)),
    with: {
      order: {
        columns: { ...orderColumns, shipFullAddress: true, shipFullName: true, shipPhone: true, shipAddress: true, cod: true, note: true, moneyToCollect: true, itemsCount: true, totalQuantity: true, insertedAt: true, statusName: true },
        with: { items: { columns: { id: true, productName: true, variationDetail: true, sku: true, quantity: true, unitPrice: true, lineTotal: true, image: true, returnQuantity: true } } },
      },
      codBatch: true,
      events: { orderBy: [desc(schema.shipmentEvents.occurredAt)] },
    },
  });
  return shipment ?? null;
}

export type ShipmentDetail = NonNullable<Awaited<ReturnType<typeof getShipmentDetail>>>;

export type OrderListGap = { from: string; to: string; noStatus: number; noCode: number; cod: number };

/**
 * KHOẢNG NGÀY CẦN XUẤT "DANH SÁCH VẬN ĐƠN" TỪ VIETTEL POST.
 *
 * Khác với bảng kê (tiền), tệp này mang TRẠNG THÁI GIAO HÀNG. ERP cần nó cho hai nhóm vận đơn:
 *  · chưa có trạng thái thật từ Viettel Post — trạng thái hiện tại chỉ suy từ Pancake, mà quy tắc
 *    của shop là xung đột thì tính theo Viettel Post;
 *  · chưa có mã vận đơn — đơn tạo thẳng trên web Viettel Post, ERP ghép mã theo SĐT người nhận
 *    khi nạp tệp.
 *
 * Đối chiếu qua API không thay thế được: tài khoản API của shop không sở hữu các vận đơn này.
 * Vì vậy màn hình nhập liệu phải nói thẳng cần xuất tệp cho khoảng ngày nào thay vì để chủ shop
 * tự đoán.
 */
export async function orderListCoverage(): Promise<{ ranges: OrderListGap[]; totalNoStatus: number; totalNoCode: number }> {
  const db = await getDb();
  const s = schema.shipments;
  const NO_CODE = sql`coalesce(nullif(${s.vtpOrderNumber}, ''), nullif(${s.trackingCode}, '')) is null`;
  const NO_STATUS = sql`(${s.isFinal} = false and ${s.vtpStatus} is null)`;
  const DAY = sql`coalesce(${s.vtpStatusDate}, ${s.createdAt})::date`;

  const days = await db
    .select({
      day: sql<string>`${DAY}::text`,
      noStatus: sql<number>`count(*) filter (where ${NO_STATUS})`,
      noCode: sql<number>`count(*) filter (where ${NO_CODE})`,
      cod: sql<number>`coalesce(sum(${s.codAmount}), 0)`,
    })
    .from(s)
    .where(sql`(${NO_STATUS} or ${NO_CODE})`)
    .groupBy(DAY)
    .orderBy(DAY);

  // Gom ngày liền nhau (cách nhau ≤ 3 ngày) để chủ shop xuất một tệp cho cả khoảng.
  const ranges: OrderListGap[] = [];
  for (const d of days) {
    const day = String(d.day);
    const last = ranges[ranges.length - 1];
    if (last && (Date.parse(day) - Date.parse(last.to)) / 86_400_000 <= 3) {
      last.to = day;
      last.noStatus += Number(d.noStatus);
      last.noCode += Number(d.noCode);
      last.cod += Number(d.cod);
    } else {
      ranges.push({ from: day, to: day, noStatus: Number(d.noStatus), noCode: Number(d.noCode), cod: Number(d.cod) });
    }
  }

  return {
    ranges,
    totalNoStatus: ranges.reduce((a, r) => a + r.noStatus, 0),
    totalNoCode: ranges.reduce((a, r) => a + r.noCode, 0),
  };
}
