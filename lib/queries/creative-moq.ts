import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { chayKhongJit, schema, type Db } from "@/db";
import { ORDER_AD_ID, orderAdCandidates } from "@/lib/queries/ads-attribution-link";
import { CONFIRMED_ORDER } from "@/lib/queries/metrics";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";

/**
 * ═══════════ MOQ THIẾT KẾ MỚI — ĐẾM ĐƠN CỦA MỘT THIẾT KẾ (CHỈ ĐỌC) ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §5h. `lib/queries/*` không ghi (`tests/advisory-safety.test.ts`) — đường ghi
 * nháp lệnh sản xuất nằm ở `lib/creative/moq.ts`.
 *
 * ─── HAI ĐƯỜNG, KHAI RIÊNG, HỢP BẰNG ID ĐƠN ───
 *
 *  (a) `viaAd`   — đơn mà `ORDER_AD_ID` (`lib/queries/ads-attribution-link.ts` — CHÍNH biểu thức cấp mẩu
 *                  của `/ads` và của `variantMetrics`, không bản chép) quy về một mẩu QC thuộc biến thể có
 *                  `design_concept_id` này: `ad_id` Pancake gửi trước; không có (NULL / rỗng) thì bài viết
 *                  của đơn, CHỈ khi bài ấy thuộc ĐÚNG MỘT mẩu trong toàn sổ `fb_ads`. Bài nhiều mẩu cùng chạy
 *                  ⇒ không nối. Đơn mang `ad_id` luôn đi đường trực tiếp — không bị đếm lại qua bài viết,
 *                  không bị kéo sang mẩu khác vì bài viết của nó. Hai phần tách ở `viaAdDirect` /
 *                  `viaAdPost` để màn hình và tin báo nói ra được căn cứ. (Trước B2, 26/09/2026, đường này
 *                  chỉ đọc `orders.ad_id` — tức đếm THIẾU mọi đơn đến qua bình luận/nhắn tin dưới bài.)
 *  (b) `viaCode` — đơn có dòng hàng KHÔNG PHẢI QUÀ là sản phẩm Pancake mã (`products.custom_id`) = mã TK.
 *                  Dòng nối về sản phẩm qua `order_items.product_id` HOẶC `order_items.variant_id →
 *                  product_variants.product_id` (đường quan hệ của `lib/queries/product-code.ts` — không dò
 *                  chuỗi SKU / tên hàng).
 *
 * Một đơn thấy ở cả hai đường tính MỘT lần (`both`). Đơn = population `CONFIRMED_ORDER` và KHÔNG huỷ theo
 * `ORDER_OUTCOME_FAST` (bảng dẫn xuất + rào `OUTCOME_FENCE`, nối vận đơn bằng `PRIMARY_ATTEMPT`) — đúng định
 * nghĩa "đơn chốt" (`bookedOrders`) của vòng mẫu. KHÔNG dùng "giao thành công": thiết kế chưa sản xuất thì
 * chưa có gì để giao.
 *
 * Số lượng chỉ lấy từ DÒNG MÃ TK (bỏ quà `is_bonus`). Đơn chỉ thấy qua quảng cáo mà không có dòng mã TK thì
 * khách đã đặt bao nhiêu cái của thiết kế là CHƯA BIẾT (`adOnly`) — không cộng, không đoán từ tên hàng.
 * Màu / size đọc từ mẫu mã (`product_variants.color/size`); thiếu một trong hai ⇒ `qtyNoVariant`, không chia
 * vào ma trận.
 */

export type DesignMoqLine = { color: string; size: string; qty: number };

export type DesignMoqCount = {
  designId: string;
  code: string;
  viaAd: number;
  /** Phần của `viaAd` mang `ad_id` Pancake gửi — bằng chứng trực tiếp. */
  viaAdDirect: number;
  /** Phần của `viaAd` không mang `ad_id`, nối qua bài viết của ĐÚNG MỘT mẩu. `viaAdDirect + viaAdPost = viaAd`. */
  viaAdPost: number;
  viaCode: number;
  both: number;
  /** HỢP hai đường theo id đơn — con số so với MOQ. */
  orders: number;
  /** Đơn chỉ thấy qua quảng cáo (không có dòng mã TK) — số lượng CHƯA BIẾT. */
  adOnly: number;
  /** Sản phẩm Pancake mang đúng mã TK (có thể nhiều hơn một nếu người tạo trùng mã). */
  productIds: string[];
  productName: string | null;
  qtyKnown: number;
  qtyNoVariant: number;
  /** Số lượng theo (màu, size) — chỉ dòng biết đủ cả hai. */
  lines: DesignMoqLine[];
};

