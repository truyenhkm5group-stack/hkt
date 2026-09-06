import Link from "next/link";
import { AlertTriangle, Banknote, CheckCheck, Clock, Download, Landmark, X } from "lucide-react";
import { CodTable } from "@/app/(dashboard)/cod/cod-table";
import { CodTabs, type CodTabItem } from "@/app/(dashboard)/cod/cod-tabs";
import { CodReconciliation } from "@/app/(dashboard)/cod/reconciliation";
import { StatementDialog } from "@/app/(dashboard)/cod/statement-dialog";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requirePermission } from "@/lib/auth/session";
import { activeCodTab, COD_TABS, codStatusesFromFilter } from "@/lib/constants/cod";
import { formatDate, formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { codFacets, codKpis, codPeriodColumn, codSummary, COD_SORTABLE, getCodBatch, listCodShipments, recentCodBatches } from "@/lib/queries/cod";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Đối soát COD" };

export default async function CodPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("cod:view");
  const canWrite = can(user, "cod:write");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "deliveredAt", filterKeys: ["cod", "carrier", "batch"], sortable: COD_SORTABLE, defaultPeriod: "all" });
  const batchId = params.filters.batch?.[0];
  const reconValues = ["unproven", "pending", "stale"];
  const reconDrill = reconValues.includes(param(raw, "recon")) ? param(raw, "recon") : null;
  const reconPage = Math.max(1, Number(param(raw, "rpage", "1")) || 1);
  const [{ rows, total, pageCount }, kpis, facets, summary, batches, activeBatch] = await Promise.all([
    listCodShipments(params),
    codKpis(params.period),
    codFacets(params),
    codSummary(params),
    recentCodBatches(10),
    batchId ? getCodBatch(batchId) : Promise.resolve(null),
  ]);
  const exportQuery = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : []))).toString();
  const tab = activeCodTab(params.filters.cod);
  const statuses = codStatusesFromFilter(params.filters.cod);
  const periodLabel = codPeriodColumn(statuses).label;
  const tabs: CodTabItem[] = COD_TABS.map((t) => ({
    value: t.value,
    label: t.label,
    count: t.statuses === "all" ? null : t.statuses.reduce((sum, s) => sum + kpis.byStatus[s].count, 0),
  }));
  const waiting = kpis.byStatus.COLLECTED.amount + kpis.byStatus.RECONCILED.amount;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Đối soát COD"
        description={`${formatVND(waiting, { compact: true })} đã giao chờ tiền về · ${formatVND(kpis.byStatus.PENDING.amount, { compact: true })} chưa thu · ${formatNumber(kpis.byStatus.DISPUTED.count)} vận đơn chênh lệch`}
        actions={
          <>
            {canWrite ? <StatementDialog defaultOpen={param(raw, "import") === "orders"} /> : null}
            <Button asChild variant="outline" size="sm">
              <a href={`/api/export/cod?${exportQuery}`}>
                <Download className="size-4" /> Xuất CSV
              </a>
            </Button>
            <SyncButton job="vtp-tracking" label="Cập nhật từ Viettel Post" />
          </>
        }
      />

      <CodReconciliation period={params.period} drill={reconDrill} page={reconPage} />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Chưa thu" value={formatVND(kpis.byStatus.PENDING.amount, { compact: true })} note={`${formatNumber(kpis.byStatus.PENDING.count)} vận đơn đang giao (không tính hoàn / huỷ)`} icon={Clock} tone="amber" />
        <MetricCard label="Đã thu, chờ đối soát" value={formatVND(kpis.byStatus.COLLECTED.amount, { compact: true })} note={`${formatNumber(kpis.byStatus.COLLECTED.count)} vận đơn giao thành công`} icon={Banknote} tone="blue" />
        <MetricCard label="ĐVVC đã đối soát" value={formatVND(kpis.byStatus.RECONCILED.collected, { compact: true })} note={`${formatNumber(kpis.byStatus.RECONCILED.count)} vận đơn chờ chuyển khoản`} icon={CheckCheck} tone="primary" />
        <MetricCard
          label="Đã về ngân hàng trong kỳ"
          value={formatVND(Math.max(kpis.paidInPeriod.amount, kpis.batchesInPeriod.gross), { compact: true })}
          note={
            kpis.batchesInPeriod.count
              ? `${formatNumber(kpis.batchesInPeriod.count)} bảng kê Viettel Post · COD ${formatVND(kpis.batchesInPeriod.gross, { compact: true })} − cước ${formatVND(kpis.batchesInPeriod.fee, { compact: true })} = thực nhận ${formatVND(kpis.batchesInPeriod.net, { compact: true })} · ${formatNumber(kpis.paidInPeriod.count)} vận đơn đã gắn`
              : `${formatNumber(kpis.paidInPeriod.count)} vận đơn · ${params.period.label.toLowerCase()} · chưa có bảng kê trong kỳ`
          }
          icon={Landmark}
          tone="green"
        />
        <MetricCard label="Có chênh lệch" value={formatVND(kpis.byStatus.DISPUTED.amount, { compact: true })} note={`${formatNumber(kpis.byStatus.DISPUTED.count)} vận đơn cần đối chiếu`} icon={AlertTriangle} tone={kpis.byStatus.DISPUTED.count ? "rose" : "slate"} />
      </section>

      <CodTabs tabs={tabs} active={activeBatch ? "PAID_TO_BANK" : (tab?.value ?? "")} />

      {activeBatch ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
          <Landmark className="size-4 text-primary" />
          <span>
            Đợt nhận tiền <span className="font-mono font-semibold">{activeBatch.reference}</span> · {activeBatch.carrier} · nhận {formatDate(activeBatch.receivedAt)} · tổng <Money value={activeBatch.totalAmount} className="font-semibold" />
            {activeBatch.note ? <span className="text-muted-foreground"> · {activeBatch.note}</span> : null}
          </span>
          <Button asChild variant="ghost" size="sm" className="ml-auto h-7">
            <Link href="/cod?cod=PAID_TO_BANK">
              <X className="size-3.5" /> Bỏ lọc đợt
            </Link>
          </Button>
        </div>
      ) : null}

      <DataTableToolbar
        searchPlaceholder="Mã vận đơn, SĐT, tên khách, mã đơn…"
        period={{ defaultKey: "all" }}
        facets={[{ key: "carrier", label: "ĐVVC", options: facets.carriers }]}
        resultLabel={
          <>
            {formatNumber(total)} vận đơn {activeBatch ? "trong đợt" : `· ${tab?.description ?? "lọc theo trạng thái COD"}`} · COD {formatVND(summary.codAmount)} · đã thu {formatVND(summary.codCollected)} · phí ship {formatVND(summary.shippingFee)}
            {!activeBatch && params.period.from ? ` · kỳ tính theo ${periodLabel}` : ""}
          </>
        }
      />
      <CodTable rows={rows} pageCount={pageCount} total={total} canWrite={canWrite} />

      <SectionCard title="Đợt nhận tiền / bảng kê gần đây" description="Bảng kê tiền COD Viettel Post (tiền COD − cước/dư nợ = tiền thu về) và các đợt đánh dấu tay · số thu về được tính vào báo cáo Dòng tiền thực theo ngày đối soát" padded={false}>
        {batches.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Mã bảng kê</TableHead>
                  <TableHead>ĐVVC</TableHead>
                  <TableHead>Ngày nhận</TableHead>
                  <TableHead className="text-right">Tiền COD</TableHead>
                  <TableHead className="text-right">Cước / dư nợ</TableHead>
                  <TableHead className="text-right">Thu về</TableHead>
                  <TableHead className="text-right">Vận đơn</TableHead>
                  <TableHead>Ghi chú</TableHead>
                  <TableHead>Người tạo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((b) => (
                  <TableRow key={b.id} className={b.id === batchId ? "bg-primary/5" : undefined}>
                    <TableCell>
                      <Link href={`/cod?batch=${b.id}`} className="font-mono text-sm font-semibold text-foreground hover:text-primary hover:underline">
                        {b.reference}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{b.carrier}</TableCell>
                    <TableCell className="text-sm">{formatDate(b.receivedAt)}</TableCell>
                    <TableCell className="text-right">
                      <Money value={b.codGross || b.totalAmount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={b.feeTotal} className="text-muted-foreground" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={b.totalAmount} className="font-semibold" />
                      {b.shipments && b.collected !== b.totalAmount ? <div className="text-[10.5px] text-muted-foreground">đã thu <Money value={b.collected} compact /></div> : null}
                    </TableCell>
                    <TableCell className="text-right text-sm">{formatNumber(b.shipments)}</TableCell>
                    <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground">{b.note || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div>{b.createdBy || "—"}</div>
                      <div>{formatDateTime(b.createdAt)}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="px-5 py-6 text-sm text-muted-foreground">Chưa có đợt nhận tiền nào. Chọn các vận đơn đã giao rồi bấm “Đánh dấu đã về ngân hàng” để tạo đợt đầu tiên.</p>
        )}
      </SectionCard>
    </div>
  );
}
