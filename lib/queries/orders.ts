import { listKey, memo } from "@/lib/cache";
import { and, asc, count, desc, eq, exists, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { vanDonDaiDien } from "@/lib/constants/shipment-pick";
import { liveLineUnitCost, liveOrderCogs } from "@/lib/constants/live-cogs";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { manualPaymentStates } from "@/lib/queries/order-payments";
import type { OrderStage } from "@/db/schema";
import { ORDER_STAGE_LABEL, ORDER_STAGE_ORDER, pancakeConversationUrl } from "@/lib/constants/pancake";
import { isManualOrderId, MANUAL_ORDER_ID_PREFIX, manualOrderGaps } from "@/lib/constants/manual-orders";
import { noCodPaymentState } from "@/lib/constants/no-cod-payment";
import { reviewFromValue } from "@/lib/constants/order-review";
import { canUseModule } from "@/lib/platform/capabilities";
import type { ListParams } from "@/lib/search-params";
import { loadAlertConfig } from "@/lib/alerts/config";
import { assessCustomerRisk } from "@/lib/alerts/risk";

export const ORDER_SORTABLE = ["insertedAt", "total", "systemId", "updatedAtExternal", "status"];

export function orderSearchCondition(q: string): SQL | undefined {
  const term = q.trim();
  if (!term) return undefined;
  const like = `%${term}%`;
  const numeric = Number(term.replace(/^#/, ""));
  const conds: SQL[] = [ilike(schema.orders.billPhone, like), ilike(schema.orders.billFullName, like), ilike(schema.orders.shipFullName, like), eq(schema.orders.id, term.replace(/^#/, ""))];
  if (Number.isFinite(numeric) && numeric > 0 && Number.isInteger(numeric)) conds.push(eq(schema.orders.systemId, numeric));
  if (term.length >= 5) {
    conds.push(
      exists(
        getShipmentSearch(like),
      ),
    );
    conds.push(exists(sql`(select 1 from ${schema.orderItems} oi where oi.order_id = ${schema.orders.id} and (oi.sku ilike ${like} or oi.product_name ilike ${like}))`));
  }
  return or(...conds);
}

import { ORDER_BUCKET_SCALAR } from "@/lib/queries/fulfillment-buckets";

function getShipmentSearch(like: string) {
  return sql`(select 1 from ${schema.shipments} s where s.order_id = ${schema.orders.id} and (s.tracking_code ilike ${like} or s.vtp_order_number ilike ${like}))`;
}

/**
 * ĐƠN CẦN NGƯỜI KIỂM (chủ shop 08/10/2026 — `lib/constants/order-review.ts`): đơn tay `erp-` đang mang `raw.review` (khách báo
 * huỷ · địa chỉ chưa ghép xã). MỘT biểu thức cho bộ lọc và con số trên nhãn bộ lọc. Đơn đồng bộ không bao giờ khớp.
 */
export const ORDER_NEEDS_REVIEW = sql`(${schema.orders.id} like ${`${MANUAL_ORDER_ID_PREFIX}%`} and jsonb_typeof(${schema.orders.raw}->'review') = 'object')`;

export function orderListWhere(params: ListParams, opts: { ignoreAddressFilter?: boolean; ignoreReviewFilter?: boolean } = {}) {
  const conds: (SQL | undefined)[] = [];
  const { period, q } = params;
  const filters: Record<string, string[] | undefined> = { ...params.filters, ...(opts.ignoreAddressFilter ? { address: undefined } : {}), ...(opts.ignoreReviewFilter ? { review: undefined } : {}) };
  if (period.from) conds.push(gte(schema.orders.insertedAt, period.from));
  if (period.to) conds.push(lte(schema.orders.insertedAt, period.to));
  if (filters.stage?.length) conds.push(inArray(schema.orders.stage, filters.stage as OrderStage[]));
  if (filters.source?.length) conds.push(inArray(schema.orders.source, filters.source));
  if (filters.carrier?.length) conds.push(exists(sql`(select 1 from ${schema.shipments} s where s.order_id = ${schema.orders.id} and s.carrier in ${filters.carrier})`));
  if (filters.seller?.length) conds.push(inArray(schema.orders.sellerName, filters.seller));
  if (filters.tag?.length) conds.push(sql`${schema.orders.tags} && ${sql.raw(`ARRAY[${filters.tag.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")}]::text[]`)}`);
  // Pancake chỉ giao được khi đã ghép địa chỉ khách vào đơn vị hành chính (3 cấp cũ hoặc 2 cấp mới
  // từ 01/07/2025). Không ghép được thì `province_name` rỗng và đơn đứng im ở POS với dòng "Vui lòng
  // cung cấp địa chỉ cần chuẩn hoá" — nhân viên phải mở đơn, hỏi lại khách rồi chọn tay.
  if (filters.address?.includes("unnormalized")) conds.push(sql`coalesce(${schema.orders.shipProvince}, '') = ''`);
  if (filters.address?.includes("normalized")) conds.push(sql`coalesce(${schema.orders.shipProvince}, '') <> ''`);
  if (filters.review?.includes("flagged")) conds.push(ORDER_NEEDS_REVIEW);
  if (filters.payment?.includes("cod")) conds.push(sql`${schema.orders.moneyToCollect} > 0`);
  if (filters.payment?.includes("prepaid")) conds.push(sql`${schema.orders.moneyToCollect} = 0`);
  /*
    RỔ GIAO VẬN THEO CHỨNG TỪ ĐVVC — dùng CHUNG biểu thức với thẻ đếm trên trang chủ.

    Bấm vào thẻ "Đã gửi" phải mở ra ĐÚNG chừng ấy dòng. Cách chắc chắn duy nhất để hai con số không
    bao giờ lệch là hai nơi dùng cùng MỘT biểu thức, chứ không phải hai câu lệnh cùng ý.
  */
  if (filters.fulfillment?.length) conds.push(sql`${ORDER_BUCKET_SCALAR} in ${filters.fulfillment}`);
  conds.push(orderSearchCondition(q));
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listOrders(params: ListParams) {
  const db = await getDb();
  const where = orderListWhere(params);
  const sortMap: Record<string, AnyPgColumn> = {
    insertedAt: schema.orders.insertedAt,
    total: schema.orders.totalPriceAfterDiscount,
    systemId: schema.orders.systemId,
    updatedAtExternal: schema.orders.updatedAtExternal,
    status: schema.orders.status,
  };
  const sortColumn = sortMap[params.sort] ?? schema.orders.insertedAt;
  const orderBy = params.dir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const [rowsRaw, [{ total }], riskCfg] = await Promise.all([
    db.query.orders.findMany({
      where,
      orderBy: [orderBy, desc(schema.orders.id)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      columns: {
        id: true,
        systemId: true,
        status: true,
        statusName: true,
        stage: true,
        billFullName: true,
        billPhone: true,
        shipProvince: true,
        shipCommune: true,
        shipPhone: true,
        shipAddress: true,
        source: true,
        totalPriceAfterDiscount: true,
        shippingFee: true,
        moneyToCollect: true,
        prepaid: true,
        transferMoney: true,
        cogs: true,
        itemsCount: true,
        totalQuantity: true,
        sellerName: true,
        tags: true,
        insertedAt: true,
        updatedAtExternal: true,
        lastUpdateStatusAt: true,
        pageId: true,
        conversationId: true,
      },
      // Cờ CẦN NGƯỜI KIỂM — chỉ khoá `review` của đơn tay, không kéo cả `raw` (payload Pancake) về trang danh sách.
      extras: { review: sql<unknown>`case when ${schema.orders.id} like ${`${MANUAL_ORDER_ID_PREFIX}%`} then ${schema.orders.raw}->'review' end`.as("review") },
      with: {
        // MỌI lần gửi rồi CHỌN lần đại diện — cùng luật với `PRIMARY_ATTEMPT` mà cột tiền dùng.
        attempts: { columns: { id: true, attemptNo: true, direction: true, createdAt: true, vtpOrderNumber: true, trackingCode: true, stage: true, carrier: true, codStatus: true, vtpStatusName: true } },
        items: { columns: { productName: true, variationDetail: true, quantity: true, image: true }, limit: 3 },
        // Lịch sử khách theo Pancake — đủ để chấm rủi ro ngay trên dòng.
        customer: { columns: { succeedOrderCount: true, returnedOrderCount: true, isBlock: true } },
      },
    }),
    db.select({ total: count() }).from(schema.orders).where(where),
    loadAlertConfig(),
  ]);

  /*
    CỜ RỦI RO NGAY TRÊN DÒNG. Trước đây khách có lịch sử hoàn cao chỉ lộ ra khi MỞ chi tiết đơn —
    người CSKH duyệt 50 đơn mỗi sáng thì không mở 50 trang. Cùng công thức với chi tiết đơn và luật
    cảnh báo (`assessCustomerRisk`), chỉ khác là ở đây dùng số Pancake của khách (không tra thêm lịch
    sử ERP theo SĐT cho từng dòng); chi tiết đơn vẫn có bản đầy đủ.
  */
  /*
    TRẠNG THÁI THANH TOÁN CỦA ĐƠN TAY — chứng từ `order_payments`, tính lúc đọc (ORDER_OUTCOME.md mục 11). Một câu gộp cho
    các đơn tay CỦA TRANG; trang không có đơn tay (tổ chức nhà) ⇒ không chạy câu nào. Đơn khác ⇒ `null` (không áp dụng).
  */
  const payStates = await manualPaymentStates(rowsRaw);
  const [chats, inboxOn] = await Promise.all([orderChatThreads(rowsRaw.filter((r) => isManualOrderId(r.id)).map((r) => r.id)), salesInboxEnabled()]);
  const rows = rowsRaw.map((r) => {
    const c = r.customer;
    const risk = c ? assessCustomerRisk({ succeed: c.succeedOrderCount ?? 0, returned: c.returnedOrderCount ?? 0, isBlock: Boolean(c.isBlock) }, riskCfg) : null;
    /*
      MỘT CHỖ TÍNH, MỌI CỘT ĐỌC LẠI.

      Cột tiền của trang này đi qua `PRIMARY_ATTEMPT` ở tầng SQL; `vanDonDaiDien` là bản TypeScript
      của đúng luật ấy. Để mỗi cột tự chọn lần gửi là mở đường cho dòng nói hai điều khác nhau.
    */
    const chat = chatLinkOf(chats.get(r.id), inboxOn, { pageId: r.pageId, conversationId: r.conversationId });
    // Chỗ còn thiếu của đơn tay — nút nhanh «Xác nhận đơn» không chốt đơn thiếu xã / SĐT / địa chỉ, dẫn sang sửa đơn (review #675, L2).
    const gaps = isManualOrderId(r.id) ? manualOrderGaps({ phone: r.shipPhone, address: r.shipAddress, province: r.shipProvince, ward: r.shipCommune }, r.itemsCount) : [];
    return { ...r, review: reviewFromValue(r.review)?.entries ?? [], gaps, shipment: vanDonDaiDien(r.attempts), risk: risk?.risky ? { severity: risk.severity, reasons: risk.reasons } : null, payment: payStates.get(r.id) ?? null, noCodPayment: noCodPaymentState(r), chatUrl: chat?.href ?? null, chatInternal: chat?.internal ?? false };
  });

  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type OrderListRow = Awaited<ReturnType<typeof listOrders>>["rows"][number];

/**
 * HỘI THOẠI FANPAGE CỦA ĐƠN TAY (đơn bot chốt · đơn ghi từ hội thoại nhân viên chốt — lib/sales-chatbot/*). Đơn `erp-…` không
 * mang `page_id` / `conversation_id` (chỉ đơn đồng bộ Pancake mới có) nên tra NGƯỢC trong `sales_chat_conversations`: đơn
 * nháp / đã chốt hiện tại, đơn của các lượt mua trước (`state.pastOrders`) và đơn ghi từ hội thoại (`state.orderSync.orders`).
 * Một câu cho cả trang; không đơn tay ⇒ không chạy câu nào.
 */
export type OrderChatThread = { conversationId: string; channel: string; pageId: string | null; threadId: string | null };

export async function orderChatThreads(orderIds: readonly string[]): Promise<Map<string, OrderChatThread>> {
  const out = new Map<string, OrderChatThread>();
  if (!orderIds.length) return out;
  const db = await getDb();
  const c = schema.salesChatConversations;
  const o = schema.orders;
  const ids = sql`array[${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)}]::text[]`;
  // Khoá CỨNG trước: `orders.sales_conversation_id` (đơn bot chốt / nhân viên tạo trong khung chat — mọi kênh, cả Messenger
  // trực tiếp, Zalo, chat web). Tra ngược trong `state` của hội thoại là đường cũ cho đơn ghi trước khi có cột đó.
  const direct = await db.select({ orderId: o.id, conversationId: o.salesConversationId }).from(o).where(and(inArray(o.id, [...orderIds]), sql`${o.salesConversationId} is not null`));
  const directConv = new Map(direct.map((d) => [d.conversationId as string, d.orderId]));
  const has = (path: string) => sql`exists (select 1 from jsonb_array_elements(coalesce(${c.state}->${sql.raw(path)}, '[]'::jsonb)) e where e->>'orderId' = any(${ids}))`;
  const legacy = and(
    eq(c.channel, "FANPAGE"),
    sql`${c.pageId} is not null and ${c.threadId} is not null`,
    sql`(${c.orderId} = any(${ids}) or ${c.draftOrderId} = any(${ids}) or ${c.state}->'confirmed'->>'orderId' = any(${ids}) or ${has("'pastOrders'")} or ${has("'orderSync'->'orders'")})`,
  );
  const rows = await db
    .select({ id: c.id, channel: c.channel, pageId: c.pageId, threadId: c.threadId, orderId: c.orderId, draftOrderId: c.draftOrderId, state: c.state })
    .from(c)
    .where(and(sql`${c.channel} <> 'TEST'`, directConv.size ? or(inArray(c.id, [...directConv.keys()]), legacy) : legacy));
  const wanted = new Set(orderIds);
  const put = (orderId: string, r: (typeof rows)[number]) => {
    if (!out.has(orderId)) out.set(orderId, { conversationId: r.id, channel: r.channel, pageId: r.pageId, threadId: r.threadId });
  };
  for (const r of rows) {
    const d = directConv.get(r.id);
    if (d) put(d, r);
  }
  for (const r of rows) {
    if (r.channel !== "FANPAGE" || !r.pageId || !r.threadId) continue;
    const st = (r.state ?? {}) as { confirmed?: { orderId?: string | null }; pastOrders?: { orderId?: string | null }[]; orderSync?: { orders?: { orderId?: string }[] } };
    const linked = [r.orderId, r.draftOrderId, st.confirmed?.orderId, ...(st.pastOrders ?? []).map((p) => p.orderId), ...(st.orderSync?.orders ?? []).map((x) => x.orderId)];
    for (const id of linked) if (id && wanted.has(id)) put(id, r);
  }
  return out;
}

export type ChatLink = { href: string; internal: boolean };

/**
 * Lối mở hội thoại của MỘT đơn — một chỗ cho danh sách lẫn chi tiết đơn. Tổ chức có Hộp thư khách (module AI bán hàng) ⇒ mở
 * hội thoại NGAY TRONG ERP (đúng cho mọi kênh — link `pancake.vn` sai hẳn với hội thoại Messenger trực tiếp vì mã luồng là
 * PSID của Meta). Không có hộp thư ⇒ link Pancake như trước. Đơn đồng bộ từ Pancake giữ link Pancake mang sẵn trên đơn.
 */
export function chatLinkOf(chat: OrderChatThread | undefined, inboxOn: boolean, pancake: { pageId: string | null; conversationId: string | null }): ChatLink | null {
  if (chat && inboxOn) return { href: `/ai/sales-chatbot/inbox?c=${encodeURIComponent(chat.conversationId)}`, internal: true };
  const url = chat ? (chat.channel === "FANPAGE" ? pancakeConversationUrl(chat.pageId, chat.threadId) : null) : pancakeConversationUrl(pancake.pageId, pancake.conversationId);
  return url ? { href: url, internal: false } : null;
}

/** Tổ chức đang ngữ cảnh có Hộp thư khách không (module AI bán hàng). */
export async function salesInboxEnabled(): Promise<boolean> {
  return canUseModule("ai_sales");
}

/** Số đơn theo giai đoạn / nguồn / ĐVVC trong kỳ (cho bộ lọc) */
export async function orderFacets(params: ListParams) {
  return memo(`orderFacets:${listKey(params, false)}`, 30_000, () => orderFacetsUncached(params));
}

async function orderFacetsUncached(params: ListParams) {
  const db = await getDb();
  const base = orderListWhere({ ...params, filters: {}, q: params.q });
  const [stages, sources, carriers, sellers] = await Promise.all([
    db.select({ value: schema.orders.stage, count: count() }).from(schema.orders).where(base).groupBy(schema.orders.stage),
    db.select({ value: schema.orders.source, count: count() }).from(schema.orders).where(base).groupBy(schema.orders.source).orderBy(desc(count())),
    db
      .select({ value: schema.shipments.carrier, count: count() })
      .from(schema.shipments)
      .innerJoin(schema.orders, eq(schema.shipments.orderId, schema.orders.id))
      .where(base)
      .groupBy(schema.shipments.carrier)
      .orderBy(desc(count())),
    db.select({ value: schema.orders.sellerName, count: count() }).from(schema.orders).where(and(base, sql`${schema.orders.sellerName} <> ''`)).groupBy(schema.orders.sellerName).orderBy(desc(count())).limit(30),
  ]);
  const stageCount = Object.fromEntries(stages.map((s) => [s.value, Number(s.count)]));
  return {
    stages: ORDER_STAGE_ORDER.map((stage) => ({ value: stage, label: ORDER_STAGE_LABEL[stage], count: stageCount[stage] ?? 0 })).filter((s) => s.count > 0 || params.filters.stage?.includes(s.value)),
    sources: sources.map((s) => ({ value: s.value, label: s.value, count: Number(s.count) })),
    carriers: carriers.filter((c) => c.value).map((c) => ({ value: c.value, label: c.value, count: Number(c.count) })),
    sellers: sellers.map((s) => ({ value: s.value, label: s.value, count: Number(s.count) })),
  };
}

export async function orderSummary(params: ListParams) {
  return memo(`orderSummary:${listKey(params)}`, 30_000, () => orderSummaryUncached(params));
}

async function orderSummaryUncached(params: ListParams) {
  const db = await getDb();
  const where = orderListWhere(params);
  const [row] = await db
    .select({
      // Đếm đơn KHÔNG huỷ — cùng định nghĩa với «Doanh số POS» ở Báo cáo lợi nhuận danh nghĩa (HSLC 08/10/2026: hai trang phải ra một số).
      orders: sql<number>`count(*) filter (where ${schema.orders.stage} not in ('CANCELLED','DELETED'))`,
      cancelled: sql<number>`count(*) filter (where ${schema.orders.stage} in ('CANCELLED','DELETED'))`,
      revenue: sql<number>`coalesce(sum(case when ${schema.orders.stage} not in ('CANCELLED','DELETED') then ${schema.orders.totalPriceAfterDiscount} else 0 end), 0)`,
      cod: sql<number>`coalesce(sum(case when ${schema.orders.stage} not in ('CANCELLED','DELETED') then ${schema.orders.moneyToCollect} else 0 end), 0)`,
      success: sql<number>`sum(case when ${ORDER_OUTCOME_FAST} = 'DELIVERED' then 1 else 0 end)`,
      quantity: sql<number>`coalesce(sum(case when ${schema.orders.stage} not in ('CANCELLED','DELETED') then ${schema.orders.totalQuantity} else 0 end), 0)`,
    })
    .from(schema.orders)
    // MỖI ĐƠN MỘT DÒNG: đơn nhiều lần gửi không được cộng tiền nhiều lần (xem PRIMARY_ATTEMPT).
    .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, schema.orders.id), PRIMARY_ATTEMPT))
    .where(where);
  // Đếm đơn chưa chuẩn hoá địa chỉ BỎ QUA chính bộ lọc địa chỉ, để con số trên nhãn bộ lọc không
  // đổi theo lựa chọn của chính nó (chọn "Đã chuẩn hoá" mà nhãn kia hiện 0 thì gây hiểu nhầm).
  const [unnormalized] = await db
    .select({ n: count() })
    .from(schema.orders)
    .where(and(orderListWhere(params, { ignoreAddressFilter: true }), sql`coalesce(${schema.orders.shipProvince}, '') = ''`, sql`${schema.orders.stage} not in ('CANCELLED','DELETED')`));
  return { orders: Number(row?.orders ?? 0), cancelled: Number(row?.cancelled ?? 0), revenue: Number(row?.revenue ?? 0), cod: Number(row?.cod ?? 0), success: Number(row?.success ?? 0), quantity: Number(row?.quantity ?? 0), unnormalizedAddress: Number(unnormalized?.n ?? 0) };
}

/**
 * Số đơn CẦN NGƯỜI KIỂM trên nhãn bộ lọc — KHÔNG qua bộ nhớ đệm của dải số (`orderSummary`, 30 giây): người vừa bấm «Xác nhận đơn»
 * phải thấy con số giảm ngay ở lượt dựng lại (review #675, L6). Một câu `count` trên chỉ mục khoá chính. Bỏ qua chính bộ lọc «Cần
 * người kiểm», để con số không tự về 0 / tự bằng tổng.
 */
export async function orderNeedsReviewCount(params: ListParams): Promise<number> {
  const db = await getDb();
  const [r] = await db.select({ n: count() }).from(schema.orders).where(and(orderListWhere(params, { ignoreReviewFilter: true }), ORDER_NEEDS_REVIEW));
  return Number(r?.n ?? 0);
}

export async function getOrderDetail(id: string) {
  const db = await getDb();
  const order = await db.query.orders.findFirst({
    where: or(eq(schema.orders.id, id), Number.isInteger(Number(id)) ? eq(schema.orders.systemId, Number(id)) : undefined),
    with: {
      customer: true,
      warehouse: true,
      items: { with: { variant: { columns: { id: true, images: true, remainQuantity: true, sku: true, lastImportedPrice: true } } } },
      statusHistory: { orderBy: [desc(schema.orderStatusHistory.updatedAt)] },
      /**
       * MỌI LẦN GỬI, KHÔNG PHẢI MỘT.
       *
       * Quan hệ `shipment` là `one(...)` — nó lấy MỘT dòng bất kỳ. Từ 10/09/2026 một đơn được phép
       * có nhiều lần gửi (giao thất bại rồi gửi lại, huỷ rồi tạo lại, gửi hàng thay thế), nên hiển
       * thị một dòng là XOÁ lịch sử khỏi mắt người vận hành: họ thấy "đang giao" mà không biết đây
       * đã là lần thứ ba.
       *
       * Sắp theo thứ tự lần gửi để đọc được như một dòng thời gian.
       */
      attempts: {
        with: { events: { orderBy: [desc(schema.shipmentEvents.occurredAt)] }, codBatch: true },
        orderBy: [asc(schema.shipments.attemptNo), asc(schema.shipments.createdAt)],
      },
      returns: true,
    },
  });
  if (!order) return null;
  // Giá vốn "sống": giá nhập trên phiếu ERP gần nhất → giá vốn Pancake ghi trên đơn → giá nhập mẫu mã
  const variantIds = order.items.map((it) => it.variantId).filter((v): v is string => Boolean(v));
  const receiptCosts = variantIds.length
    ? await db
        .select({ variantId: schema.stockReceiptItems.variantId, unitCost: schema.stockReceiptItems.unitCost })
        .from(schema.stockReceiptItems)
        .innerJoin(schema.stockReceipts, eq(schema.stockReceipts.id, schema.stockReceiptItems.receiptId))
        .where(and(inArray(schema.stockReceiptItems.variantId, variantIds), sql`${schema.stockReceiptItems.unitCost} > 0`))
        .orderBy(desc(schema.stockReceipts.receivedAt), desc(schema.stockReceipts.createdAt))
    : [];
  const lastCost = new Map<string, number>();
  for (const rc of receiptCosts) if (rc.variantId && !lastCost.has(rc.variantId)) lastCost.set(rc.variantId, Number(rc.unitCost));
  // Không nguồn nào ⇒ `liveUnitCost = null` (CHƯA BIẾT) — bản cũ kết thúc bằng `|| 0` nên trang in
  // "Giá vốn 0 ₫" và lãi gộp = nguyên doanh thu (AGENTS.md mục 42). Luật nằm ở `lib/constants/live-cogs.ts`.
  const items = order.items.map((it) => {
    const live = liveLineUnitCost({ receipt: it.variantId ? lastCost.get(it.variantId) : null, orderSnapshot: it.unitCost, variantDefault: it.variant?.lastImportedPrice });
    return { ...it, liveUnitCost: live.unitCost, liveCostSource: live.source };
  });
  const cogs = liveOrderCogs(items.map((it) => ({ unitCost: it.liveUnitCost, quantity: it.quantity })));
  return { ...order, items, liveCogs: cogs.cogs, liveCogsCoverage: { knownCogs: cogs.knownCogs, knownLines: cogs.knownLines, totalLines: cogs.totalLines } };
}

export type OrderDetail = NonNullable<Awaited<ReturnType<typeof getOrderDetail>>>;
