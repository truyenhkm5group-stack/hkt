import { sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { loadSource } from "@/lib/constants/model-360";
import {
  deriveStockFeedback,
  STOCK_FEEDBACK_ADS_PERIOD,
  type StockFeedbackAds,
  type StockFeedbackInput,
  type StockFeedbackResult,
  type StockFeedbackVariant,
} from "@/lib/constants/stock-feedback";
import { getAdsDecision, type AdsDecisionRow } from "@/lib/queries/ads-decision";
import { getInventoryDecisionReport, type InventoryDecisionReport, type InventoryDecisionRow } from "@/lib/queries/inventory-decision";
import { spendMappedProductIds, summarizeModelAds } from "@/lib/queries/model-ads";
import { resolvePeriod } from "@/lib/search-params";

/**
 * ═══════════ VÒNG PHẢN HỒI TỒN → CREATIVE / QUẢNG CÁO — ĐỌC NGUỒN (Company OS · Agent X) ═══════════
 *
 * Luật: `lib/constants/stock-feedback.ts`. Tệp này chỉ ĐỌC mỗi bộ máy ĐÚNG MỘT LẦN cho cả shop rồi cắt theo
 * mã hàng — không vòng lặp đọc theo từng mẫu:
 *
 *  · tồn kho   — `getInventoryDecisionReport()` (decideInventory, đã trừ hàng đặt xưởng; đệm 120 s);
 *  · quảng cáo — `getAdsDecision(30 ngày, "product")` + `spendMappedProductIds` ⇒ `summarizeModelAds` từng mã
 *    (đúng cách `getModelSignalsBatch` và `getModelAdsSummary` đọc — CHỈ khi người xem được xem quảng cáo);
 *  · creative  — ngày mẫu gần nhất / lần vào thư viện gần nhất theo mã (`creative_variants`);
 *  · mẫu       — `product_models.product_id` ⇒ mẫu của mã (để đề xuất gắn về dòng thời gian mẫu).
 *
 * Tồn đọc hỏng ⇒ NÉM (nơi gọi nêu tên nguồn hỏng). Quảng cáo / creative đọc hỏng ⇒ phần đó CHƯA BIẾT
 * (`null`), đề xuất phụ thuộc quảng cáo không sinh ra, và câu lỗi đi vào `notes`.
 */

export type StockFeedbackShop = {
  /** Đầu vào của từng mã có ít nhất một dòng quyết định tồn (dòng "Giữ nguyên" không có trong báo cáo). */
  inputs: StockFeedbackInput[];
  inventoryGate: InventoryDecisionReport["dataGate"];
  notes: string[];
};

/** Ngày creative gần nhất và lần vào thư viện gần nhất của MỌI mã một lượt. Mã chưa có creative ⇒ không có trong map. */
export async function lastCreativeDatesByProduct(db: Db): Promise<Map<string, { lastCreativeAt: Date | null; lastLibraryAt: Date | null }>> {
  const cv = schema.creativeVariants;
  const rows = await db
    .select({
      productId: cv.productId,
      lastCreativeAt: sql<string | null>`max(${cv.createdAt})`.as("sf_last_creative_at"),
      lastLibraryAt: sql<string | null>`max(${cv.libraryAt})`.as("sf_last_library_at"),
    })
    .from(cv)
    .where(sql`${cv.productId} is not null`)
    .groupBy(cv.productId);
  const out = new Map<string, { lastCreativeAt: Date | null; lastLibraryAt: Date | null }>();
  for (const r of rows) out.set(String(r.productId), { lastCreativeAt: r.lastCreativeAt ? new Date(r.lastCreativeAt) : null, lastLibraryAt: r.lastLibraryAt ? new Date(r.lastLibraryAt) : null });
  return out;
}

/** Dòng quyết định tồn ⇒ mẫu mã của vòng phản hồi. `DATA_INSUFFICIENT` ⇒ tồn CHƯA BIẾT (chưa phiếu nhập hoặc sổ lệch). */
export function toFeedbackVariant(r: InventoryDecisionRow): StockFeedbackVariant {
  return {
    variantId: r.variantId,
    label: r.sku || [r.color, r.size].filter(Boolean).join(" / ") || r.variantId,
    decision: r.decision,
    stockKnown: r.decision !== "DATA_INSUFFICIENT",
    available: r.available,
    velocity: r.velocity,
    sold30: r.sold30,
    daysOfCover: r.daysOfCover,
    leadTimeDays: r.leadTimeDays,
    unitCost: r.unitCost,
    suggestedQty: r.suggestedQty,
    openPoQty: r.openPoQty,
    capitalFreeable: r.capitalFreeable,
    grossImpactEstimate: r.grossImpactEstimate,
    reorderByDate: r.reorderByDate,
  };
}

/**
 * Đọc cả shop một lượt. `adsVisible = false` ⇒ KHÔNG đọc nguồn quảng cáo (không phải đọc rồi giấu).
 * `onlyProductId` chỉ cắt ĐẦU RA (trang 360) — nguồn vẫn là lượt đọc cả shop đã đệm, để hai nơi không thể
 * nói hai điều khác nhau về cùng một mã.
 */
export async function getStockFeedbackShop(opts: { adsVisible: boolean; onlyProductId?: string }): Promise<StockFeedbackShop> {
  const db = await getDb();
  const period = resolvePeriod({ period: STOCK_FEEDBACK_ADS_PERIOD }, STOCK_FEEDBACK_ADS_PERIOD);
  const [inv, ads, creative, models] = await Promise.all([
    getInventoryDecisionReport(),
    opts.adsVisible
      ? loadSource("quảng cáo (bảng quyết định chiều mã hàng)", async () => {
          const [decision, mapped] = await Promise.all([getAdsDecision(period, "product"), spendMappedProductIds(db)]);
          return { decision, mapped };
        })
      : Promise.resolve(null),
    loadSource("creative của mã", () => lastCreativeDatesByProduct(db)),
    db.select({ id: schema.productModels.id, productId: schema.productModels.productId }).from(schema.productModels),
  ]);
  const notes: string[] = [];
  if (ads && !ads.ok) notes.push(`Vòng phản hồi tồn: không đọc được ${ads.source} (${ads.error}) — không đề xuất gì phụ thuộc quảng cáo.`);
  if (!creative.ok) notes.push(`Vòng phản hồi tồn: không đọc được ${creative.source} (${creative.error}) — ngày creative in "—".`);

  const byProduct = new Map<string, InventoryDecisionRow[]>();
  for (const r of inv.rows) {
    if (opts.onlyProductId && r.productId !== opts.onlyProductId) continue;
    const list = byProduct.get(r.productId) ?? [];
    list.push(r);
    byProduct.set(r.productId, list);
  }
  const adsRowOf = new Map<string, AdsDecisionRow>();
  if (ads && ads.ok) for (const r of ads.data.decision.rows) if (!adsRowOf.has(r.key)) adsRowOf.set(r.key, r);
  const modelOf = new Map<string, string>();
  for (const m of models) if (m.productId) modelOf.set(m.productId, m.id);

  const inputs: StockFeedbackInput[] = [];
  for (const [productId, rows] of byProduct) {
    let adsIn: StockFeedbackAds | null = null;
    if (ads && ads.ok) {
      const d = ads.data.decision;
      const s = summarizeModelAds(productId, adsRowOf.get(productId) ?? null, { spendMapped: ads.data.mapped.has(productId), orderCoveragePct: d.confidence.coveragePct, spendAtAdGrainPct: d.spendDetail.pct });
      adsIn = { status: s.status, action: s.decision?.action ?? null, spend: s.spend, reason: s.decision?.reason ?? "" };
    }
    inputs.push({
      productId,
      productCode: rows[0].productCode,
      productName: rows[0].productName,
      modelId: modelOf.get(productId) ?? null,
      variants: rows.map(toFeedbackVariant),
      inventoryGate: inv.dataGate.state,
      adsVisible: opts.adsVisible,
      ads: adsIn,
      creative: creative.ok ? (creative.data.get(productId) ?? { lastCreativeAt: null, lastLibraryAt: null }) : null,
    });
  }
  return { inputs, inventoryGate: inv.dataGate, notes };
}

/** Vòng phản hồi của MỘT mã (trang 360) — cắt từ cùng lượt đọc cả shop. Mã không có dòng quyết định tồn ⇒ rỗng. */
export async function getStockFeedbackForProduct(productId: string, adsVisible: boolean): Promise<StockFeedbackResult & { notes: string[] }> {
  const shop = await getStockFeedbackShop({ adsVisible, onlyProductId: productId });
  const input = shop.inputs.find((i) => i.productId === productId);
  const r = input ? deriveStockFeedback(input) : { recommendations: [], insufficient: [] };
  return { ...r, notes: shop.notes };
}
