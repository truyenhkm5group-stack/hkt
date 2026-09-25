import { and, eq, sql, type SQL } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import {
  CANCEL_MATCHES,
  CANCEL_MATCH_REPLACED,
  POST_CONFIRM_STAGES,
  classifyCancelled,
  emptyMatchCounts,
  type CancelMatch,
  type PostConfirmStage,
} from "@/lib/constants/cancel-analysis";
import { CARRIER_HANDOFF_AT_SQL } from "@/lib/constants/carrier-handoff";
import { PRE_CONFIRM_CANCEL_BUCKETS, cancelAgeBucket, type PreConfirmCancelBucketKey } from "@/lib/constants/conversion";
import { phoneKey, type DuplicateCandidate, type ItemLike } from "@/lib/constants/order-duplicate";
import { PANCAKE_WAITING_CODES } from "@/lib/constants/stock-wait-report";
import { CANCELLED_AT, CONFIRMED_AT, ORDER_EVER_CONFIRMED } from "@/lib/queries/conversion-funnel";
import { getDuplicateRule } from "@/lib/queries/order-duplicate";
import { ORDER_SOURCE, ORDER_SOURCE_LABEL, type OrderSourceKey } from "@/lib/queries/order-source";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { median } from "@/lib/creative/learn";
import { rowsOf } from "@/lib/sql-rows";
import type { Period } from "@/lib/search-params";

const o = schema.orders;
const s = schema.shipments;

/**
 * ═══════════ PHÂN TÍCH ĐƠN HUỶ — TRƯỚC VÀ SAU XÁC NHẬN ═══════════
 *
 * Luật phân loại ở `lib/constants/cancel-analysis.ts` (hàm thuần, dùng lại luật đơn trùng). Tệp này
 * chỉ gom đầu vào, và đếm đơn huỷ bằng ĐÚNG hai vị từ của phễu — nên tổng "huỷ trước xác nhận" /
 * "huỷ sau xác nhận" ở đây BẰNG con số trên khối "Đơn kẹt ở bước nào" (bài kiểm khoá):
 *
 *   huỷ         = `ORDER_OUTCOME_FAST = 'CANCELLED'` (kết quả đơn chuẩn, mục 3.1)
 *   trước / sau = `ORDER_EVER_CONFIRMED` (vị từ duy nhất của bước "đã xác nhận")
 *
 * Kỳ lọc theo NGÀY LÊN ĐƠN, như phễu.
 */

/** Cửa sổ nhạy cảm in cạnh cửa sổ luật: "nếu nới ra một tuần thì bao nhiêu đơn huỷ có đơn thay". */
export const WIDE_WINDOW_HOURS = 7 * 24;

type CancelledRow = {
  id: string;
  bill_phone: string | null;
  bill_full_name: string | null;
  ship_address: string | null;
  total: number | string | null;
  inserted_at: string | Date;
  stage: string;
  source: OrderSourceKey;
  ever_confirmed: boolean;
  confirmed_at: string | Date | null;
  cancelled_at: string | Date | null;
  has_shipment: boolean;
  handed_off: boolean;
  waited_stock: boolean;
};

type SiblingRow = { id: string; bill_phone: string | null; bill_full_name: string | null; ship_address: string | null; total: number | string | null; inserted_at: string | Date };
type ItemRow = { order_id: string; variant_id: string | null; sku: string | null; product_name: string | null; variation_detail: string | null; quantity: number | string | null };

