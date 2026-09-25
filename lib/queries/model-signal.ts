import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { classifyProduct, type ProductVerdict } from "@/lib/constants/product-verdict";
import { DESIGN_STATUSES, type DesignStatus } from "@/lib/constants/creative-loop";
import { loadSource, type Loaded } from "@/lib/constants/model-360";
import { isModelState, type ModelState } from "@/lib/constants/model-lifecycle";
import { deriveModelSignal, MODEL_SIGNAL_LABEL, SIGNAL_SOURCE_LABEL, type ModelSignalInputs, type ModelSignalResult, type SignalAdsInput, type SignalSource } from "@/lib/constants/model-signal";
import { TOPIC_OPEN_STATUSES } from "@/lib/constants/production-os";
import { getAdsDecision, type AdsDecisionRow } from "@/lib/queries/ads-decision";
import { getInventoryDecisionReport, type InventoryDecisionRow } from "@/lib/queries/inventory-decision";
import { creativeVerdictCountsByProduct, getModelAdsSummary, getModelCreativeSummary, spendMappedProductIds, summarizeModelAds, type ModelAdsSummary } from "@/lib/queries/model-ads";
import { getModelInventoryDecisions, pickModelInventoryRows, type ModelInventoryDecisions } from "@/lib/queries/model-360";
import { getModel } from "@/lib/queries/models";
import { adSpendByProduct, getProductIntelligence, type ProductIntelRow } from "@/lib/queries/product-intelligence";
import { resolvePeriod, type Period } from "@/lib/search-params";

/**
 * ═══════════ TÍN HIỆU MẪU — ĐỌC NGUỒN RỒI GỘP (Company OS · A2 · hợp đồng chung §6) ═══════════
 *
 * `getModelSignal(modelId, range?)` gom NHÃN mà các bộ máy đã phán cho mẫu, rồi đưa qua bảng gộp thuần
 * `deriveModelSignal` (lib/constants/model-signal.ts). Không nguồn nào bị tính lại ở đây:
 *
 *  · quảng cáo  — `getModelAdsSummary` (B) → hành động `decideAction` chiều mã hàng;
 *  · mẫu mã     — `getProductIntelligence` + `adSpendByProduct` → `classifyProduct`, dựng ĐÚNG như
 *                 /products/performance (cùng hàm, cùng tham số từng ô);
 *  · creative   — `getModelCreativeSummary` (B) → phán quyết đã chụp;
 *  · thiết kế   — `design_concepts.status` qua `getModel` (A);
 *  · tồn kho    — `getInventoryDecisionReport` → dòng của mã (bối cảnh, không bỏ phiếu).
 *
 * Nguồn nào NÉM LỖI thì lá phiếu của nó thành "chưa đủ" kèm câu "Không đọc được nguồn" — tín hiệu vẫn
 * ra, và không bao giờ là THẮNG khi thiếu một nguồn thị trường.
 *
 * `range` mặc định 30 ngày (cùng mặc định của trang 360). Mọi nguồn có đệm với khoá chứa kỳ.
 *
 * ─── HAI ĐƯỜNG ĐỌC, MỘT PHÉP GỘP (Agent S) ───
 *
 * `getModelSignal` đọc nguồn cho MỘT mẫu; `getModelSignalsBatch` đọc MỖI nguồn ĐÚNG MỘT LẦN cho cả shop
 * rồi cắt theo mã hàng. Hai đường chỉ khác nhau ở CÁCH ĐỌC; phần đổi dòng nguồn thành đầu vào
 * (`adsSignalInput`, `productSourceInput`, `inventoryKindsOf`, `finishReport`) và phép gộp
 * `deriveModelSignal` là CÙNG hàm. `tests/company-os-signal-batch.test.ts` so hai đường trên từng mẫu.
 */

export type ModelSignalReport = ModelSignalResult & {
  modelId: string;
  periodLabel: string;
  /** Câu tóm tắt ngắn cho đề xuất / tiêu đề — chỉ nhãn, không số. */
  summary: string;
};

function designStatusOf(s: string | null | undefined): DesignStatus | null {
  return s && (DESIGN_STATUSES as readonly string[]).includes(s) ? (s as DesignStatus) : null;
}

