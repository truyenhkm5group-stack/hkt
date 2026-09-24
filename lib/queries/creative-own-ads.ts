import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { OWN_AD_IMPORT, classifyOwnAd, type OwnAdMetrics, type OwnAdReason } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
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
  reason: OwnAdReason;
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
  /** Số mẩu có chi trong kỳ và đủ tin nhắn — tức số đã được xét, kể cả mẩu không đạt. */
  scanned: number;
  /** Ngày VN đầu của cửa sổ xét. */
  since: string;
};

/** Chia an toàn: mẫu số 0 hoặc tử số CHƯA BIẾT ⇒ `null`. */
function ratio(a: number | null, b: number | null, scale = 1, digits = 0): number | null {
  if (a === null || b === null || b <= 0) return null;
  const f = 10 ** digits;
  return Math.round(((a * scale) / b) * f) / f;
}

/**
 * Mẩu QC của shop đủ điều kiện làm nguồn `OWN_AD`: có dòng chi hạt `AD` trong `lookbackDays` ngày, tin
 * nhắn cả đời ≥ `minMessages`, và THẮNG (đơn chốt > `winOrdersAbove`) hoặc TỐT (chi/tin < 4.000đ, chi
 * ≥ 50.000đ). `adIds` ⇒ chỉ xét các mẩu ấy (lượt nhập kiểm lại ở máy chủ).
 *
 * Xếp: THẮNG trước, rồi nhiều đơn hơn, rồi chi/tin rẻ hơn.
 */
export async function listOwnAdCandidates(db: Db, opts: { now: Date; winOrdersAbove: number; adIds?: string[]; limit?: number }): Promise<OwnAdCandidateList> {
  const since = shiftDay(vnDay(opts.now), -OWN_AD_IMPORT.lookbackDays);
  const ads = schema.adSpends;
  const conds: SQL[] = [eq(ads.grain, "AD"), eq(ads.excluded, false), isNotNull(ads.adId), sql`${ads.adId} <> ''`];
  if (opts.adIds) {
    if (opts.adIds.length === 0) return { rows: [], scanned: 0, since };
    conds.push(inArray(ads.adId, opts.adIds));
  }
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
    })
    .from(ads)
    .where(and(...conds))
    .groupBy(ads.adId)
    .having(sql`max(${ads.spendDate}) >= ${vnStartOfDay(since).toISOString()}::timestamptz and coalesce(sum(${AD_MESSAGES}), 0) >= ${OWN_AD_IMPORT.minMessages}`);

  if (pool.length === 0) return { rows: [], scanned: 0, since };
  const ids = pool.map((r) => String(r.adId));
  const metrics = await variantMetrics(
    db,
    ids.map((id) => ({ id, fbAdId: id, startAt: null })),
  );
  const imported = await db
    .select({ fbAdId: schema.creativeSources.fbAdId, id: schema.creativeSources.id })
    .from(schema.creativeSources)
    .where(inArray(schema.creativeSources.fbAdId, ids));
  const importedOf = new Map(imported.map((r) => [String(r.fbAdId), r.id]));

  const rows: OwnAdCandidate[] = [];
  for (const r of pool) {
    const adId = String(r.adId);
    const m = metrics.get(adId);
    if (!m) continue;
    const reason = classifyOwnAd(m, opts.winOrdersAbove);
    if (!reason) continue;
    rows.push({
      adId,
      adName: r.adName ?? "",
      accountId: r.accountId ? String(r.accountId).replace(/^act_/, "") : null,
      campaignName: r.campaignName ?? "",
      reason,
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
  const cpm = (x: OwnAdCandidate) => x.costPerMessageVnd ?? Number.POSITIVE_INFINITY;
  rows.sort((a, b) => (a.reason === b.reason ? 0 : a.reason === "WIN" ? -1 : 1) || b.bookedOrders - a.bookedOrders || cpm(a) - cpm(b) || a.adId.localeCompare(b.adId));
  return { rows: rows.slice(0, Math.max(1, opts.limit ?? 200)), scanned: pool.length, since };
}

/** Số đo của một ứng viên theo đúng hình dạng lưu vào `creative_sources.metrics`. */
export function ownAdMetricsOf(c: OwnAdCandidate, productBasis: OwnAdMetrics["productBasis"], measuredAt: Date): OwnAdMetrics {
  return {
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
