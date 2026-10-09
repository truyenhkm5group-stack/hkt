import Link from "next/link";
import { shellAllows } from "@/lib/constants/saas-nav";
import { Filter, HeartHandshake, Plus, RotateCcw, UserPlus, Users } from "lucide-react";
import { CustomersTable } from "@/app/(dashboard)/customers/customers-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { ModuleSyncButton } from "@/components/module-sync-button";
import { Button } from "@/components/ui/button";
import { formatNumber, formatPercent, formatVND, pctOrNull } from "@/lib/format";
import { customerFacets, customerSummary, CUSTOMER_SORTABLE, listCustomers } from "@/lib/queries/customers";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { requireResource } from "@/lib/auth/scope-guard";
import { ScopeDenied } from "@/components/scope-denied";
import { describeListFilter, listViewDefaultSort } from "@/components/metadata/runtime-core";
import { CUSTOMER_LIST_REF_COLUMNS } from "@/lib/constants/metadata-list-columns";
import { getListMetadata, listCustomValuesFor, listMetadataFilterSql } from "@/lib/queries/metadata-lists";
import { customerCreateGate } from "@/lib/records/customer-create";
import { getBrandCopy } from "@/lib/branding/service";

/** Tham số URL tắt bộ lọc mặc định của danh sách đã xuất bản (người xem phải bỏ được lọc mình không chọn). */
const META_FILTER_OFF = "mf";

export const metadata = { title: "Khách hàng" };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, decision } = await requireResource("CUSTOMERS", "customers:view");
  // Phạm vi hẹp hơn thứ dữ liệu này biểu diễn được ⇒ TỪ CHỐI và nói rõ, không cho xem hết.
  if (decision.allow === "NONE") return <ScopeDenied title="Khách hàng" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  // Danh sách đã xuất bản (M9): thứ tự/ẩn cột, cột custom, sắp xếp + bộ lọc mặc định. `null` ⇒ y như trước.
  const [meta, createGate, copy] = await Promise.all([getListMetadata("customer", "default", user), customerCreateGate(user), getBrandCopy(user)]);
  const metaSort = listViewDefaultSort(meta?.schema, CUSTOMER_LIST_REF_COLUMNS, CUSTOMER_SORTABLE);
  const params = parseListParams(raw, { defaultSort: metaSort?.sort ?? "lastOrderAt", defaultDir: metaSort?.dir, filterKeys: ["province", "tier"], sortable: CUSTOMER_SORTABLE, defaultPeriod: "all" });
  const filtersOff = raw[META_FILTER_OFF] === "off";
  const extra = filtersOff ? undefined : listMetadataFilterSql("customer", meta);
  const [{ rows, total, pageCount }, facets, summary] = await Promise.all([listCustomers(params, extra), customerFacets(params, extra), customerSummary(params, extra)]);
  const { customValues, userNames } = await listCustomValuesFor("customer", meta, rows.map((r) => r.id), user);
  const filterText = meta?.filters.map((f) => describeListFilter(f, meta.customFields.find((d) => `custom:${d.key}` === f.ref))) ?? [];
  const toggleQuery = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (k === META_FILTER_OFF || k === "page" ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : [])));
  if (!filtersOff) toggleQuery.set(META_FILTER_OFF, "off");
  // Mẫu số = đơn ĐÃ KẾT THÚC theo ORDER_OUTCOME; chưa đơn nào kết thúc ⇒ «—», không phải 0% (luật 42).
  // Không tô màu theo ngưỡng viết cứng (luật 38): đích nằm ở metric_targets.
  const returnRate = pctOrNull(summary.returned, summary.finished);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành"
        title="Khách hàng"
        description={`${formatNumber(summary.total)} khách · ${formatNumber(summary.withOrders)} khách đã mua · tổng mua ${formatVND(summary.amount, { compact: true })} · số đơn và kết quả theo đơn hàng trong ERP`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {createGate.allowed ? (
              <Button asChild size="sm">
                <Link href="/customers/new"><Plus className="size-4" /> Tạo khách hàng</Link>
              </Button>
            ) : null}
            {shellAllows(user, "/customers/retention") ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/customers/retention"><HeartHandshake className="size-4" /> Giữ chân khách</Link>
              </Button>
            ) : null}
            <ModuleSyncButton viewer={user} job="pancake-customers" label="Đồng bộ khách hàng" />
          </div>
        }
      />

      {/*
        KHÔNG CÒN THẺ "KHÁCH MUA LẠI" Ở ĐÂY. Nó đếm theo đơn ĐÃ ĐẶT (kể cả đơn hoàn) và tự ghi chú
        rằng con số thật nằm ở trang Giữ chân khách — tức là một KPI biết mình sai mà vẫn đứng đó.
        Một chỉ số, một định nghĩa (đơn giao thành công), một chỗ: trang Giữ chân khách.
      */}
      {/* Ba con số gọn một dải (điện thoại 2 cột) thay cho ba thẻ lớn — danh sách khách là thứ người dùng đến đây để tìm. */}
      <StatStrip
        columns={3}
        items={[
          { label: "Tổng khách hàng", value: formatNumber(summary.total), note: `${formatNumber(summary.withOrders)} khách có đơn · ${formatNumber(summary.orders)} đơn`, icon: Users },
          { label: "Khách mới", value: formatNumber(summary.newInPeriod), note: `Tạo trên ${copy.name("ORDER_SOURCE")} ${summary.newLabel}`, icon: UserPlus, tone: "green" },
          { label: "Tỷ lệ hoàn", value: formatPercent(returnRate, 1), note: returnRate === null ? "Chưa có đơn nào đã kết thúc trong bộ lọc — chưa tính được" : `${formatNumber(summary.returned)} đơn hoàn / ${formatNumber(summary.finished)} đơn đã kết thúc`, icon: RotateCcw },
        ]}
      />

      <DataTableToolbar
        searchPlaceholder="Tên khách, số điện thoại…"
        period={{ defaultKey: "all" }}
        facets={[
          { key: "tier", label: "Nhóm khách", options: facets.tiers, single: true },
          { key: "province", label: "Tỉnh/TP", options: facets.provinces },
        ]}
        resultLabel={`${formatNumber(total)} khách phù hợp`}
      />
      {filterText.length || meta?.filtersSkipped ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Filter className="size-3.5" />
          {filtersOff ? <span>Đã bỏ bộ lọc mặc định của danh sách.</span> : filterText.length ? <span>Bộ lọc mặc định của danh sách: {filterText.join(" · ")}.</span> : null}
          {meta?.filtersSkipped ? <span>{formatNumber(meta.filtersSkipped)} bộ lọc mặc định không áp vì bạn không được xem trường đó.</span> : null}
          {filterText.length ? (
            <Link href={`/customers?${toggleQuery.toString()}`} className="font-semibold text-primary hover:underline">
              {filtersOff ? "Áp lại bộ lọc mặc định" : "Bỏ lọc"}
            </Link>
          ) : null}
        </p>
      ) : null}
      <CustomersTable
        rows={rows}
        pageCount={pageCount}
        total={total}
        defaultSort={metaSort?.sort}
        defaultDir={metaSort?.dir}
        meta={meta ? { listView: meta.schema, customFields: meta.customFields, customValues, userNames } : undefined}
      />
    </div>
  );
}