// ─────────────────────── ĐỔI DÒNG NGUỒN THÀNH ĐẦU VÀO (dùng chung hai đường) ───────────────────────

/** Tóm tắt quảng cáo của mã (B) ⇒ đầu vào lá phiếu quảng cáo. */
export function adsSignalInput(a: ModelAdsSummary): SignalAdsInput {
  return a.status === "NO_ROW" || !a.decision ? { kind: "NO_ROW" } : { kind: a.status === "OK" ? "OK" : "SPEND_UNMAPPED", action: a.decision.action, reason: a.decision.reason };
}

/** Dòng hiệu quả mẫu mã ⇒ nhãn `classifyProduct` — ĐÚNG cách /products/performance dựng đầu vào, không ô nào khác. */
export function productVerdictsOf(rows: readonly ProductIntelRow[], adSpend: ReadonlyMap<string, number>): ProductVerdict[] {
  return rows.map(
    (row): ProductVerdict =>
      classifyProduct({
        deliveredQty: row.deliveredQty,
        successRate: row.successRate,
        returnRate: row.returnRate,
        deliveredRevenue: row.deliveredRevenue,
        contribution: row.contribution,
        adSpend: row.productId ? (adSpend.get(row.productId) ?? null) : null,
        daysOfCover: row.daysOfCover,
        available: row.available,
      }).verdict,
  );
}

/**
 * Nguồn mẫu mã cần HAI hàm (hiệu quả mẫu mã + chi theo mã): hỏng một là không đọc được — câu lỗi của
 * hàm hỏng trước. `rowsOfProduct` chỉ được gọi khi cả hai đọc được.
 */
export function productSourceInput(
  intel: Loaded<unknown>,
  spend: Loaded<ReadonlyMap<string, number>>,
  rowsOfProduct: () => readonly ProductIntelRow[],
): { ok: true; verdicts: ProductVerdict[] } | { ok: false; unavailable: string } {
  if (intel.ok && spend.ok) return { ok: true, verdicts: productVerdictsOf(rowsOfProduct(), spend.data) };
  const bad = !intel.ok ? intel : !spend.ok ? spend : null;
  return { ok: false, unavailable: bad && !bad.ok ? `Không đọc được nguồn ${bad.source}: ${bad.error}` : "Không đọc được nguồn hiệu quả mẫu mã" };
}

/** Dòng quyết định tồn của mã ⇒ các kết luận (bối cảnh, không bỏ phiếu). */
export function inventoryKindsOf(inv: ModelInventoryDecisions): NonNullable<ModelSignalInputs["inventory"]> {
  return inv.rows.map((r) => r.decision);
}

/** Số dòng mẫu mã tối đa đọc cho MỘT mã — cùng trần ở cả hai đường (đường một mẫu truyền nó làm `limit`). */
export const SIGNAL_VARIANT_LIMIT = 500;

/** `limit` của lượt đọc cả shop: không cắt (mỗi mã tự cắt ở `SIGNAL_VARIANT_LIMIT`). */
const SHOP_WIDE_LIMIT = 2_147_483_647;

function finishReport(result: ModelSignalResult, modelId: string, range: Period): ModelSignalReport {
  const summary = result.reasons
    .filter((r) => r.source === "ADS" || r.source === "PRODUCT")
    .map((r) => `${SIGNAL_SOURCE_LABEL[r.source]}: ${r.verdict}`)
    .join(" · ");
  return { ...result, modelId, periodLabel: range.label, summary: summary || MODEL_SIGNAL_LABEL[result.signal] };
}

// ─────────────────────────── ĐƯỜNG MỘT MẪU ───────────────────────────

