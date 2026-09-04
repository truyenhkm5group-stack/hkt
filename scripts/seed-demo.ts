/**
 * Tạo dữ liệu demo để xem thử giao diện (không cần API Pancake/Viettel Post).
 *   npm run seed:demo          → tạo dữ liệu demo
 *   npm run demo:clear         → xoá dữ liệu demo (các bản ghi có id bắt đầu bằng "demo-")
 */
import "dotenv/config";
import { like, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { ensureAdminUser } from "@/lib/auth/bootstrap";
import { pancakeStatusName, pancakeStatusToStage } from "@/lib/constants/pancake";
import { vtpStatusMeta } from "@/lib/constants/viettelpost";
import type { CodStatus, ShipmentStage } from "@/db/schema";

const clear = process.argv.includes("--clear");

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
const rand = rng(20260903);
const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
const between = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));

const PRODUCTS = [
  { name: "Đầm midi Soft-V", price: 689000, cost: 238000, colors: ["Đỏ đô", "Đen", "Be"], sizes: ["S", "M", "L"] },
  { name: "Đầm Tulip Frame", price: 749000, cost: 265000, colors: ["Navy", "Trắng"], sizes: ["S", "M", "L", "XL"] },
  { name: "Áo sơ mi lụa Ribbon", price: 429000, cost: 150000, colors: ["Trắng", "Hồng nude"], sizes: ["S", "M", "L"] },
  { name: "Chân váy Comma Contour", price: 459000, cost: 160000, colors: ["Đen", "Merlot"], sizes: ["S", "M", "L"] },
  { name: "Set vest Floating Bridge", price: 1190000, cost: 420000, colors: ["Xám", "Xanh két"], sizes: ["M", "L", "XL"] },
  { name: "Quần ống rộng Infinity", price: 399000, cost: 140000, colors: ["Đen", "Kem"], sizes: ["S", "M", "L", "XL"] },
  { name: "Áo thun Basic Logo", price: 199000, cost: 65000, colors: ["Trắng", "Đen", "Xanh rêu"], sizes: ["S", "M", "L", "XL"] },
  { name: "Áo khoác blazer Linen", price: 890000, cost: 310000, colors: ["Be", "Nâu"], sizes: ["S", "M", "L"] },
  { name: "Đầm Shadow Ribbon", price: 629000, cost: 218000, colors: ["Đen", "Đỏ"], sizes: ["S", "M", "L"] },
  { name: "Áo croptop Five-Finger", price: 259000, cost: 85000, colors: ["Trắng", "Đen"], sizes: ["S", "M"] },
];
const NAMES = ["Nguyễn Thu Hương", "Trần Thu Hà", "Lê Minh Anh", "Phạm Ngọc Lan", "Vũ Thanh Mai", "Bùi Lan Chi", "Đỗ Thảo Vy", "Hoàng Yến Nhi", "Ngô Kim Ngân", "Đinh Phương Thảo", "Trịnh Hải Yến", "Lý Bảo Trân", "Mai Diễm Quỳnh", "Dương Cẩm Tú", "Phan Ánh Dương", "Võ Ngọc Hân", "Tô Mỹ Linh", "Hồ Khánh Vân", "Lương Gia Hân", "Cao Thùy Dung"];
const PROVINCES = ["Hà Nội", "TP. Hồ Chí Minh", "Đà Nẵng", "Hải Phòng", "Cần Thơ", "Nghệ An", "Thanh Hoá", "Bắc Ninh", "Đồng Nai", "Bình Dương", "Quảng Ninh", "Lâm Đồng"];
const SOURCES = ["Facebook", "Facebook", "Facebook", "TikTok Shop", "Shopee", "Website", "Instagram"];
const SELLERS = ["Thu Trang", "Minh Tâm", "Hải Đăng", "Ngọc Ánh"];
const STREETS = ["12 Nguyễn Trãi", "45 Lê Lợi", "88 Trần Hưng Đạo", "7 Phan Đình Phùng", "101 Hai Bà Trưng", "23 Điện Biên Phủ", "56 Cách Mạng Tháng 8", "9 Lý Thường Kiệt"];

