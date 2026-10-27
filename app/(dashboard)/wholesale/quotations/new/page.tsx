import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { todayVN } from "@/lib/format";
import { quotationPartyLabel, quotationVariantOptions } from "@/lib/queries/wholesale-quotations";
import { param, type SearchParams } from "@/lib/search-params";
import { WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { QuotationForm } from "@/app/(dashboard)/wholesale/quotations/quotation-form";

export const metadata = { title: "Tạo báo giá sỉ" };

/** Lập báo giá NHÁP — mở từ nút «Tạo báo giá» trên trang lead (`?lead=`) hoặc trang khách (`?customer=`). */
export default async function NewQuotationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("wholesale:work");
  const raw = await searchParams;
  const leadId = param(raw, "lead") || null;
  const customerId = param(raw, "customer") || null;
  const [label, variants] = leadId || customerId ? await Promise.all([quotationPartyLabel(leadId, customerId), quotationVariantOptions()]) : ["", []];
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Báo giá sỉ" title="Tạo báo giá" actions={<Link href="/wholesale/quotations" className="text-sm text-muted-foreground hover:underline">← Danh sách báo giá</Link>} />
      <WholesaleNav user={user} active="quotations" />
      {!leadId && !customerId ? (
        <EmptyState
          title="Chọn bên nhận báo giá trước"
          description={
            <>
              Mở một <Link href="/wholesale/leads" className="underline">lead khách sỉ</Link> hoặc một <Link href="/customers" className="underline">khách hàng</Link> rồi bấm «Tạo báo giá».
            </>
          }
        />
      ) : (
        <QuotationForm mode="create" party={{ leadId, customerId, label }} variants={variants} initial={null} today={todayVN()} />
      )}
    </div>
  );
}
