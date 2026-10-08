/**
 * ═══════════ CỔNG KHÁCH — «SẢN PHẨM CỦA TÔI» (docs/saas/README.md §7) ═══════════
 *
 * Chủ doanh nghiệp thấy workspace đang đứng, sản phẩm đã thuê, tình trạng và quyền dùng từng tính năng.
 * Workspace LẤY TỪ PHIÊN (`user.organization`, máy chủ ký) — hàm không nhận mã workspace nào, nên không có tham số để đổi
 * sang workspace khác. Không lộ chi phí AI / token / biên lãi (đó là số của nền tảng, không phải của khách — cùng luật với
 * `lib/pricing/customer.ts`).
 *
 * KHÁCH (workspace không phải nhà — `customerFacing`, lib/saas/visibility.ts) KHÔNG nhận loại tài khoản / cách lập chứng từ:
 * «Khách ngoài · Hoá đơn khách» là nhãn của control plane, không phải điều khách cần biết (kiểm vỏ khách 08/10/2026 · F-02).
 * Lọc ở DTO, không chỉ ở giao diện. Người của workspace nhà vẫn thấy đủ.
 */
import type { SessionUser } from "@/lib/auth/session";
import { billingNotice } from "@/lib/billing/rules";
import { orgBillingStanding } from "@/lib/billing/standing";
import { accountOfWorkspace, liveSubscriptions } from "@/lib/saas/accounts";
import { PRODUCT_LABEL, productDef } from "@/lib/saas/catalog";
import { productEntitlement } from "@/lib/saas/entitlements";
import { ACCOUNT_TYPE_LABEL, BILLING_MODE_LABEL, SUBSCRIPTION_STATUS_LABEL, type AccountType, type BillingMode } from "@/lib/saas/policy";
import { customerFacing } from "@/lib/saas/visibility";

export type MyProducts = {
  /** `CUSTOMER` = workspace không phải nhà: DTO không mang nhãn nội bộ của control plane. */
  audience: "HOME" | "CUSTOMER";
  /** Chỉ `HOME`; khách ⇒ `null`. */
  account: { name: string; type: string; billing: string } | null;
  workspace: { code: string; name: string };
  products: {
    key: string;
    name: string;
    status: string | null;
    grantsUse: boolean;
    /** Đang dùng thử ⇒ đúng câu của dải nhắc trên đầu ERP (`billingNotice`): «Dùng thử miễn phí — còn N ngày (tới hết …)». */
    trialNote: string | null;
    capabilities: { label: string; on: boolean }[];
    features: { key: string; effective: boolean }[];
  }[];
};

export async function loadMyProducts(user: SessionUser): Promise<MyProducts | { error: string }> {
  const org = user.organization;
  if (!org) return { error: "Phiên chưa gắn workspace — đăng nhập lại." };
  const customer = customerFacing(org);
  const [account, subs] = await Promise.all([customer ? Promise.resolve(null) : accountOfWorkspace(org.code), liveSubscriptions(org.code)]);
  const products: MyProducts["products"] = [];
  for (const s of subs) {
    if (!productDef(s.productKey)) continue;
    const e = await productEntitlement(org.code, s.productKey);
    // Tình trạng TRIAL đọc từ thu phí của workspace (`effectiveSubscriptionStatus`) — số ngày còn lại lấy đúng câu của dải nhắc, không luật thứ hai.
    const trialNote = e.status === "TRIAL" ? (billingNotice(await orgBillingStanding({ code: org.code, isHome: org.isHome === true }), true)?.text ?? null) : null;
    products.push({
      key: s.productKey,
      name: PRODUCT_LABEL[s.productKey] ?? s.productKey,
      status: e.status ? SUBSCRIPTION_STATUS_LABEL[e.status] : null,
      grantsUse: e.grantsUse,
      trialNote,
      capabilities: e.capabilities.map((c) => ({ label: c.label, on: c.modulesOn })),
      features: e.features.map((f) => ({ key: f.key, effective: f.effective })),
    });
  }
  return {
    audience: customer ? "CUSTOMER" : "HOME",
    account: account ? { name: account.name, type: ACCOUNT_TYPE_LABEL[account.accountType as AccountType] ?? account.accountType, billing: BILLING_MODE_LABEL[account.billingMode as BillingMode] ?? account.billingMode } : null,
    workspace: { code: org.code, name: org.name },
    products,
  };
}
