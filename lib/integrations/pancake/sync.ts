import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import type { CodStatus, Shipment, ShipmentStage } from "@/db/schema";
import { env } from "@/lib/env";
import { asRecord, str } from "@/lib/integrations/http";
import { getPancakeClient } from "@/lib/integrations/pancake/client";
import {
  mapCustomer,
  mapInventoryHistory,
  mapOrder,
  mapOrderReturn,
  mapProduct,
  mapVariant,
  mapWarehouse,
  type MappedCustomer,
  type MappedOrder,
  type MappedProduct,
  type MappedVariant,
} from "@/lib/integrations/pancake/mapper";
import { publish } from "@/lib/realtime/bus";
import { getSyncState, runSyncJob, setSyncState, type SyncContext, type SyncTrigger } from "@/lib/sync/runner";

const COD_RANK: Record<CodStatus, number> = { NOT_APPLICABLE: 0, PENDING: 1, COLLECTED: 2, RECONCILED: 3, PAID_TO_BANK: 4, DISPUTED: 5 };

// ───────────────────────── Customer ─────────────────────────

export async function upsertCustomer(mapped: MappedCustomer, dbArg?: Db) {
  const db = dbArg ?? (await getDb());
  const data = {
    name: mapped.name,
    phone: mapped.phone,
    phones: mapped.phones,
    emails: mapped.emails,
    gender: mapped.gender,
    dateOfBirth: mapped.dateOfBirth,
    level: mapped.level,
    tags: mapped.tags,
    orderCount: mapped.orderCount,
    succeedOrderCount: mapped.succeedOrderCount,
    returnedOrderCount: mapped.returnedOrderCount,
    purchasedAmount: mapped.purchasedAmount,
    rewardPoint: mapped.rewardPoint,
    address: mapped.address,
    province: mapped.province,
    addresses: mapped.addresses,
    fbId: mapped.fbId,
    conversationLink: mapped.conversationLink,
    isBlock: mapped.isBlock,
    lastOrderAt: mapped.lastOrderAt,
    insertedAt: mapped.insertedAt,
    updatedAtExternal: mapped.updatedAtExternal,
    raw: mapped.raw,
    syncedAt: new Date(),
  };
  const [row] = await db
    .insert(schema.customers)
    .values({ pancakeId: mapped.pancakeId, ...data })
    .onConflictDoUpdate({ target: schema.customers.pancakeId, set: { ...data, updatedAt: new Date() } })
    .returning({ id: schema.customers.id });
  return row;
}

async function ensureCustomerForOrder(db: Db, order: MappedOrder) {
  if (order.customer) return (await upsertCustomer(order.customer, db)).id;
  const phone = order.billPhone || order.shipPhone;
  if (!phone) return null;
  const existing = await db.query.customers.findFirst({ where: eq(schema.customers.phone, phone), columns: { id: true } });
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.customers)
    .values({ name: order.billFullName || order.shipFullName || "Khách hàng", phone, phones: [phone], address: order.shipFullAddress, province: order.shipProvince, syncedAt: new Date() })
    .returning({ id: schema.customers.id });
  return created.id;
}

// ───────────────────────── Warehouse ─────────────────────────

async function ensureWarehouse(db: Db, w: { id: string; name: string; fullAddress?: string; phone?: string }) {
  await db
    .insert(schema.warehouses)
    .values({ id: w.id, name: w.name, fullAddress: w.fullAddress ?? "", address: w.fullAddress ?? "", phone: w.phone ?? "" })
    .onConflictDoNothing();
}

// ───────────────────────── Product / variant ─────────────────────────