export type DesignMoqInput = { id: string; code: string };

export function emptyMoqCount(d: DesignMoqInput): DesignMoqCount {
  return { designId: d.id, code: d.code, viaAd: 0, viaAdDirect: 0, viaAdPost: 0, viaCode: 0, both: 0, orders: 0, adOnly: 0, productIds: [], productName: null, qtyKnown: 0, qtyNoVariant: 0, lines: [] };
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** Đếm đơn / số lượng của từng thiết kế. Thiết kế không có đơn nào vẫn có dòng (toàn 0 — 0 THẬT: đã đếm). */
export async function designMoqCounts(db: Db, designs: readonly DesignMoqInput[]): Promise<Map<string, DesignMoqCount>> {
  const out = new Map<string, DesignMoqCount>();
  for (const d of designs) out.set(d.id, emptyMoqCount(d));
  if (designs.length === 0) return out;
  const designOfCode = new Map(designs.map((d) => [norm(d.code), d.id]));

  // ─── (a) mẩu QC mang thiết kế ───
  const v = schema.creativeVariants;
  const adRows = await db
    .select({ designId: v.designConceptId, adId: v.fbAdId })
    .from(v)
    .where(
      and(
        inArray(
          v.designConceptId,
          designs.map((d) => d.id),
        ),
        isNotNull(v.fbAdId),
      ),
    );
  const designOfAd = new Map<string, string>();
  for (const r of adRows) {
    const ad = (r.adId ?? "").trim();
    if (ad && r.designId) designOfAd.set(ad, r.designId);
  }

  // ─── (b) sản phẩm Pancake mang đúng mã TK + mẫu mã của chúng ───
  const p = schema.products;
  const pv = schema.productVariants;
  const prodRows = await db
    .select({ id: p.id, name: p.name, code: p.customId })
    .from(p)
    .where(inArray(sql`upper(trim(${p.customId}))`, [...designOfCode.keys()]))
    .orderBy(p.id);
  const designOfProduct = new Map<string, string>();
  for (const r of prodRows) {
    const designId = designOfCode.get(norm(r.code));
    if (!designId) continue;
    designOfProduct.set(r.id, designId);
    const c = out.get(designId) as DesignMoqCount;
    c.productIds.push(r.id);
    if (c.productName === null) c.productName = r.name;
  }
  const productIds = [...designOfProduct.keys()];
  const varRows = productIds.length ? await db.select({ id: pv.id, productId: pv.productId, color: pv.color, size: pv.size }).from(pv).where(inArray(pv.productId, productIds)) : [];
  const variantOf = new Map(varRows.map((r) => [r.id, r]));
  const variantIds = [...variantOf.keys()];

  const adIds = [...designOfAd.keys()];
  if (adIds.length === 0 && productIds.length === 0) return out;

  // ─── Đơn đã xác nhận, không huỷ, thuộc ít nhất một đường ───
  const o = schema.orders;
  const s = schema.shipments;
  const oi = schema.orderItems;
  const tkLine = (): SQL => {
    const conds: SQL[] = [];
    if (productIds.length) conds.push(inArray(oi.productId, productIds));
    if (variantIds.length) conds.push(inArray(oi.variantId, variantIds));
    return and(eq(oi.isBonus, false), or(...conds)) as SQL;
  };
  const scope: SQL[] = [];
  // Siêu tập RẺ (thu hẹp vì hiệu năng) — `ORDER_AD_ID` ở cột dưới mới QUYẾT đơn thuộc mẩu nào.
  if (adIds.length) scope.push(orderAdCandidates(adIds));
  if (productIds.length) scope.push(inArray(o.id, db.select({ id: oi.orderId }).from(oi).where(tkLine())));
  const facts = db
    .select({
      orderId: sql<string>`${o.id}`.as("moq_order_id"),
      adId: sql<string | null>`${ORDER_AD_ID}`.as("moq_ad_id"),
      // Đường quy kết: đơn mang `ad_id` luôn là TRỰC TIẾP — `ORDER_AD_ID` không bao giờ hỏi tới bài viết của nó.
      viaPost: sql<boolean>`(nullif(${o.adId}, '') is null)`.as("moq_via_post"),
      outcome: ORDER_OUTCOME_FAST.as("moq_outcome"),
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG (PRIMARY_ATTEMPT) — đơn gửi lại không được đếm hai lần.
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(and(CONFIRMED_ORDER, or(...scope)))
    .offset(OUTCOME_FENCE)
    .as("design_moq_facts");
  const orderRows = await chayKhongJit(db, (tx) =>
    tx
      .select({ orderId: sql<string>`${facts.orderId}`, adId: sql<string | null>`${facts.adId}`, viaPost: sql<boolean>`${facts.viaPost}` })
      .from(facts)
      .where(sql`${facts.outcome} <> 'CANCELLED'`),
  );
  if (orderRows.length === 0) return out;

  const viaAd = new Map<string, Set<string>>();
  const viaAdPost = new Map<string, Set<string>>();
  const viaCode = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, designId: string, orderId: string) => {
    const set = m.get(designId) ?? new Set<string>();
    set.add(orderId);
    m.set(designId, set);
  };
  for (const r of orderRows) {
    const designId = r.adId ? designOfAd.get(String(r.adId).trim()) : undefined;
    if (!designId) continue;
    add(viaAd, designId, String(r.orderId));
    if (r.viaPost === true || String(r.viaPost) === "true") add(viaAdPost, designId, String(r.orderId));
  }

  // ─── Dòng mã TK của các đơn ấy ───
  const lineRows = productIds.length
    ? await db
        .select({ orderId: oi.orderId, productId: oi.productId, variantId: oi.variantId, quantity: oi.quantity })
        .from(oi)
        .where(
          and(
            inArray(
              oi.orderId,
              orderRows.map((r) => String(r.orderId)),
            ),
            tkLine(),
          ),
        )
    : [];
  const cells = new Map<string, Map<string, DesignMoqLine>>();
  for (const l of lineRows) {
    const variant = l.variantId ? variantOf.get(l.variantId) : undefined;
    const designId = (l.productId ? designOfProduct.get(l.productId) : undefined) ?? (variant ? designOfProduct.get(variant.productId) : undefined);
    if (!designId) continue;
    add(viaCode, designId, l.orderId);
    const c = out.get(designId) as DesignMoqCount;
    const qty = Math.max(0, Number(l.quantity ?? 0));
    c.qtyKnown += qty;
    // Mẫu mã phải thuộc CHÍNH sản phẩm TK; màu hoặc size trống ⇒ chưa biết, không chia vào ô nào.
    const color = variant && designOfProduct.get(variant.productId) === designId ? variant.color.trim() : "";
    const size = variant && designOfProduct.get(variant.productId) === designId ? variant.size.trim() : "";
    if (!color || !size) {
      c.qtyNoVariant += qty;
      continue;
    }
    const byKey = cells.get(designId) ?? new Map<string, DesignMoqLine>();
    const key = `${color}|${size}`;
    const cell = byKey.get(key) ?? { color, size, qty: 0 };
    cell.qty += qty;
    byKey.set(key, cell);
    cells.set(designId, byKey);
  }

  for (const c of out.values()) {
    const a = viaAd.get(c.designId) ?? new Set<string>();
    const b = viaCode.get(c.designId) ?? new Set<string>();
    let both = 0;
    for (const id of a) if (b.has(id)) both += 1;
    c.viaAd = a.size;
    c.viaAdPost = viaAdPost.get(c.designId)?.size ?? 0;
    c.viaAdDirect = a.size - c.viaAdPost;
    c.viaCode = b.size;
    c.both = both;
    c.orders = a.size + b.size - both;
    c.adOnly = a.size - both;
    c.lines = [...(cells.get(c.designId)?.values() ?? [])].sort((x, y) => x.color.localeCompare(y.color) || x.size.localeCompare(y.size));
  }
  return out;
}
