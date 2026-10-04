import { and, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { rateOrNull } from "@/lib/sales-chatbot/performance-shared";

/**
 * ═══════════ GIỎ HÀNG CỦA ĐƠN BOT CHỐT — BÁN CHÉO (CROSS-SELL) (DoD #11) ═══════════
 *
 * Upsell (#522) đo LỜI MỜI mua thêm và phần đơn nháp tăng lên sau lời mời. Bán chéo trả lời câu khác: đơn bot chốt có bao
 * nhiêu SẢN PHẨM khác nhau — khách tới vì chả mực mà về có thêm ruốc. Đọc thẳng từ `order_items` của đơn bot chốt trong kỳ
 * (cùng tập đơn với màn «Hiệu quả»: sự kiện `order.confirmed`, khung thử loại). Hàng tặng (`is_bonus`) không tính là bán.
 *
 *  · Sản phẩm CHÍNH của một đơn = sản phẩm có giá trị dòng lớn nhất; giá trị bán chéo = các dòng của sản phẩm KHÁC. Đây là
 *    GIÁ TRỊ ĐƠN CHỐT (danh nghĩa) — không phải doanh thu: doanh thu chỉ ghi khi đơn đã giao (REVENUE_RECOGNIZED_ON_DELIVERY).
 *  · Chỉ đơn `origin = AI_AGENT` của hội thoại kênh ≠ THỬ (cùng mẫu số với các ô khác); đơn có kết cục HUỶ (ORDER_OUTCOME) bị loại.
 *  · Tỷ lệ dưới `AI_SALES_MIN_SAMPLE` đơn ⇒ `null`, không in 0%.
 *  · Hai giỏ từ CÙNG một lượt đọc: `booked` = mọi đơn chốt (trừ huỷ); `delivered` = tập con có ORDER_OUTCOME = DELIVERED —
 *    bán chéo đã tới tay khách. Giá trị vẫn đọc từ dòng hàng (giá × số lượng), không phải tiền thực thu: số tiền thật của
 *    đơn giao vẫn ở báo cáo doanh thu. Đơn chưa ngã ngũ KHÔNG vào giỏ `delivered` (chưa biết ≠ không bán được).
 */

export type BasketLine = { productId: string | null; quantity: number; valueVnd: number };
export type BasketReport = { booked: BasketStats; delivered: BasketStats };
export type BasketStats = { orders: number; itemsPerOrder: number | null; multiProductRate: number | null; multiProductOrders: number; crossSellValueVnd: number; orderValueVnd: number };

/** HÀM THUẦN. Dòng thiếu mã sản phẩm được coi là một sản phẩm riêng (không gộp vào sản phẩm khác — không đoán). */
export function basketStats(orders: readonly BasketLine[][]): BasketStats {
  let items = 0;
  let multi = 0;
  let cross = 0;
  let value = 0;
  const counted = orders.filter((lines) => lines.length > 0);
  for (const lines of counted) {
    const byProduct = new Map<string, number>();
    lines.forEach((l, i) => {
      const key = l.productId ?? `?${i}`;
      byProduct.set(key, (byProduct.get(key) ?? 0) + l.valueVnd);
      items += l.quantity;
      value += l.valueVnd;
    });
    if (byProduct.size >= 2) {
      multi += 1;
      const values = [...byProduct.values()].sort((a, b) => b - a);
      cross += values.slice(1).reduce((s, v) => s + v, 0);
    }
  }
  const n = counted.length;
  return { orders: n, itemsPerOrder: n ? items / n : null, multiProductRate: rateOrNull(multi, n), multiProductOrders: multi, crossSellValueVnd: cross, orderValueVnd: value };
}

/** Giỏ hàng của đơn bot chốt trong `days` ngày gần nhất của tổ chức NGỮ CẢNH — cả đơn chốt lẫn tập đã giao. */
export async function loadBasketStats(opts: { days: number; now?: Date }): Promise<BasketReport> {
  const now = opts.now ?? new Date();
  const since = new Date(dauNgayVN(now).getTime() - (Math.max(1, opts.days) - 1) * 86_400_000);
  const db = await getDb();
  const e = schema.salesConversationEvents;
  const ids = (await db.selectDistinct({ id: e.orderId }).from(e).where(and(gte(e.occurredAt, since), ne(e.channel, "TEST"), eq(e.type, "order.confirmed"), isNotNull(e.orderId)))).map((r) => r.id!).filter(Boolean);
  const empty = (): BasketReport => ({ booked: basketStats([]), delivered: basketStats([]) });
  if (!ids.length) return empty();
  const o = schema.orders;
  const s = schema.shipments;
  const kept = (
    await db
      .select({ id: o.id, outcome: sql<string>`${ORDER_OUTCOME}` })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(and(inArray(o.id, ids), eq(o.origin, "AI_AGENT"), sql`${ORDER_OUTCOME} <> 'CANCELLED'`))
  );
  if (!kept.length) return empty();
  const it = schema.orderItems;
  const rows = await db
    .select({ orderId: it.orderId, productId: it.productId, quantity: it.quantity, unitPrice: it.unitPrice })
    .from(it)
    .where(and(inArray(it.orderId, kept.map((k) => k.id)), eq(it.isBonus, false)));
  const byOrder = new Map<string, BasketLine[]>(kept.map((k) => [k.id, []]));
  for (const r of rows) byOrder.get(r.orderId)?.push({ productId: r.productId, quantity: r.quantity, valueVnd: r.quantity * r.unitPrice });
  return {
    booked: basketStats([...byOrder.values()]),
    delivered: basketStats(kept.filter((k) => k.outcome === "DELIVERED").map((k) => byOrder.get(k.id) ?? [])),
  };
}
