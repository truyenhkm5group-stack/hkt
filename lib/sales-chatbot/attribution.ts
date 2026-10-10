/**
 * ═══════════ QUY KẾT TỪNG ĐƠN + FOLLOW-UP THU HỒI — ĐỌC SỔ (docs/revenue-attribution.md) ═══════════
 *
 * Phần luật nằm ở `attribution-shared.ts` (hàm thuần). Ở đây chỉ đọc: tập đơn của kỳ, sự kiện của hội thoại gắn với chúng,
 * và kết cục từng đơn qua `ORDER_OUTCOME` — đúng kỳ, đúng khung thử bị loại, đúng biểu thức doanh thu của màn «Hiệu quả»
 * (`performance.ts`), để hai khối trên một trang không nói hai con số.
 *
 * Tập đơn = đơn có `order.confirmed` (bất kể ai chốt) trong kỳ, kênh ≠ THỬ. Đơn bot lên nháp mà nhân viên chốt ở trang Đơn
 * hàng (không qua hội thoại) không có `order.confirmed` trong sổ ⇒ NẰM NGOÀI tập (đếm thiếu cho AI, không đếm thừa).
 *
 * LÃI GỘP ĐÃ GIAO (Master Mission mục P0.5 «Conversation → Delivered Profit»): giá vốn đọc qua `orderCogsFast` — ĐÚNG đường
 * của Báo cáo lợi nhuận (giá vốn đã chốt lúc giao, phiếu nhập mới không viết lại kỳ cũ). Đơn giá vốn 0 = CHƯA BIẾT, đứng
 * riêng (`cogsUnknown`), không cộng vào lãi với giá vốn 0. Cột đọc (`orderFactColumns`) + phép dựng dữ kiện đơn
 * (`orderFactsOf`) là ĐƯỜNG CHUNG với so AI vs người theo nhánh thử nghiệm (experiment-report.ts) — không có bản thứ hai.
 */
import { and, eq, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import type { OrderOutcome } from "@/lib/constants/returns";
import { isFinishedOutcome } from "@/lib/constants/truth";
import { orderCogsFast } from "@/lib/queries/cogs";
import { REVENUE_RECOGNIZED_ON_DELIVERY } from "@/lib/queries/manual-order-sql";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import {
  attributeOrder,
  attributionOverlays,
  attributionTable,
  deliveredCogs,
  followupRecovery,
  overlayTable,
  type AttributedOrder,
  type AttributionEvent,
  type AttributionOverlay,
  type AttributionTable,
  type OrderAttribution,
  type OrderFacts,
  type OrderOverlay,
  type RecoveredOverlayStats,
  type UpsellOverlayStats,
} from "@/lib/sales-chatbot/attribution-shared";
import { onPage } from "@/lib/sales-chatbot/events-sql";
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

export type OrderAttributionReport = {
  table: AttributionTable;
  followup: FollowupStats;
  /**
   * THUỘC TÍNH CHỒNG (attribution-shared.ts): TẬP CON của AI_ONLY ∪ AI_ASSISTED — KHÔNG cộng vào tổng đơn / doanh thu của
   * `table`. `recovered` khác `followup.recoveredOrders` đúng bằng `recovered.outsideAiLabels` (thu hồi mà nhãn chính là người bán).
   */
  recovered: RecoveredOverlayStats;
  /** Đơn có lời nhận mua thêm (nhãn AI) + phần tăng ĐÃ GIAO. Không thay `upsell.revenueVnd` của màn «Hiệu quả». */
  upsell: UpsellOverlayStats;
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Cột đọc KẾT CỤC + DOANH THU + GIÁ VỐN của một đơn — ĐƯỜNG CHUNG của bảng quy kết theo nhãn và so AI vs người theo nhánh
 * thử nghiệm (experiment-report.ts). Câu gọi phải `leftJoin(shipments, PRIMARY_ATTEMPT)`: mỗi đơn đúng một dòng (đơn gửi lại
 * không đếm hai lần), và `orderCogsFast` đọc giá vốn đã chốt của CHÍNH lần gửi ấy.
 */
export function orderFactColumns() {
  return { outcome: ORDER_OUTCOME, value: sql<number>`${schema.orders.totalPriceAfterDiscount}`, recognized: sql<boolean>`${REVENUE_RECOGNIZED_ON_DELIVERY}`, cogs: orderCogsFast() };
}

/**
 * Một dòng đọc bằng `orderFactColumns()` ⇒ dữ kiện của đơn: doanh thu chỉ khi DELIVERED và được ghi nhận; giá vốn 0 trên đơn
 * có doanh thu = CHƯA BIẾT (`deliveredCogs`). HÀM THUẦN.
 */
export function orderFactsOf(row: { outcome: string; value: unknown; recognized: unknown; cogs: unknown }): OrderFacts {
  const value = num(row.value);
  const delivered = row.outcome === "DELIVERED";
  const deliveredRevenueVnd = delivered && row.recognized ? value : 0;
  return {
    valueVnd: value,
    delivered,
    deliveredRevenueVnd,
    settled: isFinishedOutcome(row.outcome as OrderOutcome),
    cancelled: row.outcome === "CANCELLED",
    deliveredCogsVnd: deliveredCogs(deliveredRevenueVnd, num(row.cogs)),
  };
}

const CHUNK = 500;
async function inChunks<T>(ids: readonly string[], fn: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fn(ids.slice(i, i + CHUNK))));
  return out;
}

