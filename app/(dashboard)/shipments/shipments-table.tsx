"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { shipmentColumns } from "@/app/(dashboard)/shipments/columns";
import { DataTable } from "@/components/data-table/data-table";
import { Button } from "@/components/ui/button";
import type { ShipmentListRow } from "@/lib/queries/shipments";

type RefreshResponse = { ok?: boolean; error?: string; message?: string; summary?: { imported: number; updated: number; skipped: number; failed: number; detail: string } };

/** Gọi POST /api/shipments/refresh cho các vận đơn đã chọn */
function RefreshShipmentsButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const run = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/shipments/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
      const body = (await res.json().catch(() => ({}))) as RefreshResponse;
      if (!res.ok || body.ok === false) toast.error(body.error || body.message || `Không cập nhật được (${res.status})`);
      else {
        const s = body.summary;
        toast.success(s ? s.detail || `Đã kiểm tra ${ids.length} vận đơn · cập nhật ${s.updated} · lỗi ${s.failed}` : body.message || "Đã cập nhật");
      }
      startTransition(() => router.refresh());
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Lỗi mạng");
    } finally {
      setLoading(false);
    }
  };
  return (
    <Button variant="outline" size="sm" className="h-7 bg-background" onClick={run} disabled={loading}>
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
      Cập nhật từ Viettel Post
    </Button>
  );
}

export function ShipmentsTable({ rows, pageCount, total }: { rows: ShipmentListRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      columns={shipmentColumns}
      data={rows}
      pageCount={pageCount}
      total={total}
      rowHref={(row) => `/shipments/${row.id}`}
      getRowId={(row) => row.id}
      selectable
      bulkActions={(selected, clear) => <RefreshShipmentsButton ids={selected.map((r) => r.id)} onDone={clear} />}
      emptyTitle="Không có vận đơn"
      emptyDescription="Thử đổi khoảng thời gian hoặc bộ lọc. Vận đơn được tạo khi Pancake đẩy đơn sang ĐVVC hoặc khi nhập từ tài khoản Viettel Post."
    />
  );
}
