import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { OWN_AD_IMPORT, classifyOwnAd, type OwnAdMetrics, type OwnAdReason } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { rankOwnAds, type OwnAdMode, type OwnAdRank, type OwnAdRankMetric } from "@/lib/constants/own-ad-ranking";
import { vnStartOfDay } from "@/lib/format";
import { variantMetrics } from "@/lib/queries/creative-loop";
import { AD_MESSAGES } from "@/lib/queries/ads-roas";

/**
 * ═══════════ VÒNG MẪU — ỨNG VIÊN "QUẢNG CÁO CŨ CỦA SHOP" (CHỈ ĐỌC) ═══════════
 *
 * Chủ shop 24/09/2026: "Lấy luôn những ảnh mẫu win và những ảnh mẫu có chỉ số tốt (giá tin nhắn <
 * 4.000đ) để làm nguồn ảnh ban đầu". Tệp này trả lời câu "mẩu nào đủ điều kiện" — bước XEM TRƯỚC của
 * nút nhập, và cũng là phép kiểm lại ở máy chủ lúc nhập (không tin danh sách client gửi lên).
 *
 * ─── KHÔNG NGUỒN SỐ ĐO MỚI ───
 *
 * Chi / hiển thị / nhấp / tin nhắn / đơn đều đọc qua `variantMetrics()` — ĐÚNG hàm đo mẫu của vòng
 * (hạt `AD` của `ad_spends`, đơn theo `orders.ad_id` qua `ORDER_OUTCOME_FAST` + `CONFIRMED_ORDER`).
 * Không viết một điều kiện kết quả đơn thứ hai: cùng một mẩu phải mang cùng một số đơn ở đây, ở màn
 * vòng mẫu và ở `/ads`. Ở đây chỉ thêm một câu gộp `ad_spends` để CHỌN population (mẩu có chi trong
 * `OWN_AD_IMPORT.lookbackDays` ngày và đủ tin nhắn), rồi hàm thuần `classifyOwnAd()` quyết.
 *
 * Số đo là CẢ ĐỜI của mẩu trong hạt `AD` (không mốc ngày — `startAt: null`), vì "chi / tin nhắn"
 * của riêng 60 ngày cuối sẽ khen một mẩu đã đắt suốt ba tháng trước đó.
 */

export type OwnAdCandidate = {
  adId: string;
  adName: string;
  accountId: string | null;
  campaignName: string;
  /** Lý do theo luật cũ (`CLASSIFY`). Nhánh `RANK` không có lý do kiểu này ⇒ `null`; đọc `rank`. */
  reason: OwnAdReason | null;
  /** Thứ hạng tương đối trong các mẩu của tổ chức (`rankOwnAds`) — có ở CẢ hai nhánh để người xem thấy vì sao. */
  rank: OwnAdRank;
  /** Lượt mua THEO META (`ad_spends.orders` của dòng đồng bộ, cả đời mẩu) — không phải đơn ERP. */
  metaPurchases: number | null;
  costPerMetaPurchaseVnd: number | null;
  /** Mã hàng suy được (đơn mang `ad_id` → `ad_spends.product_id`); `null` ⇒ người nhập phải chọn, máy không đoán. */
  inferredProduct: { productId: string; name: string; basis: "ORDERS" | "AD_SPENDS" } | null;
  spendVnd: number | null;
  messages: number | null;
  impressions: number | null;
  clicks: number | null;
  /** `null` = CHƯA BIẾT (0 tin nhắn / 0 lượt nhấp / 0 hiển thị) — mục 42. */
  costPerMessageVnd: number | null;
  ctrPct: number | null;
  cpcVnd: number | null;
  bookedOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  periodFrom: string | null;
  periodTo: string | null;
  /** Đã nhập thành nguồn `OWN_AD` chưa (id nguồn), để màn hình nói "đã có" thay vì cho nhập lại. */
  importedSourceId: string | null;
};

export type OwnAdCandidateList = {
  rows: OwnAdCandidate[];
  /** Số mẩu đã được xét, kể cả mẩu không đạt (`CLASSIFY`: có chi trong kỳ và đủ tin nhắn · `RANK`: có chi trong kỳ). */
  scanned: number;
  /** Ngày VN đầu của cửa sổ xét. */
  since: string;
  mode: OwnAdMode;
  /** Chỉ số nào vào điểm, chỉ số nào bị bỏ cho cả nhóm và vì sao; số mẩu đã xếp hạng / chưa đủ dữ liệu. */
  ranking: { metricsUsed: OwnAdRankMetric[]; metricsSkipped: { metric: OwnAdRankMetric; reason: string }[]; ranked: number; insufficient: number; minEvents: number };
};

