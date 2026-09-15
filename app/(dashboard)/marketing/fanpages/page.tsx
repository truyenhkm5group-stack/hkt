import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { AssignPanel, type FanpageView, type MarketerOption } from "@/app/(dashboard)/marketing/fanpages/assign-panel";
import { SkuFilter } from "@/app/(dashboard)/marketing/fanpages/sku-filter";
import { FanpageTabs } from "@/app/(dashboard)/marketing/fanpages/tabs";
import { ReconcileButton } from "@/app/(dashboard)/marketing/fanpages/reconcile-button";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { UrlPagination } from "@/components/data-table/url-pagination";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb, schema } from "@/db";
import { can, requirePermission } from "@/lib/auth/session";
import { listFanpages } from "@/lib/attribution/fanpage";
import {
  ATTRIBUTION_STATUSES,
  ATTRIBUTION_STATUS_FIX,
  ATTRIBUTION_STATUS_HINT,
  ATTRIBUTION_STATUS_LABEL,
  ATTRIBUTION_STATUS_TONE,
  DUPLICATE_CANDIDATE_WINDOW_HOURS,
  DUPLICATE_SCORE_THRESHOLD,
} from "@/lib/constants/fanpage-attribution";
import { formatDateTime, formatNumber, formatVND, pctOrNull } from "@/lib/format";
import { marketerLabel, marketerNames } from "@/lib/queries/order-marketer";
import {
  ATTR_UNATTRIBUTED,
  ATTR_UNATTRIBUTED_LABEL,
  getMarketerAttributionReport,
  listAttributionMarketers,
  listAttributionOrders,
  listAttributionPages,
  listMarketerOptions,
} from "@/lib/queries/fanpage-attribution";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { sql } from "drizzle-orm";

export const metadata = { title: "Fanpage & quy kết marketer" };

const TABS = new Set(["report", "orders", "assign"]);

/** Số đơn mỗi fanpage — để người khai biết page nào đáng gán trước. */
async function ordersByPage(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db
    .select({ pageId: schema.orders.pageId, n: sql<number>`count(*)::int` })
    .from(schema.orders)
    .where(sql`coalesce(${schema.orders.pageId}, '') <> ''`)
    .groupBy(schema.orders.pageId);
  return new Map(rows.filter((r) => r.pageId).map((r) => [r.pageId as string, Number(r.n)]));
}

