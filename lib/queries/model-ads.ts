import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { ADS_ACTION_LABEL, type AdsAction, type DecisionBasis } from "@/lib/constants/ads-decision";
import { CREATIVE_VERDICTS, type CreativeVerdict } from "@/lib/constants/creative-loop";
import { costPerOrderOf } from "@/lib/creative/judge";
import { getAdsDecision } from "@/lib/queries/ads-decision";
import { variantMetrics } from "@/lib/queries/creative-loop";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ QUẢNG CÁO VÀ CREATIVE CỦA MỘT MẪU — HAI HÀM ĐỌC CHO TRANG 360 ═══════════
 *
 * Hợp đồng: `docs/company-os/shared-contracts.md` §6 (Agent B). Tệp này KHÔNG có một công thức nào
 * của riêng nó:
 *
 *  · `getModelAdsSummary` đọc NGUYÊN dòng chiều MÃ HÀNG của bảng quyết định (`getAdsDecision(…,
 *    "product")`) — chi, đơn, CPO, ROAS, lợi nhuận sau QC, hành động và lý do. Không tính lại, không
 *    làm tròn khác, không một ngưỡng nào.
 *  · `getModelCreativeSummary` đếm creative theo phán quyết ĐÃ CHỤP (`creative_verdicts`, dòng mới nhất
 *    của mỗi mẫu) và đo bằng CHÍNH `variantMetrics` của vòng mẫu.
 *
 * ─── CHƯA BIẾT LÀ `null`, KHÔNG PHẢI 0 (AGENTS.md mục 42, 67) ───
 *
 * Hai chỗ trống trông giống nhau nhưng khác hẳn:
 *  1. Mã không có dòng nào trong bảng quyết định của kỳ (không đơn, không chi đã ghép) ⇒ MỌI ô `null`
 *     và `status = "NO_ROW"`. Hàm không kết luận "mẫu này bán 0 đơn" — id sai và mẫu chưa lên kệ
 *     trông y hệt nhau từ chỗ này.
 *  2. Mã CÓ đơn nhưng bảng chi tiêu CHƯA TỪNG ghép chiến dịch nào với mã (`ad_spends.product_id`) ⇒
 *     bảng quyết định vẫn in chi 0 ₫ cho dòng ấy (đó là quy ước của nó — tệp của Agent F). Ở đây chi,
 *     CPO, ROAS và lợi nhuận sau QC là `null` và `status = "SPEND_UNMAPPED"`: "chưa ghép" ≠ "không
 *     tiêu", và in 0 ₫ là tô một mẫu đang đốt tiền thành mẫu lãi. Hành động của bảng quyết định vẫn
 *     được trả nguyên kèm cờ này — người đọc thấy cả hai, không ai sửa hộ ai.
 *
 * ─── ĐỘ PHỦ QUY KẾT ĐI KÈM ───
 *
 * Chiều mã hàng KHÔNG lọc `ad_id`: đơn = mọi đơn đã chốt CHỨA mã, chi = dòng `ad_spends` ghép về mã
 * theo tên chiến dịch (`docs/ads-decision-contract.md` §6). Nên con số đọc như "mẫu này làm ra gì
 * trong kỳ khi đang chạy quảng cáo", không phải "quảng cáo đẻ ra bao nhiêu đơn". Độ phủ quy kết của cả
 * bảng (`confidence`) và phần chi đã ở hạt mẩu (`spendDetail`) được trả nguyên để trang in cạnh số.
 */

export type ModelAdsStatus = "OK" | "NO_ROW" | "SPEND_UNMAPPED";

export type ModelAdsSummary = {
  productId: string;
  status: ModelAdsStatus;
  /** Chi quảng cáo đã ghép về mã trong kỳ. `null` = CHƯA BIẾT (không có dòng, hoặc chưa ghép chiến dịch). */
  spend: number | null;
  /** Đơn đã chốt (không huỷ) chứa mã trong kỳ — theo chiều mã hàng của bảng quyết định. */
  orders: number | null;
  deliveredOrders: number | null;
  /** Chi / đơn chốt — `costPerOrder` của bảng quyết định. */
  cpo: number | null;
  /** ROAS lên đơn và ROAS giao thành công — nguyên của bảng quyết định. */
  bookedRoas: number | null;
  deliveredRoas: number | null;
  /** Lợi nhuận góp SAU quảng cáo (đo được) và bản TẠM TÍNH (ước tính — phải in nhãn). */
  profitAfterAds: number | null;
  projectedProfitAfterAds: number | null;
  decision: {
    action: AdsAction;
    label: string;
    reason: string;
    basis: DecisionBasis;
  } | null;
  attribution: {
    /** Câu khai căn cứ — in nguyên cạnh con số. */
    basis: string;
    /** Độ phủ quy kết đơn → quảng cáo của CẢ bảng quyết định. `null` = chưa đo được. */
    orderCoveragePct: number | null;
    /** Phần chi của kỳ đã ở hạt mẩu (% theo tiền). `null` = kỳ không có đồng chi nào. */
    spendAtAdGrainPct: number | null;
    /** Bảng chi tiêu đã từng ghép ít nhất một chiến dịch với mã này (mọi thời điểm). */
    spendMapped: boolean;
  };
};

