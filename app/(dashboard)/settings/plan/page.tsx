import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { AiLimitsTable, AiUsageTotalsTable } from "@/components/ai-usage/ai-usage-tables";
import { getPlanUsage } from "@/lib/entitlements/check";
import { loadOrgAiUsage } from "@/lib/ai-usage/view";
import { cn } from "@/lib/utils";
import { loadTenantBilling, type TenantBilling } from "@/lib/billing/service";
import { BILLING_STANDING_LABEL, type BillingStandingKind } from "@/lib/billing/rules";
import { AddonPicker, InvoiceInfoForm, OpenInvoiceCard, RenewalPicker } from "@/components/billing/tenant-billing";
import { isAddonKind } from "@/lib/billing/addons";
import { formatDate, formatDateTime, formatVND } from "@/lib/format";
import { CustomerUsageSection } from "@/components/pricing/customer-usage";
import { loadCustomerPlan } from "@/lib/pricing/customer";
import { MyProductsSection } from "@/components/saas/my-products";
import { loadMyProducts } from "@/lib/saas/portal";

export const metadata = { title: "Gói & thanh toán" };

function fmt(n: number, kind: string): string {
  return kind === "storageMb" ? n.toLocaleString("vi-VN", { maximumFractionDigits: 1 }) : n.toLocaleString("vi-VN");
}

/**
 * GÓI & HẠN MỨC (Phase 10 · §5) — mức dùng ĐẾM TƯƠI từ CSDL tổ chức của người xem. "—" = CHƯA ĐO ĐƯỢC (loại chưa có
 * bộ đếm, luật 42), không phải 0; "Không giới hạn" = gói khai `null`.
 */