export type CancelSide = {
  total: number;
  /** Trong đó bị XOÁ (Pancake "Đã xoá"), không phải huỷ — thường là đơn thử / đơn nhập nhầm. */
  deleted: number;
  /** Theo cửa sổ luật đơn trùng. */
  byMatch: Record<CancelMatch, number>;
  /** Cùng phép xếp với cửa sổ 7 ngày — độ nhạy, không phải định nghĩa. */
  byMatchWide: Record<CancelMatch, number>;
  /** Đã có đơn khác xác nhận thay (cùng mẫu mã hoặc chồng lấn). */
  replaced: number;
  /** Mất thật = khác mẫu mã + không đơn nào thay. KHÔNG gồm "không đủ SĐT". */
  lost: number;
  /** Huỷ sau bao lâu — tính từ lúc lên đơn (trước XN) hoặc từ lúc xác nhận (sau XN). */
  ageBuckets: { key: PreConfirmCancelBucketKey; label: string; count: number }[];
  /** Số đơn đo được tuổi lúc huỷ (có đủ hai mốc). */
  ageMeasured: number;
  medianAgeHours: number | null;
};

export type CancelSourceRow = { key: OrderSourceKey; label: string; pre: number; preLost: number; post: number; postLost: number };

export type CancelAnalysis = {
  windowHours: number;
  pre: CancelSide;
  post: CancelSide & {
    byStage: Record<PostConfirmStage, number>;
    /** Đơn từng CHỜ HÀNG (sổ ERP hoặc trạng thái Pancake "Chờ hàng") rồi bị huỷ sau xác nhận. */
    waitedStock: number;
  };
  bySource: CancelSourceRow[];
};

const toDateOrNull = (v: string | Date | null) => (v ? new Date(v) : null);

function candidate(r: SiblingRow | CancelledRow, items: Map<string, ItemLike[]>): DuplicateCandidate {
  return {
    orderId: r.id,
    insertedAt: new Date(r.inserted_at),
    phone: r.bill_phone ?? "",
    receiverName: r.bill_full_name ?? "",
    address: r.ship_address ?? "",
    total: Number(r.total ?? 0),
    items: items.get(r.id) ?? [],
  };
}

async function loadCancelled(period: Period): Promise<CancelledRow[]> {
  const db = await getDb();
  const conds: SQL[] = [];
  if (period.from) conds.push(sql`${o.insertedAt} >= ${period.from.toISOString()}::timestamptz`);
  if (period.to) conds.push(sql`${o.insertedAt} <= ${period.to.toISOString()}::timestamptz`);
  const base = db
    .select({
      id: o.id,
      billPhone: o.billPhone,
      billFullName: o.billFullName,
      shipAddress: o.shipAddress,
      total: o.totalPriceAfterDiscount,
      insertedAt: o.insertedAt,
      stage: sql<string>`${o.stage}::text`.as("c_stage"),
      source: sql<OrderSourceKey>`${ORDER_SOURCE}`.as("c_source"),
      outcome: ORDER_OUTCOME_FAST.as("c_outcome"),
      everConfirmed: sql<boolean>`${ORDER_EVER_CONFIRMED}`.as("c_ever"),
      confirmedAt: sql`${CONFIRMED_AT}`.as("c_confirmed_at"),
      cancelledAt: sql`${CANCELLED_AT}`.as("c_cancelled_at"),
      hasShipment: sql<boolean>`${s.id} is not null`.as("c_has_ship"),
      handedOff: sql<boolean>`${sql.raw(CARRIER_HANDOFF_AT_SQL)} is not null`.as("c_handed"),
      waitedStock: sql<boolean>`(exists (select 1 from stock_wait_log wl where wl.order_id = ${o.id})
        or exists (select 1 from order_status_history hw where hw.order_id = ${o.id} and hw.status in ${sql.raw(`(${PANCAKE_WAITING_CODES.join(",")})`)}))`.as("c_waited"),
    })
    .from(o)
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(conds.length ? and(...conds) : sql`true`)
    .offset(OUTCOME_FENCE)
    .as("c_base");
  // TẮT JIT — cùng hình dạng với phễu (kết quả đơn tính sẵn + vài truy vấn con tương quan).
  const rows = await chayKhongJit(db, (tx) => tx.select().from(base).where(sql`${base.outcome} = 'CANCELLED'`));
  return rows.map((r) => ({
    id: r.id,
    bill_phone: r.billPhone,
    bill_full_name: r.billFullName,
    ship_address: r.shipAddress,
    total: r.total,
    inserted_at: r.insertedAt,
    stage: String(r.stage),
    source: r.source,
    ever_confirmed: Boolean(r.everConfirmed),
    confirmed_at: (r.confirmedAt as string | Date | null) ?? null,
    cancelled_at: (r.cancelledAt as string | Date | null) ?? null,
    has_shipment: Boolean(r.hasShipment),
    handed_off: Boolean(r.handedOff),
    waited_stock: Boolean(r.waitedStock),
  }));
}

