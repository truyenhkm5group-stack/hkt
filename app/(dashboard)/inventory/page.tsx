import { ArrowDownToLine, ArrowUpFromLine, ListOrdered } from "lucide-react";
import { InventoryTable } from "@/app/(dashboard)/inventory/inventory-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { formatNumber } from "@/lib/format";
import { inventoryFacets, inventorySummary, INVENTORY_SORTABLE, listInventory } from "@/lib/queries/inventory";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Nhật ký kho" };

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "insertedAt", filterKeys: ["warehouse", "table", "direction"], sortable: INVENTORY_SORTABLE, defaultPeriod: "30d" });
  const [{ rows, total, pageCount }, facets, summary] = await Promise.all([listInventory(params), inventoryFacets(params), inventorySummary(params)]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho & tài chính"
        title="Nhật ký kho"
        description={`Lịch sử xuất / nhập / chuyển kho ghi nhận từ Pancake POS · ${params.period.label.toLowerCase()} · ${formatNumber(summary.variants)} mẫu mã có biến động`}
        actions={<SyncButton job="pancake-inventory" label="Đồng bộ nhật ký kho" />}
      />

      <section className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Nhập trong kỳ" value={`+${formatNumber(summary.imported)}`} note={`${formatNumber(summary.importTx)} giao dịch nhập`} icon={ArrowDownToLine} tone="green" />
        <MetricCard label="Xuất trong kỳ" value={`−${formatNumber(summary.exported)}`} note={`${formatNumber(summary.exportTx)} giao dịch xuất`} icon={ArrowUpFromLine} tone="rose" />
        <MetricCard label="Số giao dịch" value={formatNumber(summary.transactions)} note={`Chênh lệch ${summary.imported - summary.exported >= 0 ? "+" : ""}${formatNumber(summary.imported - summary.exported)} sản phẩm`} icon={ListOrdered} tone="blue" />
      </section>

      <DataTableToolbar
        searchPlaceholder="SKU, tên sản phẩm, loại giao dịch, mã tham chiếu…"
        period={{ defaultKey: "30d" }}
        facets={[
          { key: "warehouse", label: "Kho", options: facets.warehouses },
          { key: "table", label: "Nguồn", options: facets.tables },
          { key: "direction", label: "Chiều", options: facets.direction, single: true },
        ]}
        resultLabel={`${formatNumber(total)} giao dịch phù hợp`}
      />
      <InventoryTable rows={rows} pageCount={pageCount} total={total} />
    </div>
  );
}
