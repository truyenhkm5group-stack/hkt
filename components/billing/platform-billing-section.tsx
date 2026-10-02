import Link from "next/link";
import { BillingReceiverForm, PlanPriceForm, ReconcileBillingButton, ResolvePaymentForm } from "@/components/billing/operator-billing";
import { SectionCard } from "@/components/ui-bits";
import { BILLING_STANDING_LABEL, PAYMENT_OUTCOME_LABEL, type BillingStandingKind } from "@/lib/billing/rules";
import type { PlatformBilling } from "@/lib/billing/service";
import { formatDate, formatDateTime, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

const ORDER: BillingStandingKind[] = ["ACTIVE", "DUE_SOON", "OVERDUE", "LOCKED", "NOT_BILLED"];
const TONE: Record<BillingStandingKind, string> = {
  NOT_BILLED: "text-muted-foreground",
  ACTIVE: "text-emerald-700 dark:text-emerald-400",
  DUE_SOON: "text-amber-700 dark:text-amber-400",
  OVERDUE: "text-rose-700 dark:text-rose-400",
  LOCKED: "font-semibold text-rose-700 dark:text-rose-400",
};

/** Khung THU PHÍ THUÊ BAO của `/platform` — dữ liệu từ `loadPlatformBilling` (đã hỏi người vận hành). */
export function PlatformBillingSection({ data }: { data: PlatformBilling }) {
  return (
    <SectionCard
      id="billing"
      title="Thu phí thuê bao"
      description={`MRR ${formatVND(data.mrrVnd)} · ${ORDER.map((k) => `${BILLING_STANDING_LABEL[k]} ${data.countByStanding[k]}`).join(" · ")}`}
      hint="MRR = tổng giá THÁNG của gói ở các tổ chức đang chạy, đã bật thu phí và chưa bị khoá (còn hạn · sắp hết · đang ân hạn). Tình trạng tính lúc đọc từ «đã trả tới» + ân hạn — không job nào khoá hay mở khoá. Tiền về: SePay ghi vào sổ ngân hàng của tổ chức nhà, hệ thống khớp theo nội dung ERPHD…; khoản không khớp nằm ở «Tiền chưa khớp», không biến mất."
      actions={<ReconcileBillingButton />}
    >
      <div className="space-y-6 text-sm">
        <div className="space-y-2" data-billing-receiver={data.receiver ? "set" : "missing"}>
          <h3 className="font-semibold">Tài khoản nhận tiền</h3>
          <p className={cn("text-xs", data.receiver ? "text-muted-foreground" : "font-medium text-destructive")}>
            {data.receiver ? `${data.receiver.bankName} · ${data.receiver.accountNumber} · ${data.receiver.accountName}` : "CHƯA KHAI — khách không tạo được mã thanh toán."}
          </p>
          <BillingReceiverForm current={data.receiver} />
        </div>

        <div className="space-y-2">
          <h3 className="font-semibold">Bảng giá</h3>
          <div className="space-y-3">
            {data.plans.map((p) => (
              <div key={p.key} className="grid gap-2 border-t border-hairline pt-3 md:grid-cols-[14rem_1fr]" data-plan-price={p.key}>
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="numeric text-xs text-muted-foreground">{p.priceVnd === null ? "Không bán" : `${formatVND(p.priceVnd)}/tháng`}</div>
                </div>
                <PlanPriceForm plan={p} />
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="font-semibold">Tổ chức</h3>
          {data.orgs.length === 0 ? (
            <p className="text-xs text-muted-foreground">Chưa có tổ chức khách nào.</p>
          ) : (
            <table className="w-full" data-billing-orgs>
              <thead className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3">Tổ chức</th>
                  <th className="py-1.5 pr-3">Gói</th>
                  <th className="py-1.5 pr-3 text-right">Giá tháng</th>
                  <th className="py-1.5 pr-3">Tình trạng</th>
                  <th className="py-1.5">Trả tới</th>
                </tr>
              </thead>
              <tbody>
                {data.orgs.map((o) => (
                  <tr key={o.code} className="border-t border-hairline">
                    <td className="py-1.5 pr-3">
                      <Link href={`/platform/org/${encodeURIComponent(o.code)}#billing`} className="hover:underline">
                        {o.name}
                      </Link>
                      {o.status !== "ACTIVE" ? <span className="ml-1 text-xs text-muted-foreground">({o.status})</span> : null}
                    </td>
                    <td className="py-1.5 pr-3">{o.planName}</td>
                    <td className="numeric py-1.5 pr-3 text-right">{o.priceVnd === null ? "—" : formatVND(o.priceVnd)}</td>
                    <td className={cn("py-1.5 pr-3", TONE[o.standing.kind])}>{BILLING_STANDING_LABEL[o.standing.kind]}</td>
                    <td className="py-1.5">{o.standing.paidThrough ? formatDate(o.standing.paidThrough) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="space-y-2" data-unresolved-payments={data.unresolvedPayments.length}>
          <h3 className="font-semibold">Tiền chưa khớp ({data.unresolvedPayments.length})</h3>
          {data.unresolvedPayments.length === 0 ? (
            <p className="text-xs text-muted-foreground">Không có khoản nào.</p>
          ) : (
            <div className="space-y-3">
              {data.unresolvedPayments.map((p) => (
                <div key={p.id} className="space-y-1 border-t border-hairline pt-3">
                  <div className="flex flex-wrap gap-x-3 text-xs">
                    <span className="numeric font-medium">{formatVND(p.amountVnd)}</span>
                    <span>{formatDateTime(p.txnAt)}</span>
                    <span className="font-mono">{p.transferCode}</span>
                    <span>{p.orgCode ?? "không rõ tổ chức"}</span>
                    <span className="text-rose-700 dark:text-rose-400">{PAYMENT_OUTCOME_LABEL[p.outcome]}</span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground" title={p.description}>
                    {p.description}
                  </p>
                  <ResolvePaymentForm paymentId={p.id} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-1">
            <h3 className="font-semibold">Hoá đơn đang mở ({data.openInvoices.length})</h3>
            {data.openInvoices.length === 0 ? (
              <p className="text-xs text-muted-foreground">Không có.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {data.openInvoices.map((i) => (
                  <li key={i.id}>
                    <Link href={`/platform/org/${encodeURIComponent(i.orgCode)}#billing`} className="font-mono hover:underline">
                      {i.transferCode}
                    </Link>{" "}
                    · {i.orgCode} · {i.planName} {i.months} tháng · <span className="numeric">{formatVND(i.amountVnd)}</span> · tạo {formatDateTime(i.createdAt)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-1">
            <h3 className="font-semibold">Vừa thu</h3>
            {data.recentPaid.length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa có.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {data.recentPaid.map((i) => (
                  <li key={i.id}>
                    <span className="font-mono">{i.transferCode}</span> · {i.orgCode} · <span className="numeric">{formatVND(i.paidAmountVnd)}</span> · {i.paidSource === "MANUAL" ? `tay (${i.paidByEmail ?? "?"})` : "ngân hàng"} · {formatDateTime(i.paidAt)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