export default async function PlanPage() {
  const user = await requirePermission("settings:manage");
  const usage = await getPlanUsage(user.organization?.code);
  // Mã tổ chức lấy từ PHIÊN (không từ URL): tổ chức chỉ thấy sổ AI của chính mình.
  const ai = await loadOrgAiUsage(usage.orgCode);
  const billing = usage.isHome ? null : await loadTenantBilling(usage.orgCode);
  // Hạn mức THƯƠNG MẠI tháng này (0222): đơn vị dễ hiểu, không token / chi phí — cùng mã tổ chức của PHIÊN.
  const customer = usage.isHome ? null : await loadCustomerPlan(usage.orgCode);
  // Sản phẩm đã thuê (0224): workspace lấy từ PHIÊN; khách nội bộ và khách ngoài cùng một khung.
  // Khung mới (0224) không được làm sập trang gói của mọi tổ chức (kể cả nhà) khi sổ thương mại lỗi — lỗi ⇒ ẩn khung.
  const products = await loadMyProducts(user).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Gói & thanh toán"
        description={usage.plan ? `Gói «${usage.plan.name}»${usage.isHome ? " — tổ chức nhà, không giới hạn" : ""}` : "Không đọc được gói"}
        hint="Hạn mức kiểm ở đúng chỗ tạo: người dùng, trang tuỳ biến, luật tự động, tải tệp. Vượt thì thao tác đó báo lỗi rõ ràng, không có gì bị xoá. Thiếu đúng một hạng mục: mua thêm giữa kỳ, trả theo số ngày còn lại. Nâng gói: chọn gói ở khung Thanh toán, chuyển khoản theo mã QR — tiền về là gói mới có hiệu lực."
      />
      {"error" in products ? null : <MyProductsSection view={products} />}
      {customer ? <CustomerUsageSection view={customer} /> : null}
      {billing ? <BillingSection billing={billing} /> : null}
      {!usage.plan ? (
        <EmptyState title="Không đọc được gói dịch vụ" description="Bảng gói của nền tảng chưa có hoặc gói của tổ chức không tồn tại — báo người vận hành nền tảng." />
      ) : (
        <SectionCard title="Mức dùng" description={usage.plan.fellBack ? "Gói khai trên tổ chức không có trong bảng — đang áp hạn mức của gói Dùng thử." : (usage.plan.description ?? undefined)} padded={false}>
          <table className="w-full text-sm" data-plan-usage>
            <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Hạng mục</th>
                <th className="px-4 py-2 text-right">Đang dùng</th>
                <th className="px-4 py-2 text-right">Hạn mức</th>
                <th className="px-4 py-2">Đếm từ</th>
              </tr>
            </thead>
            <tbody>
              {usage.rows.map((r) => {
                const over = r.used !== null && r.limit !== null && r.used >= r.limit;
                const added = isAddonKind(r.kind) ? (usage.plan?.addons[r.kind] ?? 0) : 0;
                return (
                  <tr key={r.kind} className="border-t border-hairline" data-kind={r.kind}>
                    <td className="px-4 py-2">{r.label}</td>
                    <td className={cn("numeric px-4 py-2 text-right", over && "font-semibold text-destructive")}>{r.used === null ? "—" : fmt(r.used, r.kind)}</td>
                    <td className="numeric px-4 py-2 text-right">
                      {r.limit === null ? (r.undeclared ? "Chưa khai" : "Không giới hạn") : `${fmt(r.limit, r.kind)} ${r.unit}`}
                      {added > 0 && r.limit !== null ? <div className="text-[11px] text-muted-foreground">gồm {fmt(added, r.kind)} mua thêm</div> : null}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{r.note ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </SectionCard>
      )}
      <SectionCard
        title="Dùng AI"
        description={ai.disabledReason ?? "Lượt · token · tiền ƯỚC TÍNH theo bảng giá model (không phải hoá đơn) — hôm nay và tháng này, theo nguồn trả tiền"}
        hint="Khoá AI của tổ chức: bạn trả tiền cho nhà cung cấp AI, nền tảng chỉ giới hạn số lượt. Credit AI của nền tảng: nền tảng trả, giới hạn bằng tiền. Vượt ngưỡng cảnh báo ⇒ vẫn chạy và báo một lần mỗi ngày; tới trần cứng ⇒ AI dừng, không gọi model. “—” = chưa biết giá, không phải 0."
        padded={false}
      >
        <div className="space-y-3 pb-3" data-ai-usage-section>
          <AiUsageTotalsTable today={ai.today} month={ai.month} />
          {ai.limits && !ai.limits.isHome ? <AiLimitsTable limits={ai.limits.limits} usage={ai.quotaUsage} undeclared={ai.limits.undeclared} /> : <p className="px-5 text-xs text-muted-foreground">{ai.limits ? "Tổ chức nhà — AI không giới hạn theo gói." : "Không đọc được gói — AI Builder sẽ từ chối cho tới khi người vận hành kiểm bảng gói."}</p>}
        </div>
      </SectionCard>
    </div>
  );
}

const STANDING_TONE: Record<BillingStandingKind, string> = {
  NOT_BILLED: "text-muted-foreground",
  ACTIVE: "text-emerald-700 dark:text-emerald-400",
  DUE_SOON: "text-amber-700 dark:text-amber-400",
  OVERDUE: "text-rose-700 dark:text-rose-400",
  LOCKED: "text-rose-700 dark:text-rose-400",
};

function standingLine(b: TenantBilling): string {
  const s = b.standing;
  if (s.kind === "NOT_BILLED") return b.terms?.paidThrough ? `Chưa bật thu phí — dùng tới ${formatDate(b.terms.paidThrough)}.` : "Tổ chức chưa bật thu phí — không nhắc, không khoá.";
  if (s.kind === "LOCKED") return `Hết hạn ${formatDate(s.paidThrough)} — tổ chức đang CHỈ XEM (xem và xuất được; không tạo / sửa được). Thanh toán xong là mở lại ngay.`;
  if (s.kind === "OVERDUE") return `Hết hạn ${formatDate(s.paidThrough)} — vẫn dùng đủ tới hết ${formatDate(s.lockOn ? s.lockOn : null)} (ân hạn); sau đó chỉ xem.`;
  return `Đã trả tới ${formatDate(s.paidThrough)} (còn ${s.daysLeft} ngày).`;
}

/** Khung THANH TOÁN — chỉ tổ chức khách; nhà không trả phí cho chính nó. */
function BillingSection({ billing }: { billing: TenantBilling }) {
  const s = billing.standing;
  return (
    <SectionCard
      title="Thanh toán"
      description={
        <span className={cn("font-medium", STANDING_TONE[s.kind])} data-billing-standing={s.kind}>
          {BILLING_STANDING_LABEL[s.kind]} · {standingLine(billing)}
        </span>
      }
      hint="Gia hạn bằng chuyển khoản theo mã QR: mỗi lần tạo mã là một hoá đơn với nội dung chuyển khoản riêng; tiền về tài khoản của nền tảng thì hệ thống tự khớp theo nội dung và gia hạn. Không có dữ liệu nào bị xoá khi quá hạn — chỉ chuyển sang chế độ chỉ xem."
    >
      <div className="space-y-6">
        {billing.openInvoice ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Mã thanh toán đang chờ</h3>
            <OpenInvoiceCard invoice={billing.openInvoice} receiver={billing.receiver} />
          </div>
        ) : null}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{billing.openInvoice ? "Đổi gói / số tháng" : "Gia hạn hoặc đổi gói"}</h3>
          {billing.receiver ? (
            <RenewalPicker offers={billing.offers} currentPlanKey={billing.currentPlan?.key ?? null} hasOpenInvoice={!!billing.openInvoice} canVat={!!billing.invoiceInfo} />
          ) : (
            <EmptyState title="Chưa tạo được mã thanh toán" description="Nền tảng chưa khai tài khoản nhận tiền. Báo người vận hành nền tảng — tổ chức của bạn vẫn dùng bình thường." />
          )}
        </div>
        <div className="space-y-2" data-addon-section>
          <h3 className="text-sm font-semibold">Mua thêm hạn mức</h3>
          {billing.addons.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Đang có: {billing.addons.map((a) => `${a.label.toLowerCase()} +${a.unitsLabel}`).join(" · ")}
              {billing.addonMonthlyVnd !== null && billing.addonMonthlyVnd > 0 ? ` — cộng ${formatVND(billing.addonMonthlyVnd)}/tháng vào lần gia hạn sau.` : billing.addonMonthlyVnd === null ? " — gói hiện tại không còn khai giá cho phần này; người vận hành nền tảng sẽ báo giá khi gia hạn." : "."}
            </p>
          ) : null}
          {billing.receiver ? (
            <AddonPicker offers={billing.addonOffers} blockedReason={billing.addonBlockedReason} hasOpenInvoice={!!billing.openInvoice} canVat={!!billing.invoiceInfo} />
          ) : null}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Thông tin xuất hoá đơn</h3>
          <InvoiceInfoForm current={billing.invoiceInfo} />
        </div>
        {billing.invoices.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Lịch sử</h3>
            <table className="w-full text-sm" data-invoice-history>
              <thead className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3">Mã</th>
                  <th className="py-1.5 pr-3">Nội dung · kỳ</th>
                  <th className="py-1.5 pr-3 text-right">Số tiền</th>
                  <th className="py-1.5">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {billing.invoices.map((i) => (
                  <tr key={i.id} className="border-t border-hairline">
                    <td className="py-1.5 pr-3 font-mono text-xs">{i.transferCode}</td>
                    <td className="py-1.5 pr-3">
                      {i.label} · {formatDate(i.periodStart)} → {formatDate(i.periodEnd)}
                      {i.invoiceInfo ? <div className="text-[11px] text-muted-foreground">{i.vatIssuedAt ? `Đã xuất hoá đơn VAT ${i.vatRef ?? ""}` : i.status === "PAID" ? "Hoá đơn VAT: đang chờ người vận hành xuất" : "Có yêu cầu hoá đơn VAT"}</div> : null}
                    </td>
                    <td className="numeric py-1.5 pr-3 text-right">{formatVND(i.status === "PAID" ? i.paidAmountVnd : i.amountVnd)}</td>
                    <td className="py-1.5 text-xs">{i.status === "PAID" ? `Đã trả ${formatDateTime(i.paidAt)}` : `Đã huỷ — ${i.voidReason ?? "không ghi lý do"}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
