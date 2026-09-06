"use client";

import { PackageCheck, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cancelReturnReceived, confirmReturnReceived } from "@/lib/actions/returns-warehouse";

/**
 * Xác nhận kho đã nhận hàng hoàn. Chỉ sau thao tác này hàng mới được cộng lại tồn ERP.
 * Cố ý giữ đơn giản: chọn dòng → bấm xác nhận, không có quy trình phiếu nhập hoàn đầy đủ.
 */
export function ReceiveReturns({ rows }: { rows: { id: string; label: string; receivedAt: string | null }[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const router = useRouter();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function run(action: typeof confirmReturnReceived) {
    const ids = [...selected];
    if (!ids.length) return;
    start(async () => {
      const result = await action({ ids });
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(result.message);
        setSelected(new Set());
        router.refresh();
      }
    });
  }

  const allPending = rows.filter((r) => !r.receivedAt);
  const allChecked = allPending.length > 0 && allPending.every((r) => selected.has(r.id));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!selected.size || pending} onClick={() => run(confirmReturnReceived)}>
          <PackageCheck className="size-4" />
          Kho đã nhận {selected.size ? `(${selected.size})` : ""}
        </Button>
        <Button size="sm" variant="outline" disabled={!selected.size || pending} onClick={() => run(cancelReturnReceived)}>
          <Undo2 className="size-4" />
          Huỷ xác nhận
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!allPending.length}
          onClick={() => setSelected(allChecked ? new Set() : new Set(allPending.map((r) => r.id)))}
        >
          {allChecked ? "Bỏ chọn tất cả" : "Chọn tất cả chưa nhận"}
        </Button>
      </div>
      <ul className="divide-y rounded-lg border">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Checkbox checked={selected.has(row.id)} onCheckedChange={() => toggle(row.id)} aria-label={`Chọn ${row.label}`} />
            <span className="numeric font-medium">{row.label}</span>
            {row.receivedAt ? (
              <span className="ml-auto text-xs text-success">Đã nhận {row.receivedAt}</span>
            ) : (
              <span className="ml-auto text-xs text-muted-foreground">Chưa về kho</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
