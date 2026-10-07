/**
 * ═══════════ BÁO NHÓM ĐƠN «MỚI» CHƯA XÁC NHẬN — CHỈ MÁY CHỦ ═══════════
 *
 * Chủ shop Hải Sản Làng Chài 04/10/2026: «Bắn telegram cả với những đơn mới, chứ không riêng gì đơn đã xác nhận. Cứ có đủ
 * thông tin đơn hàng (SĐT, địa chỉ, SKU) là thông báo». Luật «báo nhóm vận hành» chỉ nghe `order.confirmed` — đơn bot lên mà
 * khách chưa chốt nằm ở «Mới» và kho không hề biết (đo 04/10: 5/7 đơn hôm nay ở «Mới», không đơn nào có tin).
 *
 * Mỗi lượt (job `sales-followup`, 5 phút): đơn tạo tay / bot (ERP) ở «Mới», ĐỦ SĐT + địa chỉ + ít nhất một dòng hàng, tạo
 * cách đây hơn `settleMinutes` (đơn bot thường được khách chốt ngay sau tóm tắt — chốt kịp thì đã có tin «ĐƠN MỚI» của luật
 * xác nhận, không báo hai lần) và trong `lookbackHours` ⇒ MỘT tin vào đúng nhóm báo đơn. Mỗi đơn một tin (khoá `order-new:<id>`).
 * Đơn ghi từ hội thoại nhân viên (`ORDER_SYNC_CHANNEL`) đã có tin riêng lúc ghi — bỏ qua. Không ném.
 */
