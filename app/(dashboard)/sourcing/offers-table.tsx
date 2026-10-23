"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Columns3 } from "lucide-react";
import { sourcingOfferColumns } from "@/app/(dashboard)/sourcing/offers-columns";
import { DataTable } from "@/components/data-table/data-table";
import { Button } from "@/components/ui/button";
import { SOURCING_COMPARE_MAX } from "@/lib/constants/sourcing";
import type { SourcingOfferRow } from "@/lib/queries/sourcing";

export function SourcingOffersTable({ rows, pageCount, total, nowIso }: { rows: SourcingOfferRow[]; pageCount: number; total: number; nowIso: string }) {
  const router = useRouter();
  const columns = useMemo(() => sourcingOfferColumns(new Date(nowIso)), [nowIso]);
  return (
    <DataTable
      defaultSort="createdAt"
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.id}
      rowHref={(row) => `/sourcing/offers/${row.id}`}
      selectable
      bulkActions={(sel, clear) => (
        <Button
          size="sm"
          disabled={sel.length < 2 || sel.length > SOURCING_COMPARE_MAX}
          title={sel.length > SOURCING_COMPARE_MAX ? `Chọn tối đa ${SOURCING_COMPARE_MAX} mẫu` : sel.length < 2 ? "Chọn ít nhất 2 mẫu" : undefined}
          onClick={() => {
            router.push(`/sourcing/compare?ids=${sel.map((r) => encodeURIComponent(r.id)).join(",")}`);
            clear();
          }}
        >
          <Columns3 className="size-4" />
          So sánh {sel.length} mẫu
        </Button>
      )}
      emptyTitle="Kho mẫu trống"
      emptyDescription="Dán link sản phẩm 1688 / Alibaba / Taobao ở «Thêm mẫu» rồi gõ bậc giá, MOQ, nhà cung cấp."
    />
  );
}
