import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { todayVN } from "@/lib/format";
import { getQuotation, quotationVariantOptions } from "@/lib/queries/wholesale-quotations";
import { QUOTATION_STATUS_LABEL, REVISABLE_STATUSES } from "@/lib/wholesale/quotation-engine";
import { WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { QuotationForm } from "@/app/(dashboard)/wholesale/quotations/quotation-form";

export const metadata = { title: "Sửa báo giá sỉ" };

/** Sửa = lập PHIÊN BẢN MỚI từ đầu vào của bản này (ảnh chụp); bản này giữ nguyên số. */
export default async function EditQuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("wholesale:work");
  const { id } = await params;
  const data = await getQuotation(user, id);
  if (!data) notFound();
  if ("unavailable" in data) return <EmptyState title="Chưa dùng được báo giá sỉ" description="CSDL của tổ chức chưa áp migration 0263." />;
  const input = data.snapshot.input;
  const party = data.snapshot.party;
  const variants = await quotationVariantOptions();
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Báo giá sỉ" title={`Sửa ${data.row.code} — tạo bản ${data.row.version + 1}`} description="Máy tính lại bằng bảng giá, tồn và giá vốn HÔM NAY. Bản hiện tại giữ nguyên số và chuyển thành «Đã có bản mới»." actions={<Link href={`/wholesale/quotations/${id}`} className="text-sm text-muted-foreground hover:underline">← Về báo giá</Link>} />
      <WholesaleNav user={user} active="quotations" />
      {REVISABLE_STATUSES.includes(data.status) ? (
        <QuotationForm
          mode="revise"
          quotationId={id}
          party={{ leadId: data.row.leadId, customerId: data.row.customerId, label: party.name }}
          variants={variants}
          initial={{ lines: input.lines, quoteDiscount: input.quoteDiscount, shippingAmount: input.shipping?.amount ?? null, shippingSource: input.shipping?.source ?? "", validUntil: input.validUntil, incoterm: input.incoterm, notes: input.notes }}
          today={todayVN()}
        />
      ) : (
        <EmptyState title={`Báo giá đang «${QUOTATION_STATUS_LABEL[data.status]}» — không sửa được`} description="Khách đã chấp nhận, hoặc đã có phiên bản mới hơn — mở bản mới nhất." />
      )}
    </div>
  );
}
