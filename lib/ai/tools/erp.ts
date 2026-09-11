import { z } from "zod";
import { defineTool } from "@/lib/ai/tools/registry";
import { reopenCase, setCareStatus } from "@/lib/care/service";
import { classifyProduct } from "@/lib/constants/product-verdict";
import { getBusinessBrief } from "@/lib/queries/business-brief";
import { getOrderOutcomes } from "@/lib/queries/canonical-outcome";
import { getCashflow } from "@/lib/queries/cashflow";
import { getCustomerDetail } from "@/lib/queries/customers";
import { getOrderTimeline } from "@/lib/queries/entity-timeline";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
import { getOrderDetail } from "@/lib/queries/orders";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { adSpendByProduct, getProductIntelligence } from "@/lib/queries/product-intelligence";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import { searchEntities } from "@/lib/queries/search";
import { getSlowMoving } from "@/lib/queries/slow-moving";
import { resolvePeriod, type PeriodKey } from "@/lib/search-params";

/**
 * ═══════════ TOOL ĐỌC TOÀN ERP — CÙNG HÀM VỚI MÀN HÌNH ═══════════
 *
 * Mỗi tool gọi đúng hàm `lib/queries/*` mà trang tương ứng đang dùng (KPI chính thức, đã memo).
 * Không có phép tính KPI nào ở đây — chỉ chọn trường, cắt bớt, gắn nhãn. Kết quả đơn lấy từ bảng
 * vật chất hoá theo `ORDER_OUTCOME`; AI không bao giờ tự suy "đã giao".
 */

const PERIODS = ["today", "yesterday", "7d", "30d", "month", "last_month", "90d"] as const satisfies readonly PeriodKey[];
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const periodOf = (key: (typeof PERIODS)[number]) => resolvePeriod({ period: key }, "30d");

export const searchCustomerTool = defineTool({
  name: "search_customer",
  label: "Tìm khách / đơn / vận đơn / sản phẩm",
  description: "Tìm trong ERP theo SĐT, tên khách, mã đơn (#123), mã vận đơn hoặc tên sản phẩm. Trả về danh sách khớp kèm id để gọi tool chi tiết (get_customer_history, get_order_context, get_care_case).",
  kind: "read",
  riskClass: "general",
  permission: "customers:view",
  policy: "auto",
  input: z.object({ query: z.string().min(2).max(80) }),
  run: async (_ctx, { query }) => {
    const r = await searchEntities(query, 5);
    return { query: r.query, counts: r.counts, ambiguous: r.ambiguous, hits: r.hits.map((h) => ({ kind: h.kind, id: h.id, title: h.title, subtitle: h.subtitle })) };
  },
});

export const getCustomerHistoryTool = defineTool({
  name: "get_customer_history",
  label: "Lịch sử mua của khách",
  description: "Hồ sơ một khách: số đơn giao thành công / hoàn / huỷ, doanh thu, đơn gần nhất (kèm vận đơn và trạng thái COD), sản phẩm hay mua. customerId lấy từ search_customer.",
  kind: "read",
  riskClass: "general",
  permission: "customers:view",
  policy: "auto",
  input: z.object({ customerId: z.string().min(1) }),
  run: async (_ctx, { customerId }) => {
    const c = await getCustomerDetail(customerId);
    if (!c) return { error: "Không tìm thấy khách" };
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      province: c.province,
      level: c.level,
      tags: c.tags,
      isBlock: c.isBlock,
      stats: { ...c.stats, firstOrderAt: iso(c.stats.firstOrderAt), lastOrderAt: iso(c.stats.lastOrderAt) },
      recentOrders: c.orders.slice(0, 10).map((o) => ({ id: o.id, systemId: o.systemId, at: iso(o.insertedAt), stage: o.stage, status: o.statusName, total: o.totalPriceAfterDiscount, cod: o.moneyToCollect, items: o.itemsCount, shipment: o.shipment ? { id: o.shipment.id, stage: o.shipment.stage, vtpStatus: o.shipment.vtpStatusName, codStatus: o.shipment.codStatus } : null })),
      topProducts: c.topProducts.slice(0, 5).map((p) => ({ name: p.productName, quantity: p.quantity, revenue: p.revenue, orders: p.orders })),
    };
  },
});

