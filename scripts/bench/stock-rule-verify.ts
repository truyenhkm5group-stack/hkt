/**
 * ĐỐI CHIẾU HAI ĐỊNH NGHĨA "ĐÃ XUẤT KHO" — bằng chứng nghiệp vụ cho thay đổi ở `ERP_STOCK_SUB`.
 *
 * Trang Sản phẩm & tồn kho có hai đường tính tồn. Cột tồn trong bảng luôn dùng SỔ KHO
 * (`erpStockExpr` = tổng phiếu − `SHIPMENT_LEFT_WAREHOUSE`). Bộ lọc "Sắp hết / Hết hàng / Còn hàng"
 * và ba bộ đếm facet TỪNG dùng một công thức khác: trừ theo
 * `ORDER_OUTCOME in ('DELIVERED','IN_TRANSIT') or RETURN_PENDING_WAREHOUSE` — tức đếm "đã xuất"
 * bằng ĐỊNH NGHĨA THEO TIỀN, thứ AGENTS.md mục 3.10 và HANDOFF mục 6.7 cấm.
 *
 * Script này dựng dữ liệu có ĐỦ các tình huống mà hai công thức có thể lệch, rồi in ra từng mẫu mã:
 * tổng phiếu kho · đã xuất theo SỔ KHO · đã xuất theo TIỀN · tồn theo hai cách · kết quả đơn.
 *
 * Đồng thời in các KPI KHÔNG được phép đổi (giao thành công / hoàn / huỷ / chưa biết / GTC) tính
 * bằng `ORDER_OUTCOME` — để thấy chúng độc lập hoàn toàn với thay đổi này.
 *
 * Chạy: npx tsx scripts/bench/stock-rule-verify.ts
 */