import { and, asc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { manualOrderRaw, orderNoteForGroup } from "@/lib/constants/manual-orders";
import { formatVND } from "@/lib/format";
import { deliverMessage } from "@/lib/messaging/service";
import { operationsGroupChannel } from "@/lib/sales-chatbot/alerts";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { homeRuntimeIdleReason } from "@/lib/sales-chatbot/page-runtime";
import { orderGroupText, ORDER_SYNC_CHANNEL } from "@/lib/sales-chatbot/order-sync-shared";
import { freeShipVerdict, variantWeightGrams, type FreeShippingRule } from "@/lib/sales-chatbot/shipping";

export const NEW_ORDER_ALERT = { settleMinutes: 5, lookbackHours: 24, perRun: 30 } as const;

const dedupeKeyOf = (orderId: string) => `order-new:${orderId}`;

/** `province` / `ward` = ô tỉnh / xã đã ghép theo địa giới mới; `undefined` = nơi gọi không đọc (tin không nhắc gì). */
type AlertOrder = { shippingFee: number; name: string; phone: string; address: string; note: string | null; province?: string; ward?: string };

/** Dòng nhắc khi địa chỉ chưa ghép được tỉnh / xã — kho biết đơn này chưa gửi hãng vận chuyển được. HÀM THUẦN. */
export function placeGapLine(o: { province?: string; ward?: string }): string {
  if (o.province === undefined) return "";
  if (!o.province.trim()) return "⚠ Chưa nhận ra tỉnh / thành từ địa chỉ — cần sửa địa chỉ đơn.";
  if (o.ward !== undefined && !o.ward.trim()) return "⚠ Chưa chọn xã / phường — chọn ở đơn trước khi gửi hãng vận chuyển.";
  return "";
}
type AlertLine = { name: string; quantity: number; unitPrice: number; lineTotal: number; weight: number | null };

/**
 * Tin của MỘT đơn «Mới» — cùng kiểu tin đơn của shop (không mã đơn / nguồn / link). Ship: đơn đạt luật miễn ship của shop
 * (chủ shop 04/10/2026: «không thu ship với những đơn có COD > 280K ở Hà Nội, Đà Nẵng, TP HCM» — ngưỡng và khu vực là cấu
 * hình «Miễn phí ship» của bot) ⇒ «Miễn phí»; đơn có phí ship ⇒ số; còn lại ⇒ «chưa báo» (không in 0 ₫ — luật 42). HÀM THUẦN.
 */
export function newOrderAlertText(o: AlertOrder, lines: readonly AlertLine[], rule: FreeShippingRule): string {
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const weights = lines.map((l) => (l.weight === null ? null : l.weight * l.quantity));
  const weight = weights.some((w) => w === null) ? null : (weights as number[]).reduce((s, w) => s + w, 0);
  const free = freeShipVerdict(rule, subtotal, weight, o.address, formatVND).kind === "FREE";
  const fee = free ? 0 : o.shippingFee > 0 ? o.shippingFee : null;
  const note = orderNoteForGroup(o.note);
  return orderGroupText({ header: "🆕 ĐƠN MỚI (chưa xác nhận)", name: o.name, phone: o.phone, address: o.address, province: "", lines, subtotal, shippingFee: fee, shipText: free ? "Miễn phí" : null, warnings: [note ? `Ghi chú: ${note}` : "", placeGapLine(o)].filter(Boolean) });
}

export type NewOrderAlertResult = { candidates: number; sent: number; reason?: string };

export async function sendNewOrderAlerts(now: Date = new Date()): Promise<NewOrderAlertResult> {
  try {
    // Workspace nhà: đơn đến từ Pancake và bot cũ đang lo — chưa page nào LIVE thì runtime mới không báo nhóm (page-runtime.ts).
    const idle = await homeRuntimeIdleReason();
    if (idle) return { candidates: 0, sent: 0, reason: idle };
    const group = await operationsGroupChannel();
    if (!group) return { candidates: 0, sent: 0, reason: "chưa cấu hình nhóm báo đơn" };
    const db = await getDb();
    const o = schema.orders;
    const rows = await db
      .select({ id: o.id, raw: o.raw, shipProvince: o.shipProvince, shipCommune: o.shipCommune, shipPhone: o.shipPhone, billPhone: o.billPhone, shipFullAddress: o.shipFullAddress, shipAddress: o.shipAddress, shipFullName: o.shipFullName, billFullName: o.billFullName, shippingFee: o.shippingFee, note: o.note })
      .from(o)
      .where(and(eq(o.stage, "NEW"), ne(o.source, ORDER_SYNC_CHANNEL), gte(o.insertedAt, new Date(now.getTime() - NEW_ORDER_ALERT.lookbackHours * 3_600_000)), lte(o.insertedAt, new Date(now.getTime() - NEW_ORDER_ALERT.settleMinutes * 60_000))))
      .limit(200);
    const complete = rows.filter((r) => manualOrderRaw(r.raw) && (r.shipPhone || r.billPhone)?.trim() && (r.shipFullAddress || r.shipAddress)?.trim());
    if (!complete.length) return { candidates: 0, sent: 0 };
    const d = schema.messagingDeliveries;
    const done = new Set((await db.select({ key: d.dedupeKey }).from(d).where(inArray(d.dedupeKey, complete.map((r) => dedupeKeyOf(r.id))))).map((x) => x.key));
    const todo = complete.filter((r) => !done.has(dedupeKeyOf(r.id))).slice(0, NEW_ORDER_ALERT.perRun);
    const it = schema.orderItems;
    const items = todo.length
      ? await db
          .select({ orderId: it.orderId, name: it.productName, variation: it.variationDetail, quantity: it.quantity, unitPrice: it.unitPrice, lineTotal: it.lineTotal, weight: it.weight })
          .from(it)
          .where(inArray(it.orderId, todo.map((r) => r.id)))
          .orderBy(asc(it.id))
      : [];
    const rule = (await loadSalesChatbotConfig()).freeShipping;
    let sent = 0;
    for (const r of todo) {
      const lines = items
        .filter((x) => x.orderId === r.id)
        .map((x) => ({ name: x.variation ? `${x.name} (${x.variation})` : x.name, quantity: x.quantity, unitPrice: x.unitPrice, lineTotal: x.lineTotal, weight: variantWeightGrams(x.weight, x.name, x.variation ?? "") }));
      if (!lines.length) continue;
      const body = newOrderAlertText({ shippingFee: r.shippingFee, name: r.shipFullName || r.billFullName || "—", phone: (r.shipPhone || r.billPhone || "").trim(), address: (r.shipFullAddress || r.shipAddress || "").trim(), note: r.note, province: r.shipProvince ?? "", ward: r.shipCommune ?? "" }, lines, rule);
      await deliverMessage({ connectorKey: group.connectorKey, destination: group.destination, title: "Đơn mới chưa xác nhận", body, dedupeKey: dedupeKeyOf(r.id), event: "order.new", subject: { type: "ORDER", id: r.id } });
      sent += 1;
    }
    return { candidates: todo.length, sent };
  } catch (e) {
    return { candidates: 0, sent: 0, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}
