import Link from "next/link";
import { HeartHandshake, MessageSquareHeart, Send, ShoppingBag } from "lucide-react";
import { OutreachConfigForm } from "@/app/(dashboard)/outreach/outreach-config";
import { BuildButton, OutreachTable } from "@/app/(dashboard)/outreach/outreach-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { UrlPagination } from "@/components/data-table/url-pagination";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { OUTREACH_STATUS_LABEL, SEGMENT_LABEL } from "@/lib/constants/outreach";
import { formatNumber } from "@/lib/format";
import { loadOutreachConfig } from "@/lib/outreach/build";
import { listProductsForMapping } from "@/lib/queries/ads-mapping";
import { listOutreachTargets, OUTREACH_SORTABLE, outreachStatusFacet, outreachSummary } from "@/lib/queries/outreach";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Chăm sóc & bán chéo" };

const STATUSES = ["PENDING", "SENT", "FAILED", "SKIPPED"];

export default async function OutreachPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("orders:read");
  const canWrite = can(user, "cs:manage");
  const canConfig = can(user, "settings:manage");
  const raw = await searchParams;
  const segment = raw.segment === "CROSS_SELL" ? "CROSS_SELL" : "NURTURE";
  const params = parseListParams(raw, { defaultSort: "createdAt", filterKeys: ["status"], sortable: OUTREACH_SORTABLE, defaultPeriod: "all" });
  const [{ rows, total, pageCount }, facet, summary, config, products] = await Promise.all([listOutreachTargets(params, segment), outreachStatusFacet(segment), outreachSummary(), loadOutreachConfig(), listProductsForMapping()]);
  const segHref = (seg: string) => {
    const q = new URLSearchParams();
    q.set("segment", seg);
    return `/outreach?${q.toString()}`;
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành"
        title="Chăm sóc khách băn khoăn & bán chéo"
        description="Tự lập danh sách hằng ngày: (1) khách đã nhắn Pancake nhưng chưa đặt đơn → tin hỏi thăm, tư vấn thêm; (2) khách đã nhận hàng thành công 3–14 ngày → tin cảm ơn kèm gợi ý sản phẩm phối cùng. Nhân viên duyệt, sửa nội dung rồi gửi qua inbox Pancake; khách không có hội thoại thì xuất CSV để nhắn Zalo/SMS."
        actions={canWrite ? <BuildButton segment={segment} /> : null}
      />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Băn khoăn chưa mua · chờ gửi" value={formatNumber(summary.nurture.pending)} note={`${formatNumber(summary.nurture.sent)} đã gửi · ${formatNumber(summary.nurture.failed)} lỗi`} icon={MessageSquareHeart} tone={summary.nurture.pending ? "amber" : "slate"} />
        <MetricCard label="Bán chéo sau nhận hàng · chờ gửi" value={formatNumber(summary.crossSell.pending)} note={`${formatNumber(summary.crossSell.sent)} đã gửi · ${formatNumber(summary.crossSell.failed)} lỗi`} icon={ShoppingBag} tone={summary.crossSell.pending ? "amber" : "slate"} />
        <MetricCard label="Đã gửi 24 giờ qua" value={formatNumber(summary.sentToday)} note={`Giới hạn ${formatNumber(config.dailyLimit)} tin/ngày`} icon={Send} tone="green" />
        <MetricCard label="Cửa sổ" value={`${config.nurtureDays} ngày · ${config.crossSellFromDays}–${config.crossSellToDays} ngày`} note={`Không nhắn lại cùng khách trong ${config.cooldownDays} ngày`} icon={HeartHandshake} tone="blue" />
      </section>
      <OutreachConfigForm config={config} products={products} canWrite={canConfig} />
      <div className="flex flex-wrap gap-2">
        {(["NURTURE", "CROSS_SELL"] as const).map((seg) => (
          <Link key={seg} href={segHref(seg)} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium transition", seg === segment ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}>
            {SEGMENT_LABEL[seg]} · {formatNumber(seg === "NURTURE" ? summary.nurture.pending : summary.crossSell.pending)} chờ gửi
          </Link>
        ))}
      </div>
      <DataTableToolbar
        searchPlaceholder="Tên khách, SĐT, nội dung…"
        period={false}
        facets={[{ key: "status", label: "Trạng thái", options: STATUSES.map((s) => ({ value: s, label: OUTREACH_STATUS_LABEL[s], count: facet.find((x) => x.value === s)?.count ?? 0 })) }]}
        resultLabel={`${formatNumber(total)} khách`}
      />
      <SectionCard padded={false}>
        <OutreachTable rows={rows} segment={segment} canWrite={canWrite} />
        <div className="border-t px-4 py-2">
          <UrlPagination pageCount={pageCount} total={total} />
        </div>
      </SectionCard>
    </div>
  );
}
