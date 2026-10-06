/**
 * ═══════════ BỘ MÁY GIÁ → BẢNG KÊ KỲ — THUẦN (docs/saas/COST_BILLING.md §3) ═══════════
 *
 *   Usage Event → Usage Ledger → Aggregation → PRICING (tệp này) → Billable lines → Invoice / Chargeback
 *
 * Runtime sản phẩm KHÔNG biết giá: nó chỉ ghi dùng (`recordUsage`) và hỏi entitlement. Giá nằm ở gói (`platform_plans`:
 * giá tháng, mua thêm, `commercial.overage.unitPricesVnd`) và chỉ được đọc ở đây.
 *
 * Cùng một hàm cho khách ngoài và khách nội bộ; `billingMode` chỉ quyết định NHÓM DÒNG:
 *  · `EXTERNAL_INVOICE` — gói · mua thêm · vượt hạn mức (cái khách trả);
 *  · `INTERNAL_CHARGEBACK` — như trên (theo giá gói nếu có khai) CỘNG chi phí biến đổi thật (AI nền tảng trả, chi phí phân
 *    bổ, chi phí trực tiếp) — bảng kê nội bộ trả lời "khách nội bộ tiêu bao nhiêu của nền tảng".
 *
 * Dòng không biết số ⇒ `amountVnd = null` + lý do; tổng chỉ cộng dòng biết số và LUÔN đi kèm số dòng chưa biết (luật 42 —
 * không in tổng như thể đủ). Dùng thử là 0 THẬT (miễn phí theo điều khoản), khác chưa biết.
 */
import type { AllocatedLine } from "@/lib/saas/allocation";
import { subscriptionGrantsUse, type BillingMode, type EffectiveSubscriptionStatus } from "@/lib/saas/policy";

/** v2 (0225): giá gói theo PHIÊN BẢN đã ghim + phần vượt theo khối khách AI / fanpage / người dùng thêm (`billedOverage`). */
export const STATEMENT_ENGINE_VERSION = "saas-statement-v2";

export type StatementLineKind = "PLAN" | "PRODUCT_PLAN" | "ADDON" | "OVERAGE" | "AI_COST" | "ALLOCATED_COST" | "DIRECT_COST";

export const STATEMENT_LINE_LABEL: Record<StatementLineKind, string> = {
  PLAN: "Gói workspace",
  PRODUCT_PLAN: "Gói sản phẩm",
  ADDON: "Mua thêm",
  OVERAGE: "Vượt hạn mức",
  AI_COST: "Chi phí AI",
  ALLOCATED_COST: "Chi phí phân bổ",
  DIRECT_COST: "Chi phí trực tiếp",
};

export type StatementLine = {
  kind: StatementLineKind;
  orgCode: string | null;
  productKey: string | null;
  label: string;
  quantity: number | null;
  unitPriceVnd: number | null;
  amountVnd: number | null;
  note: string | null;
};

export type PlanRef = { key: string; name: string; priceVnd: number | null };

export type StatementWorkspace = {
  orgCode: string;
  name: string;
  plan: PlanRef;
  addon: { ok: true; vnd: number } | { ok: false };
  subscriptions: readonly { productKey: string; ownPlan: PlanRef | null; status: EffectiveSubscriptionStatus }[];
  overage: readonly { productKey: string; label: string; included: number; used: number | null; unitPriceVnd: number | null }[];
  /**
   * Phần vượt ĐÃ TÍNH SẴN bằng `lib/pricing/versions.ts::computeOverage` (khối khách AI · fanpage / người dùng thêm) — một
   * phép tính cho hoá đơn khách ngoài, bảng kê nội bộ và màn khách. Hội thoại / tin / đơn không bao giờ có dòng ở đây.
   */
  billedOverage?: readonly { productKey: string | null; label: string; quantity: number | null; unitPriceVnd: number | null; amountVnd: number | null; note: string | null }[];
  /** Chi phí AI nền tảng trả trong kỳ, theo sản phẩm (VND). `vnd = null` = có lượt chưa định giá được hết. */
  aiCost: readonly { productKey: string | null; vnd: number | null; unpricedCalls: number }[];
  allocated: readonly AllocatedLine[];
};

export type Statement = { billingMode: BillingMode; periodMonth: string; lines: StatementLine[]; totalKnownVnd: number; unknownLines: number; revenueKnownVnd: number; costKnownVnd: number; engineVersion: string };

const REVENUE_KINDS: ReadonlySet<StatementLineKind> = new Set(["PLAN", "PRODUCT_PLAN", "ADDON", "OVERAGE"]);

function priceLine(kind: "PLAN" | "PRODUCT_PLAN", ws: StatementWorkspace, productKey: string | null, plan: PlanRef, status: EffectiveSubscriptionStatus, mode: BillingMode): StatementLine {
  const base = { kind, orgCode: ws.orgCode, productKey, label: `${plan.name}${productKey ? "" : " (gói gộp)"}`, quantity: 1, unitPriceVnd: plan.priceVnd };
  if (status === "TRIAL") return { ...base, unitPriceVnd: 0, amountVnd: 0, note: "dùng thử — miễn phí theo điều khoản" };
  if (plan.priceVnd === null)
    return { ...base, amountVnd: null, note: mode === "INTERNAL_CHARGEBACK" ? "gói chưa khai giá nội bộ — bảng kê chỉ tính chi phí biến đổi" : "gói không niêm yết giá (liên hệ / theo hợp đồng)" };
  return { ...base, amountVnd: plan.priceVnd, note: null };
}

