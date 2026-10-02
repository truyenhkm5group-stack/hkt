import { InvoiceOperatorActions, OrgBillingForm } from "@/components/billing/operator-billing";
import { SectionCard } from "@/components/ui-bits";
import { BILLING_STANDING_LABEL, PAYMENT_OUTCOME_LABEL } from "@/lib/billing/rules";
import type { OrgBilling } from "@/lib/billing/service";
import { formatDate, formatDateTime, formatVND } from "@/lib/format";

/** Khung THU PHÍ của một tổ chức ở `/platform/org/<mã>` — dữ liệu từ `loadOrgBilling` (đã hỏi người vận hành). */
export function OrgBillingSection({ orgCode, orgName, data }: { orgCode: string; orgName: string; data: OrgBilling }) {
  const s = data.standing;
  const open = data.invoices.find((i) => i.status === "OPEN") ?? null;
  return (
    <SectionCard
      id="billing"
      title="Thu phí"
      description={`${BILLING_STANDING_LABEL[s.kind]}${s.paidThrough ? ` · trả tới ${formatDate(s.paidThrough)}` : ""}${s.lockOn && s.kind !== "LOCKED" ? ` · chỉ xem từ ${formatDate(s.lockOn)} nếu không gia hạn` : ""}`}
      hint="«Trả tới» là ngày cuối đã trả (giờ VN). Lúc bật thu phí cho khách mới, đặt nó = hạn dùng thử. Quá hạn + ân hạn ⇒ chỉ xem: xem và xuất được, không ghi, job nền dừng; webhook vẫn nhận. Tiền về (tự khớp hoặc xác nhận tay) ⇒ gia hạn và đổi gói ngay."
    >
      <div className="space-y-5 text-sm" data-org-billing={s.kind}>
        <OrgBillingForm orgCode={orgCode} orgName={orgName} current={data.terms} />
        {open ? (
          <div className="space-y-2 border-t border-hairline pt-3">
            <p>
              Hoá đơn đang mở <span className="font-mono">{open.transferCode}</span> · {open.planName} {open.months} tháng · kỳ {formatDate(open.periodStart)} → {formatDate(open.periodEnd)} · <span className="numeric font-medium">{formatVND(open.amountVnd)}</span>
              {open.creditVnd > 0 ? <span className="text-muted-foreground"> (trừ {formatVND(open.creditVnd)})</span> : null} · tạo bởi {open.createdByEmail ?? "?"} lúc {formatDateTime(open.createdAt)}
            </p>
            <InvoiceOperatorActions invoice={{ id: open.id, transferCode: open.transferCode, amountVnd: open.amountVnd, periodEnd: open.periodEnd, planName: open.planName }} />
          </div>
        ) : null}
        <div className="grid gap-4 border-t border-hairline pt-3 lg:grid-cols-2">
          <div className="space-y-1">
            <h3 className="font-semibold">Hoá đơn</h3>
            {data.invoices.filter((i) => i.status !== "OPEN").length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa có.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {data.invoices
                  .filter((i) => i.status !== "OPEN")
                  .map((i) => (
                    <li key={i.id}>
                      <span className="font-mono">{i.transferCode}</span> · {i.planName} · {formatDate(i.periodStart)} → {formatDate(i.periodEnd)} ·{" "}
                      {i.status === "PAID" ? (
                        <>
                          đã thu <span className="numeric">{formatVND(i.paidAmountVnd)}</span> ({i.paidSource === "MANUAL" ? `tay — ${i.paidByEmail ?? "?"}` : "ngân hàng"}) {formatDateTime(i.paidAt)}
                        </>
                      ) : (
                        <>đã huỷ — {i.voidReason ?? "không ghi lý do"}</>
                      )}
                    </li>
                  ))}
              </ul>
            )}
          </div>
          <div className="space-y-1">
            <h3 className="font-semibold">Tiền về mang mã của tổ chức</h3>
            {data.payments.length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa có.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {data.payments.map((p) => (
                  <li key={p.id}>
                    <span className="numeric">{formatVND(p.amountVnd)}</span> · {formatDateTime(p.txnAt)} · <span className="font-mono">{p.transferCode}</span> · {PAYMENT_OUTCOME_LABEL[p.outcome]}
                    {p.resolvedAt ? ` · đã xử lý: ${p.resolvedNote ?? ""}` : ""}
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