import "dotenv/config";
import { rmSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

const dir = path.join("data", `pglite-stockrule-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.DATABASE_URL = `pglite://${dir}`;

const DAY = 86_400_000;
const now = Date.now();

/** Một tình huống = một mẫu mã, để mọi chênh lệch quy được về đúng nguyên nhân. */
type Case = {
  key: string;
  mota: string;
  orderStage: string;
  shipmentStage: string | null;
  pickedUp: boolean;
  codCollected: number;
  returnReceived: boolean;
  /** Có sự kiện hành trình thật của ĐVVC hay không (không có ⇒ ORDER_OUTCOME = UNKNOWN) */
  vtpEvent: null | { status: string; leg: string; stage: string };
  /** Kho đã lập phiếu tái nhập cho kiện hoàn chưa */
  returnReceipt: boolean;
};

const CASES: Case[] = [
  { key: "v1", mota: "Dang giao (da lay hang)", orderStage: "SHIPPED", shipmentStage: "IN_TRANSIT", pickedUp: true, codCollected: 0, returnReceived: false, vtpEvent: { status: "300", leg: "OUTBOUND", stage: "IN_TRANSIT" }, returnReceipt: false },
  { key: "v2", mota: "Giao thanh cong, thu du tien", orderStage: "DELIVERED", shipmentStage: "DELIVERED", pickedUp: true, codCollected: 500_000, returnReceived: false, vtpEvent: { status: "501", leg: "OUTBOUND", stage: "DELIVERED" }, returnReceipt: false },
  { key: "v3", mota: "Hoan, kho CHUA nhan", orderStage: "RETURNED", shipmentStage: "RETURNED", pickedUp: true, codCollected: 0, returnReceived: false, vtpEvent: { status: "504", leg: "RETURN", stage: "RETURNED" }, returnReceipt: false },
  { key: "v4", mota: "Hoan, kho DA nhan va da lap phieu tai nhap", orderStage: "RETURNED", shipmentStage: "RETURNED", pickedUp: true, codCollected: 0, returnReceived: true, vtpEvent: { status: "504", leg: "RETURN", stage: "RETURNED" }, returnReceipt: true },
  { key: "v5", mota: "Huy SAU khi da xuat kho", orderStage: "CANCELLED", shipmentStage: "CANCELLED", pickedUp: true, codCollected: 0, returnReceived: false, vtpEvent: { status: "201", leg: "OUTBOUND", stage: "CANCELLED" }, returnReceipt: false },
  { key: "v6", mota: "Da tao van don, buu ta CHUA lay hang", orderStage: "CONFIRMED", shipmentStage: "PENDING", pickedUp: false, codCollected: 0, returnReceived: false, vtpEvent: null, returnReceipt: false },
  { key: "v7", mota: "Co van don nhung KHONG dau vet DVVC (UNKNOWN)", orderStage: "DELIVERED", shipmentStage: "PENDING", pickedUp: false, codCollected: 0, returnReceived: false, vtpEvent: null, returnReceipt: false },
  { key: "v8", mota: "Tieu huy (503) - hang KHONG quay ve kho", orderStage: "SHIPPED", shipmentStage: "DELIVERED", pickedUp: true, codCollected: 0, returnReceived: false, vtpEvent: { status: "503", leg: "OUTBOUND", stage: "RETURNED" }, returnReceipt: false },
];

async function main() {
  const { ensureMigrated } = await import("@/db/migrate");
  await ensureMigrated();
  const { getDb, schema } = await import("@/db");
  const db = await getDb();

  await db.insert(schema.products).values({ id: "sr-p", name: "Ma hang kiem chung", insertedAt: new Date(now - 100 * DAY), syncedAt: new Date() });
  const [receipt] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: new Date(now - 90 * DAY), reference: "NK-KIEM-CHUNG", totalQuantity: 0, totalCost: 0, createdBy: "verify" })
    .returning({ id: schema.stockReceipts.id });

  for (const c of CASES) {
    await db.insert(schema.productVariants).values({ id: c.key, productId: "sr-p", sku: c.key.toUpperCase(), detail: c.mota, retailPrice: 500_000, lastImportedPrice: 200_000, insertedAt: new Date(now - 90 * DAY), syncedAt: new Date() });
    // Mỗi mẫu mã nhập 10 cái
    await db.insert(schema.stockReceiptItems).values({ receiptId: receipt.id, variantId: c.key, quantity: 10, unitCost: 200_000 });

    const orderId = `sr-o-${c.key}`;
    await db.insert(schema.orders).values({
      id: orderId,
      status: c.orderStage === "CANCELLED" ? 6 : 3,
      statusName: c.orderStage,
      stage: c.orderStage as never,
      billFullName: c.mota,
      totalPrice: 500_000,
      totalPriceAfterDiscount: 500_000,
      cod: 500_000,
      insertedAt: new Date(now - 20 * DAY),
      syncedAt: new Date(),
    });
    await db.insert(schema.orderItems).values({ id: `sr-i-${c.key}`, orderId, variantId: c.key, productId: "sr-p", productName: "Ma hang kiem chung", sku: c.key.toUpperCase(), quantity: 1, unitPrice: 500_000, unitCost: 200_000, lineTotal: 500_000 });

    if (c.shipmentStage) {
      const shipmentId = `sr-s-${c.key}`;
      await db.insert(schema.shipments).values({
        id: shipmentId,
        orderId,
        carrier: "Viettel Post",
        trackingCode: c.vtpEvent ? `PKE${c.key}` : null,
        vtpOrderNumber: c.vtpEvent ? `PKE${c.key}` : null,
        stage: c.shipmentStage as never,
        codAmount: 500_000,
        codCollected: c.codCollected,
        shippingFee: 25_000,
        codStatus: c.codCollected > 0 ? "COLLECTED" : "PENDING",
        pickedUpAt: c.pickedUp ? new Date(now - 18 * DAY) : null,
        deliveredAt: c.shipmentStage === "DELIVERED" ? new Date(now - 15 * DAY) : null,
        returnedAt: c.shipmentStage === "RETURNED" ? new Date(now - 14 * DAY) : null,
        returnReceivedAt: c.returnReceived ? new Date(now - 10 * DAY) : null,
        returnReceivedBy: c.returnReceived ? "kho" : null,
      });
      if (c.vtpEvent) {
        await db.insert(schema.shipmentEvents).values({
          id: `sr-e-${c.key}`,
          shipmentId,
          source: "VTP_WEBHOOK",
          status: c.vtpEvent.status,
          statusName: c.vtpEvent.status,
          occurredAt: new Date(now - 15 * DAY),
          legType: c.vtpEvent.leg,
          normalizedStage: c.vtpEvent.stage as never,
          sourceReference: `PKE${c.key}`,
        });
      }
      // Kho lập phiếu tái nhập cho kiện hoàn đã đếm
      if (c.returnReceipt) {
        const [rr] = await db
          .insert(schema.stockReceipts)
          .values({ kind: "RETURN", receivedAt: new Date(now - 10 * DAY), reference: `TN-${c.key}`, totalQuantity: 0, totalCost: 0, createdBy: "kho" })
          .returning({ id: schema.stockReceipts.id });
        await db.insert(schema.stockReceiptItems).values({ receiptId: rr.id, variantId: c.key, quantity: 1, unitCost: 200_000, shipmentId });
      }
    }
  }
  await db.execute(sql`analyze`);

  const { ORDER_OUTCOME, RETURN_PENDING_WAREHOUSE, SHIPMENT_LEFT_WAREHOUSE } = await import("@/lib/queries/return-rate");
  const pv = schema.productVariants;
  const oi = schema.orderItems;
  const o = schema.orders;
  const s = schema.shipments;

  const daXuat = (dieuKien: ReturnType<typeof sql>) => sql`coalesce((select sum(${oi.quantity}) from ${oi}
      join ${o} on ${o.id} = ${oi.orderId}
      left join ${s} on ${s.orderId} = ${o.id}
      where ${oi.variantId} = ${pv.id} and ${dieuKien}), 0)`;
  const nhap = sql`coalesce((select sum(ri.quantity) from stock_receipt_items ri where ri.variant_id = ${pv.id}), 0)`;

  const rows = await db
    .select({
      key: sql<string>`${pv.id}`,
      mota: sql<string>`${pv.detail}`,
      nhap: sql<number>`${nhap}`,
      xuatSoKho: sql<number>`${daXuat(SHIPMENT_LEFT_WAREHOUSE)}`,
      xuatTheoTien: sql<number>`${daXuat(sql`(${ORDER_OUTCOME} in ('DELIVERED','IN_TRANSIT') or ${RETURN_PENDING_WAREHOUSE})`)}`,
    })
    .from(pv)
    .orderBy(pv.id);

  // Kết quả đơn lấy bằng một truy vấn riêng trên đúng bảng của nó, rồi ghép trong JS —
  // nhét `ORDER_OUTCOME` vào truy vấn con vô hướng bên trên làm tên cột nhập nhằng.
  const outcomes = await db
    .select({ orderId: sql<string>`${o.id}`, outcome: ORDER_OUTCOME })
    .from(o)
    .leftJoin(s, sql`${s.orderId} = ${o.id}`);
  const outcomeOf = new Map(outcomes.map((x) => [String(x.orderId), String(x.outcome)]));

  const head = ["MAU MA", "TINH HUONG", "NHAP", "XUAT(so kho)", "XUAT(tien)", "TON MOI", "TON CU", "KET QUA DON", "LECH"];
  const table = rows.map((r) => {
    const moi = Number(r.nhap) - Number(r.xuatSoKho);
    const cu = Number(r.nhap) - Number(r.xuatTheoTien);
    const ketQua = outcomeOf.get(`sr-o-${r.key}`) ?? "?";
    return [String(r.key), String(r.mota).slice(0, 42), String(r.nhap), String(r.xuatSoKho), String(r.xuatTheoTien), String(moi), String(cu), ketQua, moi === cu ? "" : `** ${cu} -> ${moi}`];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log("\n" + line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of table) console.log(line(r));

  const lech = table.filter((r) => r[8]);
  console.log(`\nSo mau ma LECH giua hai dinh nghia: ${lech.length}/${table.length}`);
  for (const r of lech) console.log(`  ${r[0]} (${r[1]}): ton cu ${r[6]} -> ton moi ${r[5]}  [ket qua don: ${r[7]}]`);

  // ── KPI KHÔNG ĐƯỢC PHÉP ĐỔI ─────────────────────────────────────────────
  const [kpi] = await db
    .select({
      delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE'))`,
      cancelled: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'CANCELLED')`,
      inTransit: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
      unknown: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'UNKNOWN')`,
      leftWarehouse: sql<number>`count(*) filter (where ${SHIPMENT_LEFT_WAREHOUSE})`,
    })
    .from(o)
    .leftJoin(s, sql`${s.orderId} = ${o.id}`);
  const d = Number(kpi.delivered);
  const r = Number(kpi.returned);
  console.log(
    `\nKPI theo ORDER_OUTCOME (khong phu thuoc thay doi nay): giao TC ${d} · hoan ${r} · huy ${kpi.cancelled} · dang giao ${kpi.inTransit} · chua biet ${kpi.unknown} · GTC ${d + r ? ((d / (d + r)) * 100).toFixed(1) : "—"}%`,
  );
  console.log(`Da roi kho theo SHIPMENT_LEFT_WAREHOUSE: ${kpi.leftWarehouse} don\n`);

  rmSync(dir, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  });