/** Đơn KHÁC, cùng khoá SĐT với một đơn huỷ, lên đơn trong cửa sổ rộng, và ĐÃ TỪNG được xác nhận. */
async function loadSiblings(cancelled: CancelledRow[]): Promise<SiblingRow[]> {
  const keys = [...new Set(cancelled.map((c) => phoneKey(c.bill_phone)).filter((k): k is string => Boolean(k)))];
  if (!keys.length) return [];
  const times = cancelled.map((c) => new Date(c.inserted_at).getTime());
  const from = new Date(Math.min(...times) - WIDE_WINDOW_HOURS * 3_600_000);
  const to = new Date(Math.max(...times) + WIDE_WINDOW_HOURS * 3_600_000);
  const db = await getDb();
  return rowsOf<SiblingRow>(
    await db.execute(sql`
      select ${o.id} as id, ${o.billPhone} as bill_phone, ${o.billFullName} as bill_full_name, ${o.shipAddress} as ship_address,
             ${o.totalPriceAfterDiscount} as total, ${o.insertedAt} as inserted_at
        from ${o}
       where right(regexp_replace(coalesce(${o.billPhone}, ''), '[^0-9]', '', 'g'), 9) in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
         and ${o.insertedAt} >= ${from.toISOString()}::timestamptz
         and ${o.insertedAt} <= ${to.toISOString()}::timestamptz
         and ${ORDER_EVER_CONFIRMED}
    `),
  );
}

async function loadItems(ids: string[]): Promise<Map<string, ItemLike[]>> {
  const map = new Map<string, ItemLike[]>();
  if (!ids.length) return map;
  const db = await getDb();
  const rows = rowsOf<ItemRow>(
    await db.execute(sql`
      select i.order_id, i.variant_id, i.sku, i.product_name, i.variation_detail, i.quantity
        from order_items i
       where i.order_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
         -- Hàng TẶNG không nói lên khách đã mua gì — cùng quy ước với hàng đợi đơn trùng.
         and i.is_bonus = false`),
  );
  for (const r of rows) {
    const list = map.get(r.order_id) ?? [];
    list.push({ variantId: r.variant_id, sku: r.sku ?? "", productName: r.product_name ?? "", variationDetail: r.variation_detail ?? "", quantity: Number(r.quantity ?? 0) });
    map.set(r.order_id, list);
  }
  return map;
}

function side(rows: CancelledRow[], siblings: DuplicateCandidate[], items: Map<string, ItemLike[]>, windowHours: number, ageFrom: (r: CancelledRow) => Date | null) {
  const byMatch = emptyMatchCounts();
  const byMatchWide = emptyMatchCounts();
  const matchOf = new Map<string, CancelMatch>();
  const buckets = new Map<PreConfirmCancelBucketKey, number>(PRE_CONFIRM_CANCEL_BUCKETS.map((b) => [b.key, 0]));
  const ages: number[] = [];
  for (const r of rows) {
    const c = candidate(r, items);
    const m = classifyCancelled(c, siblings, windowHours);
    byMatch[m] += 1;
    byMatchWide[classifyCancelled(c, siblings, WIDE_WINDOW_HOURS)] += 1;
    matchOf.set(r.id, m);
    const start = ageFrom(r);
    const end = toDateOrNull(r.cancelled_at);
    const hours = start && end ? (end.getTime() - start.getTime()) / 3_600_000 : null;
    const b = cancelAgeBucket(hours);
    if (b && hours !== null) {
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
      ages.push(hours);
    }
  }
  const replaced = CANCEL_MATCH_REPLACED.reduce((t, k) => t + byMatch[k], 0);
  const out: CancelSide = {
    total: rows.length,
    deleted: rows.filter((r) => r.stage === "DELETED").length,
    byMatch,
    byMatchWide,
    replaced,
    lost: byMatch.SAME_CUSTOMER_OTHER + byMatch.LOST,
    ageBuckets: PRE_CONFIRM_CANCEL_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: buckets.get(b.key) ?? 0 })),
    ageMeasured: ages.length,
    medianAgeHours: median(ages),
  };
  return { out, matchOf };
}

