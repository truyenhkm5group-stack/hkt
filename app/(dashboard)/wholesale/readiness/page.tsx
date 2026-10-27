import Link from "next/link";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { wholesaleReadinessBoard } from "@/lib/queries/wholesale-readiness";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { CATALOG_CHECK_LABEL, CATALOG_CHECKS, EXPORT_STATUS_LABEL, pageReadinessRows, READINESS_FILTERS, READINESS_SORTABLE, READINESS_STATUS_LABEL, type ExportItemStatus } from "@/lib/wholesale/catalog-readiness";
import { WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { ReadinessTable } from "@/app/(dashboard)/wholesale/readiness/readiness-table";
import { cn } from "@/lib/utils";

export const metadata = { title: "Sẵn sàng bán sỉ" };

const EXPORT_TONE: Record<ExportItemStatus, string> = {
  AVAILABLE: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  PARTIAL: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  MISSING: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  UNAVAILABLE: "bg-muted text-foreground",
};

/**
 * SẴN SÀNG BÁN SỈ / XUẤT KHẨU (docs/tech/hslc-b2b-sales-agent.md · P1c) — CHỈ ĐỌC. Danh mục chưa đủ dữ kiện thì AI B2B không
 * được báo giá: trang này nói mẫu mã nào thiếu ĐÚNG cái gì. Dữ liệu là danh mục của tổ chức, không phải lead, nên không lọc
 * theo phạm vi lead; quyền `wholesale:view`, module `wholesale_leads` (tuyến `/wholesale`).
 */
export default async function WholesaleReadinessPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("wholesale:view");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "missingCount", defaultDir: "desc", filterKeys: READINESS_FILTERS, sortable: [...READINESS_SORTABLE], defaultPageSize: 50 });
  const board = await wholesaleReadinessBoard();
  const s = board.summary;
  const page = pageReadinessRows(board.rows, params);
  const ex = board.exportReadiness;
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Săn khách sỉ"
        title="Sẵn sàng bán sỉ"
        description={`${formatNumber(s.ready)}/${formatNumber(s.total)} mẫu mã đang bán đủ dữ kiện để báo giá sỉ · ${formatNumber(s.missingBy.PRICE_TIER)} thiếu bậc giá · ${formatNumber(s.missingBy.STOCK)} chưa biết tồn.`}
        hint="Chỉ đọc. Bậc giá đọc ở BẢNG GIÁ MẶC ĐỊNH đang bật — khách sỉ mới (chưa gán bảng riêng) chỉ nhận giá từ bảng này, thiếu thì nhận giá lẻ. MOQ = bậc «mua từ» nhỏ nhất. Tồn theo sổ kho: chưa có phiếu nhập là CHƯA BIẾT, không phải 0. Mô tả / bảo quản đọc field sản phẩm của mẫu ngành; hạng mục ERP không có nguồn hiện «ERP chưa có nguồn», không đoán."
      />
      <WholesaleNav user={user} active="readiness" />

      <StatStrip
        columns={4}
        items={[
          { label: "Sẵn sàng bán sỉ", value: `${formatNumber(s.ready)}/${formatNumber(s.total)}`, note: `${formatNumber(s.missing)} mẫu còn thiếu`, tone: "green" },
          { label: "Thiếu bậc giá sỉ", value: formatNumber(s.missingBy.PRICE_TIER), note: board.sources.defaultListName ? `bảng mặc định «${board.sources.defaultListName}»` : "chưa có bảng mặc định", href: "/products/price-lists" },
          { label: "Tồn chưa biết", value: formatNumber(s.missingBy.STOCK), note: "chưa có phiếu nhập" },
          { label: "Thiếu khối lượng · ảnh · mô tả", value: `${formatNumber(s.missingBy.WEIGHT)} · ${formatNumber(s.missingBy.IMAGE)} · ${formatNumber(s.missingBy.DESCRIPTION)}`, note: `${formatNumber(s.outOfStock)} mẫu hết hàng khả dụng` },
        ]}
      />
      {board.truncated ? <p className="text-xs text-amber-700 dark:text-amber-400">Danh mục dài hơn 3.000 mẫu mã — trang chỉ xét 3.000 mẫu đầu theo tên.</p> : null}

      <SectionCard
        title="Sẵn sàng xuất khẩu"
        description={ex.ready ? "Đủ mọi hạng mục." : `CHƯA sẵn sàng — ${ex.unavailable}/${ex.items.length} hạng mục ERP chưa có nguồn dữ liệu. AI không được nhắc tới chứng nhận / mã HS / xuất khẩu khi ô tương ứng chưa đủ.`}
        padded={false}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-export-readiness>
            <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Hạng mục</th>
                <th className="px-4 py-2">Trạng thái</th>
                <th className="px-4 py-2 text-right">Phủ</th>
                <th className="px-4 py-2">Thiếu gì / nguồn</th>
              </tr>
            </thead>
            <tbody>
              {ex.items.map((i) => (
                <tr key={i.key} className="border-t border-hairline align-top" data-export-item={i.key}>
                  <td className="px-4 py-2 font-medium">{i.label}</td>
                  <td className="px-4 py-2">
                    <span className={cn("inline-flex whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold", EXPORT_TONE[i.status])}>{EXPORT_STATUS_LABEL[i.status]}</span>
                  </td>
                  <td className="numeric whitespace-nowrap px-4 py-2 text-right">{i.covered === null ? "—" : `${formatNumber(i.covered)}/${formatNumber(i.total)}`}</td>
                  <td className="max-w-[560px] px-4 py-2 text-xs">
                    {i.missingWhat ? <div>{i.missingWhat}</div> : null}
                    {i.source ? <div className="text-muted-foreground">Nguồn: {i.source}</div> : null}
                    {i.note ? <div className="text-muted-foreground">{i.note}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <DataTableToolbar
        searchPlaceholder="Tên sản phẩm, SKU, quy cách…"
        period={false}
        facets={[
          { key: "status", label: "Kết luận", options: (["READY", "MISSING"] as const).map((v) => ({ value: v, label: READINESS_STATUS_LABEL[v] })) },
          { key: "missing", label: "Thiếu", options: CATALOG_CHECKS.map((k) => ({ value: k, label: `${CATALOG_CHECK_LABEL[k]} (${formatNumber(s.missingBy[k])})` })) },
        ]}
        resultLabel={`${formatNumber(page.total)} mẫu mã`}
      />
      {s.total === 0 ? (
        <EmptyState
          title="Chưa có mẫu mã nào đang bán"
          description={
            <>
              Thêm sản phẩm ở <Link href="/products" className="underline">trang Sản phẩm</Link> rồi quay lại đây.
            </>
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <ReadinessTable rows={page.rows} total={page.total} pageCount={page.pageCount} />
        </div>
      )}
    </div>
  );
}