type AttributionWindow = { days?: number; now?: Date; until?: Date | null; pageId?: string | null };

/** Một đơn của tập quy kết: dữ kiện + nhãn chính + thuộc tính chồng. Nội bộ — đường chung của bảng tổng và danh sách drill-down. */
type CollectedOrder = OrderFacts & {
  orderId: string;
  conversationId: string;
  confirmedAt: Date | null;
  outcome: OrderOutcome;
  attribution: OrderAttribution | null;
  overlay: OrderOverlay;
};

/**
 * Đọc MỘT lần tập đơn của kỳ + sự kiện hội thoại + kết cục từng đơn. `loadOrderAttribution` (tổng) và `listAttributedOrders`
 * (drill-down) cùng đi qua đây, nên danh sách luôn cộng lại đúng bằng bảng tổng — không có câu truy vấn thứ hai.
 */
async function collectAttribution(opts: AttributionWindow): Promise<{ orders: CollectedOrder[]; followup: FollowupStats }> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 30), 1), 180);
  const now = opts.now ?? new Date();
  const since = new Date(dauNgayVN(now).getTime() - (days - 1) * 86_400_000);
  const db = await getDb();
  const e = schema.salesConversationEvents;
  const inPeriod = and(gte(e.occurredAt, since), opts.until ? lte(e.occurredAt, opts.until) : undefined, ne(e.channel, "TEST"), onPage(opts.pageId));

  const confirmedRows = await db.selectDistinct({ conv: e.conversationId, orderId: e.orderId }).from(e).where(and(inPeriod, eq(e.type, "order.confirmed"), isNotNull(e.orderId)));
  const nudgedRows = await db.selectDistinct({ conv: e.conversationId }).from(e).where(and(inPeriod, eq(e.type, "followup.sent")));
  const orderConv = new Map<string, string>();
  for (const r of confirmedRows) if (r.orderId && !orderConv.has(r.orderId)) orderConv.set(r.orderId, r.conv);
  const convIds = [...new Set([...confirmedRows.map((r) => r.conv), ...nudgedRows.map((r) => r.conv)])];

  // Sự kiện của các hội thoại đó, KHÔNG giới hạn kỳ: góp công / chạm vào có thể xảy ra trước đầu kỳ trong cùng lượt mua.
  // `upsell.accepted` chỉ thuộc tính chồng AI_UPSELL đọc — nhãn chính và follow-up không nhìn tới loại này.
  const evRows = await inChunks(convIds, (part) =>
    db
      .select({ conv: e.conversationId, type: e.type, actorKind: e.actorKind, occurredAt: e.occurredAt, cycle: e.cycle, orderId: e.orderId, amountVnd: e.amountVnd })
      .from(e)
      .where(
        and(
          inArray(e.conversationId, part),
          inArray(e.type, ["quote.given", "order.drafted", "upsell.offered", "upsell.accepted", "customer.identified", "order.confirmed", "handoff.requested", "human.took_over", "human.replied", "followup.sent", "message.received"]),
        ),
      ),
  );
  const byConv = new Map<string, AttributionEvent[]>();
  for (const r of evRows) {
    const list = byConv.get(r.conv) ?? [];
    // Số tiền thiếu giữ `null` (CHƯA BIẾT) — không ép về 0.
    const amount = r.amountVnd === null || r.amountVnd === undefined ? null : Number(r.amountVnd);
    list.push({ type: r.type, actorKind: r.actorKind, occurredAt: new Date(r.occurredAt), cycle: r.cycle, orderId: r.orderId, amountVnd: amount !== null && Number.isFinite(amount) ? amount : null });
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
      .select({ id: o.id, ...orderFactColumns() })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(inArray(o.id, part)),
  );
  const orders: CollectedOrder[] = [];
  const followup: FollowupStats = { conversations: nudgedRows.length, replied, replyRate: rateOrNull(replied, nudgedRows.length), recoveredOrders: 0, recoveredValueVnd: 0, recoveredDelivered: 0, recoveredDeliveredRevenueVnd: 0 };
  for (const row of outcomes) {
    const facts = orderFactsOf(row);
    const isRecovered = recovered.has(row.id);
    if (isRecovered) {
      followup.recoveredOrders += 1;
      followup.recoveredValueVnd += facts.valueVnd;
      if (facts.delivered) {
        followup.recoveredDelivered += 1;
        followup.recoveredDeliveredRevenueVnd += facts.deliveredRevenueVnd;
      }
    }
    const conversationId = orderConv.get(row.id)!;
    const events = byConv.get(conversationId) ?? [];
    const attribution = attributeOrder(row.id, events);
    const confirms = events.filter((x) => x.orderId === row.id && x.type === "order.confirmed").map((x) => x.occurredAt.getTime());
    orders.push({
      ...facts,
      orderId: row.id,
      conversationId,
      confirmedAt: confirms.length ? new Date(Math.min(...confirms)) : null,
      outcome: row.outcome as OrderOutcome,
      attribution,
      overlay: attributionOverlays({ orderId: row.id, attribution, events, followupRecovered: isRecovered }),
    });
  }
  return { orders, followup };
}