async function ensureVariantFromOrderItem(db: Db, variation: NonNullable<MappedOrder["items"][number]["variation"]>) {
  await db.insert(schema.products).values({ id: variation.productId, name: variation.name, image: variation.images[0] ?? null }).onConflictDoNothing();
  const attrs = variation.fields;
  const color = attrs.find((a) => /(màu|mau|color)/i.test(a.name))?.value ?? "";
  const size = attrs.find((a) => /(size|cỡ|kích)/i.test(a.name))?.value ?? "";
  await db
    .insert(schema.productVariants)
    .values({
      id: variation.id,
      productId: variation.productId,
      sku: variation.sku,
      barcode: variation.barcode || null,
      attributes: attrs.length ? attrs : null,
      detail: variation.detail || attrs.map((a) => `${a.name}: ${a.value}`).join(", "),
      color,
      size,
      images: variation.images,
      weight: variation.weight,
      retailPrice: variation.retailPrice,
      retailPriceAfterDiscount: variation.retailPrice,
      lastImportedPrice: variation.lastImportedPrice,
      avgImportedPrice: variation.avgPrice,
    })
    .onConflictDoNothing();
}

export async function upsertProduct(mapped: MappedProduct, dbArg?: Db) {
  const db = dbArg ?? (await getDb());
  const data = {
    name: mapped.name,
    customId: mapped.customId,
    displayId: mapped.displayId,
    image: mapped.image,
    categories: mapped.categories,
    tags: mapped.tags,
    isPublished: mapped.isPublished,
    isHidden: mapped.isHidden,
    isRemoved: mapped.isRemoved,
    note: mapped.note,
    insertedAt: mapped.insertedAt,
    raw: mapped.raw,
    syncedAt: new Date(),
  };
  await db
    .insert(schema.products)
    .values({ id: mapped.id, ...data })
    .onConflictDoUpdate({ target: schema.products.id, set: { ...data, updatedAt: new Date() } });
  for (const variant of mapped.variants) await upsertVariant(variant, db);
}

export async function upsertVariant(v: MappedVariant, dbArg?: Db) {
  const db = dbArg ?? (await getDb());
  await db.insert(schema.products).values({ id: v.productId, name: v.sku || "Sản phẩm" }).onConflictDoNothing();
  const data = {
    productId: v.productId,
    sku: v.sku,
    barcode: v.barcode,
    customId: v.customId,
    attributes: v.attributes,
    detail: v.detail,
    color: v.color,
    size: v.size,
    images: v.images,
    weight: v.weight,
    retailPrice: v.retailPrice,
    retailPriceAfterDiscount: v.retailPriceAfterDiscount,
    lastImportedPrice: v.lastImportedPrice,
    avgImportedPrice: v.avgImportedPrice,
    remainQuantity: v.remainQuantity,
    actualRemainQuantity: v.actualRemainQuantity,
    isHidden: v.isHidden,
    isLocked: v.isLocked,
    isRemoved: v.isRemoved,
    insertedAt: v.insertedAt,
    updatedAtExternal: v.updatedAtExternal,
    raw: v.raw,
    syncedAt: new Date(),
  };
  await db
    .insert(schema.productVariants)
    .values({ id: v.id, ...data })
    .onConflictDoUpdate({ target: schema.productVariants.id, set: { ...data, updatedAt: new Date() } });
  for (const stock of v.stocks) {
    await ensureWarehouse(db, { id: stock.warehouseId, name: "Kho" });
    await db
      .insert(schema.variantStocks)
      .values({ variantId: v.id, ...stock })
      .onConflictDoUpdate({ target: [schema.variantStocks.variantId, schema.variantStocks.warehouseId], set: { ...stock, updatedAt: new Date() } });
  }
}

// ───────────────────────── Order ─────────────────────────

export type UpsertOrderResult = "created" | "updated" | "skipped";

/**
 * Ghi một đơn Pancake vào ERP. Bỏ qua nếu dữ liệu không mới hơn bản đã có (chống webhook về muộn),
 * trừ khi force = true.
 */