export function buildStatement(input: { billingMode: BillingMode; periodMonth: string; workspaces: readonly StatementWorkspace[]; accountCosts?: readonly AllocatedLine[] }): Statement {
  const lines: StatementLine[] = [];
  const mode = input.billingMode;
  for (const ws of input.workspaces) {
    const billable = ws.subscriptions.filter((s) => subscriptionGrantsUse(s.status));
    const onWorkspacePlan = billable.filter((s) => !s.ownPlan);
    if (onWorkspacePlan.length) {
      const status: EffectiveSubscriptionStatus = onWorkspacePlan.every((s) => s.status === "TRIAL") ? "TRIAL" : "ACTIVE";
      lines.push(priceLine("PLAN", ws, null, ws.plan, status, mode));
      if (status !== "TRIAL") {
        if (!ws.addon.ok) lines.push({ kind: "ADDON", orgCode: ws.orgCode, productKey: null, label: "Hạn mức mua thêm", quantity: null, unitPriceVnd: null, amountVnd: null, note: "phần mua thêm không còn giá ở gói" });
        else if (ws.addon.vnd > 0) lines.push({ kind: "ADDON", orgCode: ws.orgCode, productKey: null, label: "Hạn mức mua thêm", quantity: null, unitPriceVnd: null, amountVnd: ws.addon.vnd, note: null });
      }
    }
    for (const s of billable) if (s.ownPlan) lines.push(priceLine("PRODUCT_PLAN", ws, s.productKey, s.ownPlan, s.status, mode));
    for (const o of ws.overage) {
      if (o.used === null) {
        lines.push({ kind: "OVERAGE", orgCode: ws.orgCode, productKey: o.productKey, label: o.label, quantity: null, unitPriceVnd: o.unitPriceVnd, amountVnd: null, note: "chưa đo được số dùng của kỳ" });
        continue;
      }
      const over = o.used - o.included;
      if (over <= 0) continue;
      lines.push({ kind: "OVERAGE", orgCode: ws.orgCode, productKey: o.productKey, label: o.label, quantity: over, unitPriceVnd: o.unitPriceVnd, amountVnd: o.unitPriceVnd === null ? null : over * o.unitPriceVnd, note: o.unitPriceVnd === null ? "vượt hạn mức — gói chưa khai đơn giá vượt" : null });
    }
    // Dùng thử không có phần vượt (miễn phí theo điều khoản) — cùng luật với dòng gói.
    const allTrial = billable.length > 0 && billable.every((s) => s.status === "TRIAL");
    if (!allTrial) for (const o of ws.billedOverage ?? []) if (o.amountVnd !== 0 || o.quantity === null) lines.push({ kind: "OVERAGE", orgCode: ws.orgCode, productKey: o.productKey, label: o.label, quantity: o.quantity, unitPriceVnd: o.unitPriceVnd, amountVnd: o.amountVnd, note: o.note });
    if (mode === "INTERNAL_CHARGEBACK") {
      for (const a of ws.aiCost) {
        if (a.vnd === null && a.unpricedCalls === 0) continue;
        lines.push({ kind: "AI_COST", orgCode: ws.orgCode, productKey: a.productKey, label: "AI do nền tảng trả", quantity: null, unitPriceVnd: null, amountVnd: a.vnd, note: a.unpricedCalls ? `${a.unpricedCalls} lượt chưa định giá được — số là cận dưới` : null });
      }
      for (const c of ws.allocated) lines.push({ kind: c.basis === "DIRECT" ? "DIRECT_COST" : "ALLOCATED_COST", orgCode: ws.orgCode, productKey: c.productKey, label: c.label, quantity: null, unitPriceVnd: null, amountVnd: c.amountVnd, note: c.note });
    }
  }
  if (mode === "INTERNAL_CHARGEBACK")
    for (const c of input.accountCosts ?? []) lines.push({ kind: "DIRECT_COST", orgCode: null, productKey: c.productKey, label: c.label, quantity: null, unitPriceVnd: null, amountVnd: c.amountVnd, note: c.note });

  const known = lines.filter((l) => l.amountVnd !== null);
  const sum = (ls: StatementLine[]) => ls.reduce((a, l) => a + (l.amountVnd ?? 0), 0);
  return {
    billingMode: mode,
    periodMonth: input.periodMonth,
    lines,
    totalKnownVnd: sum(known),
    unknownLines: lines.length - known.length,
    revenueKnownVnd: sum(known.filter((l) => REVENUE_KINDS.has(l.kind))),
    costKnownVnd: sum(known.filter((l) => !REVENUE_KINDS.has(l.kind))),
    engineVersion: STATEMENT_ENGINE_VERSION,
  };
}

/** Kỳ tháng: `YYYY-MM-01` hợp lệ. */
export function isPeriodMonth(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(v);
}