/** Quy kết đơn + follow-up thu hồi + thuộc tính chồng của tổ chức NGỮ CẢNH trong `days` ngày (cùng cách tính kỳ với màn «Hiệu quả»). */
export async function loadOrderAttribution(opts: AttributionWindow): Promise<OrderAttributionReport> {
  const { orders, followup } = await collectAttribution(opts);
  const attributed: AttributedOrder[] = [];
  let unattributed = 0;
  for (const x of orders) {
    if (!x.attribution) unattributed += 1;
    else attributed.push({ ...x, attribution: x.attribution });
  }
  return { table: attributionTable(attributed, unattributed), followup, ...overlayTable(orders) };
}

// ─────────────────────────── Drill-down: đơn ↔ hội thoại ───────────────────────────

/**
 * Một dòng drill-down — CHỈ mã đơn · mã hội thoại · nhãn · thuộc tính chồng · kết cục · số tiền của chính đơn. KHÔNG tên /
 * SĐT / địa chỉ khách (kho PUBLIC, màn nền tảng đọc chéo tổ chức).
 */
export type AttributedOrderListRow = {
  orderId: string;
  conversationId: string;
  /** Mốc `order.confirmed` sớm nhất của đơn — mốc lọc kỳ (luật 58). */
  confirmedAt: Date | null;
  /** `null` = CHƯA QUY KẾT, không phải người bán. */
  attribution: OrderAttribution | null;
  overlays: AttributionOverlay[];
  outcome: OrderOutcome;
  delivered: boolean;
  /** Chưa ngã ngũ: chưa giao xong, chưa hoàn, chưa huỷ. */
  pending: boolean;
  cancelled: boolean;
  valueVnd: number;
  deliveredRevenueVnd: number;
  /** Chỉ có khi đơn mang AI_UPSELL (`null` ⇒ không áp dụng); `amountVnd = null` ⇒ CHƯA BIẾT số tiền. */
  upsell: { amountVnd: number | null } | null;
};
export type AttributedOrderListPage = { rows: AttributedOrderListRow[]; total: number; page: number; pageSize: number; pageCount: number };

export const ATTRIBUTED_ORDERS_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Danh sách đơn của tập quy kết, có phân trang — cùng tập và cùng luật với `loadOrderAttribution` (đọc chung `collectAttribution`).
 * Sắp theo mốc chốt mới nhất trước, hoà thì theo mã đơn — thứ tự ỔN ĐỊNH nên hai trang không trùng / không sót dòng.
 * Lọc tuỳ chọn theo nhãn chính (`UNATTRIBUTED` = chưa quy kết) hoặc theo thuộc tính chồng.
 */
export async function listAttributedOrders(
  opts: AttributionWindow & { page?: number; pageSize?: number; attribution?: OrderAttribution | "UNATTRIBUTED" | null; overlay?: AttributionOverlay | null },
): Promise<AttributedOrderListPage> {
  const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? ATTRIBUTED_ORDERS_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const page = Math.max(Math.trunc(opts.page ?? 1), 1);
  const { orders } = await collectAttribution(opts);
  const filtered = orders.filter(
    (x) =>
      (!opts.attribution || (opts.attribution === "UNATTRIBUTED" ? x.attribution === null : x.attribution === opts.attribution)) &&
      (!opts.overlay || x.overlay.overlays.includes(opts.overlay)),
  );
  filtered.sort((a, b) => {
    const ta = a.confirmedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const tb = b.confirmedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (ta !== tb) return tb - ta;
    return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
  });
  const total = filtered.length;
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize).map(
    (x): AttributedOrderListRow => ({
      orderId: x.orderId,
      conversationId: x.conversationId,
      confirmedAt: x.confirmedAt,
      attribution: x.attribution,
      overlays: [...x.overlay.overlays],
      outcome: x.outcome,
      delivered: x.delivered,
      pending: !x.settled && !x.cancelled,
      cancelled: x.cancelled,
      valueVnd: x.valueVnd,
      deliveredRevenueVnd: x.deliveredRevenueVnd,
      upsell: x.overlay.overlays.includes("AI_UPSELL") ? { amountVnd: x.overlay.upsellAmountVnd } : null,
    }),
  );
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