export async function upsertOrder(mapped: MappedOrder, options: { force?: boolean; source?: string } = {}): Promise<UpsertOrderResult> {
  const db = await getDb();
  const existing = await db.query.orders.findFirst({
    where: eq(schema.orders.id, mapped.id),
    columns: { id: true, status: true, updatedAtExternal: true },
    with: { shipment: true },
  });
  if (
    existing &&
    !options.force &&
    existing.updatedAtExternal &&
    mapped.updatedAtExternal &&
    existing.updatedAtExternal.getTime() >= mapped.updatedAtExternal.getTime() &&
    existing.status === mapped.status
  ) {
    return "skipped";
  }

  const customerId = await ensureCustomerForOrder(db, mapped);
  if (mapped.warehouse) await ensureWarehouse(db, mapped.warehouse);
  for (const item of mapped.items) if (item.variation) await ensureVariantFromOrderItem(db, item.variation);
  const wantedVariantIds = mapped.items.map((i) => i.variantId ?? "").filter(Boolean);
  const variantIds = new Set(
    wantedVariantIds.length ? (await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(inArray(schema.productVariants.id, wantedVariantIds))).map((v) => v.id) : [],
  );

  const orderData = {
    systemId: mapped.systemId,
    displayId: mapped.displayId,
    customId: mapped.customId,
    shopId: mapped.shopId,
    status: mapped.status,
    statusName: mapped.statusName,
    stage: mapped.stage,
    subStatus: mapped.subStatus,
    customerId,
    billFullName: mapped.billFullName,
    billPhone: mapped.billPhone,
    billEmail: mapped.billEmail,
    shipFullName: mapped.shipFullName,
    shipPhone: mapped.shipPhone,
    shipAddress: mapped.shipAddress,
    shipFullAddress: mapped.shipFullAddress,
    shipProvince: mapped.shipProvince,
    shipDistrict: mapped.shipDistrict,
    shipCommune: mapped.shipCommune,
    totalPrice: mapped.totalPrice,
    totalPriceAfterDiscount: mapped.totalPriceAfterDiscount,
    totalDiscount: mapped.totalDiscount,
    shippingFee: mapped.shippingFee,
    partnerFee: mapped.partnerFee,
    customerPayFee: mapped.customerPayFee,
    isFreeShipping: mapped.isFreeShipping,
    cod: mapped.cod,
    moneyToCollect: mapped.moneyToCollect,
    prepaid: mapped.prepaid,
    transferMoney: mapped.transferMoney,
    cash: mapped.cash,
    surcharge: mapped.surcharge,
    tax: mapped.tax,
    feeMarketplace: mapped.feeMarketplace,
    returnFee: mapped.returnFee,
    exchangeValue: mapped.exchangeValue,
    isExchangeOrder: mapped.isExchangeOrder,
    isLivestream: mapped.isLivestream,
    source: mapped.source,
    accountName: mapped.accountName,
    pageId: mapped.pageId,
    conversationId: mapped.conversationId,
    postId: mapped.postId,
    adId: mapped.adId,
    marketplaceId: mapped.marketplaceId,
    sellerName: mapped.sellerName,
    careName: mapped.careName,
    marketerName: mapped.marketerName,
    creatorName: mapped.creatorName,
    warehouseId: mapped.warehouseId,
    note: mapped.note,
    notePrint: mapped.notePrint,
    tags: mapped.tags,
    itemsCount: mapped.itemsCount,
    totalQuantity: mapped.totalQuantity,
    cogs: mapped.cogs,
    returnedReason: mapped.returnedReason,
    insertedAt: mapped.insertedAt,
    updatedAtExternal: mapped.updatedAtExternal,
    lastUpdateStatusAt: mapped.lastUpdateStatusAt,
    timeSendPartner: mapped.timeSendPartner,
    estimateDeliveryDate: mapped.estimateDeliveryDate,
    raw: mapped.raw,
    syncedAt: new Date(),
  };

  await db.transaction(async (tx) => {
    if (existing) {
      await tx.update(schema.orders).set({ ...orderData, updatedAt: new Date() }).where(eq(schema.orders.id, mapped.id));
      await tx.delete(schema.orderItems).where(eq(schema.orderItems.orderId, mapped.id));
    } else {
      await tx.insert(schema.orders).values({ id: mapped.id, ...orderData });
    }
    if (mapped.items.length) {
      await tx
        .insert(schema.orderItems)
        .values(
          mapped.items.map((item) => ({
            id: item.id,
            orderId: mapped.id,
            variantId: item.variantId && variantIds.has(item.variantId) ? item.variantId : null,
            productId: item.productId,
            productName: item.productName,
            variationDetail: item.variationDetail,
            sku: item.sku,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            unitCost: item.unitCost,
            discountEach: item.discountEach,
            totalDiscount: item.totalDiscount,
            isBonus: item.isBonus,
            returnQuantity: item.returnQuantity,
            lineTotal: item.lineTotal,
            weight: item.weight,
            image: item.image,
          })),
        )
        .onConflictDoNothing();
    }
    if (mapped.statusHistory.length) {
      await tx
        .insert(schema.orderStatusHistory)
        .values(mapped.statusHistory.map((h) => ({ orderId: mapped.id, status: h.status, oldStatus: h.oldStatus, editorName: h.editorName, updatedAt: h.updatedAt })))
        .onConflictDoNothing();
    }
  });

  await upsertShipmentFromOrder(db, mapped, existing?.shipment ?? null);
  publish({ type: "order", orderId: mapped.id, action: existing ? "updated" : "created" });
  return existing ? "updated" : "created";
}