const EMPTY_RANKING: OwnAdCandidateList["ranking"] = { metricsUsed: [], metricsSkipped: [], ranked: 0, insufficient: 0, minEvents: OWN_AD_IMPORT.minMessages };

/**
 * Tổ chức này CÓ đơn quy về mẩu quảng cáo (`orders.ad_id` dạng số Facebook, cùng dạng `isUsableAdId`) trong cửa sổ
 * xét không — câu hỏi quyết định nhánh `decideOwnAdMode`. Đơn của tổ chức khách (bot / nhập tay / Pancake không gửi
 * `ad_id`) thường không có.
 */
export async function hasErpAdAttribution(db: Db, now: Date): Promise<boolean> {
  const since = vnStartOfDay(shiftDay(vnDay(now), -OWN_AD_IMPORT.lookbackDays));
  const o = schema.orders;
  const rows = await db
    .select({ id: o.id })
    .from(o)
    .where(and(isNotNull(o.adId), sql`btrim(${o.adId}) ~ '^[0-9]{5,}$'`, sql`${o.insertedAt} >= ${since.toISOString()}::timestamptz`))
    .limit(1);
  return rows.length > 0;
}

/** Chia an toàn: mẫu số 0 hoặc tử số CHƯA BIẾT ⇒ `null`. */
function ratio(a: number | null, b: number | null, scale = 1, digits = 0): number | null {
  if (a === null || b === null || b <= 0) return null;
  const f = 10 ** digits;
  return Math.round(((a * scale) / b) * f) / f;
}

/**
 * Mẩu QC của shop làm nguồn `OWN_AD` — hai nhánh (`decideOwnAdMode`):
 *
 *  · `CLASSIFY` (mặc định, tổ chức có đơn quy về `ad_id`): có dòng chi hạt `AD` trong `lookbackDays` ngày, tin nhắn
 *    cả đời ≥ `minMessages`, và THẮNG (đơn chốt > `winOrdersAbove`) hoặc TỐT (chi/tin < 4.000đ, chi ≥ 50.000đ).
 *    Xếp: THẮNG trước, rồi nhiều đơn hơn, rồi chi/tin rẻ hơn. Đúng luật cũ — thứ hạng tương đối chỉ đi kèm để đọc.
 *  · `RANK` (tổ chức không có đơn quy về `ad_id`): MỌI mẩu có chi trong kỳ, xếp theo `rankOwnAds` trong chính nhóm
 *    ấy. Không ngưỡng tiền; mẩu chưa đủ dữ liệu vẫn hiện, mang nhãn, đứng cuối.
 *
 * `adIds` ⇒ chỉ trả các mẩu ấy (lượt nhập kiểm lại ở máy chủ). Ở nhánh `RANK` thứ hạng vẫn tính trên CẢ NHÓM rồi mới
 * lọc — xếp hạng riêng ba mẩu được chọn là ra ba điểm khác với điểm người xem vừa thấy.
 */