async function clearDemo() {
  const db = await getDb();
  await db.delete(schema.orders).where(like(schema.orders.id, "demo-%"));
  await db.delete(schema.shipments).where(like(schema.shipments.id, "demo-%"));
  await db.delete(schema.customers).where(like(schema.customers.id, "demo-%"));
  await db.delete(schema.products).where(like(schema.products.id, "demo-%"));
  await db.delete(schema.warehouses).where(like(schema.warehouses.id, "demo-%"));
  await db.delete(schema.expenses).where(like(schema.expenses.id, "demo-%"));
  await db.delete(schema.adSpends).where(like(schema.adSpends.id, "demo-%"));
  await db.delete(schema.codBatches).where(like(schema.codBatches.id, "demo-%"));
  await db.delete(schema.inventoryHistories).where(like(schema.inventoryHistories.id, "demo-%"));
  await db.delete(schema.orderReturns).where(like(schema.orderReturns.id, "demo-%"));
  await db.delete(schema.syncRuns).where(or(like(schema.syncRuns.actor, "demo%"), sql`false`));
  console.log("Đã xoá dữ liệu demo.");
}

async function seed() {
  const db = await getDb();
  await clearDemo();
  const now = Date.now();
  const day = 86_400_000;

  // Kho
  const warehouses = [
    { id: "demo-wh-1", name: "Kho Hà Nội", fullAddress: "Số 5 ngõ 12 Láng Hạ, Đống Đa, Hà Nội", address: "Số 5 ngõ 12 Láng Hạ", phone: "0987000111" },
    { id: "demo-wh-2", name: "Kho Sài Gòn", fullAddress: "120 Cộng Hoà, Tân Bình, TP.HCM", address: "120 Cộng Hoà", phone: "0987000222" },
  ];
  await db.insert(schema.warehouses).values(warehouses).onConflictDoNothing();

  // Sản phẩm & mẫu mã
  type V = { id: string; productId: string; name: string; sku: string; color: string; size: string; price: number; cost: number; image: string };
  const variants: V[] = [];
  let pi = 0;
  for (const p of PRODUCTS) {
    pi += 1;
    const productId = `demo-p-${pi}`;
    const image = "";
    await db.insert(schema.products).values({ id: productId, name: p.name, customId: `SP${String(pi).padStart(3, "0")}`, displayId: pi, image: image || null, categories: [pi % 2 ? "Đầm & váy" : "Áo & quần"], isPublished: true, insertedAt: new Date(now - 120 * day), syncedAt: new Date() });
    let vi = 0;
    for (const color of p.colors) {
      for (const size of p.sizes) {
        vi += 1;
        const id = `demo-v-${pi}-${vi}`;
        const sku = `SP${String(pi).padStart(3, "0")}-${color.slice(0, 2).toUpperCase().replace(/\s/g, "")}-${size}`;
        variants.push({ id, productId, name: p.name, sku, color, size, price: p.price, cost: p.cost, image });
        const stockHn = between(0, 40);
        const stockSg = between(0, 25);
        await db.insert(schema.productVariants).values({
          id,
          productId,
          sku,
          barcode: `${8930000000000 + pi * 100 + vi}`,
          attributes: [{ name: "Màu", value: color }, { name: "Size", value: size }],
          detail: `Màu: ${color}, Size: ${size}`,
          color,
          size,
          images: image ? [image] : [],
          weight: between(200, 600),
          retailPrice: p.price,
          retailPriceAfterDiscount: p.price,
          lastImportedPrice: p.cost,
          avgImportedPrice: p.cost * (0.95 + rand() * 0.1),
          remainQuantity: stockHn + stockSg,
          actualRemainQuantity: stockHn + stockSg + between(0, 3),
          insertedAt: new Date(now - 120 * day),
          updatedAtExternal: new Date(now - between(0, 10) * day),
          syncedAt: new Date(),
        });
        await db.insert(schema.variantStocks).values([
          { variantId: id, warehouseId: "demo-wh-1", remainQuantity: stockHn, actualRemainQuantity: stockHn + between(0, 2), totalQuantity: stockHn + between(20, 80), pendingQuantity: between(0, 3) },
          { variantId: id, warehouseId: "demo-wh-2", remainQuantity: stockSg, actualRemainQuantity: stockSg + between(0, 1), totalQuantity: stockSg + between(10, 40), pendingQuantity: between(0, 2) },
        ]);
      }
    }
  }

  // Khách hàng
  const customers: { id: string; name: string; phone: string; province: string; address: string }[] = [];
  for (let i = 0; i < 140; i += 1) {
    const name = `${pick(NAMES).split(" ").slice(0, -1).join(" ")} ${pick(["Anh", "Chi", "Dung", "Hà", "Linh", "Mai", "Ngọc", "Phương", "Quỳnh", "Trang", "Vy", "Yến"])}`;
    const phone = `09${between(10000000, 99999999)}`;
    const province = pick(PROVINCES);
    const address = `${pick(STREETS)}, ${province}`;
    customers.push({ id: `demo-c-${i + 1}`, name, phone, province, address });
  }
  await db.insert(schema.customers).values(customers.map((c) => ({ id: c.id, pancakeId: `demo-pc-${c.id}`, name: c.name, phone: c.phone, phones: [c.phone], address: c.address, province: c.province, insertedAt: new Date(now - between(10, 300) * day), syncedAt: new Date() })));

  // Đơn hàng 75 ngày
  const stagesByAge = (ageDays: number): number => {
    if (ageDays < 1) return pick([0, 0, 17, 1, 1, 8, 9, 2]);
    if (ageDays < 3) return pick([1, 8, 9, 2, 2, 2, 3, 6]);
    if (ageDays < 7) return pick([2, 2, 3, 3, 3, 3, 4, 6, 16]);
    return pick([3, 3, 3, 3, 3, 16, 16, 16, 5, 5, 4, 6, 15]);
  };
  let orderNo = 5200;
  const orderIds: { id: string; total: number; cod: number; insertedAt: Date; stage: string }[] = [];
  for (let d = 75; d >= 0; d -= 1) {
    const perDay = d === 0 ? between(3, 9) : between(6, 22) + (d % 7 === 0 ? 8 : 0);
    for (let k = 0; k < perDay; k += 1) {
      orderNo += 1;
      const insertedAt = new Date(now - d * day - between(0, 14) * 3600_000 - between(0, 59) * 60_000);
      const status = stagesByAge(d);
      const stage = pancakeStatusToStage(status);
      const customer = pick(customers);
      const lines = between(1, 3);
      const items: { variant: V; qty: number }[] = [];
      for (let l = 0; l < lines; l += 1) items.push({ variant: pick(variants), qty: rand() < 0.8 ? 1 : 2 });
      const totalPrice = items.reduce((s, i) => s + i.variant.price * i.qty, 0);
      const discount = rand() < 0.3 ? Math.round((totalPrice * pick([5, 10, 15])) / 100 / 1000) * 1000 : 0;
      const shippingFee = pick([0, 25000, 30000, 35000]);
      const customerPayFee = shippingFee > 0;
      const total = totalPrice - discount + (customerPayFee ? shippingFee : 0);
      const prepaid = rand() < 0.25 ? total : 0;
      const cod = prepaid ? 0 : total;
      const cogs = items.reduce((s, i) => s + i.variant.cost * i.qty, 0);
      const source = pick(SOURCES);
      const id = `demo-o-${orderNo}`;
      const partnerFee = status >= 2 && status !== 6 ? pick([22000, 25000, 28000, 32000, 35000]) : 0;
      const returnFee = status === 5 || status === 15 ? pick([15000, 20000]) : 0;
      const seller = pick(SELLERS);
      const lastStatusAt = new Date(insertedAt.getTime() + (status >= 2 && status !== 6 ? between(36, 96) : between(1, 30)) * 3600_000);
      await db.insert(schema.orders).values({
        id,
        systemId: orderNo,
        shopId: "408063069",
        status,
        statusName: pancakeStatusName(status),
        stage,
        customerId: customer.id,
        billFullName: customer.name,
        billPhone: customer.phone,
        shipFullName: customer.name,
        shipPhone: customer.phone,
        shipAddress: customer.address.split(",")[0],
        shipFullAddress: customer.address,
        shipProvince: customer.province,
        totalPrice,
        totalPriceAfterDiscount: total,
        totalDiscount: discount,
        shippingFee,
        partnerFee,
        customerPayFee,
        cod,
        moneyToCollect: cod,
        prepaid,
        source,
        accountName: source === "Facebook" ? "Glovico Fashion" : "",
        sellerName: seller,
        careName: rand() < 0.5 ? pick(SELLERS) : "",
        warehouseId: customer.province.includes("Hồ Chí Minh") || ["Đồng Nai", "Bình Dương", "Cần Thơ", "Lâm Đồng"].includes(customer.province) ? "demo-wh-2" : "demo-wh-1",
        note: rand() < 0.2 ? pick(["Giao giờ hành chính", "Gọi trước khi giao", "Không cho thử hàng", "Khách cần gấp"]) : "",
        tags: rand() < 0.3 ? [pick(["VIP", "Khách cũ", "Đổi size", "Ưu tiên"])] : [],
        itemsCount: items.length,
        totalQuantity: items.reduce((s, i) => s + i.qty, 0),
        cogs,
        returnFee,
        returnedReason: status === 5 ? pick(["Khách không nghe máy", "Khách đổi ý", "Sai size"]) : null,
        insertedAt,
        updatedAtExternal: lastStatusAt,
        lastUpdateStatusAt: lastStatusAt,
        timeSendPartner: status >= 2 ? new Date(insertedAt.getTime() + between(2, 30) * 3600_000) : null,
        raw: { demo: true },
        syncedAt: new Date(),
      });
      await db.insert(schema.orderItems).values(
        items.map((i, idx) => ({
          id: `${id}-i${idx + 1}`,
          orderId: id,
          variantId: i.variant.id,
          productId: i.variant.productId,
          productName: i.variant.name,
          variationDetail: `Màu: ${i.variant.color}, Size: ${i.variant.size}`,
          sku: i.variant.sku,
          quantity: i.qty,
          unitPrice: i.variant.price,
          unitCost: i.variant.cost,
          lineTotal: i.variant.price * i.qty,
          image: i.variant.image || null,
        })),
      );
      await db.insert(schema.orderStatusHistory).values([
        { orderId: id, status: 0, oldStatus: null, editorName: seller, updatedAt: insertedAt },
        ...(status !== 0 ? [{ orderId: id, status, oldStatus: status === 6 ? 0 : 1, editorName: status >= 2 ? "Hệ thống" : seller, updatedAt: lastStatusAt }] : []),
      ]);
      orderIds.push({ id, total, cod, insertedAt, stage });

      // Vận đơn
      if (status >= 2 && status !== 6 && status !== 7) {
        const carrier = rand() < 0.85 ? "Viettel Post" : pick(["GHN", "GHTK", "J&T"]);
        const vtpNumber = carrier === "Viettel Post" ? `${between(10000000000, 99999999999)}` : null;
        let vtpStatus: number | null = null;
        let shipmentStage: ShipmentStage = "PICKED_UP";
        let codStatus: CodStatus = cod > 0 ? "PENDING" : "NOT_APPLICABLE";
        let deliveredAt: Date | null = null;
        let returnedAt: Date | null = null;
        if (stage === "SHIPPED") {
          vtpStatus = pick([200, 300, 400, 500, 506, 508]);
          shipmentStage = vtpStatusMeta(vtpStatus).stage;
        } else if (stage === "DELIVERED" || stage === "PAID") {
          vtpStatus = 501;
          shipmentStage = "DELIVERED";
          deliveredAt = lastStatusAt;
          if (cod > 0) codStatus = stage === "PAID" || d > 14 ? "PAID_TO_BANK" : d > 7 ? "RECONCILED" : "COLLECTED";
        } else if (stage === "RETURNING") {
          vtpStatus = pick([502, 505, 515]);
          shipmentStage = "RETURNING";
          codStatus = "NOT_APPLICABLE";
        } else if (stage === "RETURNED" || stage === "PARTIAL_RETURN") {
          vtpStatus = 504;
          shipmentStage = "RETURNED";
          returnedAt = lastStatusAt;
          codStatus = "NOT_APPLICABLE";
        }
        const sid = `demo-s-${orderNo}`;
        const pickedUpAt = new Date(insertedAt.getTime() + between(6, 30) * 3600_000);
        await db.insert(schema.shipments).values({
          id: sid,
          orderId: id,
          carrier,
          partnerId: carrier === "Viettel Post" ? 3 : 1,
          trackingCode: vtpNumber ?? `${carrier.slice(0, 2).toUpperCase()}${between(100000000, 999999999)}`,
          vtpOrderNumber: vtpNumber,
          orderReference: String(orderNo),
          partnerStatus: shipmentStage === "DELIVERED" ? "delivered" : shipmentStage === "RETURNED" ? "returned" : "on_the_way",
          stage: shipmentStage,
          vtpStatus: carrier === "Viettel Post" ? vtpStatus : null,
          vtpStatusName: carrier === "Viettel Post" && vtpStatus ? vtpStatusMeta(vtpStatus).name : null,
          vtpStatusDate: lastStatusAt,
          vtpLocation: carrier === "Viettel Post" ? `Bưu cục ${pick(["Cầu Giấy", "Tân Bình", "Hải Châu", "Ngô Quyền", "Ninh Kiều"])}` : null,
          service: carrier === "Viettel Post" ? pick(["VCN", "LCOD", "NCOD"]) : null,
          weight: between(300, 900),
          codAmount: cod,
          codCollected: ["COLLECTED", "RECONCILED", "PAID_TO_BANK"].includes(codStatus) ? cod : 0,
          shippingFee: partnerFee,
          codStatus,
          codReconciledAt: ["RECONCILED", "PAID_TO_BANK"].includes(codStatus) ? new Date(lastStatusAt.getTime() + 2 * day) : null,
          codPaidToBankAt: codStatus === "PAID_TO_BANK" ? new Date(lastStatusAt.getTime() + 4 * day) : null,
          receiverName: customer.name,
          receiverPhone: customer.phone,
          receiverAddress: customer.address,
          pickedUpAt,
          firstDeliveryAt: shipmentStage === "PENDING" || shipmentStage === "PICKED_UP" ? null : new Date(pickedUpAt.getTime() + between(12, 60) * 3600_000),
          deliveredAt,
          returnedAt,
          isFinal: ["DELIVERED", "RETURNED", "CANCELLED"].includes(shipmentStage),
          lastVtpSyncAt: new Date(now - between(0, 300) * 60_000),
          lastPancakeSyncAt: new Date(),
          raw: { demo: true },
        });
        const events: (typeof schema.shipmentEvents.$inferInsert)[] = [
          { shipmentId: sid, source: "PANCAKE", status: "picked_up", statusName: "Đã lấy hàng", occurredAt: pickedUpAt },
        ];
        if (carrier === "Viettel Post") {
          events.push({ shipmentId: sid, source: "VTP_WEBHOOK", status: "200", statusName: "Lấy hàng thành công - nhập bưu cục gốc", location: "Bưu cục gốc", occurredAt: new Date(pickedUpAt.getTime() + 3600_000) });
          if (vtpStatus && vtpStatus >= 300) events.push({ shipmentId: sid, source: "VTP_WEBHOOK", status: "300", statusName: "Đóng tải - vận chuyển đi", location: "Trung tâm khai thác", occurredAt: new Date(pickedUpAt.getTime() + 6 * 3600_000) });
          if (vtpStatus && vtpStatus >= 400) events.push({ shipmentId: sid, source: "VTP_WEBHOOK", status: "400", statusName: "Nhận bàn giao - đến bưu cục phát", location: `Bưu cục phát ${customer.province}`, occurredAt: new Date(pickedUpAt.getTime() + 20 * 3600_000) });
          if (vtpStatus && vtpStatus >= 500) events.push({ shipmentId: sid, source: "VTP_WEBHOOK", status: "500", statusName: "Phân công bưu tá đi giao hàng", location: `Bưu cục phát ${customer.province}`, occurredAt: new Date(pickedUpAt.getTime() + 26 * 3600_000) });
          if (vtpStatus && vtpStatus !== 200 && vtpStatus !== 300 && vtpStatus !== 400 && vtpStatus !== 500) events.push({ shipmentId: sid, source: "VTP_WEBHOOK", status: String(vtpStatus), statusName: vtpStatusMeta(vtpStatus).name, location: `Bưu cục phát ${customer.province}`, note: vtpStatus === 506 ? "Khách không nghe máy" : "", occurredAt: lastStatusAt });
        }
        await db.insert(schema.shipmentEvents).values(events).onConflictDoNothing();
      }
    }
  }

  // Đổi trả
  const returnedOrders = orderIds.filter((o) => o.stage === "RETURNED" || o.stage === "PARTIAL_RETURN").slice(0, 25);
  if (returnedOrders.length) {
    await db.insert(schema.orderReturns).values(
      returnedOrders.map((o, i) => ({
        id: `demo-r-${i + 1}`,
        displayId: 300 + i,
        orderId: o.id,
        orderToReturnedId: o.id,
        status: pick([0, 1, 3]),
        statusName: pick(["Mới", "Đã nhận hàng hoàn", "Hoàn tất"]),
        returnedFee: pick([0, 15000, 20000]),
        isExchange: rand() < 0.3,
        billFullName: "",
        items: [{ product_name: "Sản phẩm hoàn", returned_quantity: 1 }],
        insertedAt: new Date(o.insertedAt.getTime() + 5 * day),
        raw: { demo: true },
      })),
    );
  }

  // Chi phí & quảng cáo
  const expenseRows: (typeof schema.expenses.$inferInsert)[] = [];
  const adRows: (typeof schema.adSpends.$inferInsert)[] = [];
  for (let d = 75; d >= 0; d -= 1) {
    const date = new Date(now - d * day);
    adRows.push({ id: `demo-a-fb-${d}`, platform: "Facebook", campaign: "Đầm midi — Conversion", spend: between(900000, 2400000), leads: between(40, 120), orders: between(6, 20), revenue: between(4000000, 14000000), spendDate: date, createdBy: "demo" });
    if (d % 2 === 0) adRows.push({ id: `demo-a-tt-${d}`, platform: "TikTok", campaign: "Video review — Áo thun", spend: between(400000, 1300000), leads: between(20, 70), orders: between(3, 12), revenue: between(1500000, 7000000), spendDate: date, createdBy: "demo" });
    if (d % 7 === 0) expenseRows.push({ id: `demo-e-pack-${d}`, category: "PACKAGING", description: "Túi zip, thiệp cảm ơn, tem size", amount: between(600000, 1200000), occurredAt: date, reference: `CP-${d}`, createdBy: "demo" });
    if (d % 30 === 0) {
      expenseRows.push({ id: `demo-e-rent-${d}`, category: "RENT", description: "Mặt bằng kho + văn phòng", amount: 18000000, occurredAt: date, createdBy: "demo" });
      expenseRows.push({ id: `demo-e-sal-${d}`, category: "SALARY", description: "Lương nhân viên chốt đơn & kho", amount: 46000000, occurredAt: date, createdBy: "demo" });
      expenseRows.push({ id: `demo-e-soft-${d}`, category: "SOFTWARE", description: "Pancake POS + phần mềm CSKH", amount: 2400000, occurredAt: date, createdBy: "demo" });
    }
  }
  await db.insert(schema.adSpends).values(adRows);
  await db.insert(schema.expenses).values(expenseRows);

  // Đợt nhận tiền COD
  await db.insert(schema.codBatches).values([
    { id: "demo-cb-1", reference: "VTP-BK-2026-08-20", carrier: "Viettel Post", receivedAt: new Date(now - 14 * day), totalAmount: 0, note: "Bảng kê COD kỳ 2", createdBy: "demo" },
    { id: "demo-cb-2", reference: "VTP-BK-2026-08-27", carrier: "Viettel Post", receivedAt: new Date(now - 7 * day), totalAmount: 0, note: "Bảng kê COD kỳ 3", createdBy: "demo" },
  ]);
  await db.execute(sql`update shipments set cod_batch_id = case when cod_paid_to_bank_at < now() - interval '10 days' then 'demo-cb-1' else 'demo-cb-2' end where id like 'demo-%' and cod_status = 'PAID_TO_BANK'`);
  await db.execute(sql`update cod_batches b set total_amount = coalesce((select sum(cod_collected) from shipments s where s.cod_batch_id = b.id), 0) where b.id like 'demo-%'`);

  // Nhật ký kho
  const invRows: (typeof schema.inventoryHistories.$inferInsert)[] = [];
  for (let i = 0; i < 120; i += 1) {
    const v = pick(variants);
    const isImport = rand() < 0.3;
    invRows.push({ id: `demo-ih-${i}`, variantId: v.id, warehouseId: pick(["demo-wh-1", "demo-wh-2"]), quantity: isImport ? between(10, 50) : -between(1, 3), remainQuantity: between(5, 60), avgPrice: v.cost, type: isImport ? `Nhập hàng #${between(100, 400)}` : `Xuất kho đơn #${between(5200, orderNo)}`, tableName: isImport ? "purchases" : "orders", editorName: pick(SELLERS), insertedAt: new Date(now - between(0, 60) * day - between(0, 20) * 3600_000) });
  }
  await db.insert(schema.inventoryHistories).values(invRows);

  // Lịch sử đồng bộ mẫu
  await db.insert(schema.syncRuns).values([
    { source: "PANCAKE", job: "orders_incremental", status: "SUCCESS", trigger: "CRON", actor: "demo-scheduler", imported: 4, updated: 27, skipped: 61, detail: "92 đơn thay đổi (mới 4, cập nhật 27)", startedAt: new Date(now - 9 * 60_000), finishedAt: new Date(now - 8 * 60_000) },
    { source: "VIETTELPOST", job: "tracking_poll", status: "SUCCESS", trigger: "CRON", actor: "demo-scheduler", updated: 12, skipped: 140, detail: "Đã kiểm tra 152 vận đơn · cập nhật 12", startedAt: new Date(now - 25 * 60_000), finishedAt: new Date(now - 23 * 60_000) },
    { source: "PANCAKE", job: "products", status: "SUCCESS", trigger: "CRON", actor: "demo-scheduler", updated: 10, detail: "10 sản phẩm · 78 mẫu mã", startedAt: new Date(now - 65 * 60_000), finishedAt: new Date(now - 64 * 60_000) },
  ]);

  console.log(`Đã tạo demo: ${PRODUCTS.length} sản phẩm, ${variants.length} mẫu mã, ${customers.length} khách, ${orderIds.length} đơn hàng.`);
}

async function main() {
  await ensureMigrated();
  await ensureAdminUser();
  if (clear) await clearDemo();
  else await seed();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
