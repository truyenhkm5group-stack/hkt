import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { planPackingWaves, type PackingPlan, type PackOrder } from "@/lib/constants/packing-waves";
import { promiseSuppressesInternalSla } from "@/lib/constants/promised-delivery";
import { variantLabel } from "@/lib/constants/stock-shortage";
import { dataBlockReason } from "@/lib/queries/fulfillment-bottleneck";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { RESERVED_IN_WAREHOUSE } from "@/lib/queries/stock";
import { getStockShortage } from "@/lib/queries/stock-shortage";

const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;
const pv = schema.productVariants;
const p = schema.products;

/**
 * ═══════════ ĐÓNG GÓI THEO LƯỢT — ĐỌC ═══════════
 *
 * Luật gom ở `lib/constants/packing-waves.ts` (hàm thuần). Tệp này chỉ chọn ĐƠN NÀO được gom, và chọn
 * bằng đúng các vị ngữ đã có — không vị ngữ thứ hai:
 *
 *  · Hàng CHƯA rời kho = `RESERVED_IN_WAREHOUSE` (sổ kho), nối vận đơn theo `PRIMARY_ATTEMPT`.
 *  · CÒN PHẢI ĐÓNG = đơn ở giai đoạn `CONFIRMED` hoặc `PACKING` ("Đang đóng hàng"). KHÔNG dựa vào
 *    "đã có vận đơn hay chưa": Pancake tạo vận đơn TRƯỚC khi đóng gói — đo production 24/09/2026,
 *    đơn "Đang đóng hàng" đã mang mã PKE. `READY_TO_SHIP` ("Chờ lấy hàng") và `SHIPPED` là đã đóng.
 *  · ĐỦ HÀNG = `allocateStock` nói `READY` (`getStockShortage`) — cùng phép phân bổ ai lên trước được
 *    hàng trước mà trang Thiếu hàng và hàng đợi fulfillment dùng.
 *  · THIẾU DỮ LIỆU = `dataBlockReason` của hàng đợi fulfillment — đơn chưa tạo được vận đơn thì đóng
 *    gói trước là đóng một gói có thể bị huỷ.
 *  · KHÁCH HẸN NGÀY XA = `promiseSuppressesInternalSla` — chưa cần đóng hôm nay.
 *
 * Đơn bị loại được ĐẾM theo từng lý do, không biến mất khỏi mắt người đọc.
 */

export type PackingExclusions = {
  waitingStock: number;
  stockUnknown: number;
  dataBlocked: number;
  promisedLater: number;
  /** Đơn vừa xuất hiện giữa hai lượt đọc — bảng phân bổ (đệm 60 giây) chưa kết luận. */
  notYetAllocated: number;
};

export type PackingWaves = PackingPlan & { excluded: PackingExclusions; measuredAt: Date };

export async function getPackingWaves(now: Date = new Date()): Promise<PackingWaves> {
  const db = await getDb();
  const rows = await db
    .select({
      orderId: o.id,
      systemId: o.systemId,
      customer: o.billFullName,
      phone: o.billPhone,
      address: o.shipAddress,
      province: o.shipProvince,
      insertedAt: o.insertedAt,
      promisedAt: o.customerPromisedAt,
      variantId: oi.variantId,
      qty: oi.quantity,
      productCode: sql<string>`coalesce(${p.customId}, '')`,
      productName: p.name,
      color: pv.color,
      size: pv.size,
      sku: pv.sku,
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .innerJoin(pv, eq(pv.id, oi.variantId))
    .innerJoin(p, eq(p.id, pv.productId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(and(RESERVED_IN_WAREHOUSE, isNotNull(oi.variantId), inArray(o.stage, ["CONFIRMED", "PACKING"])));

  const excluded: PackingExclusions = { waitingStock: 0, stockUnknown: 0, dataBlocked: 0, promisedLater: 0, notYetAllocated: 0 };
  if (!rows.length) return { ...planPackingWaves([]), excluded, measuredAt: now };

  const snapshot = await getStockShortage();
  const byOrder = new Map<string, PackOrder & { phone: string; address: string; province: string; promisedAt: Date | null }>();
  for (const r of rows) {
    const cur =
      byOrder.get(r.orderId) ??
      {
        orderId: r.orderId,
        systemId: r.systemId ?? null,
        customer: r.customer || "Khách",
        insertedAt: new Date(r.insertedAt),
        lines: [],
        phone: r.phone,
        address: r.address,
        province: r.province,
        promisedAt: r.promisedAt ? new Date(r.promisedAt) : null,
      };
    cur.lines.push({ variantId: r.variantId as string, label: variantLabel(r), qty: Number(r.qty ?? 0) });
    byOrder.set(r.orderId, cur);
  }

  const ready: PackOrder[] = [];
  for (const d of byOrder.values()) {
    if (promiseSuppressesInternalSla(d.promisedAt, now)) {
      excluded.promisedLater += 1;
      continue;
    }
    if (dataBlockReason({ bill_phone: d.phone, ship_address: d.address, ship_province: d.province })) {
      excluded.dataBlocked += 1;
      continue;
    }
    const v = snapshot.orders.get(d.orderId);
    if (!v) excluded.notYetAllocated += 1;
    else if (v.state === "WAITING_STOCK") excluded.waitingStock += 1;
    else if (v.state === "STOCK_UNKNOWN") excluded.stockUnknown += 1;
    else ready.push({ orderId: d.orderId, systemId: d.systemId, customer: d.customer, insertedAt: d.insertedAt, lines: d.lines });
  }

  return { ...planPackingWaves(ready), excluded, measuredAt: now };
}