export async function getModelSignal(modelId: string, range: Period = resolvePeriod({}, "30d")): Promise<ModelSignalReport | null> {
  const model = await getModel(modelId);
  if (!model) return null;
  const pid = model.product?.id ?? null;
  const unavailable: Partial<Record<SignalSource, string>> = {};

  const inputs: ModelSignalInputs = {
    ads: null,
    productVerdicts: null,
    creative: null,
    design: designStatusOf(model.design?.status),
    inventory: null,
    declaredState: model.state,
    unavailable,
  };

  if (pid) {
    const [ads, intel, spend, creative, inv] = await Promise.all([
      loadSource("quảng cáo", () => getModelAdsSummary(pid, range)),
      loadSource("hiệu quả mẫu mã", () => getProductIntelligence({ period: range, productId: pid, limit: SIGNAL_VARIANT_LIMIT })),
      loadSource("chi quảng cáo theo mã", () => adSpendByProduct(range)),
      loadSource("creative", () => getModelCreativeSummary(pid)),
      loadSource("quyết định tồn", () => getModelInventoryDecisions(pid)),
    ]);

    if (ads.ok) inputs.ads = adsSignalInput(ads.data);
    else unavailable.ADS = `Không đọc được nguồn ${ads.source}: ${ads.error}`;

    const product = productSourceInput(intel, spend, () => (intel.ok ? intel.data : []));
    if (product.ok) inputs.productVerdicts = product.verdicts;
    else unavailable.PRODUCT = product.unavailable;

    if (creative.ok) inputs.creative = { total: creative.data.total, byVerdict: creative.data.byVerdict };
    else unavailable.CREATIVE = `Không đọc được nguồn ${creative.source}: ${creative.error}`;

    if (inv.ok) inputs.inventory = inventoryKindsOf(inv.data);
    else unavailable.INVENTORY = `Không đọc được nguồn ${inv.source}: ${inv.error}`;
  }

  return finishReport(deriveModelSignal(inputs), modelId, range);
}

// ─────────────────────────── ĐƯỜNG THEO LÔ (Agent S) ───────────────────────────

export type ModelSignalBatchRow = {
  model: { id: string; code: string; name: string; state: ModelState | null; productId: string | null };
  signal: ModelSignalReport;
  /**
   * Topic sản xuất ĐANG MỞ của mẫu (`TOPIC_OPEN_STATUSES` — cùng tập `getModelProductionSummary` đếm).
   * `null` = không đọc được nguồn sản xuất (câu lỗi ở `topicsError`), KHÔNG phải 0.
   */
  openProductionTopics: number | null;
};

export type ModelSignalBatch = {
  rows: ModelSignalBatchRow[];
  periodLabel: string;
  /** Nguồn sản xuất không đọc được ⇒ câu lỗi; mọi `openProductionTopics` là `null`. */
  topicsError: string | null;
};

/**
 * Tín hiệu của MỌI mẫu trong sổ một lượt. Mỗi nguồn đọc ĐÚNG MỘT LẦN cho cả shop:
 *
 *  · quảng cáo — `getAdsDecision(range, "product")` + `spendMappedProductIds` ⇒ `summarizeModelAds` từng mã
 *    (đúng thứ `getModelAdsSummary` làm cho một mã);
 *  · mẫu mã    — `getProductIntelligence({ splitByProduct })` cả shop + `adSpendByProduct` ⇒ cắt theo mã,
 *    tối đa `SIGNAL_VARIANT_LIMIT` dòng mỗi mã theo đúng thứ tự của truy vấn;
 *  · creative  — `creativeVerdictCountsByProduct` (cùng luật ô đếm `verdictBucket`);
 *  · thiết kế  — `design_concepts.status` qua cùng phép nối của `getModel`;
 *  · tồn kho   — `getInventoryDecisionReport` ⇒ `pickModelInventoryRows` từng mã;
 *  · sản xuất  — `production_topics` đang mở (chỉ để NƠI DÙNG lọc — KHÔNG bỏ phiếu).
 *
 * Rồi đưa từng mẫu qua CÙNG `deriveModelSignal`. Không ngưỡng mới, không phép gộp thứ hai. Đệm theo kỳ.
 */
export async function getModelSignalsBatch(range: Period = resolvePeriod({}, "30d")): Promise<ModelSignalBatch> {
  return memo(`modelSignalsBatch:${periodKey(range)}`, 90_000, () => modelSignalsBatchUncached(range));
}