const ATTRIBUTION_BASIS =
  "Chiều mã hàng của bảng quyết định: đơn = mọi đơn đã chốt chứa mã (không lọc ad_id); chi = dòng chi quảng cáo ghép về mã theo tên chiến dịch. Không phải số đơn do quảng cáo đẻ ra.";

/** Hàm thuần: dòng bảng quyết định (hoặc không có) + cờ ghép chi ⇒ tóm tắt. Tách ra để kiểm thử không cần CSDL. */
export function summarizeModelAds(
  productId: string,
  row: Awaited<ReturnType<typeof getAdsDecision>>["rows"][number] | null,
  ctx: { spendMapped: boolean; orderCoveragePct: number | null; spendAtAdGrainPct: number | null },
): ModelAdsSummary {
  const attribution = { basis: ATTRIBUTION_BASIS, orderCoveragePct: ctx.orderCoveragePct, spendAtAdGrainPct: ctx.spendAtAdGrainPct, spendMapped: ctx.spendMapped };
  if (!row) {
    return {
      productId,
      status: "NO_ROW",
      spend: null,
      orders: null,
      deliveredOrders: null,
      cpo: null,
      bookedRoas: null,
      deliveredRoas: null,
      profitAfterAds: null,
      projectedProfitAfterAds: null,
      decision: null,
      attribution,
    };
  }
  const spendTrusted = row.spendKnown && ctx.spendMapped;
  return {
    productId,
    status: spendTrusted ? "OK" : "SPEND_UNMAPPED",
    spend: spendTrusted ? row.spend : null,
    orders: row.bookedOrders,
    deliveredOrders: row.deliveredOrders,
    cpo: spendTrusted ? row.costPerOrder : null,
    bookedRoas: spendTrusted ? row.bookedRoas : null,
    deliveredRoas: spendTrusted ? row.deliveredRoas : null,
    profitAfterAds: spendTrusted ? row.profitAfterAds : null,
    projectedProfitAfterAds: spendTrusted ? row.projectedProfitAfterAds : null,
    decision: { action: row.action, label: ADS_ACTION_LABEL[row.action], reason: row.reason, basis: row.basis },
    attribution,
  };
}

/**
 * Bảng chi tiêu đã từng ghép ít nhất một chiến dịch (không bị loại) với mã chưa — MỌI thời điểm. Một nguồn
 * cho mọi màn hình hỏi "chi QC của mã này là 0 thật hay chưa ghép": tóm tắt quảng cáo (ở đây), kinh tế
 * theo mẫu (F) và chứng cứ giai đoạn quan sát (A) cùng đọc hàm này.
 */
export async function spendMappedFor(db: Db, productId: string): Promise<boolean> {
  const ads = schema.adSpends;
  const [r] = await db
    .select({ n: sql<number>`count(*)` })
    .from(ads)
    .where(and(eq(ads.productId, productId), eq(ads.excluded, false)));
  return Number(r?.n ?? 0) > 0;
}

/**
 * CÙNG câu hỏi của `spendMappedFor`, hỏi cho CẢ SHOP một lượt: tập mã hàng đã từng được ghép ít nhất một
 * chiến dịch (không bị loại). Tín hiệu mẫu theo lô (`getModelSignalsBatch`) đọc hàm này thay vì gọi
 * `spendMappedFor` cho từng mẫu — điều kiện y hệt (`excluded = false`, `product_id` khớp).
 */
export async function spendMappedProductIds(db: Db): Promise<Set<string>> {
  const ads = schema.adSpends;
  const rows = await db
    .selectDistinct({ productId: ads.productId })
    .from(ads)
    .where(and(sql`${ads.productId} is not null`, eq(ads.excluded, false)));
  return new Set(rows.map((r) => String(r.productId)));
}

