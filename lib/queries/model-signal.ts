import { classifyProduct, type ProductVerdict } from "@/lib/constants/product-verdict";
import { DESIGN_STATUSES, type DesignStatus } from "@/lib/constants/creative-loop";
import { loadSource } from "@/lib/constants/model-360";
import { deriveModelSignal, MODEL_SIGNAL_LABEL, SIGNAL_SOURCE_LABEL, type ModelSignalInputs, type ModelSignalResult, type SignalSource } from "@/lib/constants/model-signal";
import { getModelAdsSummary, getModelCreativeSummary } from "@/lib/queries/model-ads";
import { getModelInventoryDecisions } from "@/lib/queries/model-360";
import { getModel } from "@/lib/queries/models";
import { adSpendByProduct, getProductIntelligence } from "@/lib/queries/product-intelligence";
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
      loadSource("hiệu quả mẫu mã", () => getProductIntelligence({ period: range, productId: pid, limit: 500 })),
      loadSource("chi quảng cáo theo mã", () => adSpendByProduct(range)),
      loadSource("creative", () => getModelCreativeSummary(pid)),
      loadSource("quyết định tồn", () => getModelInventoryDecisions(pid)),
    ]);

    if (ads.ok) {
      const a = ads.data;
      inputs.ads = a.status === "NO_ROW" || !a.decision ? { kind: "NO_ROW" } : { kind: a.status === "OK" ? "OK" : "SPEND_UNMAPPED", action: a.decision.action, reason: a.decision.reason };
    } else unavailable.ADS = `Không đọc được nguồn ${ads.source}: ${ads.error}`;

    if (intel.ok && spend.ok) {
      const adSpend = spend.data;
      // ĐÚNG cách /products/performance dựng đầu vào — không ô nào khác.
      inputs.productVerdicts = intel.data.map(
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
    } else {
      const bad = !intel.ok ? intel : !spend.ok ? spend : null;
      if (bad && !bad.ok) unavailable.PRODUCT = `Không đọc được nguồn ${bad.source}: ${bad.error}`;
    }

    if (creative.ok) inputs.creative = { total: creative.data.total, byVerdict: creative.data.byVerdict };
    else unavailable.CREATIVE = `Không đọc được nguồn ${creative.source}: ${creative.error}`;

    if (inv.ok) inputs.inventory = inv.data.rows.map((r) => r.decision);
    else unavailable.INVENTORY = `Không đọc được nguồn ${inv.source}: ${inv.error}`;
  }

  const result = deriveModelSignal(inputs);
  const summary = result.reasons
    .filter((r) => r.source === "ADS" || r.source === "PRODUCT")
    .map((r) => `${SIGNAL_SOURCE_LABEL[r.source]}: ${r.verdict}`)
    .join(" · ");
  return { ...result, modelId, periodLabel: range.label, summary: summary || MODEL_SIGNAL_LABEL[result.signal] };
}