async function modelSignalsBatchUncached(range: Period): Promise<ModelSignalBatch> {
  const db = await getDb();
  const pm = schema.productModels;
  const p = schema.products;
  const dc = schema.designConcepts;
  const t = schema.productionTopics;

  const [models, ads, intel, spend, creative, inv, topics] = await Promise.all([
    db
      .select({ id: pm.id, code: pm.code, name: pm.name, state: pm.lifecycleState, productId: p.id, designStatus: dc.status })
      .from(pm)
      .leftJoin(p, eq(p.id, pm.productId))
      .leftJoin(dc, eq(dc.id, pm.designConceptId))
      .orderBy(pm.code),
    loadSource("quảng cáo", async () => {
      const [decision, mapped] = await Promise.all([getAdsDecision(range, "product"), spendMappedProductIds(db)]);
      return { decision, mapped };
    }),
    loadSource("hiệu quả mẫu mã", () => getProductIntelligence({ period: range, splitByProduct: true, limit: SHOP_WIDE_LIMIT })),
    loadSource("chi quảng cáo theo mã", () => adSpendByProduct(range)),
    loadSource("creative", () => creativeVerdictCountsByProduct(db)),
    loadSource("quyết định tồn", () => getInventoryDecisionReport()),
    loadSource("topic sản xuất", () => db.select({ modelId: t.modelId }).from(t).where(inArray(t.status, [...TOPIC_OPEN_STATUSES]))),
  ]);

  // Cắt nguồn cả shop theo mã hàng — giữ NGUYÊN thứ tự dòng của từng nguồn.
  const adsRowOf = new Map<string, AdsDecisionRow>();
  if (ads.ok) for (const r of ads.data.decision.rows) if (!adsRowOf.has(r.key)) adsRowOf.set(r.key, r);
  const intelOf = new Map<string, ProductIntelRow[]>();
  if (intel.ok) {
    for (const r of intel.data) {
      if (!r.productId) continue;
      const list = intelOf.get(r.productId) ?? [];
      if (list.length < SIGNAL_VARIANT_LIMIT) list.push(r);
      intelOf.set(r.productId, list);
    }
  }
  const invOf = new Map<string, InventoryDecisionRow[]>();
  if (inv.ok) {
    for (const r of inv.data.rows) {
      const list = invOf.get(r.productId) ?? [];
      list.push(r);
      invOf.set(r.productId, list);
    }
  }
  const openOf = new Map<string, number>();
  if (topics.ok) for (const x of topics.data) openOf.set(x.modelId, (openOf.get(x.modelId) ?? 0) + 1);

  const rows: ModelSignalBatchRow[] = models.map((m) => {
    const pid = m.productId ?? null;
    const state = isModelState(m.state) ? m.state : null;
    const unavailable: Partial<Record<SignalSource, string>> = {};
    const inputs: ModelSignalInputs = {
      ads: null,
      productVerdicts: null,
      creative: null,
      design: designStatusOf(m.designStatus),
      inventory: null,
      declaredState: state,
      unavailable,
    };
    if (pid) {
      if (ads.ok) {
        const d = ads.data.decision;
        const summary = summarizeModelAds(pid, adsRowOf.get(pid) ?? null, { spendMapped: ads.data.mapped.has(pid), orderCoveragePct: d.confidence.coveragePct, spendAtAdGrainPct: d.spendDetail.pct });
        inputs.ads = adsSignalInput(summary);
      } else unavailable.ADS = `Không đọc được nguồn ${ads.source}: ${ads.error}`;

      const product = productSourceInput(intel, spend, () => intelOf.get(pid) ?? []);
      if (product.ok) inputs.productVerdicts = product.verdicts;
      else unavailable.PRODUCT = product.unavailable;

      // Mã không có creative nào ⇒ tổng 0 (đúng thứ `modelCreativeSummary` trả) ⇒ "không có nguồn".
      if (creative.ok) inputs.creative = creative.data.get(pid) ?? { total: 0, byVerdict: {} };
      else unavailable.CREATIVE = `Không đọc được nguồn ${creative.source}: ${creative.error}`;

      if (inv.ok) inputs.inventory = inventoryKindsOf(pickModelInventoryRows({ rows: invOf.get(pid) ?? [], dataGate: inv.data.dataGate }, pid));
      else unavailable.INVENTORY = `Không đọc được nguồn ${inv.source}: ${inv.error}`;
    }
    return {
      model: { id: m.id, code: m.code, name: m.name, state, productId: pid },
      signal: finishReport(deriveModelSignal(inputs), m.id, range),
      openProductionTopics: topics.ok ? (openOf.get(m.id) ?? 0) : null,
    };
  });

  return { rows, periodLabel: range.label, topicsError: topics.ok ? null : `Không đọc được nguồn ${topics.source}: ${topics.error}` };
}
