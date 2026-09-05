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
import { NURTURE_WINDOWS, OUTREACH_STATUS_LABEL, OUTREACH_STATUSES, SEGMENT_LABEL } from "@/lib/constants/outreach";
import { formatNumber } from "@/lib/format";
import { loadOutreachConfig } from "@/lib/outreach/build";
import { listProductsForMapping } from "@/lib/queries/ads-mapping";
import { listOutreachTargets, OUTREACH_SORTABLE, outreachStatusFacet, outreachSummary } from "@/lib/queries/outreach";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Chăm sóc & bán chéo" };


export default async function OutreachPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("outreach:view");
  const canWrite = can(user, "outreach:send");
  const canConfig = can(user, "outreach:config");
  const raw = await searchParams;
  const segment = raw.segment === "CROSS_SELL" ? "CROSS_SELL" : "NURTURE";
  const params = parseListParams(raw, { defaultSort: "nextAt", defaultDir: "asc", filterKeys: ["status"], sortable: OUTREACH_SORTABLE, defaultPeriod: "all" });
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
        description="(1) Khách đã nhắn Pancake trong 24 giờ hoặc 7 ngày nhưng chưa đặt đơn → kịch bản băn khoăn nhiều bước, mỗi ngày một tin (ưu đãi chốt nhanh → chất lượng → kiểm hàng trước khi trả tiền → còn ít hàng → hỗ trợ → hỏi lại); tự dừng khi khách đặt đơn hoặc trả lời để nhân viên tiếp quản. (2) Khách đã nhận hàng 3–14 ngày → tin cảm ơn kèm gợi ý sản phẩm phối cùng. Nhân viên duyệt, sửa nội dung rồi gửi qua inbox Pancake; khách không có hội thoại thì xuất CSV để nhắn Zalo/SMS."
        actions={canWrite ? <BuildButton segment={segment} defaultHours={config.nurtureWindowHours} /> : null}
      />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Băn khoăn chưa mua · đến hạn gửi" value={formatNumber(summary.nurture.due)} note={`${formatNumber(summary.nurture.pending)} đang trong kịch bản · ${formatNumber(summary.nurture.converted)} đã mua · ${formatNumber(summary.nurture.replied)} khách trả lời · ${formatNumber(summary.nurture.failed)} lỗi`} icon={MessageSquareHeart} tone={summary.nurture.due ? "amber" : "slate"} />
        <MetricCard label="Bán chéo sau nhận hàng · chờ gửi" value={formatNumber(summary.crossSell.due)} note={`${formatNumber(summary.crossSell.sent)} đã gửi · ${formatNumber(summary.crossSell.failed)} lỗi`} icon={ShoppingBag} tone={summary.crossSell.pending ? "amber" : "slate"} />
        <MetricCard label="Đã gửi 24 giờ qua" value={formatNumber(summary.sentToday)} note={`Giới hạn ${formatNumber(config.dailyLimit)} tin/ngày`} icon={Send} tone="green" />
        <MetricCard label="Kịch bản băn khoăn" value={`${config.nurtureSteps.length} bước · ${NURTURE_WINDOWS.find((w) => w.hours === config.nurtureWindowHours)?.label ?? `${config.nurtureWindowHours} giờ`}`} note={`Mỗi bước cách ${config.nurtureStepGapDays} ngày · bán chéo ${config.crossSellFromDays}–${config.crossSellToDays} ngày sau nhận · không nhắn lại trong ${config.cooldownDays} ngày`} icon={HeartHandshake} tone="blue" />
      </section>
      <OutreachConfigForm config={config} products={products} canWrite={canConfig} />
      <div className="flex flex-wrap gap-2">
        {(["NURTURE", "CROSS_SELL"] as const).map((seg) => (
          <Link key={seg} href={segHref(seg)} className={cn("rounded-full border px-4 py-1.5 text-sm font-medium transition", seg === segment ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}>
            {SEGMENT_LABEL[seg]} · {formatNumber(seg === "NURTURE" ? summary.nurture.due : summary.crossSell.due)} đến hạn
          </Link>
        ))}
      </div>
      <DataTableToolbar
        searchPlaceholder="Tên khách, SĐT, nội dung…"
        period={false}
        facets={[{ key: "status", label: "Trạng thái", options: OUTREACH_STATUSES.map((s) => ({ value: s, label: OUTREACH_STATUS_LABEL[s], count: facet.find((x) => x.value === s)?.count ?? 0 })) }]}
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
