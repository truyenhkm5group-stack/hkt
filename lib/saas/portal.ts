/**
 * ═══════════ CỔNG KHÁCH — «SẢN PHẨM CỦA TÔI» (docs/saas/README.md §7) ═══════════
 *
 * Chủ doanh nghiệp thấy tài khoản của mình, workspace đang đứng, sản phẩm đã thuê, tình trạng và quyền dùng từng tính năng.
 * Workspace LẤY TỪ PHIÊN (`user.organization`, máy chủ ký) — hàm không nhận mã workspace nào, nên không có tham số để đổi
 * sang workspace khác. Không lộ chi phí AI / token / biên lãi (đó là số của nền tảng, không phải của khách — cùng luật với
 * `lib/pricing/customer.ts`).
 */
import type { SessionUser } from "@/lib/auth/session";
import { accountOfWorkspace, liveSubscriptions } from "@/lib/saas/accounts";
import { PRODUCT_LABEL, productDef } from "@/lib/saas/catalog";
import { productEntitlement } from "@/lib/saas/entitlements";
import { ACCOUNT_TYPE_LABEL, BILLING_MODE_LABEL, SUBSCRIPTION_STATUS_LABEL, type AccountType, type BillingMode } from "@/lib/saas/policy";

export type MyProducts = {
  account: { name: string; type: string; billing: string } | null;
  workspace: { code: string; name: string };
  products: { key: string; name: string; status: string | null; grantsUse: boolean; capabilities: { label: string; on: boolean }[]; features: { key: string; effective: boolean }[] }[];
};

export async function loadMyProducts(user: SessionUser): Promise<MyProducts | { error: string }> {
  const org = user.organization;
  if (!org) return { error: "Phiên chưa gắn workspace — đăng nhập lại." };
  const [account, subs] = await Promise.all([accountOfWorkspace(org.code), liveSubscriptions(org.code)]);
  const products = [];
  for (const s of subs) {
    if (!productDef(s.productKey)) continue;
    const e = await productEntitlement(org.code, s.productKey);
    products.push({
      key: s.productKey,
      name: PRODUCT_LABEL[s.productKey] ?? s.productKey,
      status: e.status ? SUBSCRIPTION_STATUS_LABEL[e.status] : null,
      grantsUse: e.grantsUse,
      capabilities: e.capabilities.map((c) => ({ label: c.label, on: c.modulesOn })),
      features: e.features.map((f) => ({ key: f.key, effective: f.effective })),
    });
  }
  return {
    account: account ? { name: account.name, type: ACCOUNT_TYPE_LABEL[account.accountType as AccountType] ?? account.accountType, billing: BILLING_MODE_LABEL[account.billingMode as BillingMode] ?? account.billingMode } : null,
    workspace: { code: org.code, name: org.name },
    products,
  };
}
