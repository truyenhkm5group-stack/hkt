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
import { CONFIRMED_STAGES } from "@/lib/constants/pancake";
import { fanpageAccessStatus, fanpageDisplayName } from "@/lib/constants/fanpage-access";
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
import { ATTRIBUTION_SOURCE_LABEL, LANDING_EVIDENCE_LABEL, LANDING_GAP_FIX, LANDING_GAP_LABEL } from "@/lib/constants/landing-attribution";
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
  NO_PAGE_GROUPS,
  NO_PAGE_GROUP_HINT,
  NO_PAGE_GROUP_LABEL,
} from "@/lib/queries/fanpage-attribution";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { sql } from "drizzle-orm";

export const metadata = { title: "Fanpage & quy kết marketer" };

const TABS = new Set(["report", "orders", "assign"]);

/** Số đơn mỗi fanpage — để người khai biết page nào đáng gán trước. */
type PageTally = { orders: number; confirmedOrders: number; confirmedRevenue: number };

/** Đơn KHÔNG có `page_id` — nhóm thứ tư, và nó không thuộc fanpage nào nên đếm riêng. */
async function noPageTally(): Promise<PageTally> {
  const db = await getDb();
  const confirmed = sql`${schema.orders.stage} in (${sql.join(CONFIRMED_STAGES.map((x) => sql`${x}`), sql`, `)})`;
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      confirmedOrders: sql<number>`count(*) filter (where ${confirmed})::int`,
      confirmedRevenue: sql<number>`coalesce(sum(${schema.orders.totalPriceAfterDiscount}) filter (where ${confirmed}), 0)::bigint`,
    })
    .from(schema.orders)
    .where(sql`coalesce(${schema.orders.pageId}, '') = ''`);
  return { orders: Number(row?.n ?? 0), confirmedOrders: Number(row?.confirmedOrders ?? 0), confirmedRevenue: Number(row?.confirmedRevenue ?? 0) };
}