export async function listOwnAdCandidates(db: Db, opts: { now: Date; winOrdersAbove: number; adIds?: string[]; limit?: number; mode?: OwnAdMode }): Promise<OwnAdCandidateList> {
  const mode: OwnAdMode = opts.mode ?? "CLASSIFY";
  const since = shiftDay(vnDay(opts.now), -OWN_AD_IMPORT.lookbackDays);
  const ads = schema.adSpends;
  const conds: SQL[] = [eq(ads.grain, "AD"), eq(ads.excluded, false), isNotNull(ads.adId), sql`${ads.adId} <> ''`];
  if (opts.adIds) {
    if (opts.adIds.length === 0) return { rows: [], scanned: 0, since, mode, ranking: EMPTY_RANKING };
    if (mode === "CLASSIFY") conds.push(inArray(ads.adId, opts.adIds));
  }
  const sinceAt = vnStartOfDay(since).toISOString();
  const having =
    mode === "CLASSIFY"
      ? sql`max(${ads.spendDate}) >= ${sinceAt}::timestamptz and coalesce(sum(${AD_MESSAGES}), 0) >= ${OWN_AD_IMPORT.minMessages}`
      : sql`max(${ads.spendDate}) >= ${sinceAt}::timestamptz and coalesce(sum(${ads.spend}), 0) > 0`;
  // Sàng trước bằng CÙNG định nghĩa tin nhắn mà variantMetrics dùng để chấm ở dưới (AD_MESSAGES):
  // sàng bằng cột trần thì mẩu 0 hội thoại mà đủ lead bị loại trước khi được chấm.
  const pool = await db
    .select({
      adId: sql<string>`${ads.adId}`,
      // Tên MỚI NHẤT của mẩu (người ta đổi tên mẩu giữa chừng), không phải tên lớn nhất theo bảng chữ.
      adName: sql<string>`(array_agg(${ads.adName} order by ${ads.spendDate} desc))[1]`,
      accountId: sql<string | null>`(array_agg(${ads.accountId} order by ${ads.spendDate} desc))[1]`,
      campaignName: sql<string>`(array_agg(${ads.campaign} order by ${ads.spendDate} desc))[1]`,
      periodFrom: sql<string>`to_char(min(${ads.spendDate}) at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`,
      periodTo: sql<string>`to_char(max(${ads.spendDate}) at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`,
      // Lượt mua THEO META của dòng đồng bộ hạt AD — cả đời mẩu, cùng phạm vi với số đo variantMetrics (startAt: null).
      metaPurchases: sql<number>`coalesce(sum(${ads.orders}), 0)::int`,
    })
    .from(ads)
    .where(and(...conds))
    .groupBy(ads.adId)
    .having(having);

  if (pool.length === 0) return { rows: [], scanned: 0, since, mode, ranking: EMPTY_RANKING };
  const ids = pool.map((r) => String(r.adId));
  const metrics = await variantMetrics(
    db,
    ids.map((id) => ({ id, fbAdId: id, startAt: null })),
  );
  const ranking = rankOwnAds(
    pool.map((r) => {
      const m = metrics.get(String(r.adId));
      return { id: String(r.adId), spendVnd: m?.spendVnd ?? null, messages: m?.messages ?? null, metaPurchases: Number(r.metaPurchases ?? 0) };
    }),
  );
  const wanted = opts.adIds ? new Set(opts.adIds) : null;
  const shown = wanted ? pool.filter((r) => wanted.has(String(r.adId))) : pool;
  const shownIds = shown.map((r) => String(r.adId));
  const imported = shownIds.length
    ? await db
        .select({ fbAdId: schema.creativeSources.fbAdId, id: schema.creativeSources.id })
        .from(schema.creativeSources)
        .where(inArray(schema.creativeSources.fbAdId, shownIds))
    : [];
  const importedOf = new Map(imported.map((r) => [String(r.fbAdId), r.id]));

  const rows: OwnAdCandidate[] = [];
  for (const r of shown) {
    const adId = String(r.adId);
    const m = metrics.get(adId);
    const rank = ranking.byId.get(adId);
    if (!m || !rank) continue;
    const reason = classifyOwnAd(m, opts.winOrdersAbove);
    if (mode === "CLASSIFY" && !reason) continue;
    rows.push({
      adId,
      adName: r.adName ?? "",
      accountId: r.accountId ? String(r.accountId).replace(/^act_/, "") : null,
      campaignName: r.campaignName ?? "",
      reason: mode === "CLASSIFY" ? reason : null,
      rank,
      metaPurchases: rank.values.metaPurchases,
      costPerMetaPurchaseVnd: rank.values.costPerMetaPurchaseVnd,
      inferredProduct: null,
      spendVnd: m.spendVnd,
      messages: m.messages,
      impressions: m.impressions,
      clicks: m.clicks,
      costPerMessageVnd: ratio(m.spendVnd, m.messages),
      ctrPct: ratio(m.clicks, m.impressions, 100, 2),
      cpcVnd: ratio(m.spendVnd, m.clicks),
      bookedOrders: m.bookedOrders,
      deliveredOrders: m.deliveredOrders,
      returnedOrders: m.returnedOrders,
      periodFrom: r.periodFrom ?? null,
      periodTo: r.periodTo ?? null,
      importedSourceId: importedOf.get(adId) ?? null,
    });
  }
  if (mode === "CLASSIFY") {
    const cpm = (x: OwnAdCandidate) => x.costPerMessageVnd ?? Number.POSITIVE_INFINITY;
    rows.sort((a, b) => (a.reason === b.reason ? 0 : a.reason === "WIN" ? -1 : 1) || b.bookedOrders - a.bookedOrders || cpm(a) - cpm(b) || a.adId.localeCompare(b.adId));
  } else {
    const pos = new Map(ranking.order.map((id, i) => [id, i]));
    rows.sort((a, b) => (pos.get(a.adId) ?? 0) - (pos.get(b.adId) ?? 0));
  }
  const out = rows.slice(0, Math.max(1, opts.limit ?? 200));

  // Mã hàng suy được cho từng dòng hiện ra — để người nhập biết dòng nào PHẢI tự chọn mã (máy không đoán).
  const products = out.length ? await inferOwnAdProducts(db, out.map((x) => x.adId)) : new Map<string, { productId: string; basis: "ORDERS" | "AD_SPENDS" }>();
  if (products.size) {
    const names = await db
      .select({ id: schema.products.id, name: schema.products.name })
      .from(schema.products)
      .where(inArray(schema.products.id, [...new Set([...products.values()].map((p) => p.productId))]));
    const nameOf = new Map(names.map((p) => [p.id, p.name]));
    for (const x of out) {
      const p = products.get(x.adId);
      if (p) x.inferredProduct = { productId: p.productId, name: nameOf.get(p.productId) ?? p.productId, basis: p.basis };
    }
  }
  const { metricsUsed, metricsSkipped, ranked, insufficient, minEvents } = ranking;
  return { rows: out, scanned: pool.length, since, mode, ranking: { metricsUsed, metricsSkipped, ranked, insufficient, minEvents } };
}

