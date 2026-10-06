/**
 * ═══════════ CỔNG THU TIỀN — GIAO DIỆN `BillingProvider` (docs/platform/pricing-billing-foundation.md §7) ═══════════
 *
 * Mã nghiệp vụ / màn hình gọi QUA giao diện này, không gọi thẳng một nhà cung cấp — để ngày thêm cổng thẻ (VNPay · PayOS ·
 * Stripe — mỗi cái là dịch vụ ngoài mới, phải hỏi chủ nền tảng, AGENTS.md §7) chỉ là thêm MỘT bộ chuyển, không sửa luật.
 *
 * Bộ chuyển DUY NHẤT hôm nay: `SEPAY_BANK_TRANSFER` — BỌC đường thu tiền đã có (0187 · `lib/billing/service.ts`): hoá đơn
 * mang mã `ERPHD…` + VietQR, SePay ghi tiền vào sổ ngân hàng của tổ chức nhà, `reconcileBillingPayments` khớp theo mã.
 * Không có đường ghi thứ hai: mọi phương thức chỉ gọi lại hàm của service (cùng kiểm quyền, cùng nhật ký).
 *
 * Mô hình "trả tới ngày" KHÔNG tự trừ tiền: "huỷ thuê bao" = huỷ hoá đơn đang mở và để `paid_through` trôi; quá ân hạn thì
 * tổ chức chuyển CHỈ XEM như mọi thuê bao không gia hạn — không xoá dữ liệu, không tự đình chỉ.
 */
import { and, eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { createRenewalInvoice, markInvoicePaidManually, reconcileBillingPayments, voidInvoice, type ReconcileSummary } from "@/lib/billing/service";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

export type ProviderResult<T extends object = object> = ({ ok: true; message: string } & T) | { error: string };

export interface BillingProvider {
  readonly key: string;
  readonly label: string;
  /** Khách (phiên của tổ chức) bắt đầu thuê bao: tạo yêu cầu trả tiền cho `months` tháng gói `planKey`. */
  createSubscription(user: SessionUser, input: { planKey: string; months: number; vat?: boolean }): Promise<ProviderResult<{ invoiceId: string }>>;
  /** Đổi gói (nâng / hạ) — cùng đường báo giá (`quoteRenewal`: nâng thì trừ phần chưa dùng, hạ thì nối kỳ). */
  changePlan(user: SessionUser, input: { planKey: string; months: number; vat?: boolean }): Promise<ProviderResult<{ invoiceId: string }>>;
  /** Người vận hành dừng thuê bao: huỷ yêu cầu trả tiền đang mở. Quyền dùng giữ tới `paid_through` + ân hạn. */
  cancelSubscription(user: SessionUser, input: { orgCode: string; reason: string }): Promise<ProviderResult>;
  /** Người vận hành ghi một khoản tiền về ngoài đường tự động (ngân hàng khác, tiền mặt). */
  recordPayment(user: SessionUser, input: { invoiceId: string; amountVnd: number; ref?: string; reason: string }): Promise<ProviderResult>;
  /** Tiền về (webhook / quét / sao kê) ⇒ khớp với yêu cầu trả tiền. Idempotent theo mã giao dịch ngân hàng. */
  handleWebhook(input: { bankRefs?: readonly string[]; now?: Date }): Promise<ReconcileSummary>;
}

export const sepayBankTransferProvider: BillingProvider = {
  key: "SEPAY_BANK_TRANSFER",
  label: "Chuyển khoản VietQR (SePay đối soát)",
  async createSubscription(user, input) {
    const r = await createRenewalInvoice(user, input);
    return "ok" in r ? { ok: true, message: r.message, invoiceId: r.invoiceId } : r;
  },
  async changePlan(user, input) {
    const r = await createRenewalInvoice(user, input);
    return "ok" in r ? { ok: true, message: r.message, invoiceId: r.invoiceId } : r;
  },
  cancelSubscription: cancelSepaySubscription,
  async recordPayment(user, input) {
    return markInvoicePaidManually(user, input);
  },
  async handleWebhook(input) {
    return reconcileBillingPayments({ bankRefs: input.bankRefs, now: input.now });
  },
};

/** Huỷ yêu cầu trả tiền đang mở của một tổ chức (nếu có). Hỏi người vận hành TRƯỚC mọi lượt đọc. */
export async function cancelSepaySubscription(user: SessionUser, input: { orgCode: string; reason: string }): Promise<ProviderResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const pdb = await getPlatformDb();
  const inv = schema.platformInvoices;
  const [open] = await pdb.select({ id: inv.id }).from(inv).where(and(eq(inv.orgCode, input.orgCode), eq(inv.status, "OPEN"))).limit(1);
  if (!open) return { ok: true, message: "Không có yêu cầu trả tiền nào đang mở — thuê bao tự dừng khi hết hạn (không có tự trừ tiền)." };
  const r = await voidInvoice(user, { invoiceId: open.id, reason: input.reason });
  return "ok" in r ? { ok: true, message: `${r.message} Quyền dùng giữ tới hết ngày đã trả + ân hạn.` } : r;
}

const PROVIDERS: Record<string, BillingProvider> = { [sepayBankTransferProvider.key]: sepayBankTransferProvider };

/** Cổng thu tiền đang dùng. Hôm nay chỉ có một — chỗ chọn nằm ở đây để thêm cổng không phải sửa nơi gọi. */
export function billingProvider(key: string = sepayBankTransferProvider.key): BillingProvider {
  return PROVIDERS[key] ?? sepayBankTransferProvider;
}
