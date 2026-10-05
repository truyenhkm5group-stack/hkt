/**
 * ═══════════ QUY KẾT TỪNG ĐƠN + FOLLOW-UP THU HỒI — ĐỌC SỔ (docs/revenue-attribution.md) ═══════════
 *
 * Phần luật nằm ở `attribution-shared.ts` (hàm thuần). Ở đây chỉ đọc: tập đơn của kỳ, sự kiện của hội thoại gắn với chúng,
 * và kết cục từng đơn qua `ORDER_OUTCOME` — đúng kỳ, đúng khung thử bị loại, đúng biểu thức doanh thu của màn «Hiệu quả»
 * (`performance.ts`), để hai khối trên một trang không nói hai con số.
 *
 * Tập đơn = đơn có `order.confirmed` (bất kể ai chốt) trong kỳ, kênh ≠ THỬ. Đơn bot lên nháp mà nhân viên chốt ở trang Đơn
 * hàng (không qua hội thoại) không có `order.confirmed` trong sổ ⇒ NẰM NGOÀI tập (đếm thiếu cho AI, không đếm thừa).
 */
import { and, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import type { OrderOutcome } from "@/lib/constants/returns";
import { isFinishedOutcome } from "@/lib/constants/truth";
import { REVENUE_RECOGNIZED_ON_DELIVERY } from "@/lib/queries/manual-order-sql";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { attributeOrder, attributionTable, followupRecovery, type AttributedOrder, type AttributionEvent, type AttributionTable } from "@/lib/sales-chatbot/attribution-shared";
import { rateOrNull } from "@/lib/sales-chatbot/performance-shared";

export type FollowupStats = {
  /** Hội thoại được bot nhắc ít nhất một lần trong kỳ. */
  conversations: number;
  /** …trong đó khách nhắn lại sau lần nhắc. */
  replied: number;
  replyRate: number | null;
  /** Đơn thu hồi (chốt sau khi khách trả lời lần nhắc) + giá trị + doanh thu đã giao (ORDER_OUTCOME). */
  recoveredOrders: number;
  recoveredValueVnd: number;
  recoveredDelivered: number;
  recoveredDeliveredRevenueVnd: number;
};

export type OrderAttributionReport = { table: AttributionTable; followup: FollowupStats };

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const CHUNK = 500;
async function inChunks<T>(ids: readonly string[], fn: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fn(ids.slice(i, i + CHUNK))));
  return out;
}

/** Quy kết đơn + follow-up thu hồi của tổ chức NGỮ CẢNH trong `days` ngày (cùng cách tính kỳ với màn «Hiệu quả»). */
export async function loadOrderAttribution(opts: { days?: number; now?: Date }): Promise<OrderAttributionReport> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 30), 1), 180);
  const now = opts.now ?? new Date();
  const since = new Date(dauNgayVN(now).getTime() - (days - 1) * 86_400_000);
  const db = await getDb();
  const e = schema.salesConversationEvents;
  const inPeriod = and(gte(e.occurredAt, since), ne(e.channel, "TEST"));

  const confirmedRows = await db.selectDistinct({ conv: e.conversationId, orderId: e.orderId }).from(e).where(and(inPeriod, eq(e.type, "order.confirmed"), isNotNull(e.orderId)));
  const nudgedRows = await db.selectDistinct({ conv: e.conversationId }).from(e).where(and(inPeriod, eq(e.type, "followup.sent")));
  const orderConv = new Map<string, string>();
  for (const r of confirmedRows) if (r.orderId && !orderConv.has(r.orderId)) orderConv.set(r.orderId, r.conv);
  const convIds = [...new Set([...confirmedRows.map((r) => r.conv), ...nudgedRows.map((r) => r.conv)])];

  // Sự kiện của các hội thoại đó, KHÔNG giới hạn kỳ: góp công / chạm vào có thể xảy ra trước đầu kỳ trong cùng lượt mua.
  const evRows = await inChunks(convIds, (part) =>
    db
      .select({ conv: e.conversationId, type: e.type, actorKind: e.actorKind, occurredAt: e.occurredAt, cycle: e.cycle, orderId: e.orderId })
      .from(e)
      .where(and(inArray(e.conversationId, part), inArray(e.type, ["quote.given", "order.drafted", "upsell.offered", "customer.identified", "order.confirmed", "handoff.requested", "human.took_over", "human.replied", "followup.sent", "message.received"]))),
  );
  const byConv = new Map<string, AttributionEvent[]>();
  for (const r of evRows) {
    const list = byConv.get(r.conv) ?? [];
    list.push({ type: r.type, actorKind: r.actorKind, occurredAt: new Date(r.occurredAt), cycle: r.cycle, orderId: r.orderId });
    byConv.set(r.conv, list);
  }

  // Follow-up: đơn thu hồi có thể nằm NGOÀI tập đơn của kỳ (khách quay lại, chốt sau cuối kỳ thì không — mốc chốt phải trong kỳ).
  let replied = 0;
  const recovered = new Set<string>();
  for (const r of nudgedRows) {
    const f = followupRecovery(byConv.get(r.conv) ?? [], since);
    if (f.replied) replied += 1;
    for (const id of f.recoveredOrderIds) if (orderConv.has(id)) recovered.add(id);
  }

  // Kết cục từng đơn — cùng biểu thức doanh thu với màn «Hiệu quả».
  const orderIds = [...orderConv.keys()];
  const o = schema.orders;
  const s = schema.shipments;
  const outcomes = await inChunks(orderIds, (part) =>
    db
      .select({ id: o.id, outcome: ORDER_OUTCOME, value: sql<number>`${o.totalPriceAfterDiscount}`, recognized: sql<boolean>`${REVENUE_RECOGNIZED_ON_DELIVERY}` })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(inArray(o.id, part)),
  );
  const attributed: AttributedOrder[] = [];
  let unattributed = 0;
  const followup: FollowupStats = { conversations: nudgedRows.length, replied, replyRate: rateOrNull(replied, nudgedRows.length), recoveredOrders: 0, recoveredValueVnd: 0, recoveredDelivered: 0, recoveredDeliveredRevenueVnd: 0 };
  for (const row of outcomes) {
    const value = num(row.value);
    const delivered = row.outcome === "DELIVERED";
    const deliveredRevenueVnd = delivered && row.recognized ? value : 0;
    if (recovered.has(row.id)) {
      followup.recoveredOrders += 1;
      followup.recoveredValueVnd += value;
      if (delivered) {
        followup.recoveredDelivered += 1;
        followup.recoveredDeliveredRevenueVnd += deliveredRevenueVnd;
      }
    }
    const label = attributeOrder(row.id, byConv.get(orderConv.get(row.id)!) ?? []);
    if (!label) {
      unattributed += 1;
      continue;
    }
    attributed.push({ attribution: label, valueVnd: value, delivered, deliveredRevenueVnd, settled: isFinishedOutcome(row.outcome as OrderOutcome), cancelled: row.outcome === "CANCELLED" });
  }
  return { table: attributionTable(attributed, unattributed), followup };
}