/** Số đơn / đơn đã xác nhận / doanh thu xác nhận theo từng Page ID — để page CHƯA gán cũng thấy được đang treo bao nhiêu. */
async function ordersByPage(): Promise<Map<string, PageTally>> {
  const db = await getDb();
  const confirmed = sql`${schema.orders.stage} in (${sql.join(CONFIRMED_STAGES.map((x) => sql`${x}`), sql`, `)})`;
  const rows = await db
    .select({
      pageId: schema.orders.pageId,
      n: sql<number>`count(*)::int`,
      confirmedOrders: sql<number>`count(*) filter (where ${confirmed})::int`,
      confirmedRevenue: sql<number>`coalesce(sum(${schema.orders.totalPriceAfterDiscount}) filter (where ${confirmed}), 0)::bigint`,
    })
    .from(schema.orders)
    .where(sql`coalesce(${schema.orders.pageId}, '') <> ''`)
    .groupBy(schema.orders.pageId);
  return new Map(
    rows
      .filter((r) => r.pageId)
      .map((r) => [r.pageId as string, { orders: Number(r.n), confirmedOrders: Number(r.confirmedOrders), confirmedRevenue: Number(r.confirmedRevenue) }]),
  );
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
  /*
    LỌC RIÊNG ĐƠN LANDING. Nguồn quy kết là một CHIỀU KHÁC với tình trạng: một đơn landing có thể
    đã quy kết được (`LANDING_UTM`) hoặc còn treo (`NO_PAGE` nhưng có dòng landing). Gộp hai chiều
    vào một ô chọn sẽ làm không cách nào xem "tất cả đơn landing" trong một lần.
  */
  const source = param(raw, "src") || null;
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
    {
      key: "src",
      label: "Nguồn quy kết",
      options: [
        { value: "LANDING", label: "Landing (mọi đơn có form)", count: 0 },
        { value: "LANDING_UTM", label: "Landing — đã quy kết bằng tracking", count: 0 },
        { value: "LANDING_UNRESOLVED", label: "Landing — chưa đủ bằng chứng", count: 0 },
        { value: "PANCAKE_PAGE", label: "Fanpage (Pancake)", count: 0 },
      ],
    },
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
        <AssignTab canWrite={canWrite} noPageOrders={await noPageTally()} />
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

          {/*
            NHÓM "KHÔNG CÓ FANPAGE" TÁCH RA BỐN LOẠI.

            Gộp landing với đơn nhập tay thành một con số duy nhất là cách chắc chắn nhất để không
            ai sửa gì cả: hai loại ấy có hai cách sửa hoàn toàn khác nhau, và một trong hai CỨU
            ĐƯỢC bằng tracking quảng cáo. Thẻ đầu tiên chính là phần đã cứu — nó KHÔNG còn nằm
            trong "không có fanpage" nữa.
          */}
          {NO_PAGE_GROUPS.some((g) => report.noPageGroups[g].orders > 0) ? (
            <SectionCard
              title="Đơn không mang page_id của Pancake — tách theo loại"
              description="Đơn landing có đủ bằng chứng tracking đã RA KHỎI nhóm “không có fanpage”. Ba nhóm còn lại là ba việc phải làm khác nhau."
            >
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {NO_PAGE_GROUPS.map((g) => {
                  const b = report.noPageGroups[g];
                  return (
                    <div key={g} className="rounded-lg border p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[11.5px] font-medium">{NO_PAGE_GROUP_LABEL[g]}</span>
                        <span className={cn("font-mono text-sm font-semibold", g === "LANDING_ATTRIBUTED" && b.orders > 0 && "text-success")}>{formatNumber(b.orders)}</span>
                      </div>
                      <p className="mt-1 text-[11.5px] text-muted-foreground">
                        {b.confirmedOrders > 0 ? `${formatNumber(b.confirmedOrders)} đơn xác nhận · ${formatVND(b.confirmedRevenue)} · ` : ""}
                        {NO_PAGE_GROUP_HINT[g]}
                      </p>
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          ) : null}

          {tab === "orders" ? (
            <OrdersTab params={params} filters={{ ...filters, status, source }} />
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
async function AssignTab({ canWrite, noPageOrders }: { canWrite: boolean; noPageOrders: PageTally }) {
  const [pages, counts, marketers, names] = await Promise.all([listFanpages(), ordersByPage(), listMarketerOptions(), marketerNames()]);
  // Mốc liệt kê API GẦN NHẤT của cả sổ — tính MỘT lần rồi truyền vào, để 15 page không thành 15 lượt quét.
  const newestSeen = pages.reduce<Date | null>((acc, p) => (p.lastSeenInApiAt && (!acc || p.lastSeenInApiAt > acc) ? p.lastSeenInApiAt : acc), null);
  const view: FanpageView[] = pages.map((p) => {
    const tally = counts.get(p.externalPageId) ?? { orders: 0, confirmedOrders: 0, confirmedRevenue: 0 };
    return {
      id: p.id,
      externalPageId: p.externalPageId,
      name: fanpageDisplayName(p),
      alias: p.alias,
      externalName: p.name,
      access: fanpageAccessStatus(p.lastSeenInApiAt, newestSeen),
      active: p.active,
      orders: tally.orders,
      confirmedOrders: tally.confirmedOrders,
      confirmedRevenue: tally.confirmedRevenue,
      firstOrderAt: p.firstOrderAt ? p.firstOrderAt.toISOString() : null,
      lastOrderAt: p.lastOrderAt ? p.lastOrderAt.toISOString() : null,
      current: p.current ? { assignmentId: p.current.assignmentId, marketerId: p.current.marketerId, marketerLabel: marketerLabel(p.current.marketerId, names), effectiveFrom: p.current.effectiveFrom.toISOString() } : null,
      history: p.history.map((h) => ({ id: h.id, marketerLabel: marketerLabel(h.marketerId, names), effectiveFrom: h.effectiveFrom.toISOString(), effectiveTo: h.effectiveTo ? h.effectiveTo.toISOString() : null, active: h.active, note: h.note })),
    };
  });

  /*
    BỐN NHÓM, và ranh giới giữa chúng là hai câu hỏi KHÁC NHAU:
      · đã gán ai chưa?           → quyết định đơn có quy kết được không;
      · API còn đọc được tên không? → chỉ quyết định màn hình hiện tên hay hiện 15 chữ số.
    Trộn hai câu ấy là cách một page lịch sử trở thành không quản lý được.
  */
  const mapped = view.filter((p) => p.current);
  const unmapped = view.filter((p) => !p.current);
  const unmappedHistorical = unmapped.filter((p) => p.access === "HISTORICAL");
  const unmappedActive = unmapped.filter((p) => p.access !== "HISTORICAL");
  const treoOrders = unmapped.reduce((t, p) => t + p.orders, 0);
  const treoRevenue = unmapped.reduce((t, p) => t + p.confirmedRevenue, 0);

  const group = (title: string, desc: React.ReactNode, list: FanpageView[]) =>
    list.length ? (
      <SectionCard title={title} description={desc}>
        <AssignPanel pages={list} marketers={marketers as MarketerOption[]} canWrite={canWrite} />
      </SectionCard>
    ) : null;

  return (
    <div className="space-y-4">
      {group(
        `Chưa gán · còn quyền truy cập (${formatNumber(unmappedActive.length)})`,
        <>
          Page Pancake vẫn đọc được nhưng <b>chưa ai phụ trách</b> — đơn của chúng không quy kết được cho ai.
        </>,
        unmappedActive,
      )}
      {group(
        `Chưa gán · page lịch sử (${formatNumber(unmappedHistorical.length)})`,
        <>
          Token Pancake hiện tại <b>không còn đọc được</b> những page này, nên không có tên. Quy kết đi bằng <b>Page ID</b> nên vẫn gán
          được bình thường — đặt một <b>tên gợi nhớ</b> để nhận ra page, rồi gán như thường.
        </>,
        unmappedHistorical,
      )}
      {group(
        `Đã gán (${formatNumber(mapped.length)})`,
        `${formatNumber(mapped.length)} fanpage đã có người phụ trách.`,
        mapped,
      )}
      <SectionCard
        title="Đơn không có nguồn fanpage"
        description="Pancake không gửi `page_id` cho những đơn này — chúng KHÔNG thuộc fanpage nào, nên không ép vào mô hình Fanpage → MKTer."
      >
        <p className="text-[13px]">
          <b>{formatNumber(noPageOrders.orders)}</b> đơn · <b>{formatNumber(noPageOrders.confirmedOrders)}</b> đã xác nhận ·{" "}
          <b>{formatVND(noPageOrders.confirmedRevenue)}</b>{" "}
          <Link className="underline" href={{ pathname: "/marketing/fanpages", query: { tab: "orders", st: "NO_PAGE", period: "all" } }}>
            xem danh sách
          </Link>
        </p>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          Phần lớn là đơn landing page và đơn nhập tay. Đã dò payload gốc Pancake: không đơn nào mang `page_id`, và không đơn nào có
          `conversation_id` / `post_id` để suy ra — nên KHÔNG có gì để backfill.
        </p>
      </SectionCard>
      {unmapped.length ? (
        <p className="text-[12px] text-muted-foreground">
          Tổng đang treo ở {formatNumber(unmapped.length)} page chưa gán: <b>{formatNumber(treoOrders)}</b> đơn ·{" "}
          <b>{formatVND(treoRevenue)}</b> doanh thu xác nhận.
        </p>
      ) : null}
    </div>
  );
}

/** Soi từng đơn — một báo cáo quy kết không mở ra được tới từng đơn là một báo cáo không kiểm chứng được. */
async function OrdersTab({ params, filters }: { params: ReturnType<typeof parseListParams>; filters: { marketerId: string | null; pageId: string | null; sku: string | null; status: string | null; source: string | null } }) {
  const { rows, total, pageCount } = await listAttributionOrders(params, filters);
  return (
    <SectionCard title="Từng đơn" description="Mốc hiển thị là MỐC ĐƠN LÊN TẠI PANCAKE — cùng mốc mà luật trùng đơn dùng để quyết ai thắng.">
      {rows.length === 0 ? (
        <EmptyState title="Không có đơn nào khớp bộ lọc" description="Đổi kỳ, bỏ bớt bộ lọc, hoặc chạy đối soát nếu vừa gán fanpage." />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] text-[12.5px]">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-medium">Đơn</th>
                  <th className="py-2 pr-3 font-medium">Lên lúc (Pancake)</th>
                  <th className="py-2 pr-3 font-medium">Nguồn · quy kết qua</th>
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
                    {/*
                      NGUỒN QUY KẾT ĐỨNG NGAY CẠNH KẾT LUẬN.

                      Hai đường trả lời cùng một câu hỏi bằng hai loại chứng cứ: `page_id` là CHỨNG
                      TỪ của Pancake, còn tracking landing là SUY LUẬN có căn cứ. Người đọc phải
                      phân biệt được ngay trên dòng, nên cột này in cả chuỗi bằng chứng đầy đủ.
                    */}
                    <td className="py-2 pr-3">
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", r.attributionSource === "LANDING_UTM" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>
                        {ATTRIBUTION_SOURCE_LABEL[r.attributionSource]}
                      </span>
                      {r.landing ? (
                        <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground" title={r.landing.evidence}>
                          {r.landing.tier ? <div>Căn cứ: {LANDING_EVIDENCE_LABEL[r.landing.tier]}</div> : null}
                          {r.landing.adId ? <div>Ad: <code>{r.landing.adId}</code></div> : null}
                          {r.landing.adsetId ? <div>Adset: <code>{r.landing.adsetId}</code></div> : null}
                          {r.landing.campaignId ? <div>Chiến dịch: <code>{r.landing.campaignId}</code></div> : null}
                          {r.landing.campaignName ? <div className="max-w-[240px] truncate" title={r.landing.campaignName}>utm: {r.landing.campaignName}</div> : null}
                          {r.landing.utmCampaign ? <div className="max-w-[240px] truncate" title={r.landing.utmCampaign}>Meta: {r.landing.utmCampaign}</div> : null}
                          {r.landing.adAccountId ? <div>TKQC: <code>{r.landing.adAccountId}</code></div> : null}
                          {r.landing.landingUrl ? <div className="max-w-[240px] truncate" title={r.landing.landingUrl}>Landing: {r.landing.landingUrl}</div> : null}
                          {r.landing.gap ? <div className="text-amber-700 dark:text-amber-400">{LANDING_GAP_LABEL[r.landing.gap]} — {LANDING_GAP_FIX[r.landing.gap]}</div> : null}
                          {r.landing.productMismatch ? (
                            <div className="text-amber-700 dark:text-amber-400">
                              Chiến dịch nói mã {r.landing.campaignProductCode}, đơn lại là mã khác — mã của đơn GIỮ NGUYÊN, đánh dấu để rà.
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      {/*
                        KHÔNG BẮT BUỘC CÓ PAGE MỚI ĐƯỢC QUY KẾT. Đơn landing xác định chắc
                        chiến dịch → TKQC → marketer nhưng không có bằng chứng nào về fanpage thì
                        ô này nói thẳng "Không xác định" — KHÔNG bịa một Page ID, và cũng không để
                        người đọc tưởng là thiếu dữ liệu.
                      */}
                      <div>{r.attributionSource === "LANDING_UTM" && !r.pageId && !r.landing?.inferredPageId ? <span className="text-muted-foreground">Không xác định</span> : r.pageName || "—"}</div>
                      {r.pageId ? <code className="text-[11px] text-muted-foreground">{r.pageId}</code> : null}
                      {r.landing?.inferredPageId ? (
                        <div className="mt-0.5 text-[11px] text-muted-foreground" title="Fanpage SUY RA từ mẩu quảng cáo — khác hẳn page_id do Pancake gửi.">
                          suy ra từ QC: <code>{r.landing.inferredPageId}</code>
                        </div>
                      ) : null}
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
