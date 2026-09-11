/**
 * DỮ LIỆU MẪU CHO PHÉP ĐO — sinh dữ liệu có hình dạng giống production để đo hiệu năng báo cáo.
 *
 * Không phải dữ liệu demo cho giao diện: mục tiêu duy nhất là ĐÚNG HÌNH DẠNG và ĐÚNG TỶ LỆ so với
 * dữ liệu thật (số đơn / số vận đơn / số sự kiện hành trình / số dòng bảng kê), để câu truy vấn
 * chạm đúng những index mà nó sẽ chạm trên máy chủ thật.
 *
 * Tỷ lệ lấy từ số đo production ngày 08/09/2026 (docs/erp-perf-audit.md):
 *   orders ≈ 1.200 · order_items ≈ 2.465 · shipments ≈ 1.773 · customers ≈ 4.000 · ad_spends ≈ 2.686
 *   cod_statement_lines ≈ 2.493
 * `scale` nhân toàn bộ lên: scale 1 = quy mô hiện tại, scale 10 = shop lớn gấp 10.
 */
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { OrderStage, ShipmentStage } from "@/db/schema";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DAY = 86_400_000;

export type SeedStats = Record<string, number>;

/** Chèn theo lô để không vượt giới hạn tham số của Postgres (65.535 tham số mỗi câu) */
async function insertChunked(table: Parameters<Awaited<ReturnType<typeof getDb>>["insert"]>[0], rows: unknown[], perRow: number) {
  const db = await getDb();
  const size = Math.max(1, Math.floor(45000 / Math.max(1, perRow)));
  for (let i = 0; i < rows.length; i += size) {
    await db.insert(table).values(rows.slice(i, i + size) as never);
  }
}