async function getCancelAnalysisUncached(period: Period, windowHours: number): Promise<CancelAnalysis> {
  const cancelled = await loadCancelled(period);
  const siblingsRaw = await loadSiblings(cancelled);
  const items = await loadItems([...new Set([...cancelled.map((c) => c.id), ...siblingsRaw.map((x) => x.id)])]);
  const siblings = siblingsRaw.map((x) => candidate(x, items));

  const preRows = cancelled.filter((r) => !r.ever_confirmed);
  const postRows = cancelled.filter((r) => r.ever_confirmed);
  const pre = side(preRows, siblings, items, windowHours, (r) => new Date(r.inserted_at));
  // Huỷ sau xác nhận: tuổi tính TỪ LÚC XÁC NHẬN (thiếu mốc xác nhận ⇒ không đo được, không tính 0).
  const post = side(postRows, siblings, items, windowHours, (r) => toDateOrNull(r.confirmed_at));

  const byStage = Object.fromEntries(POST_CONFIRM_STAGES.map((k) => [k, 0])) as Record<PostConfirmStage, number>;
  for (const r of postRows) byStage[r.handed_off ? "AFTER_HANDOFF" : r.has_shipment ? "BEFORE_HANDOFF" : "BEFORE_SHIPMENT"] += 1;

  const lostKeys: readonly CancelMatch[] = ["SAME_CUSTOMER_OTHER", "LOST"];
  const src = new Map<OrderSourceKey, CancelSourceRow>();
  const row = (k: OrderSourceKey) => {
    const cur = src.get(k) ?? { key: k, label: ORDER_SOURCE_LABEL[k] ?? k, pre: 0, preLost: 0, post: 0, postLost: 0 };
    src.set(k, cur);
    return cur;
  };
  for (const r of preRows) {
    const x = row(r.source);
    x.pre += 1;
    if (lostKeys.includes(pre.matchOf.get(r.id) as CancelMatch)) x.preLost += 1;
  }
  for (const r of postRows) {
    const x = row(r.source);
    x.post += 1;
    if (lostKeys.includes(post.matchOf.get(r.id) as CancelMatch)) x.postLost += 1;
  }

  return {
    windowHours,
    pre: pre.out,
    post: { ...post.out, byStage, waitedStock: postRows.filter((r) => r.waited_stock).length },
    bySource: [...src.values()].sort((a, b) => b.pre + b.post - (a.pre + a.post)),
  };
}

/**
 * Đệm 120 giây — cùng nhịp với phễu. Cửa sổ đơn trùng đọc từ `settings` (sửa được không cần deploy)
 * nên nó phải nằm TRONG khoá đệm cùng với kỳ (AGENTS.md mục 2).
 */
export async function getCancelAnalysis(period: Period, opts: { fresh?: boolean } = {}): Promise<CancelAnalysis> {
  const { windowHours } = await getDuplicateRule();
  if (opts.fresh) return getCancelAnalysisUncached(period, windowHours);
  return memo(`cancelAnalysis:${windowHours}:${periodKey(period)}`, 120_000, () => getCancelAnalysisUncached(period, windowHours));
}

export { CANCEL_MATCHES };
