import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { chayKhongJit, schema, type Db } from "@/db";
import {
  DESIGN_DNA_VERSION,
  DESIGN_NOVELTY,
  DESIGN_PARENT_RULES,
  MOCKUP_RULES,
  PRODUCT_DNA_RETRY_HOURS,
  designParentScore,
  parseDna,
  parsePartialDna,
  type CreativeVerdict,
  type DesignDna,
  type DesignStatus,
} from "@/lib/constants/creative-loop";
import { RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { shiftDay } from "@/lib/constants/marketing-decision-ledger";
import type { DesignParent, DesignPlanInput, DnaObservation } from "@/lib/creative/design";
import { dnaStats } from "@/lib/creative/design";
import { AD_MESSAGES } from "@/lib/queries/ads-roas";
import { variantMetrics } from "@/lib/queries/creative-loop";
import { designMoqCounts, emptyMoqCount, type DesignMoqCount } from "@/lib/queries/creative-moq";
import { vnMidnight } from "@/lib/queries/creative-plan";
import { CONFIRMED_ORDER } from "@/lib/queries/metrics";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";

/**
 * ═══════════ THIẾT KẾ SẢN PHẨM MỚI — ĐẦU VÀO VÀ MÀN HÌNH (CHỈ ĐỌC) ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §5f. `lib/queries/*` không ghi (`tests/advisory-safety.test.ts`).
 *
 * ─── "BÁN TỐT" KHÔNG CÓ CÔNG THỨC KẾT QUẢ ĐƠN THỨ HAI ───
 *
 * Đơn giao thành công / hoàn của một mã đọc qua `ORDER_OUTCOME_FAST` (bảng dẫn xuất + rào
 * `OUTCOME_FENCE`, nối vận đơn bằng `PRIMARY_ATTEMPT` — đúng hình dạng của `variantMetrics`) trên
 * population `CONFIRMED_ORDER`. Không viết lại điều kiện `stage` nào (AGENTS.md mục 3.1). Đơn nối về mã
 * qua `order_items.product_id`, bỏ dòng quà tặng (quà không phải thứ khách chọn mua). Chi / tin nhắn đọc
 * từ `ad_spends` hạt `AD` — nguồn tiền duy nhất của vòng mẫu.
 *
 * Mốc cửa sổ tính lùi từ 00:00 giờ Việt Nam của NGÀY LÔ, không từ đồng hồ lúc gọi — chạy lại cùng lô
 * ra cùng đầu vào.
 */

export type ProductSellScore = {
  productId: string;
  /** Đơn (không tính quà) giao thành công trong cửa sổ, theo `ORDER_OUTCOME`. */
  delivered: number;
  /** Đơn hoàn (`RETURNED` + `RETURNED_BY_RULE`, luôn gộp — ORDER_OUTCOME.md mục 6). */
  returned: number;
  /** `null` = mã không có dòng chi hạt `AD` nào trong cửa sổ (CHƯA BIẾT, không phải 0). */
  spendVnd: number | null;
  messages: number | null;
};

/** Điểm "bán tốt" thô của mọi mã có đơn hoặc có chi QC trong `days` ngày trước `asOf`. */
export async function productSellScores(db: Db, asOf: Date, days: number = DESIGN_PARENT_RULES.lookbackDays): Promise<Map<string, ProductSellScore>> {
  const since = new Date(asOf.getTime() - days * 86_400_000);
  const out = new Map<string, ProductSellScore>();
  const get = (id: string) => {
    let r = out.get(id);
    if (!r) {
      r = { productId: id, delivered: 0, returned: 0, spendVnd: null, messages: null };
      out.set(id, r);
    }
    return r;
  };

  const o = schema.orders;
  const oi = schema.orderItems;
  const s = schema.shipments;
  const facts = db
    .select({
      orderId: sql<string>`${o.id}`.as("ds_order_id"),
      productId: sql<string>`${oi.productId}`.as("ds_product_id"),
      outcome: ORDER_OUTCOME_FAST.as("ds_outcome"),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(and(CONFIRMED_ORDER, eq(oi.isBonus, false), isNotNull(oi.productId), gte(o.insertedAt, since), lt(o.insertedAt, asOf)))
    .offset(OUTCOME_FENCE)
    .as("design_sell_facts");
  const orderRows = await chayKhongJit(db, (tx) =>
    tx
      .select({
        productId: sql<string>`${facts.productId}`,
        delivered: sql<number>`count(distinct ${facts.orderId}) filter (where ${facts.outcome} = 'DELIVERED')`,
        returned: sql<number>`count(distinct ${facts.orderId}) filter (where ${facts.outcome} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))`,
      })
      .from(facts)
      .groupBy(facts.productId),
  );
  for (const r of orderRows) {
    const x = get(String(r.productId));
    x.delivered = Number(r.delivered ?? 0);
    x.returned = Number(r.returned ?? 0);
  }

  const ads = schema.adSpends;
  const spendRows = await db
    .select({ productId: sql<string>`${ads.productId}`, spend: sql<number>`coalesce(sum(${ads.spend}), 0)`, messages: sql<number>`coalesce(sum(${AD_MESSAGES}), 0)` })
    .from(ads)
    .where(and(eq(ads.grain, "AD"), eq(ads.excluded, false), isNotNull(ads.productId), gte(ads.spendDate, since), lt(ads.spendDate, asOf)))
    .groupBy(ads.productId);
  for (const r of spendRows) {
    const x = get(String(r.productId));
    x.spendVnd = Number(r.spend ?? 0);
    x.messages = Number(r.messages ?? 0);
  }
  return out;
}

/**
 * Chi / tin nhắn của TỪNG mẩu QC lịch sử của mỗi mã trong `MOCKUP_RULES.lookbackDays` ngày trước `asOf` —
 * đầu vào của luật riêng ô mockup (`mockupRulesFromHistory`). Mẩu nối về mã bằng `ad_spends.product_id`
 * của dòng hạt `AD`; dòng không có mã thì theo mẫu của vòng (`creative_variants.fb_ad_id`) hoặc quảng cáo
 * cũ đã nhập (`creative_sources.fb_ad_id`). Mẩu 0 tin nhắn không vào mẫu (tỷ số CHƯA BIẾT, mục 42).
 */
export async function productAdCostHistory(db: Db, productIds: readonly string[], asOf: Date): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (productIds.length === 0) return out;
  const since = new Date(asOf.getTime() - MOCKUP_RULES.lookbackDays * 86_400_000);
  const v = schema.creativeVariants;
  const src = schema.creativeSources;
  const [fromVariants, fromSources] = await Promise.all([
    db.select({ adId: sql<string>`${v.fbAdId}`, productId: sql<string>`${v.productId}` }).from(v).where(and(isNotNull(v.fbAdId), inArray(v.productId, [...productIds]))),
    db.select({ adId: sql<string>`${src.fbAdId}`, productId: sql<string>`${src.productId}` }).from(src).where(and(eq(src.kind, "OWN_AD"), isNotNull(src.fbAdId), inArray(src.productId, [...productIds]))),
  ]);
  const mapped = new Map<string, string>();
  for (const r of [...fromVariants, ...fromSources]) if (r.adId && !mapped.has(String(r.adId))) mapped.set(String(r.adId), String(r.productId));

  const ads = schema.adSpends;
  const conds = [inArray(ads.productId, [...productIds])];
  if (mapped.size) conds.push(inArray(ads.adId, [...mapped.keys()]));
  const rows = await db
    .select({
      adId: sql<string>`${ads.adId}`,
      productId: sql<string | null>`min(${ads.productId})`,
      spend: sql<number>`coalesce(sum(${ads.spend}), 0)`,
      messages: sql<number>`coalesce(sum(${AD_MESSAGES}), 0)`,
    })
    .from(ads)
    .where(and(eq(ads.grain, "AD"), eq(ads.excluded, false), isNotNull(ads.adId), gte(ads.spendDate, since), lt(ads.spendDate, asOf), or(...conds)))
    .groupBy(ads.adId);
  const wanted = new Set(productIds);
  for (const r of rows) {
    const pid = r.productId ? String(r.productId) : mapped.get(String(r.adId));
    if (!pid || !wanted.has(pid)) continue;
    const msgs = Number(r.messages ?? 0);
    if (msgs <= 0) continue;
    const list = out.get(pid) ?? [];
    list.push(Number(r.spend ?? 0) / msgs);
    out.set(pid, list);
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

/** Giá bán của nhiều mã — cùng luật `loadProductBrief`: một giá duy nhất, không thì `null`. */
async function productPrices(db: Db, productIds: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (productIds.length === 0) return out;
  const pv = schema.productVariants;
  const rows = await db
    .select({ productId: pv.productId, after: pv.retailPriceAfterDiscount, list: pv.retailPrice })
    .from(pv)
    .where(and(inArray(pv.productId, productIds), eq(pv.isRemoved, false)));
  const by = new Map<string, Set<number>>();
  for (const r of rows) {
    const price = r.after > 0 ? r.after : r.list;
    if (!(price > 0) || !r.productId) continue;
    const set = by.get(r.productId) ?? new Set<number>();
    set.add(price);
    by.set(r.productId, set);
  }
  for (const id of productIds) {
    const set = by.get(id);
    out.set(id, set && set.size === 1 ? [...set][0] : null);
  }
  return out;
}

/**
 * Đầu vào của `planDesigns()` cho lô `batchDay`: mã cha (bán tốt + có DNA), DNA của mọi mã đang có,
 * thiết kế 30 ngày gần nhất, thống kê DNA của thiết kế đã test.
 */
export async function loadDesignInputs(db: Db, batchDay: string): Promise<Omit<DesignPlanInput, "batchDay" | "count">> {
  const asOf = vnMidnight(batchDay);
  const pd = schema.productDna;
  const dnaRows = await db.select({ productId: pd.productId, dna: pd.dna }).from(pd).where(eq(pd.dnaVersion, DESIGN_DNA_VERSION));
  const dnaOf = new Map<string, ReturnType<typeof parsePartialDna>>();
  for (const r of dnaRows) {
    const d = parsePartialDna(r.dna);
    if (Object.keys(d).length > 0) dnaOf.set(r.productId, d);
  }
  const existingDna = [...dnaOf.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, d]) => d);

  const scores = await productSellScores(db, asOf);
  const candidateIds = [...dnaOf.keys()].filter((id) => {
    const sc = scores.get(id);
    return sc ? designParentScore(sc) !== null : false;
  });

  const s = schema.creativeSources;
  const img = schema.creativeImages;
  const p = schema.products;
  const [photoRows, prodRows, prices] = await Promise.all([
    candidateIds.length
      ? db
          .select({ sourceId: s.id, productId: s.productId })
          .from(s)
          .innerJoin(img, eq(img.id, s.imageId))
          .where(and(eq(s.kind, "PRODUCT_PHOTO"), eq(s.active, true), isNull(img.purgedAt), inArray(s.productId, candidateIds)))
          .orderBy(desc(s.createdAt), s.id)
      : Promise.resolve([] as { sourceId: string; productId: string | null }[]),
    candidateIds.length ? db.select({ id: p.id, name: p.name, customId: p.customId, displayId: p.displayId }).from(p).where(inArray(p.id, candidateIds)) : Promise.resolve([]),
    productPrices(db, candidateIds),
  ]);
  const photoOf = new Map<string, string>();
  for (const r of photoRows) if (r.productId && !photoOf.has(r.productId)) photoOf.set(r.productId, r.sourceId);
  const nameOf = new Map(prodRows.map((r) => [r.id, `${r.customId || (r.displayId !== null ? String(r.displayId) : "") || r.name}`]));

  const parents: DesignParent[] = candidateIds
    .map((id) => ({
      productId: id,
      label: nameOf.get(id) ?? id,
      dna: dnaOf.get(id) ?? {},
      score: designParentScore(scores.get(id) as ProductSellScore) as number,
      photoSourceId: photoOf.get(id) ?? null,
      priceVnd: prices.get(id) ?? null,
      metrics: (({ delivered, returned, spendVnd, messages }: ProductSellScore) => ({ delivered, returned, spendVnd, messages }))(scores.get(id) as ProductSellScore),
    }))
    .sort((a, b) => a.productId.localeCompare(b.productId));

  const dc = schema.designConcepts;
  const recentFrom = vnMidnight(shiftDay(batchDay, -DESIGN_NOVELTY.recentDesignDays));
  const recent = await db
    .select({ dna: dc.dna })
    .from(dc)
    .where(and(eq(dc.dnaVersion, DESIGN_DNA_VERSION), gte(dc.createdAt, recentFrom)))
    .orderBy(dc.code);
  const recentDesigns = recent.map((r) => parseDna(r.dna)).filter((d): d is DesignDna => d !== null);

  // ─── Học: phán quyết MỚI NHẤT của các mẩu mang thiết kế ───
  const v = schema.creativeVariants;
  const cv = schema.creativeVerdicts;
  const tested = await db
    .select({ variantId: v.id, dna: dc.dna, dnaVersion: dc.dnaVersion })
    .from(v)
    .innerJoin(dc, eq(dc.id, v.designConceptId))
    .where(isNotNull(v.fbAdId));
  const latest = tested.length
    ? await db
        .selectDistinctOn([cv.variantId], { variantId: cv.variantId, verdict: cv.verdict })
        .from(cv)
        .where(
          inArray(
            cv.variantId,
            tested.map((t) => t.variantId),
          ),
        )
        .orderBy(cv.variantId, desc(cv.verdictDay), desc(cv.updatedAt))
    : [];
  const verdictOf = new Map(latest.map((r) => [r.variantId, r.verdict as CreativeVerdict]));
  const observations: DnaObservation[] = tested.flatMap((t) => {
    const dna = parseDna(t.dna);
    const verdict = verdictOf.get(t.variantId);
    return dna && verdict ? [{ dna, dnaVersion: t.dnaVersion, verdict }] : [];
  });

  return { parents, existingDna, recentDesigns, stats: dnaStats(observations) };
}

// ───────────────────────────── MÃ CẦN ĐỌC DNA ─────────────────────────────

export type ProductDnaTarget = {
  productId: string;
  /** Ảnh trong CSDL (nguồn `PRODUCT_PHOTO` / `OWN_AD`) — ưu tiên. */
  imageId: string | null;
  /** Ảnh Pancake (`products.image`) khi CSDL không có ảnh nào của mã. */
  url: string | null;
  source: "PRODUCT_PHOTO" | "OWN_AD" | "PANCAKE_URL";
};

/**
 * Mã CHƯA có DNA đúng phiên bản (hoặc lần đọc trước hỏng và đã quá `PRODUCT_DNA_RETRY_HOURS`), KỂ CẢ mã
 * đã gỡ có ảnh — xếp mã bán tốt trước (chúng là cha mẹ của thiết kế), rồi theo id cho ổn định.
 * Ảnh: nguồn `PRODUCT_PHOTO` → nguồn `OWN_AD` gắn mã → `products.image`.
 */
export async function pendingProductDna(db: Db, now: Date, limit: number): Promise<ProductDnaTarget[]> {
  const pd = schema.productDna;
  const retryBefore = new Date(now.getTime() - PRODUCT_DNA_RETRY_HOURS * 3_600_000);
  const done = await db
    .select({ productId: pd.productId })
    .from(pd)
    .where(and(eq(pd.dnaVersion, DESIGN_DNA_VERSION), or(eq(pd.error, ""), gte(pd.readAt, retryBefore))));
  const skip = new Set(done.map((r) => r.productId));

  const s = schema.creativeSources;
  const img = schema.creativeImages;
  const p = schema.products;
  const [srcRows, prodRows] = await Promise.all([
    db
      .select({ productId: s.productId, kind: s.kind, imageId: s.imageId })
      .from(s)
      .innerJoin(img, eq(img.id, s.imageId))
      .where(and(inArray(s.kind, ["PRODUCT_PHOTO", "OWN_AD"]), isNotNull(s.productId), isNull(img.purgedAt)))
      .orderBy(desc(s.createdAt), s.id),
    db
      .select({ id: p.id, image: p.image })
      .from(p)
      .where(and(isNotNull(p.image), ne(p.image, ""))),
  ]);
  const targets = new Map<string, ProductDnaTarget>();
  for (const kind of ["PRODUCT_PHOTO", "OWN_AD"] as const) {
    for (const r of srcRows) {
      if (r.kind !== kind || !r.productId || skip.has(r.productId) || targets.has(r.productId)) continue;
      targets.set(r.productId, { productId: r.productId, imageId: r.imageId, url: null, source: kind });
    }
  }
  for (const r of prodRows) {
    const url = (r.image ?? "").trim();
    if (!url || skip.has(r.id) || targets.has(r.id)) continue;
    targets.set(r.id, { productId: r.id, imageId: null, url, source: "PANCAKE_URL" });
  }
  if (targets.size === 0) return [];
  const scores = await productSellScores(db, now);
  const rank = (id: string) => scores.get(id)?.delivered ?? 0;
  return [...targets.values()].sort((a, b) => rank(b.productId) - rank(a.productId) || a.productId.localeCompare(b.productId)).slice(0, Math.max(0, limit));
}

// ───────────────────────────── MÀN HÌNH "THIẾT KẾ MỚI" ─────────────────────────────

export type DesignConceptRow = {
  id: string;
  code: string;
  status: DesignStatus;
  dna: Record<string, string>;
  parentProductIds: string[];
  /** Nhãn mã cha (mã / tên), cùng thứ tự `parentProductIds`. */
  parentLabels: string[];
  why: string;
  priceVnd: number | null;
  imageId: string | null;
  imageAvailable: boolean;
  batchDay: string | null;
  createdAt: string;
  productionAt: string | null;
  /** Số mẩu QC đã đăng mang thiết kế. */
  ads: number;
  /** Đơn chốt / giao / hoàn quy về thiết kế qua `orders.ad_id` của các mẩu ấy (`variantMetrics`). */
  bookedOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  /** `null` = chưa mẩu nào có dòng chi (CHƯA BIẾT, không phải 0). */
  spendVnd: number | null;
  /** Tiến độ MOQ (§5h) đếm SỐNG: hai đường (mã TK · ad_id) hợp theo id đơn. */
  moq: DesignMoqCount;
  /** Mốc máy thấy đủ MOQ — có mốc thì máy không bao giờ dựng nháp thứ hai. */
  moqReachedAt: string | null;
  /** Lệnh sản xuất đang nối (nháp máy dựng hoặc lệnh người lập sẵn). `null` + có mốc ⇒ người đã xoá nháp. */
  productionOrder: { id: string; code: string; status: string } | null;
};

/** Thiết kế gần nhất (mới → cũ) + số đơn đếm qua `orders.ad_id` của các mẩu mang thiết kế. CHỈ ĐỌC. */
export async function listDesignConcepts(db: Db, limit = 100): Promise<DesignConceptRow[]> {
  const dc = schema.designConcepts;
  const img = schema.creativeImages;
  const b = schema.creativeBatches;
  const rows = await db
    .select({ c: dc, imagePurgedAt: img.purgedAt, imageRowId: img.id, batchDay: b.batchDay })
    .from(dc)
    .leftJoin(img, eq(img.id, dc.imageId))
    .leftJoin(b, eq(b.id, dc.batchId))
    .orderBy(desc(dc.createdAt), desc(dc.code))
    .limit(Math.max(1, Math.min(500, Math.round(limit))));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.c.id);
  const v = schema.creativeVariants;
  const vs = await db
    .select({ id: v.id, designConceptId: v.designConceptId, fbAdId: v.fbAdId, startAt: b.startAt })
    .from(v)
    .innerJoin(b, eq(b.id, v.batchId))
    .where(inArray(v.designConceptId, ids));
  const published = vs.filter((x) => x.fbAdId);
  const metrics = await variantMetrics(
    db,
    published.map((x) => ({ id: x.id, fbAdId: x.fbAdId, startAt: x.startAt })),
  );
  const parentIds = [...new Set(rows.flatMap((r) => r.c.parentProductIds))];
  const p = schema.products;
  const prods = parentIds.length ? await db.select({ id: p.id, name: p.name, customId: p.customId }).from(p).where(inArray(p.id, parentIds)) : [];
  const labelOf = new Map(prods.map((x) => [x.id, x.customId || x.name]));
  const moqOf = await designMoqCounts(
    db,
    rows.map((r) => ({ id: r.c.id, code: r.c.code })),
  );
  const poIds = rows.map((r) => r.c.productionOrderId).filter((x): x is string => Boolean(x));
  const po = schema.productionOrders;
  const pos = poIds.length ? await db.select({ id: po.id, code: po.code, status: po.status }).from(po).where(inArray(po.id, poIds)) : [];
  const poOf = new Map(pos.map((x) => [x.id, x]));

  return rows.map((r) => {
    const mine = published.filter((x) => x.designConceptId === r.c.id);
    let spend: number | null = null;
    let booked = 0;
    let delivered = 0;
    let returned = 0;
    for (const x of mine) {
      const m = metrics.get(x.id);
      if (!m) continue;
      if (m.spendVnd !== null) spend = (spend ?? 0) + m.spendVnd;
      booked += m.bookedOrders;
      delivered += m.deliveredOrders;
      returned += m.returnedOrders;
    }
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      id: r.c.id,
      code: r.c.code,
      status: r.c.status as DesignStatus,
      dna: { ...(r.c.dna ?? {}) },
      parentProductIds: r.c.parentProductIds,
      parentLabels: r.c.parentProductIds.map((id) => labelOf.get(id) ?? id),
      why: r.c.why,
      priceVnd: r.c.priceVnd,
      imageId: r.c.imageId,
      imageAvailable: r.c.imageId !== null && r.imageRowId !== null && r.imagePurgedAt === null,
      batchDay: r.batchDay ?? null,
      createdAt: r.c.createdAt.toISOString(),
      productionAt: iso(r.c.productionAt),
      ads: mine.length,
      bookedOrders: booked,
      deliveredOrders: delivered,
      returnedOrders: returned,
      spendVnd: spend,
      moq: moqOf.get(r.c.id) ?? emptyMoqCount({ id: r.c.id, code: r.c.code }),
      moqReachedAt: iso(r.c.moqReachedAt),
      productionOrder: r.c.productionOrderId ? (poOf.get(r.c.productionOrderId) ?? null) : null,
    };
  });
}

/** Số mã đã có DNA đọc được / tổng mã có ảnh — độ phủ in cạnh bảng thiết kế. */
export async function productDnaCoverage(db: Db): Promise<{ withDna: number; failed: number }> {
  const pd = schema.productDna;
  const [r] = await db
    .select({ ok: sql<number>`count(*) filter (where ${pd.error} = '' and ${pd.dna} <> '{}'::jsonb)::int`, failed: sql<number>`count(*) filter (where ${pd.error} <> '')::int` })
    .from(pd)
    .where(eq(pd.dnaVersion, DESIGN_DNA_VERSION));
  return { withDna: Number(r?.ok ?? 0), failed: Number(r?.failed ?? 0) };
}
