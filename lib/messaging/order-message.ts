/**
 * ═══════════ NỘI DUNG TIN ĐƠN HÀNG CHO NHÓM VẬN HÀNH (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * Dựng bộ biến `ORDER_MESSAGE_VARS` (lib/messaging/types.ts) từ đơn ĐANG LƯU trong CSDL của tổ chức ngữ cảnh — đọc lúc
 * gửi, không từ ảnh chụp của sự kiện: tin "cập nhật" phải nói địa chỉ / số lượng / COD MỚI. Phần duy nhất lấy từ sự kiện
 * là thứ chỉ sự kiện biết: phần vừa đổi (`changes`) và lý do huỷ.
 *
 * Tiền in theo `formatVND` (luật 42: số 0 thật in `0 ₫`). COD của đơn tay = tiền hàng sau chiết khấu + phí ship — đúng
 * số form đơn in ở ô «Khách trả (gồm ship)».
 */
import { asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { manualOrderRaw, manualOrderShortCode, ORDER_MATERIAL_CHANGE_LABEL, type OrderMaterialChange } from "@/lib/constants/manual-orders";
import { ORDER_STAGE_LABEL } from "@/lib/constants/pancake";
import { formatVND } from "@/lib/format";
import { organizationBaseUrl } from "@/lib/platform/publish";

export type OrderEventContext = { name: string | null; payload: Record<string, unknown> };

export async function orderMessageVars(orderId: string, ev: OrderEventContext | null): Promise<Record<string, string> | null> {
  const db = await getDb();
  const [o] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  if (!o) return null;
  const items = await db
    .select({ name: schema.orderItems.productName, variation: schema.orderItems.variationDetail, qty: schema.orderItems.quantity, unit: schema.orderItems.unitPrice, total: schema.orderItems.lineTotal })
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, orderId))
    .orderBy(asc(schema.orderItems.id));
  const lines = items.map((i) => `• ${i.name}${i.variation ? ` (${i.variation})` : ""} × ${i.qty} × ${formatVND(i.unit)} = ${formatVND(i.total)}`);
  const orderDiscount = manualOrderRaw(o.raw)?.orderDiscount ?? 0;
  const lineSum = items.reduce((s, i) => s + i.total, 0);
  const changes = Array.isArray(ev?.payload?.changes)
    ? (ev!.payload.changes as unknown[])
        .filter((c): c is OrderMaterialChange => typeof c === "string" && c in ORDER_MATERIAL_CHANGE_LABEL)
        .map((c) => ORDER_MATERIAL_CHANGE_LABEL[c])
        .join(", ")
    : "";
  const base = await organizationBaseUrl();
  return {
    order_code: `#${manualOrderShortCode(o.id)}`,
    status: ORDER_STAGE_LABEL[o.stage] ?? o.statusName ?? o.stage,
    customer_name: o.billFullName || "—",
    customer_phone: o.billPhone || "—",
    recipient_name: o.shipFullName || o.billFullName || "—",
    recipient_phone: o.shipPhone || o.billPhone || "—",
    address: o.shipFullAddress || o.shipAddress || "—",
    items: lines.length ? lines.join("\n") : "(không có dòng hàng)",
    subtotal: formatVND(lineSum),
    discount: formatVND(o.totalDiscount),
    shipping_fee: formatVND(o.shippingFee),
    cod: formatVND(o.totalPriceAfterDiscount + o.shippingFee),
    source: o.source || "—",
    note: o.note?.trim() || "—",
    changes: changes || "—",
    cancel_reason: typeof ev?.payload?.reason === "string" && ev.payload.reason.trim() ? ev.payload.reason.trim() : "—",
    erp_link: `${base}/orders/${encodeURIComponent(o.id)}`,
    order_discount: formatVND(orderDiscount),
  };
}

/** Đơn gần nhất để "Gửi thử" có dữ liệu thật; không có đơn nào ⇒ bộ biến MẪU ghi rõ là mẫu. */
export async function sampleOrderMessageVars(): Promise<{ vars: Record<string, string>; sample: boolean; orderId: string | null }> {
  const db = await getDb();
  const [o] = await db.select({ id: schema.orders.id }).from(schema.orders).orderBy(desc(schema.orders.insertedAt)).limit(1);
  if (o) {
    const vars = await orderMessageVars(o.id, { name: "order.updated", payload: { changes: ["lines", "shipping_address"], reason: "Khách đổi ý (tin thử)" } });
    if (vars) return { vars, sample: false, orderId: o.id };
  }
  const base = await organizationBaseUrl();
  return {
    sample: true,
    orderId: null,
    vars: {
      order_code: "#MAUTHU01",
      status: "Đã xác nhận",
      customer_name: "Khách mẫu",
      customer_phone: "0900000000",
      recipient_name: "Khách mẫu",
      recipient_phone: "0900000000",
      address: "Số 1 Đường Mẫu, Quận Mẫu",
      items: `• Sản phẩm mẫu × 2 × ${formatVND(100_000)} = ${formatVND(200_000)}`,
      subtotal: formatVND(200_000),
      discount: formatVND(0),
      shipping_fee: formatVND(30_000),
      cod: formatVND(230_000),
      source: "Tin thử",
      note: "—",
      changes: "Hàng / số lượng / giá",
      cancel_reason: "Tin thử",
      erp_link: `${base}/orders`,
      order_discount: formatVND(0),
    },
  };
}
