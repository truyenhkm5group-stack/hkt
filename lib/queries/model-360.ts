import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { DecisionBasis } from "@/lib/constants/ads-decision";
import { IDEA_STATUS_LABEL, ideaTitle } from "@/lib/constants/ideas";
import type { InventoryDecisionKind } from "@/lib/constants/inventory-decision";
import type { SuggestionInventoryRow } from "@/lib/constants/model-360";
import { getAdsDecision } from "@/lib/queries/ads-decision";
import { getInventoryDecisionReport, type InventoryDecisionReport } from "@/lib/queries/inventory-decision";
import type { ModelTimelineEntry } from "@/lib/queries/models";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ HÀM ĐỌC CỦA TRANG MODEL 360 (Company OS · A2) ═══════════
 *
 * Không có công thức mới. Mỗi hàm NHẶT phần của MỘT mẫu từ một bộ máy đã có:
 *
 *  · `getModelOrderOutcome` — dòng chiều MÃ HÀNG của bảng quyết định /ads (`getAdsDecision(…, "product")`,
 *    đệm 90 s, khoá có kỳ). Mọi số đơn của dòng ấy đếm theo `ORDER_OUTCOME` (qua `ORDER_OUTCOME_FAST`,
 *    luật 2) và mốc rời kho theo chứng từ ĐVVC (`SHIPMENT_LEFT_WAREHOUSE`, luật 10) — KHÔNG trạng thái
 *    Pancake. Cùng dòng mà `getModelAdsSummary` (B) và `getModelEconomics` (F) đọc, nên ba khối không
 *    thể nói ba số đơn khác nhau.
 *  · `getModelInventoryDecisions` — các dòng của mẫu trong `getInventoryDecisionReport` (đệm 120 s).
 *  · `getModelLinkedIdeas` — ý tưởng marketing đã "Đăng ký thành mẫu" (`marketing_ideas.model_id`).
 */

export type ModelOrderOutcome = {
  productId: string;
  /** `NO_ORDERS` = bảng quyết định KHÔNG có dòng của mã trong kỳ ⇒ không đơn đã chốt nào chứa mã (0 thật). */
  status: "OK" | "NO_ORDERS";
  /** Đơn đã chốt (quần thể `confirmed`), trừ đơn huỷ theo ORDER_OUTCOME. */
  booked: number;
  /** Chưa ngã ngũ và CHƯA rời kho (chứng từ ĐVVC). */
  notShipped: number;
  /** Chưa ngã ngũ và ĐÃ rời kho. */
  inTransit: number;
  delivered: number;
  /** Hoàn — gồm cả RETURNED_BY_RULE (luật 3: luôn gộp là "hoàn"). */
  returned: number;
  /** % giao thành công trên đơn ĐÃ kết thúc. `null` = chưa đơn nào kết thúc (không phải 0%). */
  successRate: number | null;
  deliveredRevenue: number;
  /** Tiền CÓ CHỨNG TỪ đã về của đơn đã giao. */
  cashReceived: number;
  basis: DecisionBasis | null;
  periodLabel: string;
};

export async function getModelOrderOutcome(productId: string, range: Period): Promise<ModelOrderOutcome> {
  const decision = await getAdsDecision(range, "product");
  const r = decision.rows.find((x) => x.key === productId) ?? null;
  if (!r) {
    return { productId, status: "NO_ORDERS", booked: 0, notShipped: 0, inTransit: 0, delivered: 0, returned: 0, successRate: null, deliveredRevenue: 0, cashReceived: 0, basis: null, periodLabel: range.label };
  }
  return {
    productId,
    status: "OK",
    booked: r.bookedOrders,
    notShipped: r.notShippedOrders,
    inTransit: r.inTransitOrders,
    delivered: r.deliveredOrders,
    returned: r.returnedOrders,
    successRate: r.successRate,
    deliveredRevenue: r.deliveredRevenue,
    cashReceived: r.cashReceived,
    basis: r.basis,
    periodLabel: range.label,
  };
}

export type ModelInventoryDecisionRow = SuggestionInventoryRow & { variantId: string; reason: string; confidence: string };

export type ModelInventoryDecisions = {
  rows: ModelInventoryDecisionRow[];
  dataGate: InventoryDecisionReport["dataGate"];
};

/** Hàm thuần: nhặt dòng của MỘT mã khỏi báo cáo quyết định tồn (dòng "Giữ nguyên" không có trong báo cáo). */
export function pickModelInventoryRows(report: Pick<InventoryDecisionReport, "rows" | "dataGate">, productId: string): ModelInventoryDecisions {
  return {
    dataGate: report.dataGate,
    rows: report.rows
      .filter((r) => r.productId === productId)
      .map((r) => ({
        variantId: r.variantId,
        label: r.sku || [r.color, r.size].filter(Boolean).join(" / ") || r.variantId,
        decision: r.decision as InventoryDecisionKind,
        reason: r.reason,
        confidence: r.confidence,
        suggestedQty: r.suggestedQty,
        capitalRequired: r.capitalRequired,
        excessQty: r.excessQty,
        capitalFreeable: r.capitalFreeable,
      })),
  };
}

export async function getModelInventoryDecisions(productId: string): Promise<ModelInventoryDecisions> {
  return pickModelInventoryRows(await getInventoryDecisionReport(), productId);
}

export type ModelLinkedIdea = { id: string; title: string; status: string; statusLabel: string; ideaDate: string; marketerName: string; createdAt: Date };

export async function getModelLinkedIdeas(modelId: string): Promise<ModelLinkedIdea[]> {
  const db = await getDb();
  const i = schema.marketingIdeas;
  const rows = await db
    .select({ id: i.id, content: i.content, status: i.status, ideaDate: i.ideaDate, marketerName: i.marketerName, createdAt: i.createdAt })
    .from(i)
    .where(eq(i.modelId, modelId))
    .orderBy(desc(i.createdAt))
    .limit(50);
  return rows.map((r) => ({ id: r.id, title: ideaTitle(r.content), status: r.status, statusLabel: IDEA_STATUS_LABEL[r.status] ?? r.status, ideaDate: r.ideaDate, marketerName: r.marketerName, createdAt: r.createdAt }));
}

/** Ý tưởng nối với mẫu ⇒ mốc dòng thời gian (PHÉP CHIẾU từ `marketing_ideas`, không chép sang sổ sự kiện). */
export function ideaTimelineEntries(ideas: readonly ModelLinkedIdea[]): ModelTimelineEntry[] {
  return ideas.map((x) => ({
    id: `idea-${x.id}`,
    at: x.createdAt,
    dimension: "DESIGN",
    title: `Ý tưởng: ${x.title}`,
    detail: `${x.marketerName || "—"} · ${x.statusLabel}`,
    source: "Ý tưởng",
    basis: "PROJECTED",
  }));
}
