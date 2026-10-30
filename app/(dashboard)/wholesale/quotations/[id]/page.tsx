import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { PRICE_SOURCE_LABEL } from "@/lib/constants/price-lists";
import { formatDate, formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getQuotation } from "@/lib/queries/wholesale-quotations";
import { REVISABLE_STATUSES } from "@/lib/wholesale/quotation-engine";
import { WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { QuotationStatusBadge } from "@/app/(dashboard)/wholesale/quotations/quotations-table";
import { IssueList, TotalsBlock } from "@/app/(dashboard)/wholesale/quotations/quotation-form";
import { QuotationActions } from "@/app/(dashboard)/wholesale/quotations/[id]/quotation-actions";
import { OrderClosePanel } from "@/app/(dashboard)/wholesale/quotations/[id]/order-close-panel";
import { bankMatchesForQuotation, orderForQuotation } from "@/lib/wholesale/order-close";

export const metadata = { title: "Báo giá sỉ" };

/** Một phiên bản báo giá — mọi số đọc từ cột / ảnh chụp đã ghi lúc lập; không tính lại. */
export default async function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("wholesale:view");
  const { id } = await params;
  const data = await getQuotation(user, id);
  if (!data) notFound();
  if ("unavailable" in data) return <EmptyState title="Chưa dùng được báo giá sỉ" description="CSDL của tổ chức chưa áp migration 0263." />;
  const { row, snapshot, lines, versions, people, status } = data;
  const result = snapshot.result;
  const partyHref = row.leadId ? `/wholesale/leads/${row.leadId}` : row.customerId ? `/customers/${row.customerId}` : null;
  // Chốt đơn sỉ (P5): đơn tạo từ báo giá (khoá chống trùng của lõi đơn) + đề nghị đối chiếu chuyển khoản — chỉ đọc.
  const [order, bank] = await Promise.all([orderForQuotation(row.id), bankMatchesForQuotation(user, row.id, row.code)]);
  const listName = [snapshot.books.customerList, snapshot.books.defaultList].find((b) => b?.id === row.priceListId)?.name ?? null;
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Báo giá sỉ"
        title={
          <span className="flex flex-wrap items-center gap-3">
            {row.code} · bản {row.version}
            <QuotationStatusBadge status={status} />
          </span>
        }
        description={`${snapshot.party.name || "—"} · lập ${formatDateTime(row.createdAt)} bởi ${row.createdByName || "—"} · hiệu lực đến hết ${formatDate(row.validUntil)}`}
        actions={<Link href="/wholesale/quotations" className="text-sm text-muted-foreground hover:underline">← Danh sách</Link>}
      />
      <WholesaleNav user={user} active="quotations" />

      <QuotationActions
        id={row.id}
        status={status}
        blockers={row.blockerCount}
        requiresApproval={row.requiresApproval}
        canWork={can(user, "wholesale:work")}
        canApprove={can(user, "wholesale:config")}
        isCreator={row.createdByUserId === user.id}
        revisable={REVISABLE_STATUSES.includes(status)}
      />

      <OrderClosePanel quotationId={row.id} accepted={status === "ACCEPTED"} canOrder={can(user, "orders:write") && can(user, "wholesale:work")} order={order} bank={bank} canLink={can(user, "bank:write")} />

      <IssueList result={result} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <SectionCard title={`Dòng hàng (${formatNumber(lines.length)})`} description="Đơn giá chọn bằng bảng giá sỉ hiệu lực lúc lập (bảng riêng của khách → bảng mặc định)." padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2">Mẫu mã</th>
                    <th className="px-4 py-2 text-right">SL</th>
                    <th className="px-4 py-2 text-right">Đơn giá</th>
                    <th className="px-4 py-2 text-right">Bậc</th>
                    <th className="px-4 py-2 text-right">CK dòng</th>
                    <th className="px-4 py-2 text-right">Thành tiền</th>
                    <th className="px-4 py-2 text-right">Tồn lúc báo</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className="border-t border-hairline align-top">
                      <td className="px-4 py-2">
                        <div className="font-medium">{l.productName || l.variantId}</div>
                        <div className="text-xs text-muted-foreground">
                          {[l.sku, l.priceSource ? PRICE_SOURCE_LABEL[l.priceSource as "CUSTOMER_LIST" | "DEFAULT_LIST"] : "không có giá sỉ"].filter(Boolean).join(" · ")}
                        </div>
                        {Array.isArray(l.warnings) && l.warnings.length ? <div className="text-xs text-amber-700 dark:text-amber-400">{(l.warnings as string[]).join(" ")}</div> : null}
                      </td>
                      <td className="numeric px-4 py-2 text-right">{formatNumber(l.quantity)}</td>
                      <td className="numeric px-4 py-2 text-right">{formatVND(l.unitPrice)}</td>
                      <td className="numeric px-4 py-2 text-right">{l.tierMinQty === null ? "—" : `từ ${formatNumber(l.tierMinQty)}`}</td>
                      <td className="numeric px-4 py-2 text-right">{l.lineDiscount ? formatVND(l.lineDiscount) : "—"}</td>
                      <td className="numeric px-4 py-2 text-right">{formatVND(l.lineTotal)}</td>
                      <td className="numeric px-4 py-2 text-right">{l.stockAvailableAtQuote === null ? <span className="text-amber-700 dark:text-amber-400">chưa xác minh</span> : formatNumber(l.stockAvailableAtQuote)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t p-4">
              <TotalsBlock totals={{ subtotal: row.subtotal, discount: row.discount, shipping: row.shipping, tax: row.tax, total: row.total }} discountPercent={result.discountPercent} marginPercent={result.marginPercent} taxRatePercent={result.taxRatePercent} />
            </div>
          </SectionCard>
        </div>
        <div className="space-y-4">
          <SectionCard title="Thông tin">
            <DescriptionList
              columns={1}
              items={[
                { label: "Bên nhận", value: partyHref ? <Link href={partyHref} className="underline">{snapshot.party.name || "—"}</Link> : snapshot.party.name || "—" },
                { label: "Tiền tệ", value: `${row.currency} (ERP chưa có nguồn tỷ giá — chỉ VND)` },
                { label: "Bảng giá", value: listName ? `${listName} · ${row.priceVersion}` : `— · ${row.priceVersion}` },
                { label: "Vận chuyển", value: row.shipping === null ? "Chưa có" : `${formatVND(row.shipping)} — ${row.shippingSource}` },
                { label: "Thuế", value: row.tax === null ? "Chưa khai thuế suất có căn cứ" : `${formatVND(row.tax)} — ${row.taxSource}` },
                { label: "Incoterms", value: row.incoterm ?? "Không ghi" },
                { label: "Duyệt", value: row.approvedAt ? `${people[row.approvedByUserId ?? ""] ?? "—"} · ${formatDateTime(row.approvedAt)}` : row.requiresApproval ? "Cần duyệt — chưa duyệt" : "Không cần duyệt" },
                { label: "Gửi khách", value: row.sentAt ? `${people[row.sentByUserId ?? ""] ?? "—"} · ${formatDateTime(row.sentAt)}` : "Chưa" },
                { label: "Kết quả", value: row.acceptedAt ? `Chấp nhận ${formatDateTime(row.acceptedAt)} — ${row.decisionNote}` : row.rejectedAt ? `Từ chối ${formatDateTime(row.rejectedAt)} — ${row.decisionNote}` : "—" },
                { label: "Ghi chú", value: row.notes || "—" },
              ]}
            />
          </SectionCard>
          <SectionCard title="Phiên bản" padded={false}>
            <ul className="divide-y text-sm">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2 px-4 py-2">
                  <Link href={`/wholesale/quotations/${v.id}`} className={v.id === row.id ? "font-semibold" : "hover:underline"}>
                    Bản {v.version}
                  </Link>
                  <QuotationStatusBadge status={v.status} />
                  <span className="numeric text-xs">{formatVND(v.total)}</span>
                  <span className="text-xs text-muted-foreground">{formatDate(v.createdAt)}</span>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