export const getOrderContextTool = defineTool({
  name: "get_order_context",
  label: "Bối cảnh một đơn",
  description: "Một đơn: khách, mặt hàng, tiền, mọi LẦN GỬI (một đơn có thể gửi nhiều lần — mỗi lần là một vận đơn riêng với trạng thái ĐVVC và COD riêng), kết quả đơn theo luật chuẩn (đã vật chất hoá), và dòng thời gian gộp Pancake / Viettel Post / bảng kê / hoàn. orderId là id ERP hoặc số #systemId.",
  kind: "read",
  riskClass: "general",
  permission: "orders:read",
  policy: "auto",
  input: z.object({ orderId: z.string().min(1) }),
  run: async (_ctx, { orderId }) => {
    const o = await getOrderDetail(orderId);
    if (!o) return { error: "Không tìm thấy đơn" };
    const [timeline, outcomes] = await Promise.all([getOrderTimeline(o.id), getOrderOutcomes([o.id])]);
    const oc = outcomes.get(o.id);
    return {
      id: o.id,
      systemId: o.systemId,
      insertedAt: iso(o.insertedAt),
      stage: o.stage,
      status: o.statusName,
      source: o.source,
      customer: { name: o.billFullName, phone: o.billPhone, address: o.shipFullAddress || o.shipAddress },
      money: { total: o.totalPriceAfterDiscount, cod: o.moneyToCollect, prepaid: o.prepaid, transfer: o.transferMoney, cash: o.cash },
      items: o.items.map((i) => ({ name: i.productName, variant: i.variationDetail, sku: i.sku, qty: i.quantity, price: i.unitPrice, isBonus: i.isBonus })),
      /** Kết quả đơn theo ORDER_OUTCOME (bảng dẫn xuất). Không có = chưa vật chất hoá, KHÔNG suy đoán. */
      outcome: oc ? oc.outcome : null,
      attempts: o.attempts.map((a) => ({ shipmentId: a.id, attemptNo: a.attemptNo, tracking: a.vtpOrderNumber ?? a.trackingCode, carrierStage: a.stage, carrierStatus: a.vtpStatusName, carrierStatusAt: iso(a.vtpStatusDate), codStatus: a.codStatus, codAmount: a.codAmount, codCollected: a.codCollected, events: a.events.slice(0, 6).map((e) => ({ at: iso(e.occurredAt), status: e.statusName, stage: e.normalizedStage })) })),
      returns: o.returns.length,
      timeline: timeline.slice(0, 20).map((t) => ({ at: iso(t.at), dimension: t.dimension, source: t.source, title: t.title, detail: t.detail, amount: t.amount })),
    };
  },
});

export const getProfitSummaryTool = defineTool({
  name: "get_profit_summary",
  label: "Tóm tắt lợi nhuận kỳ",
  description: "Lợi nhuận một kỳ theo hai góc: SỰ THẬT TÀI CHÍNH (doanh thu đặt / đã giao / hoàn, COD đã thu / đã đối soát / đã về ngân hàng / còn treo, tiền mặt, lợi nhuận thực — null nếu chưa đủ chứng từ) và BÁO CÁO DANH NGHĨA (kỳ vọng theo tỷ lệ giao/hoàn, chi phí QC, vận hành). Đây là số của trang Báo cáo, không tính lại.",
  kind: "read",
  riskClass: "general",
  permission: "reports:nominal",
  policy: "auto",
  input: z.object({ period: z.enum(PERIODS) }),
  run: async (_ctx, { period }) => {
    const p = periodOf(period);
    const [truth, nominal] = await Promise.all([getFinancialTruth(p), getNominalProfitReport(p)]);
    return {
      period: p.label,
      truth: { revenue: truth.revenue, cod: truth.cod, cash: truth.cash, contribution: truth.contribution, estimatedProfit: truth.estimatedProfit, realizedProfit: truth.realizedProfit, realizedBlockedBy: truth.realizedBlockedBy, waterfall: truth.waterfall.slice(0, 12) },
      nominal: nominal.totals,
      unmatchedAdSpend: nominal.unmatchedAdSpend,
    };
  },
});

export const getCashPositionTool = defineTool({
  name: "get_cash_position",
  label: "Vị thế tiền",
  description: "Dòng tiền dự kiến 7 / 14 / 30 ngày (COD sắp về, QC, vận hành, tiền hàng đến hạn), vốn lưu động (COD phải thu, COD quá hạn, tồn kho, sản xuất đã cam kết) và các giới hạn của số liệu. Số của trang Dòng tiền.",
  kind: "read",
  riskClass: "general",
  permission: "reports:cash",
  policy: "auto",
  input: z.object({}),
  run: async () => {
    const c = await getCashflow();
    return { buckets: c.buckets, workingCapital: c.workingCapital, basis: c.basis, limitations: c.limitations };
  },
});

export const getInventoryRisksTool = defineTool({
  name: "get_inventory_risks",
  label: "Rủi ro tồn kho",
  description: "Hàng chậm / dư / chết (giá trị vốn kẹt, top mẫu) và mẫu sắp hết / đã hết theo kế hoạch bổ sung (tồn, tốc độ bán, ngày còn hàng, đề nghị nhập). Tồn chưa có phiếu nhập hiện là chưa biết, không phải 0.",
  kind: "read",
  riskClass: "general",
  permission: "planning:view",
  policy: "auto",
  input: z.object({ limit: z.number().int().min(1).max(30) }),
  run: async (_ctx, { limit }) => {
    const [slow, plan] = await Promise.all([getSlowMoving(), getReplenishmentPlan()]);
    return {
      slowMoving: { totalStockValue: slow.totalStockValue, totalExcessValue: slow.totalExcessValue, byRisk: slow.byRisk, top: slow.rows.filter((r) => r.risk !== "HEALTHY").slice(0, limit).map((r) => ({ product: r.productName, sku: r.sku, color: r.color, size: r.size, available: r.available, daysOfCover: r.daysOfCover, daysSinceLastSale: r.daysSinceLastSale, stockValue: r.stockValue, risk: r.risk, reason: r.reason })) },
      replenishment: { assumptions: plan.used, summary: plan.summary, urgent: plan.rows.filter((r) => r.status === "OUT" || r.status === "CRITICAL").slice(0, limit) },
    };
  },
});