/**
 * Số đo của một ứng viên theo đúng hình dạng lưu vào `creative_sources.metrics`. Thứ hạng chỉ chụp ở nhánh `RANK`:
 * nhánh `CLASSIFY` kiểm lại trên ĐÚNG các mẩu được chọn, nên thứ hạng ở đó không phải thứ hạng của cả nhóm và không
 * được lưu như thể là.
 */
export function ownAdMetricsOf(c: OwnAdCandidate, productBasis: OwnAdMetrics["productBasis"], measuredAt: Date, mode: OwnAdMode = "CLASSIFY", rankedOf: number | null = null): OwnAdMetrics {
  const ranked = mode === "RANK";
  return {
    selectionMode: mode,
    metaPurchases: c.metaPurchases,
    costPerMetaPurchaseVnd: c.costPerMetaPurchaseVnd,
    rankScore: ranked ? c.rank.score : null,
    rankPosition: ranked ? c.rank.rank : null,
    rankedOf: ranked ? rankedOf : null,
    rankStatus: ranked ? c.rank.status : null,
    reason: c.reason,
    spendVnd: c.spendVnd,
    messages: c.messages,
    costPerMessageVnd: c.costPerMessageVnd,
    impressions: c.impressions,
    clicks: c.clicks,
    ctrPct: c.ctrPct,
    cpcVnd: c.cpcVnd,
    bookedOrders: c.bookedOrders,
    deliveredOrders: c.deliveredOrders,
    returnedOrders: c.returnedOrders,
    periodFrom: c.periodFrom,
    periodTo: c.periodTo,
    measuredAt: measuredAt.toISOString(),
    productBasis,
  };
}

/**
 * Mã hàng của từng mẩu: mã chiếm NHIỀU DÒNG ĐƠN nhất trong các đơn mang `ad_id` ấy (bỏ dòng quà
 * tặng — quà không phải thứ quảng cáo bán). Không có đơn ⇒ mã hay gặp nhất trong `ad_spends.product_id`
 * của mẩu (ghép từ tên chiến dịch). Không có nữa ⇒ vắng khỏi kết quả — nơi gọi phải NÓI RA, không đoán.
 * Hoà số dòng ⇒ id nhỏ hơn, để chạy lại ra cùng kết quả.
 */
export async function inferOwnAdProducts(db: Db, adIds: string[]): Promise<Map<string, { productId: string; basis: "ORDERS" | "AD_SPENDS" }>> {
  const out = new Map<string, { productId: string; basis: "ORDERS" | "AD_SPENDS" }>();
  if (adIds.length === 0) return out;
  const o = schema.orders;
  const oi = schema.orderItems;
  const p = schema.products;
  const pick = (rows: { adId: string; productId: string | null; n: number }[], basis: "ORDERS" | "AD_SPENDS") => {
    const best = new Map<string, { productId: string; n: number }>();
    for (const r of rows) {
      if (!r.productId) continue;
      const cur = best.get(r.adId);
      const n = Number(r.n);
      if (!cur || n > cur.n || (n === cur.n && r.productId < cur.productId)) best.set(r.adId, { productId: r.productId, n });
    }
    for (const [adId, b] of best) if (!out.has(adId)) out.set(adId, { productId: b.productId, basis });
  };

  const fromOrders = await db
    .select({ adId: sql<string>`${o.adId}`, productId: oi.productId, n: sql<number>`count(*)::int` })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .innerJoin(p, eq(p.id, oi.productId))
    .where(and(inArray(o.adId, adIds), eq(oi.isBonus, false)))
    .groupBy(o.adId, oi.productId);
  pick(fromOrders, "ORDERS");

  const rest = adIds.filter((id) => !out.has(id));
  if (rest.length) {
    const ads = schema.adSpends;
    const fromSpend = await db
      .select({ adId: sql<string>`${ads.adId}`, productId: ads.productId, n: sql<number>`count(*)::int` })
      .from(ads)
      .innerJoin(p, eq(p.id, ads.productId))
      .where(and(eq(ads.grain, "AD"), inArray(ads.adId, rest), isNotNull(ads.productId)))
      .groupBy(ads.adId, ads.productId);
    pick(fromSpend, "AD_SPENDS");
  }
  return out;
}