async function upsertShipmentFromOrder(db: Db, mapped: MappedOrder, existing: Shipment | null) {
  const s = mapped.shipment;
  if (!s) {
    if (existing && ["CANCELLED", "DELETED"].includes(mapped.stage) && !existing.vtpStatus) {
      await db
        .update(schema.shipments)
        .set({ stage: "CANCELLED", isFinal: true, cancelledAt: existing.cancelledAt ?? new Date(), lastPancakeSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.shipments.id, existing.id));
    }
    return;
  }

  // Nếu Viettel Post đã cập nhật mới hơn dữ liệu Pancake thì giữ trạng thái của Viettel Post
  const pancakeStamp = s.partnerUpdatedAt ?? mapped.updatedAtExternal ?? mapped.insertedAt;
  // Dữ liệu Viettel Post (webhook / nhập danh sách vận đơn / bảng kê) là nguồn gốc; Pancake chỉ là bản sao có thể trễ.
  // Giữ trạng thái VTP nếu đã có, trừ khi VTP chưa kết thúc mà Pancake báo trạng thái kết thúc mới hơn.
  const FINAL_STAGES = new Set(["DELIVERED", "RETURNED", "CANCELLED"]);
  const keepVtpStage = Boolean(
    existing?.vtpStatusDate &&
      existing.stage !== "UNKNOWN" &&
      (FINAL_STAGES.has(existing.stage) || !FINAL_STAGES.has(s.stage) || existing.vtpStatusDate.getTime() > pancakeStamp.getTime()),
  );
  const stage: ShipmentStage = keepVtpStage && existing ? existing.stage : s.stage;

  let codStatus: CodStatus = s.codStatus;
  if (existing && COD_RANK[existing.codStatus] > COD_RANK[codStatus] && existing.codStatus !== "NOT_APPLICABLE") codStatus = existing.codStatus;
  if (existing?.codStatus === "DISPUTED") codStatus = "DISPUTED";

  const data = {
    carrier: s.carrier,
    partnerId: s.partnerId,
    trackingCode: s.trackingCode ?? existing?.trackingCode ?? null,
    vtpOrderNumber: s.vtpOrderNumber ?? existing?.vtpOrderNumber ?? null,
    partnerStatus: s.partnerStatus,
    stage,
    codAmount: s.codAmount,
    codCollected: Math.max(existing?.codCollected ?? 0, s.codCollected),
    codStatus,
    codReconciledAt: s.codReconciledAt ?? existing?.codReconciledAt ?? null,
    shippingFee: s.shippingFee || existing?.shippingFee || 0,
    pickedUpAt: s.pickedUpAt ?? existing?.pickedUpAt ?? null,
    firstDeliveryAt: s.firstDeliveryAt ?? existing?.firstDeliveryAt ?? null,
    deliveredAt: existing?.deliveredAt ?? s.deliveredAt,
    returnedAt: existing?.returnedAt ?? s.returnedAt,
    cancelledAt: existing?.cancelledAt ?? s.cancelledAt,
    isFinal: keepVtpStage && existing ? existing.isFinal : s.isFinal,
    receiverName: s.receiverName,
    receiverPhone: s.receiverPhone,
    receiverAddress: s.receiverAddress,
    lastPancakeSyncAt: new Date(),
    raw: existing?.raw && typeof existing.raw === "object" ? { ...(existing.raw as object), pancake: s.raw } : { pancake: s.raw },
  };

  let shipmentId: string;
  if (existing) {
    await db.update(schema.shipments).set({ ...data, updatedAt: new Date() }).where(eq(schema.shipments.id, existing.id));
    shipmentId = existing.id;
  } else {
    // vận đơn có thể đã được tạo từ webhook Viettel Post trước khi đơn Pancake về
    const orphan = s.vtpOrderNumber ? await db.query.shipments.findFirst({ where: and(eq(schema.shipments.vtpOrderNumber, s.vtpOrderNumber), sql`${schema.shipments.orderId} is null`) }) : null;
    if (orphan) {
      await db.update(schema.shipments).set({ ...data, orderId: mapped.id, stage: orphan.vtpStatusDate ? orphan.stage : stage, updatedAt: new Date() }).where(eq(schema.shipments.id, orphan.id));
      shipmentId = orphan.id;
    } else {
      const [row] = await db.insert(schema.shipments).values({ orderId: mapped.id, ...data }).returning({ id: schema.shipments.id });
      shipmentId = row.id;
    }
  }

  if (s.events.length) {
    await db
      .insert(schema.shipmentEvents)
      .values(s.events.map((e) => ({ shipmentId, source: "PANCAKE", status: e.status, statusName: e.statusName, note: e.note, occurredAt: e.occurredAt, raw: e.raw })))
      .onConflictDoNothing();
  }
  publish({ type: "shipment", shipmentId, status: stage });
}