/** Quảng cáo của MỘT mẫu trong kỳ — đọc thẳng dòng chiều mã hàng của `getAdsDecision`. */
export async function getModelAdsSummary(productId: string, range: Period): Promise<ModelAdsSummary> {
  return memo(`modelAds:${productId}:${periodKey(range)}`, 90_000, async () => {
    const db = await getDb();
    const [decision, spendMapped] = await Promise.all([getAdsDecision(range, "product"), spendMappedFor(db, productId)]);
    const row = decision.rows.find((r) => r.key === productId) ?? null;
    return summarizeModelAds(productId, row, { spendMapped, orderCoveragePct: decision.confidence.coveragePct, spendAtAdGrainPct: decision.spendDetail.pct });
  });
}

// ───────────────────────────── CREATIVE CỦA MẪU ─────────────────────────────

/** Mẫu chưa có dòng phán quyết nào (chưa đăng, hoặc lượt chấm chưa chạy tới) — tách khỏi mọi phán quyết. */
export const NO_VERDICT = "NO_VERDICT" as const;

export type ModelCreativeSummary = {
  productId: string;
  /** Số creative (biến thể của vòng mẫu) quảng bá mã này — số ĐẾM THẬT, 0 là 0. */
  total: number;
  /** Theo phán quyết ĐÃ CHỤP gần nhất của mỗi mẫu; `NO_VERDICT` = chưa có dòng nào. */
  byVerdict: Record<CreativeVerdict | typeof NO_VERDICT, number>;
  /** Đơn chốt quy về các mẩu của mã (`variantMetrics`, `ORDER_AD_ID`) — 0 khi chưa mẩu nào đăng. */
  attributedOrders: number;
  ordersViaPost: number;
  /** Chi cấp mẩu cộng lại. `null` = không mẩu nào có số chi (CHƯA BIẾT). */
  spendVnd: number | null;
  /** Số mẩu đã đăng mà chi CHƯA BIẾT — khác 0 thì `cpoVnd` là `null` (tổng cộng thiếu không chia được). */
  spendUnknownVariants: number;
  cpoVnd: number | null;
  latestWinner: { variantId: string; headline: string; libraryAt: string; libraryOrders: number | null; imageId: string | null; href: string } | null;
  links: { library: string; live: string };
};

/** Ô đếm của một phán quyết đã chụp: phán quyết lạ / chưa có dòng nào ⇒ `NO_VERDICT`. Một luật cho cả đường một mẫu lẫn đường theo lô. */
export function verdictBucket(k: string | null | undefined): CreativeVerdict | typeof NO_VERDICT {
  return k && (CREATIVE_VERDICTS as readonly string[]).includes(k) ? (k as CreativeVerdict) : NO_VERDICT;
}

export type CreativeVerdictCounts = Pick<ModelCreativeSummary, "total" | "byVerdict">;

/**
 * Đếm creative theo phán quyết ĐÃ CHỤP cho MỌI mã hàng một lượt — đúng hai ô `total` và `byVerdict` mà
 * `modelCreativeSummary` trả cho từng mã (cùng phép nối lô, cùng "dòng phán quyết mới nhất theo ngày" —
 * `creative_verdicts` có khoá duy nhất (ngày, mẫu) nên "mới nhất" là một dòng xác định). Không đo
 * `variantMetrics`: tín hiệu mẫu chỉ đọc phán quyết. Mã không có creative nào ⇒ không có trong map.
 */
export async function creativeVerdictCountsByProduct(db: Db): Promise<Map<string, CreativeVerdictCounts>> {
  const cv = schema.creativeVariants;
  const cb = schema.creativeBatches;
  const vd = schema.creativeVerdicts;
  const [variants, latest] = await Promise.all([
    db
      .select({ id: cv.id, productId: cv.productId })
      .from(cv)
      .innerJoin(cb, eq(cb.id, cv.batchId))
      .where(sql`${cv.productId} is not null`),
    db
      .selectDistinctOn([vd.variantId], { variantId: vd.variantId, verdict: vd.verdict })
      .from(vd)
      .innerJoin(cv, eq(cv.id, vd.variantId))
      .where(sql`${cv.productId} is not null`)
      .orderBy(vd.variantId, desc(vd.verdictDay)),
  ]);
  const verdictOf = new Map(latest.map((r) => [r.variantId, r.verdict]));
  const out = new Map<string, CreativeVerdictCounts>();
  for (const v of variants) {
    const pid = String(v.productId);
    let c = out.get(pid);
    if (!c) {
      c = { total: 0, byVerdict: Object.fromEntries([...CREATIVE_VERDICTS, NO_VERDICT].map((k) => [k, 0])) as ModelCreativeSummary["byVerdict"] };
      out.set(pid, c);
    }
    c.total += 1;
    c.byVerdict[verdictBucket(verdictOf.get(v.id))] += 1;
  }
  return out;
}

