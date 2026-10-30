import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { addDays } from "@/lib/format";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import type { CoreResult } from "@/lib/wholesale/campaigns";

/**
 * ═══════════ NHẮC MUA LẠI KHÁCH SỈ — PHÉP CHIẾU LÊN /work (luật 19 · phòng SALES) — docs/tech/hslc-b2b-sales-agent.md · P6 ═══════════
 *
 * Khách SỈ là khách nối từ lead săn khách sỉ (`wholesale_leads.customer_id`) hoặc khách có báo giá sỉ. Khách ĐẾN HẠN nhắc khi đủ BA
 * điều kiện:
 *  1. đã có ít nhất một đơn giao thành công theo `ORDER_OUTCOME` (không theo trạng thái đơn, không theo tiền);
 *  2. đơn gần nhất (đơn còn hiệu lực, mọi trạng thái trừ huỷ / xoá) đã quá X ngày;
 *  3. chưa có báo giá nào lập sau đơn đó, và không có lời hẹn liên hệ (`customer_touchpoints.next_contact_on`) từ hôm nay trở đi.
 * X là cấu hình của tổ chức (`settings["wholesale.reorder"].afterDays`), KHÔNG có số mặc định: chưa khai ⇒ không có việc nào.
 *
 * Việc rời hàng đợi khi người làm việc THẬT của miền: lập báo giá mới, tạo đơn mới, hoặc ghi lần liên hệ kèm ngày hẹn (khối «Nhắc mua
 * lại» ở trang khách). Không có nút «xong» nào. Khối «Nhắc mua lại» của module CRM (`crm.reorder`, lib/queries/reorder.ts) KHÔNG chiếu
 * lên /work, nên nguồn này không đếm trùng nó.
 */

export const WHOLESALE_REORDER_SETTING_KEY = "wholesale.reorder";
export type WholesaleReorderSettings = { afterDays: number | null };
export const WHOLESALE_REORDER_MAX_DAYS = 365;

export function parseWholesaleReorderSettings(raw: unknown): WholesaleReorderSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const v = o.afterDays;
  return { afterDays: typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= WHOLESALE_REORDER_MAX_DAYS ? v : null };
}

export async function getWholesaleReorderSettings(): Promise<WholesaleReorderSettings> {
  return parseWholesaleReorderSettings(await getSettingJson<Record<string, unknown>>(WHOLESALE_REORDER_SETTING_KEY, {}));
}