export async function seedBenchData(scale: number, days = 180): Promise<SeedStats> {
  const rand = rng(20260909);
  const between = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
  const now = Date.now();

  const productCount = Math.max(10, Math.round(12 * Math.sqrt(scale)));
  const variantsPerProduct = 6;
  const ordersPerDay = Math.max(1, Math.round(7 * scale));

  const db = await getDb();
  await db.insert(schema.warehouses).values({ id: "bench-wh", name: "Kho chính" });

  // ── Sản phẩm & mẫu mã ───────────────────────────────────────────────────
  const products: { id: string; name: string; index: number }[] = [];
  const variants: { id: string; productId: string; sku: string; cost: number; price: number; productIndex: number }[] = [];
  for (let p = 0; p < productCount; p += 1) {
    const id = `bench-p-${p}`;
    products.push({ id, name: `Mã hàng ${p}`, index: p });
    for (let v = 0; v < variantsPerProduct; v += 1) {
      const cost = between(80_000, 420_000);
      variants.push({ id: `bench-v-${p}-${v}`, productId: id, sku: `SKU${p}-${v}`, cost, price: Math.round(cost * 2.8), productIndex: p });
    }
  }
  await insertChunked(
    schema.products,
    products.map((p) => ({ id: p.id, name: p.name, insertedAt: new Date(now - 300 * DAY), syncedAt: new Date() })),
    8,
  );
  await insertChunked(
    schema.productVariants,
    variants.map((v) => ({
      id: v.id,
      productId: v.productId,
      sku: v.sku,
      detail: v.sku,
      color: pick(["Đen", "Trắng", "Be", "Đỏ"]),
      size: pick(["S", "M", "L", "XL"]),
      retailPrice: v.price,
      retailPriceAfterDiscount: v.price,
      lastImportedPrice: v.cost,
      avgImportedPrice: v.cost,
      remainQuantity: between(0, 60),
      actualRemainQuantity: between(0, 60),
      insertedAt: new Date(now - 300 * DAY),
      syncedAt: new Date(),
    })),
    20,
  );

  // ── Khách hàng ──────────────────────────────────────────────────────────
  const customerCount = Math.max(50, Math.round(1000 * scale));
  const customers = Array.from({ length: customerCount }, (_, i) => ({
    id: `bench-c-${i}`,
    pancakeId: `bench-pc-${i}`,
    name: `Khách ${i}`,
    phone: `09${String(10_000_000 + i)}`,
    phones: [`09${String(10_000_000 + i)}`],
    address: `Số ${i} đường Mẫu`,
    province: pick(["Hà Nội", "TP HCM", "Đà Nẵng", "Hải Phòng", "Cần Thơ"]),
    insertedAt: new Date(now - between(10, 300) * DAY),
    syncedAt: new Date(),
  }));
  await insertChunked(schema.customers, customers, 10);

  // ── Quảng cáo ───────────────────────────────────────────────────────────
  const campaignCount = Math.max(4, Math.round(8 * Math.sqrt(scale)));
  const adIds: string[] = [];
  const fbRows: (typeof schema.fbAds.$inferInsert)[] = [];
  for (let c = 0; c < campaignCount; c += 1) {
    for (let a = 0; a < 4; a += 1) {
      const adId = `bench-ad-${c}-${a}`;
      adIds.push(adId);
      fbRows.push({
        id: adId,
        name: `Mẩu ${c}-${a}`,
        campaignId: `bench-cmp-${c}`,
        campaignName: `Chiến dịch ${c}`,
        accountId: "bench-acct",
        status: "ACTIVE",
        postId: `bench-post-${c}-${a}`,
      });
    }
  }
  await insertChunked(schema.fbAds, fbRows, 12);

  const adSpendRows: (typeof schema.adSpends.$inferInsert)[] = [];
  for (let d = days; d >= 0; d -= 1) {
    const date = new Date(now - d * DAY);
    for (let c = 0; c < campaignCount; c += 1) {
      adSpendRows.push({
        id: `bench-as-${d}-${c}`,
        platform: "Facebook",
        campaign: `Chiến dịch ${c}`,
        campaignId: `bench-cmp-${c}`,
        accountId: "bench-acct",
        accountName: "Tài khoản QC",
        spend: between(200_000, 2_400_000),
        leads: between(5, 90),
        orders: between(1, 20),
        revenue: between(1_000_000, 12_000_000),
        spendDate: date,
        externalKey: `bench:${c}:${d}`,
        productId: pick(products).id,
        impressions: between(1000, 90_000),
        clicks: between(30, 900),
        messages: between(5, 200),
      });
    }
  }
  await insertChunked(schema.adSpends, adSpendRows, 22);

  // ── Đơn hàng · vận đơn · hành trình · bảng kê ───────────────────────────
  const orderRows: (typeof schema.orders.$inferInsert)[] = [];
  const itemRows: (typeof schema.orderItems.$inferInsert)[] = [];
  const shipmentRows: (typeof schema.shipments.$inferInsert)[] = [];
  const eventRows: (typeof schema.shipmentEvents.$inferInsert)[] = [];
  const statementRows: (typeof schema.codStatementLines.$inferInsert)[] = [];

  let orderNo = 0;
  for (let d = days; d >= 0; d -= 1) {
    const count = Math.max(1, ordersPerDay + between(-2, 4));
    for (let k = 0; k < count; k += 1) {
      orderNo += 1;
      const id = `bench-o-${orderNo}`;
      const insertedAt = new Date(now - d * DAY - between(0, 20) * 3_600_000);
      const lines = between(1, 3);
      let total = 0;
      let cogs = 0;
      for (let l = 0; l < lines; l += 1) {
        const v = pick(variants);
        const qty = rand() < 0.85 ? 1 : 2;
        const lineTotal = v.price * qty;
        total += lineTotal;
        cogs += v.cost * qty;
        itemRows.push({
          id: `${id}-i${l}`,
          orderId: id,
          variantId: v.id,
          productId: v.productId,
          productName: `Mã hàng ${v.productIndex}`,
          sku: v.sku,
          variationDetail: v.sku,
          quantity: qty,
          unitPrice: v.price,
          unitCost: v.cost,
          lineTotal,
        });
      }

      // Phân bố kết quả gần thực tế shop bán COD: ~62% giao thành công · ~22% hoàn · ~9% huỷ · ~7% đang giao
      const roll = rand();
      const outcome = roll < 0.62 ? "DELIVERED" : roll < 0.84 ? "RETURNED" : roll < 0.93 ? "CANCELLED" : "IN_TRANSIT";
      const stage: OrderStage = outcome === "CANCELLED" ? "CANCELLED" : outcome === "DELIVERED" ? "DELIVERED" : outcome === "RETURNED" ? "RETURNED" : "SHIPPED";

      orderRows.push({
        id,
        systemId: orderNo,
        displayId: orderNo,
        status: outcome === "CANCELLED" ? 6 : 3,
        statusName: outcome === "CANCELLED" ? "Đã huỷ" : "Đã nhận",
        stage,
        customerId: pick(customers).id,
        billFullName: `Khách ${orderNo}`,
        billPhone: `09${String(20_000_000 + orderNo)}`,
        shipProvince: pick(["Hà Nội", "TP HCM", "Đà Nẵng"]),
        totalPrice: total,
        totalPriceAfterDiscount: total,
        cod: outcome === "CANCELLED" ? 0 : total,
        partnerFee: between(17_000, 34_000),
        prepaid: rand() < 0.08 ? total : 0,
        source: pick(["Facebook", "Landing", "Livestream", "Khác"]),
        sellerName: pick(["Ngọc", "Lan", "Hà", "Vy"]),
        pageId: `bench-page-${between(1, 3)}`,
        adId: rand() < 0.5 ? pick(adIds) : null,
        postId: rand() < 0.8 ? `bench-post-${between(0, campaignCount - 1)}-${between(0, 3)}` : null,
        itemsCount: lines,
        totalQuantity: lines,
        cogs,
        insertedAt,
        updatedAtExternal: insertedAt,
        lastUpdateStatusAt: insertedAt,
        timeSendPartner: outcome === "CANCELLED" ? null : new Date(insertedAt.getTime() + 6 * 3_600_000),
        syncedAt: new Date(),
      });

      if (outcome === "CANCELLED") continue;

      const shipmentId = `bench-s-${orderNo}`;
      const vtp = `PKE${1_500_000_000 + orderNo}`;
      const pickedUpAt = new Date(insertedAt.getTime() + between(6, 30) * 3_600_000);
      const deliveredAt = new Date(pickedUpAt.getTime() + between(24, 96) * 3_600_000);
      const shipmentStage: ShipmentStage = outcome === "DELIVERED" ? "DELIVERED" : outcome === "RETURNED" ? "RETURNED" : "IN_TRANSIT";
      const collected = outcome === "DELIVERED" ? total : 0;

      shipmentRows.push({
        id: shipmentId,
        orderId: id,
        carrier: "Viettel Post",
        trackingCode: vtp,
        vtpOrderNumber: vtp,
        stage: shipmentStage,
        vtpStatusName: outcome === "DELIVERED" ? "Thành công - Phát thành công" : outcome === "RETURNED" ? "Chuyển hoàn" : "Đang giao",
        vtpStatusDate: deliveredAt,
        codAmount: total,
        codCollected: collected,
        shippingFee: between(17_000, 34_000),
        codStatus: outcome === "DELIVERED" ? (rand() < 0.7 ? "PAID_TO_BANK" : "COLLECTED") : "NOT_APPLICABLE",
        codPaidToBankAt: outcome === "DELIVERED" ? new Date(deliveredAt.getTime() + 7 * DAY) : null,
        pickedUpAt,
        firstDeliveryAt: outcome === "IN_TRANSIT" ? null : deliveredAt,
        deliveredAt: outcome === "DELIVERED" ? deliveredAt : null,
        returnedAt: outcome === "RETURNED" ? deliveredAt : null,
        isFinal: outcome !== "IN_TRANSIT",
        lastVtpSyncAt: new Date(now - between(0, 300) * 60_000),
      });

      // Hành trình: 4 sự kiện mỗi vận đơn (nhận → lấy → đang giao → kết thúc), như dữ liệu webhook thật
      const steps: [string, string, string, number][] = [
        ["100", "Nhận từ người gửi", "OUTBOUND", 0],
        ["200", "Lấy hàng thành công", "OUTBOUND", 1],
        ["300", "Đang giao", "OUTBOUND", 2],
      ];
      if (outcome === "DELIVERED") steps.push(["501", "Thành công - Phát thành công", "OUTBOUND", 3]);
      if (outcome === "RETURNED") steps.push(["504", "Chuyển hoàn người gửi", "RETURN", 3]);
      for (const [status, statusName, legType, offset] of steps) {
        eventRows.push({
          id: `${shipmentId}-e${status}`,
          shipmentId,
          source: "VTP_WEBHOOK",
          status,
          statusName,
          occurredAt: new Date(pickedUpAt.getTime() + offset * 12 * 3_600_000),
          legType,
          normalizedStage: status === "501" ? "DELIVERED" : status === "504" ? "RETURNED" : "IN_TRANSIT",
          sourceReference: vtp,
        });
      }

      // Bảng kê: chỉ đơn đã có chứng từ tiền mới có dòng
      if (outcome === "DELIVERED" && rand() < 0.7) {
        statementRows.push({
          id: `bench-cl-${orderNo}`,
          statementKey: `BK-${deliveredAt.toISOString().slice(0, 10)}`,
          sourceFile: "bench.xlsx",
          trackingCode: vtp,
          cod: collected,
          fee: 20_000,
          net: collected - 20_000,
          codReported: true,
          paidDate: deliveredAt.toISOString().slice(0, 10),
          statementAt: new Date(deliveredAt.getTime() + 7 * DAY),
          shipmentId,
        });
      }
    }
  }

  await insertChunked(schema.orders, orderRows, 45);
  await insertChunked(schema.orderItems, itemRows, 16);
  await insertChunked(schema.shipments, shipmentRows, 30);
  await insertChunked(schema.shipmentEvents, eventRows, 14);
  await insertChunked(schema.codStatementLines, statementRows, 14);

  // ── Phiếu kho ───────────────────────────────────────────────────────────
  const receiptRows: (typeof schema.stockReceipts.$inferInsert)[] = [];
  const receiptItemRows: (typeof schema.stockReceiptItems.$inferInsert)[] = [];
  const receiptCount = Math.max(10, Math.round(60 * scale));
  for (let r = 0; r < receiptCount; r += 1) {
    const rid = `bench-r-${r}`;
    receiptRows.push({ id: rid, kind: "RECEIPT", receivedAt: new Date(now - between(0, days) * DAY), reference: `NK-${r}`, supplier: "Xưởng A", totalQuantity: 0, totalCost: 0, createdBy: "bench" });
    for (let l = 0; l < 8; l += 1) {
      const v = pick(variants);
      receiptItemRows.push({ id: `${rid}-i${l}`, receiptId: rid, variantId: v.id, quantity: between(10, 60), unitCost: v.cost });
    }
  }
  await insertChunked(schema.stockReceipts, receiptRows, 10);
  await insertChunked(schema.stockReceiptItems, receiptItemRows, 6);

  // ── Chi phí vận hành ────────────────────────────────────────────────────
  const expenseRows: (typeof schema.expenses.$inferInsert)[] = [];
  for (let d = days; d >= 0; d -= 3) {
    expenseRows.push({
      id: `bench-e-${d}`,
      category: pick(["PACKAGING", "SALARY", "RENT", "SOFTWARE", "OTHER"] as const),
      description: `Chi phí ngày ${d}`,
      amount: between(300_000, 4_000_000),
      occurredAt: new Date(now - d * DAY),
      reference: `CP-${d}`,
      createdBy: "bench",
    });
  }
  await insertChunked(schema.expenses, expenseRows, 12);

  // ── Thông báo (hàng đợi việc / cảnh báo) ────────────────────────────────
  const notificationRows: (typeof schema.notifications.$inferInsert)[] = [];
  const notifCount = Math.max(20, Math.round(300 * scale));
  for (let n = 0; n < notifCount; n += 1) {
    notificationRows.push({
      id: `bench-n-${n}`,
      kind: pick(["SHIPMENT_FAILED", "ORDER_PENDING", "SHIPMENT_STALE", "SHIPMENT_RETURNING"]),
      severity: pick(["info", "warning", "critical"] as const),
      title: `Cảnh báo ${n}`,
      body: "Nội dung cảnh báo mẫu",
      dedupeKey: `bench-dedupe-${n}`,
      occurredAt: new Date(now - between(0, 60) * DAY),
      // Đã đóng thì phải nói được VÌ SAO đóng (ràng buộc `notifications_resolution_shape_check`).
      ...(rand() < 0.5 ? { resolvedAt: new Date(now - between(0, 30) * DAY), resolution: pick(["MANUAL", "AUTO", "STALE"] as const) } : {}),
    });
  }
  await insertChunked(schema.notifications, notificationRows, 12);

  // THỐNG KÊ BẢNG — bắt buộc, nếu không phép đo là vô nghĩa.
  // Postgres chọn kế hoạch theo thống kê. CSDL vừa nạp xong chưa có autovacuum chạy nên bộ tối ưu
  // ước lượng sai hàng trăm lần (đo được: ước 2 dòng cho bảng 600 dòng) và chọn kế hoạch mà máy chủ
  // thật sẽ không bao giờ chọn. Không chạy `analyze` thì đang đo bộ tối ưu bị bịt mắt, không phải
  // đo ứng dụng.
  await db.execute(sql`analyze`);

  return {
    products: products.length,
    product_variants: variants.length,
    customers: customers.length,
    orders: orderRows.length,
    order_items: itemRows.length,
    shipments: shipmentRows.length,
    shipment_events: eventRows.length,
    cod_statement_lines: statementRows.length,
    ad_spends: adSpendRows.length,
    fb_ads: fbRows.length,
    stock_receipt_items: receiptItemRows.length,
    expenses: expenseRows.length,
    notifications: notificationRows.length,
  };
}
