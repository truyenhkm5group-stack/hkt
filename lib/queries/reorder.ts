import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { todayVN } from "@/lib/format";
import { getSettingJson } from "@/lib/settings";
import { parseReorderSetting, REORDER_SETTING_KEY, reorderState, type LastTouch, type ReorderSetting, type ReorderState, type ReorderStatus, type TouchKind, type TouchOutcome } from "@/lib/constants/reorder";
import { IS_MANUAL_ORDER } from "@/lib/queries/manual-order-sql";

/**
 * ═══════════ BẢNG NHẮC MUA LẠI — đọc lịch sử đơn tạo tay + sổ liên hệ (docs/verticals/reorder-reminders.md) ═══════════
 *
 * Ngày mua = ngày lên đơn (giờ Việt Nam) của đơn tạo tay ĐÃ CHỐT hoặc ĐÃ GIAO — đơn mới / chờ hàng / huỷ không phải một
 * lần mua. Đơn đồng bộ từ Pancake không vào đây (tổ chức nhà có màn CRM riêng).
 */

export async function getReorderSetting(): Promise<ReorderSetting> {
  return parseReorderSetting(await getSettingJson<Record<string, unknown>>(REORDER_SETTING_KEY, {}));
}

export type ReorderRow = ReorderState & {
  customerId: string;
  name: string;
  phone: string | null;
  lastOrderId: string | null;
  lastOrderTotal: number | null;
  lastTouch: (LastTouch & { kind: TouchKind; note: string; userName: string }) | null;
};

export type ReorderBoard = { today: string; setting: ReorderSetting; rows: ReorderRow[]; counts: Record<ReorderStatus, number> };

const BUYING_STAGES = ["CONFIRMED", "DELIVERED"] as const;
const VN_DAY = sql<string>`to_char(${schema.orders.insertedAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;

export async function loadReorderBoard(opts: { today?: string; customerIds?: readonly string[] } = {}): Promise<ReorderBoard> {
  const db = await getDb();
  const today = opts.today ?? todayVN();
  const setting = await getReorderSetting();
  if (opts.customerIds && opts.customerIds.length === 0) return { today, setting, rows: [], counts: emptyCounts() };
  const o = schema.orders;
  const history = await db
    .select({ customerId: o.customerId, day: VN_DAY, orderId: o.id, total: sql<number>`(${o.totalPriceAfterDiscount} + ${o.shippingFee})`.mapWith(Number), insertedAt: o.insertedAt })
    .from(o)
    .where(sql`${IS_MANUAL_ORDER} and ${o.customerId} is not null and ${inArray(o.stage, [...BUYING_STAGES])}${opts.customerIds ? sql` and ${inArray(o.customerId, [...opts.customerIds])}` : sql``}`)
    .orderBy(o.insertedAt);
  const byCustomer = new Map<string, { days: string[]; lastOrderId: string; lastTotal: number }>();
  for (const h of history) {
    const cur = byCustomer.get(h.customerId!) ?? { days: [], lastOrderId: h.orderId, lastTotal: h.total };
    cur.days.push(h.day);
    cur.lastOrderId = h.orderId;
    cur.lastTotal = h.total;
    byCustomer.set(h.customerId!, cur);
  }
  const ids = [...byCustomer.keys()];
  if (ids.length === 0) return { today, setting, rows: [], counts: emptyCounts() };
  const t = schema.customerTouchpoints;
  const [customers, touches] = await Promise.all([
    db.select({ id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone }).from(schema.customers).where(inArray(schema.customers.id, ids)),
    db
      .selectDistinctOn([t.customerId], { customerId: t.customerId, at: t.at, kind: t.kind, outcome: t.outcome, note: t.note, nextContactOn: t.nextContactOn, userName: t.userName })
      .from(t)
      .where(inArray(t.customerId, ids))
      .orderBy(t.customerId, desc(t.at)),
  ]);
  const touchBy = new Map(touches.map((x) => [x.customerId, x]));
  const rows: ReorderRow[] = customers.map((c) => {
    const h = byCustomer.get(c.id)!;
    const tp = touchBy.get(c.id);
    const lastTouch = tp ? { on: dayOf(tp.at), outcome: tp.outcome as TouchOutcome, nextContactOn: tp.nextContactOn ?? null, kind: tp.kind as TouchKind, note: tp.note, userName: tp.userName } : null;
    return { customerId: c.id, name: c.name, phone: c.phone, lastOrderId: h.lastOrderId, lastOrderTotal: h.lastTotal, lastTouch, ...reorderState({ orderDays: h.days, today, setting, lastTouch }) };
  });
  rows.sort((a, b) => (a.daysUntil ?? Number.POSITIVE_INFINITY) - (b.daysUntil ?? Number.POSITIVE_INFINITY) || a.name.localeCompare(b.name, "vi"));
  const counts = emptyCounts();
  for (const r of rows) counts[r.status]++;
  return { today, setting, rows, counts };
}

function emptyCounts(): Record<ReorderStatus, number> {
  return { UNKNOWN: 0, NOT_DUE: 0, DUE_SOON: 0, DUE: 0, SNOOZED: 0, DECLINED: 0 };
}

function dayOf(d: Date): string {
  return new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** Năm lượt liên hệ gần nhất của một khách — cho trang khách. */
export async function recentTouchpoints(customerId: string, limit = 5) {
  const db = await getDb();
  const t = schema.customerTouchpoints;
  return db.select().from(t).where(eq(t.customerId, customerId)).orderBy(desc(t.at)).limit(limit);
}