const settingsSchema = z.object({ afterDays: z.number().int().min(1).max(WHOLESALE_REORDER_MAX_DAYS).nullable().default(null), reason: z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự).").max(500) }).strict();

/** Khai / bỏ X — `wholesale:config`, lý do, audit. Trống = tắt nhắc mua lại sỉ. */
export async function saveWholesaleReorderSettingsCore(user: SessionUser, raw: unknown): Promise<CoreResult> {
  if (!can(user, "wholesale:config")) return { error: "Chỉ người cấu hình (wholesale:config) sửa được nhắc mua lại sỉ." };
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const before = await getWholesaleReorderSettings();
  await setSettingJson(WHOLESALE_REORDER_SETTING_KEY, { afterDays: parsed.data.afterDays });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_REORDER_CONFIG", entity: "SETTINGS", entityId: WHOLESALE_REORDER_SETTING_KEY, before, after: { afterDays: parsed.data.afterDays }, reason: parsed.data.reason });
  return { ok: true };
}

export type ReorderFacts = { lastOrderDay: string | null; deliveredOrders: number; lastQuoteDay: string | null; nextContactOn: string | null };

/** Khách có đến hạn nhắc không, và từ ngày nào. HÀM THUẦN (ngày dạng YYYY-MM-DD giờ VN). */
export function wholesaleReorderDueFrom(f: ReorderFacts, today: string, afterDays: number | null): string | null {
  if (afterDays === null || !f.lastOrderDay || f.deliveredOrders < 1) return null;
  const dueFrom = addDays(f.lastOrderDay, afterDays);
  if (dueFrom > today) return null;
  if (f.lastQuoteDay && f.lastQuoteDay >= f.lastOrderDay) return null;
  if (f.nextContactOn && f.nextContactOn >= today) return null;
  return dueFrom;
}

export type WholesaleReorderRow = { customerId: string; name: string; phone: string | null; lastOrderDay: string; deliveredOrders: number; dueFrom: string };

const VN_DAY = (col: unknown) => sql<string>`to_char(${col} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;

/** Khách sỉ ĐẾN HẠN nhắc mua lại hôm nay — đọc lúc chiếu, không ghi gì. */
export async function wholesaleReorderDue(today: string): Promise<WholesaleReorderRow[]> {
  const { afterDays } = await getWholesaleReorderSettings();
  if (afterDays === null) return [];
  const db = await getDb();
  const [fromLeads, fromQuotes] = await Promise.all([
    db.selectDistinct({ id: schema.wholesaleLeads.customerId }).from(schema.wholesaleLeads).where(isNotNull(schema.wholesaleLeads.customerId)),
    db.selectDistinct({ id: schema.wholesaleQuotations.customerId }).from(schema.wholesaleQuotations).where(isNotNull(schema.wholesaleQuotations.customerId)),
  ]);
  const ids = [...new Set([...fromLeads, ...fromQuotes].map((r) => r.id).filter((x): x is string => Boolean(x)))];
  if (!ids.length) return [];
  const o = schema.orders;
  const q = schema.wholesaleQuotations;
  const l = schema.wholesaleLeads;
  const t = schema.customerTouchpoints;
  const [orders, quotes, touches, customers] = await Promise.all([
    // MỖI ĐƠN MỘT DÒNG (PRIMARY_ATTEMPT): đơn nhiều lần gửi không đếm nhiều lần giao thành công.
    db
      .select({ customerId: o.customerId, lastOrderDay: sql<string>`max(${VN_DAY(o.insertedAt)})`, delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')`.mapWith(Number) })
      .from(o)
      .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, o.id), PRIMARY_ATTEMPT))
      .where(and(inArray(o.customerId, ids), sql`${o.stage} not in ('CANCELLED','DELETED')`))
      .groupBy(o.customerId),
    db
      .select({ customerId: sql<string>`coalesce(${q.customerId}, ${l.customerId})`, day: sql<string>`max(${VN_DAY(q.createdAt)})` })
      .from(q)
      .leftJoin(l, eq(l.id, q.leadId))
      .where(sql`coalesce(${q.customerId}, ${l.customerId}) in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`)
      .groupBy(sql`coalesce(${q.customerId}, ${l.customerId})`),
    db.select({ customerId: t.customerId, next: sql<string | null>`max(${t.nextContactOn})::text` }).from(t).where(inArray(t.customerId, ids)).groupBy(t.customerId),
    db.select({ id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone }).from(schema.customers).where(inArray(schema.customers.id, ids)),
  ]);
  const byOrder = new Map(orders.map((r) => [r.customerId, r]));
  const byQuote = new Map(quotes.map((r) => [r.customerId, r.day]));
  const byTouch = new Map(touches.map((r) => [r.customerId, r.next]));
  const out: WholesaleReorderRow[] = [];
  for (const c of customers) {
    const ord = byOrder.get(c.id);
    const facts: ReorderFacts = { lastOrderDay: ord?.lastOrderDay ?? null, deliveredOrders: ord?.delivered ?? 0, lastQuoteDay: byQuote.get(c.id) ?? null, nextContactOn: byTouch.get(c.id) ?? null };
    const dueFrom = wholesaleReorderDueFrom(facts, today, afterDays);
    if (dueFrom && facts.lastOrderDay) out.push({ customerId: c.id, name: c.name, phone: c.phone, lastOrderDay: facts.lastOrderDay, deliveredOrders: facts.deliveredOrders, dueFrom });
  }
  return out.sort((a, b) => a.dueFrom.localeCompare(b.dueFrom));
}