export default async function FanpageAttributionPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // Xem: cùng quyền với báo cáo marketer đang có. Sửa: cùng quyền đã khai là "fanpage → marketer".
  const user = await requirePermission("reports:nominal");
  const canWrite = can(user, "payroll:manage");
  const raw = await searchParams;
  const tabParam = param(raw, "tab");
  const tab = TABS.has(tabParam) ? tabParam : "report";
  const params = parseListParams(raw, { defaultSort: "sourceOrderAt", defaultDir: "desc", defaultPeriod: "30d", defaultPageSize: 50 });

  const mkt = param(raw, "mkt") || null;
  const pageFilter = param(raw, "fp") || null;
  const sku = param(raw, "sku") || null;
  const status = param(raw, "st") || null;
  const filters = { marketerId: mkt, pageId: pageFilter, sku };

  const [report, pageOptions, marketerFacet] = await Promise.all([
    getMarketerAttributionReport(params.period, filters),
    listAttributionPages(params.period),
    listAttributionMarketers(params.period),
  ]);

  const totalAttributed = report.byStatus.ATTRIBUTED;
  const coverage = pctOrNull(totalAttributed, report.totalOrders);

  const facets = [
    ...(marketerFacet.length ? [{ key: "mkt", label: "Marketer", options: [...marketerFacet.map((m) => ({ value: m.id, label: m.label, count: 0 })), { value: ATTR_UNATTRIBUTED, label: ATTR_UNATTRIBUTED_LABEL, count: 0 }] }] : []),
    ...(pageOptions.length ? [{ key: "fp", label: "Fanpage", options: pageOptions.map((p) => ({ value: p.id, label: p.label, count: 0 })) }] : []),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Marketing"
        title="Fanpage & quy kết marketer"
        description={`${formatNumber(report.totalOrders)} đơn trong kỳ · ${formatNumber(totalAttributed)} quy kết được${coverage === null ? "" : ` (${coverage}%)`} · ${formatVND(report.totalConfirmedRevenue)} doanh thu xác nhận`}
        hint={
          <>
            Đơn phát sinh trên một fanpage được tính cho người phụ trách fanpage đó <b>tại mốc đơn lên</b>
            {" "}(mốc của Pancake, không phải mốc ERP đồng bộ). Đổi người phụ trách <b>không</b> làm đổi số của
            kỳ trước, vì mỗi phân công có khoảng hiệu lực riêng và mỗi đơn giữ lại ảnh chụp căn cứ đã dùng.
            {" "}Doanh thu ở đây là <b>doanh thu đơn đã xác nhận trên Pancake</b> — không phải COD, không phải
            tiền Viettel Post đã thu, không phải doanh thu giao thành công.
          </>
        }
        actions={canWrite ? <ReconcileButton /> : null}
      />

      {report.missing > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          <AlertTriangle className="size-4 shrink-0" />
          <span>
            <b>{formatNumber(report.missing)}</b> đơn trong kỳ chưa có dòng quy kết — bảng dưới đang thiếu đúng chừng ấy đơn.
            {canWrite ? " Bấm “Đối soát lại” để dựng lại." : " Nhờ người có quyền khai báo chạy “Đối soát lại”."}
          </span>
        </div>
      ) : null}

      <FanpageTabs active={tab} />

      {tab === "assign" ? (
        <AssignTab canWrite={canWrite} />
      ) : (
        <>
          <DataTableToolbar
            searchPlaceholder={tab === "orders" ? "SĐT, tên khách, mã đơn…" : undefined}
            period={{ defaultKey: "30d" }}
            facets={facets}
            resultLabel={
              <>
                {formatNumber(report.totalConfirmedOrders)} đơn đã xác nhận · {formatVND(report.totalConfirmedRevenue)}
                {report.duplicates.orders ? ` · ${formatNumber(report.duplicates.orders)} đơn trùng bị loại (${formatVND(report.duplicates.revenue)})` : ""}
              </>
            }
          >
            <SkuFilter />
          </DataTableToolbar>

          <SectionCard
            title="Độ phủ quy kết"
            description={`Mỗi đơn thuộc đúng một nhóm — cộng bốn nhóm bằng tổng số đơn của kỳ. Trùng đơn cần ĐỦ CHỨNG CỨ (≥ ${DUPLICATE_SCORE_THRESHOLD} điểm), tìm trong cửa sổ ${DUPLICATE_CANDIDATE_WINDOW_HOURS} giờ — riêng cửa sổ không bao giờ đủ để kết luận.`}
          >
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {ATTRIBUTION_STATUSES.map((s) => {
                const n = report.byStatus[s] ?? 0;
                const p = pctOrNull(n, report.totalOrders);
                return (
                  <div key={s} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn("rounded px-1.5 py-0.5 text-[11.5px] font-medium", ATTRIBUTION_STATUS_TONE[s])}>{ATTRIBUTION_STATUS_LABEL[s]}</span>
                      <span className="font-mono text-sm font-semibold">{formatNumber(n)}</span>
                    </div>
                    <p className="mt-1 text-[11.5px] text-muted-foreground">
                      {p === null ? "—" : `${p}% số đơn`} · {ATTRIBUTION_STATUS_HINT[s]}
                    </p>
                    {ATTRIBUTION_STATUS_FIX[s] && n > 0 ? <p className="mt-1 text-[11.5px] text-amber-700 dark:text-amber-400">{ATTRIBUTION_STATUS_FIX[s]}</p> : null}
                  </div>
                );
              })}
            </div>
          </SectionCard>

          {tab === "orders" ? (
            <OrdersTab params={params} filters={{ ...filters, status }} />
          ) : (
            <SectionCard title="Theo marketer" description="Doanh thu xác nhận = tổng giá trị đơn đã xác nhận trên Pancake. Đơn trùng không tính cho ai.">
              {report.rows.length === 0 ? (
                <EmptyState title="Chưa có đơn nào trong kỳ" description="Đổi kỳ hoặc bỏ bớt bộ lọc." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-[13px]">
                    <thead className="text-left text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-2 pr-3 font-medium">Marketer</th>
                        <th className="py-2 pr-3 text-right font-medium">Fanpage</th>
                        <th className="py-2 pr-3 text-right font-medium">Đơn quy kết</th>
                        <th className="py-2 pr-3 text-right font-medium">Đơn đã xác nhận</th>
                        <th className="py-2 pr-3 text-right font-medium">Doanh thu xác nhận</th>
                        <th className="py-2 pr-3 text-right font-medium">DT / đơn</th>
                        <th className="py-2 pr-3 text-right font-medium">Trùng bị loại</th>
                        <th className="py-2 text-right font-medium">Tỷ lệ chốt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.rows.map((r) => {
                        const rate = pctOrNull(r.confirmedOrders, r.attributedOrders);
                        return (
                          <tr key={r.marketerId ?? ATTR_UNATTRIBUTED} className={cn("border-b last:border-0", r.marketerId === null && "text-muted-foreground")}>
                            <td className="py-2 pr-3 font-medium">
                              <Link className="hover:underline" href={{ pathname: "/marketing/fanpages", query: { tab: "orders", mkt: r.marketerId ?? ATTR_UNATTRIBUTED, period: params.period.key, ...(params.period.fromKey ? { from: params.period.fromKey, to: params.period.toKey ?? "" } : {}) } }}>
                                {r.label}
                              </Link>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono">{formatNumber(r.pages)}</td>
                            <td className="py-2 pr-3 text-right font-mono">{formatNumber(r.attributedOrders)}</td>
                            <td className="py-2 pr-3 text-right font-mono">{formatNumber(r.confirmedOrders)}</td>
                            <td className="py-2 pr-3 text-right font-mono font-semibold">{formatVND(r.confirmedRevenue)}</td>
                            <td className="py-2 pr-3 text-right font-mono">{r.revenuePerOrder === null ? "—" : formatVND(r.revenuePerOrder)}</td>
                            <td className="py-2 pr-3 text-right font-mono">
                              {r.duplicateExcluded ? (
                                <Link className="hover:underline" href={{ pathname: "/marketing/fanpages", query: { tab: "orders", st: "DUPLICATE", period: params.period.key, ...(params.period.fromKey ? { from: params.period.fromKey, to: params.period.toKey ?? "" } : {}) } }}>
                                  {formatNumber(r.duplicateExcluded)}
                                </Link>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </td>
                            <td className="py-2 text-right font-mono">{rate === null ? "—" : `${rate}%`}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 font-semibold">
                        <td className="py-2 pr-3">Tổng</td>
                        <td className="py-2 pr-3" />
                        <td className="py-2 pr-3 text-right font-mono">{formatNumber(report.rows.reduce((t, r) => t + r.attributedOrders, 0))}</td>
                        <td className="py-2 pr-3 text-right font-mono">{formatNumber(report.totalConfirmedOrders)}</td>
                        <td className="py-2 pr-3 text-right font-mono">{formatVND(report.totalConfirmedRevenue)}</td>
                        <td className="py-2 pr-3 text-right font-mono">{report.totalConfirmedOrders > 0 ? formatVND(Math.round(report.totalConfirmedRevenue / report.totalConfirmedOrders)) : "—"}</td>
                        <td className="py-2 pr-3 text-right font-mono">{formatNumber(report.duplicates.orders)}</td>
                        <td className="py-2" />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </SectionCard>
          )}
        </>
      )}
    </div>
  );
}

/** Bảng khai báo — tách hàm để trang chính không phải nạp dữ liệu của tab đang không mở. */
async function AssignTab({ canWrite }: { canWrite: boolean }) {
  const [pages, counts, marketers, names] = await Promise.all([listFanpages(), ordersByPage(), listMarketerOptions(), marketerNames()]);
  const view: FanpageView[] = pages.map((p) => ({
    id: p.id,
    externalPageId: p.externalPageId,
    name: p.name,
    active: p.active,
    orders: counts.get(p.externalPageId) ?? 0,
    firstOrderAt: p.firstOrderAt ? p.firstOrderAt.toISOString() : null,
    lastOrderAt: p.lastOrderAt ? p.lastOrderAt.toISOString() : null,
    current: p.current ? { assignmentId: p.current.assignmentId, marketerId: p.current.marketerId, marketerLabel: marketerLabel(p.current.marketerId, names), effectiveFrom: p.current.effectiveFrom.toISOString() } : null,
    history: p.history.map((h) => ({ id: h.id, marketerLabel: marketerLabel(h.marketerId, names), effectiveFrom: h.effectiveFrom.toISOString(), effectiveTo: h.effectiveTo ? h.effectiveTo.toISOString() : null, active: h.active, note: h.note })),
  }));
  const unassigned = view.filter((p) => !p.current && p.orders > 0).length;
  return (
    <SectionCard
      title="Gán fanpage → marketer"
      description={
        unassigned > 0
          ? `${formatNumber(unassigned)} fanpage đang có đơn nhưng chưa ai phụ trách — đơn của chúng không quy kết được cho ai.`
          : "Mọi fanpage có đơn đều đã có người phụ trách."
      }
    >
      <AssignPanel pages={view} marketers={marketers as MarketerOption[]} canWrite={canWrite} />
    </SectionCard>
  );
}

/** Soi từng đơn — một báo cáo quy kết không mở ra được tới từng đơn là một báo cáo không kiểm chứng được. */
async function OrdersTab({ params, filters }: { params: ReturnType<typeof parseListParams>; filters: { marketerId: string | null; pageId: string | null; sku: string | null; status: string | null } }) {
  const { rows, total, pageCount } = await listAttributionOrders(params, filters);
  return (
    <SectionCard title="Từng đơn" description="Mốc hiển thị là MỐC ĐƠN LÊN TẠI PANCAKE — cùng mốc mà luật trùng đơn dùng để quyết ai thắng.">
      {rows.length === 0 ? (
        <EmptyState title="Không có đơn nào khớp bộ lọc" description="Đổi kỳ, bỏ bớt bộ lọc, hoặc chạy đối soát nếu vừa gán fanpage." />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-[12.5px]">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-medium">Đơn</th>
                  <th className="py-2 pr-3 font-medium">Lên lúc (Pancake)</th>
                  <th className="py-2 pr-3 font-medium">Fanpage</th>
                  <th className="py-2 pr-3 font-medium">Marketer</th>
                  <th className="py-2 pr-3 font-medium">Khách</th>
                  <th className="py-2 pr-3 font-medium">Mã hàng · biến thể × SL</th>
                  <th className="py-2 pr-3 font-medium">Tình trạng</th>
                  <th className="py-2 pr-3 text-right font-medium">Doanh thu xác nhận</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.orderId} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3">
                      <Link className="font-medium hover:underline" href={`/orders/${r.orderId}`}>
                        {r.systemId ? `#${r.systemId}` : r.orderId}
                      </Link>
                      <div className="text-[11px] text-muted-foreground">{r.stage}</div>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(r.sourceOrderAt)}</td>
                    <td className="py-2 pr-3">
                      <div>{r.pageName || "—"}</div>
                      <code className="text-[11px] text-muted-foreground">{r.pageId ?? "không có page"}</code>
                    </td>
                    <td className="py-2 pr-3">{r.marketerLabel}</td>
                    <td className="py-2 pr-3">
                      <div>{r.customer || "—"}</div>
                      <div className="text-[11px] text-muted-foreground">{r.phone}</div>
                    </td>
                    <td className="py-2 pr-3 whitespace-pre-line">{r.items ? r.items.split(" | ").join("\n") : "—"}</td>
                    <td className="py-2 pr-3">
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", ATTRIBUTION_STATUS_TONE[r.status])}>{ATTRIBUTION_STATUS_LABEL[r.status]}</span>
                      {r.duplicateOfOrderId ? (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          trùng với{" "}
                          <Link className="underline" href={`/orders/${r.duplicateOfOrderId}`}>
                            đơn trước
                          </Link>
                          {r.duplicateSignals.length ? (
                            <div className="mt-0.5">
                              căn cứ ({r.duplicateScore} điểm): {r.duplicateSignals.join(" · ")}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">{r.confirmed ? formatVND(r.revenue) : <span className="text-muted-foreground">chưa xác nhận</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <UrlPagination pageCount={pageCount} total={total} />
          </div>
        </>
      )}
    </SectionCard>
  );
}