// ───────────────────────── Jobs ─────────────────────────

const CURSOR_KEY = "pancake.orders.updated_at.cursor";
const BACKFILL_KEY = "pancake.orders.backfill";

export async function syncOrderById(orderId: string, options: { force?: boolean } = {}) {
  const client = getPancakeClient();
  const raw = await client.getOrder(orderId);
  const mapped = mapOrder(raw);
  if (!mapped) throw new Error(`Không đọc được đơn ${orderId}`);
  return upsertOrder(mapped, { force: options.force ?? true, source: "api" });
}

async function ingestOrders(ctx: SyncContext, orders: unknown[], force: boolean) {
  for (const raw of orders) {
    const mapped = mapOrder(raw);
    if (!mapped) {
      ctx.summary.skipped += 1;
      continue;
    }
    try {
      const result = await upsertOrder(mapped, { force });
      if (result === "created") ctx.summary.imported += 1;
      else if (result === "updated") ctx.summary.updated += 1;
      else ctx.summary.skipped += 1;
    } catch (error) {
      ctx.summary.failed += 1;
      ctx.log(`Đơn ${mapped.systemId ?? mapped.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await ctx.progress();
}

/** Đồng bộ tăng dần theo updated_at, có chồng lấn để không bỏ sót. */
export async function syncOrdersIncremental(options: { trigger?: SyncTrigger; actor?: string; overlapMinutes?: number } = {}) {
  return runSyncJob({ source: "PANCAKE", job: "orders_incremental", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const client = getPancakeClient();
    const state = await getSyncState<{ cursor: string }>(CURSOR_KEY);
    const now = new Date();
    const overlapMs = (options.overlapMinutes ?? 60) * 60_000;
    const start = state?.cursor ? new Date(new Date(state.cursor).getTime() - overlapMs) : new Date(now.getTime() - 7 * 86_400_000);
    const end = new Date(now.getTime() + 86_400_000);
    ctx.log(`Cửa sổ updated_at ${start.toISOString()} → ${end.toISOString()}`);
    let total = 0;
    for await (const page of client.iterateOrders({ updateStatus: "updated_at", start, end, pageSize: 100, includeRemoved: true })) {
      total += page.orders.length;
      await ingestOrders(ctx, page.orders, false);
      ctx.summary.detail = `Đã xử lý ${total}/${page.totalEntries} đơn cập nhật`;
    }
    await setSyncState(CURSOR_KEY, { cursor: now.toISOString() });
    ctx.summary.detail = `${total} đơn thay đổi (mới ${ctx.summary.imported}, cập nhật ${ctx.summary.updated}, không đổi ${ctx.summary.skipped})`;
    return { total };
  });
}

/** Đồng bộ toàn bộ lịch sử theo inserted_at, chia cửa sổ 7 ngày, có thể chạy lại để tiếp tục. */
export async function syncOrdersBackfill(options: { trigger?: SyncTrigger; actor?: string; days?: number; restart?: boolean } = {}) {
  return runSyncJob({ source: "PANCAKE", job: "orders_backfill", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const client = getPancakeClient();
    const days = options.days ?? env.pancake.backfillDays;
    const now = new Date();
    const end = new Date(now.getTime() + 86_400_000);
    const state = options.restart ? null : await getSyncState<{ nextStart: string; days: number; done?: boolean }>(BACKFILL_KEY);
    let windowStart = state && !state.done && state.days === days ? new Date(state.nextStart) : new Date(now.getTime() - days * 86_400_000);
    const step = 7 * 86_400_000;
    let total = 0;
    while (windowStart < end) {
      const windowEnd = new Date(Math.min(windowStart.getTime() + step, end.getTime()));
      for await (const page of client.iterateOrders({ updateStatus: "inserted_at", start: windowStart, end: windowEnd, pageSize: 100, includeRemoved: true })) {
        total += page.orders.length;
        await ingestOrders(ctx, page.orders, true);
        ctx.summary.detail = `${windowStart.toLocaleDateString("vi-VN")} → ${windowEnd.toLocaleDateString("vi-VN")}: ${total} đơn`;
      }
      windowStart = windowEnd;
      await setSyncState(BACKFILL_KEY, { nextStart: windowStart.toISOString(), days, done: false });
    }
    await setSyncState(BACKFILL_KEY, { nextStart: end.toISOString(), days, done: true, finishedAt: now.toISOString() });
    if (!(await getSyncState(CURSOR_KEY))) await setSyncState(CURSOR_KEY, { cursor: now.toISOString() });
    ctx.summary.detail = `Đồng bộ lịch sử ${days} ngày: ${total} đơn (mới ${ctx.summary.imported}, cập nhật ${ctx.summary.updated})`;
    return { total };
  });
}

/** Đồng bộ lại các đơn cập nhật trong N ngày gần nhất (ép ghi đè) – chạy hằng đêm. */
export async function syncOrdersReconcile(options: { trigger?: SyncTrigger; actor?: string; days?: number } = {}) {
  return runSyncJob({ source: "PANCAKE", job: "orders_reconcile", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const client = getPancakeClient();
    const days = options.days ?? 3;
    const now = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    const end = new Date(now.getTime() + 86_400_000);
    let total = 0;
    for await (const page of client.iterateOrders({ updateStatus: "updated_at", start, end, pageSize: 100, includeRemoved: true })) {
      total += page.orders.length;
      await ingestOrders(ctx, page.orders, true);
    }
    ctx.summary.detail = `Đối chiếu lại ${total} đơn cập nhật trong ${days} ngày`;
    return { total };
  });
}

export async function syncWarehouses(options: { trigger?: SyncTrigger; actor?: string } = {}) {
  return runSyncJob({ source: "PANCAKE", job: "warehouses", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const db = await getDb();
    const client = getPancakeClient();
    const rows = await client.listWarehouses();
    for (const row of rows) {
      const w = mapWarehouse(row);
      if (!w) continue;
      await db
        .insert(schema.warehouses)
        .values(w)
        .onConflictDoUpdate({ target: schema.warehouses.id, set: { ...w, updatedAt: new Date() } });
      ctx.summary.updated += 1;
    }
    ctx.summary.detail = `${rows.length} kho`;
    return rows.length;
  });
}

export async function syncProducts(options: { trigger?: SyncTrigger; actor?: string } = {}) {
  return runSyncJob({ source: "PANCAKE", job: "products", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const db = await getDb();
    const client = getPancakeClient();
    let page = 1;
    let totalPages = 1;
    let count = 0;
    do {
      const result = await client.listProducts(page, 100);
      totalPages = result.totalPages;
      for (const raw of result.data) {
        const mapped = mapProduct(raw);
        if (!mapped) {
          ctx.summary.skipped += 1;
          continue;
        }
        try {
          await upsertProduct(mapped, db);
          ctx.summary.updated += 1;
          count += mapped.variants.length;
        } catch (error) {
          ctx.summary.failed += 1;
          ctx.log(`Sản phẩm ${mapped.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      ctx.summary.detail = `Trang ${page}/${totalPages} · ${ctx.summary.updated} sản phẩm · ${count} mẫu mã`;
      await ctx.progress();
      page += 1;
    } while (page <= totalPages && page <= 500);

    // Bổ sung tồn kho theo danh sách mẫu mã phẳng (một số shop chỉ trả tồn kho ở endpoint này)
    try {
      let vpage = 1;
      let vpages = 1;
      do {
        const result = await client.listVariations(vpage, 100);
        vpages = result.totalPages;
        for (const raw of result.data) {
          const v = mapVariant(raw);
          if (v) await upsertVariant(v, db);
        }
        vpage += 1;
      } while (vpage <= vpages && vpage <= 500);
    } catch (error) {
      ctx.log(`Bỏ qua danh sách mẫu mã phẳng: ${error instanceof Error ? error.message : String(error)}`);
    }
    publish({ type: "stock", variantId: "*" });
    ctx.summary.detail = `${ctx.summary.updated} sản phẩm · ${count} mẫu mã`;
    return count;
  });
}

export async function syncCustomers(options: { trigger?: SyncTrigger; actor?: string; full?: boolean } = {}) {
  return runSyncJob({ source: "PANCAKE", job: options.full ? "customers_full" : "customers", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const db = await getDb();
    const client = getPancakeClient();
    const key = "pancake.customers.cursor";
    const state = options.full ? null : await getSyncState<{ cursor: string }>(key);
    const now = new Date();
    const start = state?.cursor ? Math.floor((new Date(state.cursor).getTime() - 2 * 3600_000) / 1000) : undefined;
    let page = 1;
    let totalPages = 1;
    do {
      const result = await client.listCustomers({ pageNumber: page, pageSize: 100, startUpdated: start, endUpdated: start ? Math.floor(now.getTime() / 1000) + 86_400 : undefined });
      totalPages = result.totalPages;
      for (const raw of result.data) {
        const mapped = mapCustomer(raw);
        if (!mapped) {
          ctx.summary.skipped += 1;
          continue;
        }
        try {
          await upsertCustomer(mapped, db);
          ctx.summary.updated += 1;
        } catch (error) {
          ctx.summary.failed += 1;
          ctx.log(`Khách ${mapped.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      ctx.summary.detail = `Trang ${page}/${totalPages} · ${ctx.summary.updated} khách hàng`;
      await ctx.progress();
      page += 1;
    } while (page <= totalPages && page <= 1000);
    await setSyncState(key, { cursor: now.toISOString() });
    return ctx.summary.updated;
  });
}

export async function syncInventoryHistories(options: { trigger?: SyncTrigger; actor?: string; days?: number } = {}) {
  return runSyncJob({ source: "PANCAKE", job: "inventory_histories", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const db = await getDb();
    const client = getPancakeClient();
    const key = "pancake.inventory_histories.cursor";
    const state = await getSyncState<{ cursor: string }>(key);
    const now = new Date();
    const days = options.days ?? 30;
    const startDate = state?.cursor ? new Date(new Date(state.cursor).getTime() - 6 * 3600_000) : new Date(now.getTime() - days * 86_400_000);
    let page = 1;
    let totalPages = 1;
    do {
      const result = await client.listInventoryHistories({ page, pageSize: 100, startDate: Math.floor(startDate.getTime() / 1000), endDate: Math.floor(now.getTime() / 1000) + 3600 });
      totalPages = result.totalPages;
      for (const raw of result.data) {
        const h = mapInventoryHistory(raw);
        if (!h) {
          ctx.summary.skipped += 1;
          continue;
        }
        const variant = h.variantId ? await db.query.productVariants.findFirst({ where: eq(schema.productVariants.id, h.variantId), columns: { id: true } }) : null;
        if (h.warehouseId) await ensureWarehouse(db, { id: h.warehouseId, name: str(asRecord(asRecord(raw).warehouse).name, "Kho") });
        const data = { ...h, variantId: variant ? h.variantId : null };
        await db
          .insert(schema.inventoryHistories)
          .values(data)
          .onConflictDoUpdate({ target: schema.inventoryHistories.id, set: data });
        ctx.summary.updated += 1;
      }
      ctx.summary.detail = `Trang ${page}/${totalPages} · ${ctx.summary.updated} giao dịch kho`;
      await ctx.progress();
      page += 1;
    } while (page <= totalPages && page <= 500);
    await setSyncState(key, { cursor: now.toISOString() });
    return ctx.summary.updated;
  });
}

export async function syncOrderReturns(options: { trigger?: SyncTrigger; actor?: string } = {}) {
  return runSyncJob({ source: "PANCAKE", job: "order_returns", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const db = await getDb();
    const client = getPancakeClient();
    let page = 1;
    let totalPages = 1;
    do {
      const result = await client.listOrderReturns(page, 100);
      totalPages = result.totalPages;
      for (const raw of result.data) {
        const r = mapOrderReturn(raw);
        if (!r) {
          ctx.summary.skipped += 1;
          continue;
        }
        const order = r.orderId ? await db.query.orders.findFirst({ where: eq(schema.orders.id, r.orderId), columns: { id: true } }) : null;
        const data = { ...r, orderId: order ? r.orderId : null, syncedAt: new Date() };
        await db
          .insert(schema.orderReturns)
          .values(data)
          .onConflictDoUpdate({ target: schema.orderReturns.id, set: data });
        ctx.summary.updated += 1;
      }
      ctx.summary.detail = `Trang ${page}/${totalPages} · ${ctx.summary.updated} phiếu đổi/trả`;
      await ctx.progress();
      page += 1;
    } while (page <= totalPages && page <= 100);
    return ctx.summary.updated;
  });
}

/** Chạy toàn bộ: kho → sản phẩm → đơn (lịch sử hoặc tăng dần) → khách → trả hàng → nhật ký kho */
export async function syncPancakeAll(options: { trigger?: SyncTrigger; actor?: string; backfill?: boolean; days?: number } = {}) {
  const results: Record<string, unknown> = {};
  results.warehouses = await syncWarehouses(options).catch((e) => ({ error: String(e) }));
  results.products = await syncProducts(options).catch((e) => ({ error: String(e) }));
  const backfillState = await getSyncState<{ done?: boolean }>(BACKFILL_KEY);
  results.orders =
    options.backfill || !backfillState?.done
      ? await syncOrdersBackfill({ trigger: options.trigger, actor: options.actor, days: options.days }).catch((e) => ({ error: String(e) }))
      : await syncOrdersIncremental(options).catch((e) => ({ error: String(e) }));
  results.customers = await syncCustomers(options).catch((e) => ({ error: String(e) }));
  results.returns = await syncOrderReturns(options).catch((e) => ({ error: String(e) }));
  results.inventory = await syncInventoryHistories(options).catch((e) => ({ error: String(e) }));
  return results;
}
