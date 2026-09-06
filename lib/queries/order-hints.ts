/**
 * Gợi ý "địa chỉ cũ" cho đơn thiếu thông tin.
 * Khách cũ mua lại qua chat thường không nhắn lại SĐT / địa chỉ ("gửi về địa chỉ cũ") nên đơn mới bị trống và không gửi ĐVVC được.
 * Đơn từ chat vẫn mang mã khách Pancake và mã hội thoại, vì vậy khớp theo customerId → conversationId → SĐT (theo thứ tự tin cậy giảm dần).
 */
import { and, desc, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";

const o = schema.orders;

export type PrevOrderHint = {
  orderId: string;
  systemId: number | null;
  insertedAt: Date;
  phone: string;
  address: string;
  province: string;
  /** Nhận ra khách cũ nhờ đâu: mã khách Pancake, cùng hội thoại, hay trùng SĐT */
  matchedBy: "customer" | "conversation" | "phone";
};

export type OrderKey = { id: string; customerId: string | null; conversationId: string | null; billPhone: string | null; insertedAt: Date | string };

/** Đơn gần nhất (cũ hơn) của cùng khách đã có ĐỦ SĐT + địa chỉ, cho từng đơn trong danh sách */
export async function previousOrderHints(orders: OrderKey[]): Promise<Map<string, PrevOrderHint>> {
  const out = new Map<string, PrevOrderHint>();
  if (!orders.length) return out;
  const db = await getDb();
  const customerIds = [...new Set(orders.map((r) => r.customerId).filter((x): x is string => Boolean(x)))];
  const conversationIds = [...new Set(orders.map((r) => r.conversationId).filter((x): x is string => Boolean(x)))];
  const phones = [...new Set(orders.map((r) => (r.billPhone ?? "").trim()).filter(Boolean))];
  const parts: SQL[] = [];
  if (customerIds.length) parts.push(inArray(o.customerId, customerIds));
  if (conversationIds.length) parts.push(inArray(o.conversationId, conversationIds));
  if (phones.length) parts.push(inArray(o.billPhone, phones));
  if (!parts.length) return out;
  const candidates = await db
    .select({ id: o.id, systemId: o.systemId, customerId: o.customerId, conversationId: o.conversationId, phone: o.billPhone, full: o.shipFullAddress, short: o.shipAddress, province: o.shipProvince, insertedAt: o.insertedAt })
    .from(o)
    .where(and(or(...parts), sql`${o.billPhone} <> ''`, sql`${o.shipAddress} <> ''`, notInArray(o.stage, ["DELETED", "CANCELLED"])))
    .orderBy(desc(o.insertedAt))
    .limit(2000);
  for (const r of orders) {
    const at = new Date(r.insertedAt).getTime();
    const older = candidates.filter((c) => c.id !== r.id && new Date(c.insertedAt).getTime() < at);
    const phone = (r.billPhone ?? "").trim();
    const byCustomer = r.customerId ? older.find((c) => c.customerId === r.customerId) : undefined;
    const byConv = r.conversationId ? older.find((c) => c.conversationId === r.conversationId) : undefined;
    const byPhone = phone ? older.find((c) => c.phone === phone) : undefined;
    const pick = byCustomer ?? byConv ?? byPhone;
    if (!pick) continue;
    out.set(r.id, {
      orderId: pick.id,
      systemId: pick.systemId,
      insertedAt: new Date(pick.insertedAt),
      phone: pick.phone,
      address: pick.full || pick.short,
      province: pick.province ?? "",
      matchedBy: byCustomer ? "customer" : byConv ? "conversation" : "phone",
    });
  }
  return out;
}

export async function previousOrderHint(order: OrderKey): Promise<PrevOrderHint | null> {
  return (await previousOrderHints([order])).get(order.id) ?? null;
}
