/**
 * ═══════════ HỢP ĐỒNG NỀN TẢNG ↔ SẢN PHẨM — v1 (docs/saas/INTEGRATION.md §1) ═══════════
 *
 * Bộ mặt NHỎ mà mọi sản phẩm (ERP, Chốt Đơn, sản phẩm thứ ba) gọi để biết mình đang chạy cho ai và được làm gì — không
 * sản phẩm nào đọc thẳng bảng `platform_*`. Sáu câu hỏi, không hơn:
 *
 *   currentWorkspace · productContext · hasProductFeature · recordUsage · recordCost · emitAudit
 *
 * Workspace LUÔN lấy từ ngữ cảnh máy chủ (`currentOrganization`: phiên đã ký / `withOrganization` của job) — không hàm nào
 * nhận mã workspace từ trình duyệt, nên đổi ID trên URL không đổi được workspace (docs/saas/SECURITY.md).
 *
 * Đổi hình dạng hợp đồng ⇒ tăng `SAAS_CONTRACT_VERSION` và giữ bản cũ song song tới khi mọi sản phẩm chuyển xong.
 */
import { audit } from "@/lib/audit";
import { currentOrganization } from "@/lib/platform/context";
import { hasFeature } from "@/lib/pricing/entitlements";
import type { FeatureKey } from "@/lib/pricing/features";
import { accountOfWorkspace } from "@/lib/saas/accounts";
import { SAAS_CONTRACT_VERSION, productDef } from "@/lib/saas/catalog";
import { subscriptionStatusFor } from "@/lib/saas/entitlements";
import { addCostEntry, currentPeriodMonth, recordUsage, type CostCategory } from "@/lib/saas/ledger";
import { subscriptionGrantsUse, type AccountType, type BillingMode, type EffectiveSubscriptionStatus } from "@/lib/saas/policy";

export const CONTRACT_VERSION = SAAS_CONTRACT_VERSION;

export type WorkspaceContext = { orgCode: string; accountId: string | null; accountType: AccountType | null; billingMode: BillingMode | null };

export async function currentWorkspace(): Promise<WorkspaceContext> {
  const org = await currentOrganization();
  const account = await accountOfWorkspace(org.code);
  return { orgCode: org.code, accountId: account?.id ?? null, accountType: (account?.accountType as AccountType) ?? null, billingMode: (account?.billingMode as BillingMode) ?? null };
}

export type ProductContext = { version: string; workspace: WorkspaceContext; productKey: string; subscriptionId: string | null; status: EffectiveSubscriptionStatus | null; grantsUse: boolean };

export async function productContext(productKey: string): Promise<ProductContext> {
  if (!productDef(productKey)) throw new Error(`Sản phẩm "${productKey}" không có trong danh mục.`);
  const workspace = await currentWorkspace();
  const s = await subscriptionStatusFor(workspace.orgCode, productKey);
  return { version: CONTRACT_VERSION, workspace, productKey, subscriptionId: s.subscriptionId, status: s.status, grantsUse: s.status !== null && subscriptionGrantsUse(s.status) };
}

/** Thuê bao sản phẩm cho dùng ∧ gói (+ ghi đè) có tính năng. Không bao giờ so tên gói. */
export async function hasProductFeature(productKey: string, feature: FeatureKey): Promise<boolean> {
  const ctx = await productContext(productKey);
  if (!ctx.grantsUse) return false;
  return hasFeature(feature, { orgCode: ctx.workspace.orgCode });
}

/** Ghi một sự kiện dùng của workspace hiện tại vào sổ dùng chung (idempotent theo `eventKey`). */
export async function recordProductUsage(productKey: string, metric: string, quantity: number, opts: { eventKey: string; occurredAt?: Date; correlationId?: string | null; metadata?: Record<string, unknown> }): Promise<{ recorded: boolean }> {
  const org = await currentOrganization();
  return recordUsage({ orgCode: org.code, productKey, metric, quantity, eventKey: opts.eventKey, occurredAt: opts.occurredAt, correlationId: opts.correlationId ?? null, source: `sdk:${productKey}`, metadata: opts.metadata });
}

/** Ghi một khoản chi phí TRỰC TIẾP của workspace hiện tại cho sản phẩm (vd hoá đơn API ngoài của tháng). */
export async function recordProductCost(productKey: string, input: { category: CostCategory; amountVnd: number; description: string; entryKey: string; periodMonth?: string }): Promise<{ id: string; created: boolean }> {
  const ws = await currentWorkspace();
  return addCostEntry(
    { periodMonth: input.periodMonth ?? currentPeriodMonth(), category: input.category, scope: "WORKSPACE", productKey, accountId: ws.accountId, orgCode: ws.orgCode, basis: "DIRECT", amountVnd: input.amountVnd, description: input.description, entryKey: `sdk:${productKey}:${input.entryKey}` },
    { actor: null, email: null, reason: `SDK ${productKey}`, source: "SCRIPT" },
  );
}

/** Sự kiện kiểm toán của sản phẩm — vào nhật ký CỦA workspace (người quản trị khách thấy), không vào nhật ký nền tảng. */
export async function emitAudit(productKey: string, entry: { action: string; entity: string; entityId: string; before?: unknown; after?: unknown; correlationId?: string; userId?: string | null; userEmail?: string | null }) {
  await audit({ userId: entry.userId ?? null, userEmail: entry.userEmail ?? `system:${productKey}`, actorKind: entry.userId ? "USER" : "SYSTEM", action: entry.action, entity: entry.entity, entityId: entry.entityId, before: entry.before, after: entry.after, correlationId: entry.correlationId });
}