export const getProductPerformanceTool = defineTool({
  name: "get_product_performance",
  label: "Hiệu quả sản phẩm",
  description: "Sản phẩm theo kỳ: số đặt / giao / hoàn, doanh thu đã giao, tỷ lệ giao thành công, tỷ lệ hoàn, biên đóng góp, chi QC và kết luận (thắng / rủi ro / lỗ / chưa đủ dữ liệu) theo đúng luật của trang Hiệu quả sản phẩm.",
  kind: "read",
  riskClass: "general",
  permission: "products:view",
  policy: "auto",
  input: z.object({ period: z.enum(PERIODS), query: z.string().max(80).nullable().describe("Lọc theo tên sản phẩm; null = tất cả"), limit: z.number().int().min(1).max(30) }),
  run: async (_ctx, { period, query, limit }) => {
    const p = periodOf(period);
    const [rows, ads] = await Promise.all([getProductIntelligence({ period: p, q: query ?? undefined, limit }), adSpendByProduct(p)]);
    return {
      period: p.label,
      products: rows.slice(0, limit).map((r) => {
        const v = classifyProduct({ deliveredQty: r.deliveredQty, successRate: r.successRate, returnRate: r.returnRate, deliveredRevenue: r.deliveredRevenue, contribution: r.contribution, adSpend: r.productId ? (ads.get(r.productId) ?? null) : null, daysOfCover: r.daysOfCover, available: r.available });
        return { product: r.productName, sku: r.sku, color: r.color, size: r.size, orderedQty: r.orderedQty, deliveredQty: r.deliveredQty, returnedQty: r.returnedQty, deliveredRevenue: r.deliveredRevenue, successRate: r.successRate, returnRate: r.returnRate, contribution: r.contribution, contributionBlockedBy: r.contributionBlockedBy, adSpend: r.productId ? (ads.get(r.productId) ?? null) : null, available: r.available, daysOfCover: r.daysOfCover, verdict: v.verdict, verdictReason: v.reason };
      }),
    };
  },
});

export const getOwnerBriefTool = defineTool({
  name: "get_owner_brief",
  label: "Tổng quan cho chủ shop",
  description: "Bản tin điều hành theo kỳ: chỉ số chính kèm biến động, việc cần làm ưu tiên, rủi ro, câu tóm tắt theo quy tắc. Đắt (gộp nhiều báo cáo) — gọi một lần cho câu hỏi tổng quan, không gọi lặp.",
  kind: "read",
  riskClass: "general",
  permission: "dashboard:view",
  policy: "auto",
  input: z.object({ period: z.enum(["7d", "30d", "month"]) }),
  run: async (_ctx, { period }) => {
    const b = await getBusinessBrief(periodOf(period));
    return { period: b.period.label, metrics: b.metrics, topActions: b.topActions.slice(0, 8), risks: b.risks.slice(0, 8), summary: b.summary, generatedAt: iso(b.generatedAt) };
  },
});

// ───────────────────────────── TOOL GHI — CHỈ SAU XÁC NHẬN ─────────────────────────────

export const resolveCaseTool = defineTool({
  name: "resolve_case",
  label: "Đóng case care",
  description: "Đóng case care của một kiện (RESOLVED) kèm lý do. KHÔNG đổi trạng thái Viettel Post và không nghĩa là đã giao. Chỉ dùng khi người dùng nói rõ việc đã xong.",
  kind: "write",
  riskClass: "care",
  permission: "shipments:view",
  policy: "confirm",
  input: z.object({ shipmentId: z.string().min(1), note: z.string().min(1).max(500) }),
  summarize: (i) => `Đóng case kiện ${i.shipmentId}: ${i.note}`,
  run: (ctx, i) => setCareStatus(ctx.actor, { shipmentIds: [i.shipmentId], status: "RESOLVED", note: i.note }),
});

export const reopenCaseTool = defineTool({
  name: "reopen_case",
  label: "Mở lại case care",
  description: "Mở lại một case đã đóng (RESOLVED / CANCELLED) kèm lý do; case quay về NEW hoặc ASSIGNED nếu còn người nhận.",
  kind: "write",
  riskClass: "care",
  permission: "shipments:view",
  policy: "confirm",
  input: z.object({ shipmentId: z.string().min(1), note: z.string().min(1).max(500) }),
  summarize: (i) => `Mở lại case kiện ${i.shipmentId}: ${i.note}`,
  run: (ctx, i) => reopenCase(ctx.actor, i),
});

export function registerErpTools() {
  return [searchCustomerTool, getCustomerHistoryTool, getOrderContextTool, getProfitSummaryTool, getCashPositionTool, getInventoryRisksTool, getProductPerformanceTool, getOwnerBriefTool, resolveCaseTool, reopenCaseTool];
}
