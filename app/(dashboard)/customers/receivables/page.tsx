import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { AGING_BUCKETS, AGING_LABEL } from "@/lib/constants/price-lists";
import { formatVND } from "@/lib/format";
import { listReceivables } from "@/lib/queries/receivables";
import { manualOrderOrgGate } from "@/lib/records/order-create";
import { cn } from "@/lib/utils";

export const metadata = { title: "Công nợ khách hàng" };

/**
 * CÔNG NỢ KHÁCH HÀNG (0188 · docs/verticals/price-lists-receivables.md) — đọc từ chứng từ thanh toán của đơn tạo tay. Chỉ
 * tổ chức tạo đơn tay mới có trang này; tổ chức đồng bộ đơn Pancake đi theo bảng kê đơn vị vận chuyển (404 ở đây).
 */
export default async function ReceivablesPage() {
  await requirePermission("customers:view");
  if (!(await manualOrderOrgGate()).allowed) notFound();
  const board = await listReceivables();
  const t = board.totals;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Khách hàng"
        title="Công nợ khách hàng"
        description={`${t.customers} khách còn nợ · phải thu ${formatVND(t.receivable)} · quá hạn ${formatVND(t.overdue)} · đã chốt chưa giao ${formatVND(t.committed)}`}
        hint="Phải thu = đơn tạo tay ĐÃ GIAO (phiếu ký nhận) còn thiếu tiền theo phiếu thu. Đã chốt chưa giao = sắp thành nợ. Quá hạn tính từ ngày giao + số ngày được nợ của khách; khách chưa khai số ngày thì chưa tính được — không đoán. Thu nợ ở trang từng khách."
      />
      <section className="grid gap-3 sm:grid-cols-5" data-aging>
        {AGING_BUCKETS.map((b) => (
          <div key={b} className="rounded-lg border px-3 py-2">
            <div className="text-xs text-muted-foreground">{AGING_LABEL[b]}</div>
            <div className={cn("numeric text-base font-semibold", b !== "CURRENT" && t.buckets[b] > 0 && "text-rose-700 dark:text-rose-400")}>{formatVND(t.buckets[b])}</div>
          </div>
        ))}
      </section>
      {t.termsUnknown > 0 ? <p className="text-xs text-amber-700 dark:text-amber-400">{t.termsUnknown} khách có nợ mà chưa khai số ngày được nợ — phần nợ đó chưa xếp được vào nhóm tuổi nào.</p> : null}
      <SectionCard title="Theo khách" description={t.overLimit ? `${t.overLimit} khách đang vượt hạn mức` : "Xếp: quá hạn lâu nhất trước, rồi dư nợ lớn nhất"} padded={false}>
        {board.rows.length === 0 ? (
          <EmptyState title="Không khách nào còn nợ" description="Mọi đơn tạo tay đã chốt / đã giao đều đã thu đủ theo phiếu thu." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-receivables>
              <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Khách</th>
                  <th className="px-4 py-2">Bảng giá</th>
                  <th className="px-4 py-2 text-right">Phải thu</th>
                  <th className="px-4 py-2 text-right">Quá hạn</th>
                  <th className="px-4 py-2 text-right">Chốt chưa giao</th>
                  <th className="px-4 py-2 text-right">Dư nợ / hạn mức</th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r) => (
                  <tr key={r.customerId} className="border-t border-hairline" data-customer={r.customerId}>
                    <td className="px-4 py-2">
                      <Link href={`/customers/${encodeURIComponent(r.customerId)}#trade`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {r.phone ?? "—"} · {r.openOrders} đơn{r.paymentTermsDays === null ? " · chưa khai số ngày được nợ" : ` · nợ ${r.paymentTermsDays} ngày`}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs">{r.priceListName ?? "Mặc định / giá lẻ"}</td>
                    <td className="numeric px-4 py-2 text-right">{formatVND(r.receivable)}</td>
                    <td className={cn("numeric px-4 py-2 text-right", r.overdue > 0 && "font-semibold text-rose-700 dark:text-rose-400")}>
                      {r.termsUnknown && r.overdue === 0 ? "—" : formatVND(r.overdue)}
                      {r.maxDaysOverdue ? <div className="text-xs font-normal">lâu nhất {r.maxDaysOverdue} ngày</div> : null}
                    </td>
                    <td className="numeric px-4 py-2 text-right">{formatVND(r.committed)}</td>
                    <td className={cn("numeric px-4 py-2 text-right", r.overLimit && "font-semibold text-rose-700 dark:text-rose-400")}>
                      {formatVND(r.exposure)}
                      <div className="text-xs font-normal text-muted-foreground">{r.creditLimit === null ? "chưa khai hạn mức" : `/ ${formatVND(r.creditLimit)}`}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
