import Link from "next/link";
import { CollectDebtForm, CustomerTermsForm } from "@/components/trade/customer-trade-forms";
import { SectionCard } from "@/components/ui-bits";
import { can, type SessionUser } from "@/lib/auth/session";
import { AGING_BUCKETS, AGING_LABEL } from "@/lib/constants/price-lists";
import { formatDate, formatVND } from "@/lib/format";
import { customerDebt, customerTermsView } from "@/lib/queries/receivables";
import { cn } from "@/lib/utils";

/**
 * Khung ĐIỀU KHOẢN BÁN & CÔNG NỢ trên trang một khách (0188). Số nợ đọc từ chứng từ thanh toán của đơn tay
 * (`lib/queries/receivables.ts`) — khách không có đơn tay còn nợ thì 0 là số THẬT (đã đọc chứng từ), không phải "chưa biết".
 */
export async function CustomerTradeSection({ user, customerId }: { user: SessionUser; customerId: string }) {
  const [debt, view] = await Promise.all([customerDebt(customerId), customerTermsView(customerId)]);
  if (!debt) return null;
  const s = debt.summary;
  const canEditTerms = can(user, "customers:write");
  const canCollect = can(user, "orders:write");
  return (
    <SectionCard
      id="trade"
      title="Điều khoản bán & công nợ"
      description={`${s.priceListName ? `Bảng giá «${s.priceListName}»` : "Bảng giá mặc định / giá lẻ"} · hạn mức ${s.creditLimit === null ? "chưa khai" : formatVND(s.creditLimit)} · được nợ ${s.paymentTermsDays === null ? "chưa khai" : `${s.paymentTermsDays} ngày`}`}
      hint="Công nợ = số phải trả của đơn tạo tay đã chốt / đã giao trừ các phiếu thu còn hiệu lực. «Phải thu» là đơn đã giao; «Đã chốt chưa giao» sắp thành nợ. Hạn mức chặn lượt CHỐT đơn mới khi tổng hai phần vượt hạn mức; để trống hạn mức là không chặn."
    >
      <div className="space-y-4 text-sm" data-customer-debt={s.exposure}>
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            { label: "Phải thu (đã giao)", value: s.receivable, tone: "" },
            { label: "Đã chốt chưa giao", value: s.committed, tone: "" },
            { label: "Quá hạn", value: s.overdue, tone: s.overdue > 0 ? "text-rose-700 dark:text-rose-400" : "" },
            { label: "Dư nợ / hạn mức", value: s.exposure, tone: s.overLimit ? "text-rose-700 dark:text-rose-400" : "" },
          ].map((m) => (
            <div key={m.label} className="rounded-md border px-3 py-2">
              <div className="text-xs text-muted-foreground">{m.label}</div>
              <div className={cn("numeric text-base font-semibold", m.tone)}>
                {formatVND(m.value)}
                {m.label.startsWith("Dư nợ") && s.creditLimit !== null ? <span className="text-xs font-normal text-muted-foreground"> / {formatVND(s.creditLimit)}</span> : null}
              </div>
            </div>
          ))}
        </div>
        {s.termsUnknown ? <p className="text-xs text-amber-700 dark:text-amber-400">Chưa khai số ngày được nợ ⇒ chưa tính được nợ quá hạn của khách này.</p> : null}
        {s.receivable > 0 && !s.termsUnknown ? (
          <p className="text-xs text-muted-foreground">{AGING_BUCKETS.filter((b) => s.buckets[b] > 0).map((b) => `${AGING_LABEL[b]}: ${formatVND(s.buckets[b])}`).join(" · ")}</p>
        ) : null}
        {debt.orders.length > 0 ? (
          <table className="w-full" data-debt-orders>
            <thead className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3">Đơn</th>
                <th className="py-1.5 pr-3">Lên đơn</th>
                <th className="py-1.5 pr-3">Giao</th>
                <th className="py-1.5 pr-3">Hạn trả</th>
                <th className="py-1.5 pr-3 text-right">Phải trả</th>
                <th className="py-1.5 pr-3 text-right">Đã thu</th>
                <th className="py-1.5 text-right">Còn nợ</th>
              </tr>
            </thead>
            <tbody>
              {debt.orders.map((o) => (
                <tr key={o.orderId} className="border-t border-hairline">
                  <td className="py-1.5 pr-3">
                    <Link href={`/orders/${encodeURIComponent(o.orderId)}`} className="font-mono text-xs hover:underline">
                      {o.orderId}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-3">{formatDate(o.orderedOn)}</td>
                  <td className="py-1.5 pr-3">{o.deliveredOn ? formatDate(o.deliveredOn) : "Chưa giao"}</td>
                  <td className={cn("py-1.5 pr-3", (o.daysOverdue ?? 0) > 0 && "font-medium text-rose-700 dark:text-rose-400")}>{o.dueOn ? `${formatDate(o.dueOn)}${(o.daysOverdue ?? 0) > 0 ? ` (quá ${o.daysOverdue} ngày)` : ""}` : "—"}</td>
                  <td className="numeric py-1.5 pr-3 text-right">{formatVND(o.amountDue)}</td>
                  <td className="numeric py-1.5 pr-3 text-right">{formatVND(o.paid)}</td>
                  <td className="numeric py-1.5 text-right font-medium">{formatVND(o.outstanding)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-muted-foreground">Không còn đơn nào nợ.</p>
        )}
        {canCollect && s.exposure > 0 ? (
          <div className="space-y-1 border-t border-hairline pt-3">
            <h3 className="font-semibold">Thu nợ</h3>
            <p className="text-xs text-muted-foreground">Một khoản khách trả được chia vào các đơn còn nợ, đơn cũ nhất trước — mỗi đơn một phiếu thu, xem lại ở trang từng đơn.</p>
            <CollectDebtForm customerId={customerId} outstanding={s.exposure} />
          </div>
        ) : null}
        {canEditTerms ? (
          <div className="space-y-1 border-t border-hairline pt-3">
            <h3 className="font-semibold">Điều khoản bán</h3>
            <CustomerTermsForm customerId={customerId} priceLists={view.lists} current={view.terms} />
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