export async function getModelCreativeSummary(productId: string): Promise<ModelCreativeSummary> {
  return memo(`modelCreative:${productId}`, 90_000, async () => modelCreativeSummary(await getDb(), productId));
}

/** Bản không đệm, nhận `db` — dùng cho kiểm thử và cho nơi đã có giao dịch. */
export async function modelCreativeSummary(db: Db, productId: string): Promise<ModelCreativeSummary> {
  const cv = schema.creativeVariants;
  const cb = schema.creativeBatches;
  const byVerdict = Object.fromEntries([...CREATIVE_VERDICTS, NO_VERDICT].map((k) => [k, 0])) as ModelCreativeSummary["byVerdict"];
  const links = {
    library: `/marketing/creatives?tab=thu-vien&mau=${encodeURIComponent(productId)}`,
    live: "/marketing/creatives?tab=dang-chay",
  };
  const variants = await db
    .select({ id: cv.id, fbAdId: cv.fbAdId, headline: cv.headline, libraryAt: cv.libraryAt, libraryOrders: cv.libraryOrders, imageId: cv.imageId, startAt: cb.startAt })
    .from(cv)
    .innerJoin(cb, eq(cb.id, cv.batchId))
    .where(eq(cv.productId, productId))
    .orderBy(desc(cv.createdAt));
  if (variants.length === 0) {
    return { productId, total: 0, byVerdict, attributedOrders: 0, ordersViaPost: 0, spendVnd: null, spendUnknownVariants: 0, cpoVnd: null, latestWinner: null, links };
  }
  const ids = variants.map((v) => v.id);
  const vd = schema.creativeVerdicts;
  const [latest, metrics] = await Promise.all([
    db
      .selectDistinctOn([vd.variantId], { variantId: vd.variantId, verdict: vd.verdict })
      .from(vd)
      .where(inArray(vd.variantId, ids))
      .orderBy(vd.variantId, desc(vd.verdictDay)),
    variantMetrics(
      db,
      variants.map((v) => ({ id: v.id, fbAdId: v.fbAdId, startAt: v.startAt })),
    ),
  ]);
  const verdictOf = new Map(latest.map((r) => [r.variantId, r.verdict]));
  for (const v of variants) byVerdict[verdictBucket(verdictOf.get(v.id))] += 1;
  let attributedOrders = 0;
  let ordersViaPost = 0;
  let spend: number | null = null;
  let spendUnknownVariants = 0;
  for (const v of variants) {
    const m = metrics.get(v.id);
    if (!m) continue;
    attributedOrders += m.bookedOrders;
    ordersViaPost += m.attribution.viaPost.booked;
    if (m.spendVnd === null) {
      if (v.fbAdId) spendUnknownVariants += 1;
    } else spend = (spend ?? 0) + m.spendVnd;
  }
  // CPO của tổng: CHÍNH phép chia của luật (`costPerOrderOf`) trên tổng đã cộng — và chỉ khi không còn
  // mẩu nào chưa biết chi. Cộng thiếu rồi chia là in một chi/đơn thấp hơn thật.
  const cpoVnd =
    spend === null || spendUnknownVariants > 0
      ? null
      : costPerOrderOf({ spendVnd: spend, impressions: null, clicks: null, messages: null, bookedOrders: attributedOrders, deliveredOrders: 0, returnedOrders: 0 });
  const winners = variants.filter((v) => v.libraryAt !== null).sort((a, b) => (b.libraryAt as Date).getTime() - (a.libraryAt as Date).getTime());
  const w = winners[0];
  return {
    productId,
    total: variants.length,
    byVerdict,
    attributedOrders,
    ordersViaPost,
    spendVnd: spend,
    spendUnknownVariants,
    cpoVnd,
    latestWinner: w
      ? { variantId: w.id, headline: w.headline, libraryAt: (w.libraryAt as Date).toISOString(), libraryOrders: w.libraryOrders, imageId: w.imageId, href: links.library }
      : null,
    links,
  };
}
