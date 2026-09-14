"use client";

import { PackageCheck, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cancelReturnReceived, confirmAllReturnedReceived, confirmReturnReceived } from "@/lib/actions/returns-warehouse";

/**
 * Ghi nhận kiện hàng hoàn ĐÃ VỀ TỚI KHO.
 *
 * Thao tác này KHÔNG cộng tồn. Nó chỉ chuyển kiện sang hàng đợi ĐẾM ở trang Kiểm đếm hàng hoàn —
 * nơi người đếm nói còn bao nhiêu món bán lại được, và chỉ chừng đó vào tồn.
 */
export function ReceiveReturns({
  rows,
  bulk,
}: {
  rows: { id: string; label: string; receivedAt: string | null; items?: string }[];
  /** Toàn bộ hàng hoàn ĐÃ VỀ TỚI SHOP còn chờ kho xác nhận — không giới hạn ở trang đang xem. */
  bulk?: { count: number; items: number; waitingDays: number | null };
}) {
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
          Huỷ ghi nhận
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!allPending.length}
          onClick={() => setSelected(allChecked ? new Set() : new Set(allPending.map((r) => r.id)))}
        >
          {allChecked ? "Bỏ chọn tất cả" : "Chọn tất cả chưa nhận"}
        </Button>

        {bulk && bulk.count > rows.length ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="secondary" disabled={pending}>
                Xác nhận toàn bộ {bulk.count} kiện đã về tới shop
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Ghi nhận {bulk.count} kiện hàng hoàn đã về kho?</AlertDialogTitle>
                <AlertDialogDescription>
                  Gồm {bulk.items} món, {bulk.waitingDays !== null ? `kiện chờ lâu nhất đã ${bulk.waitingDays} ngày` : "trên toàn bộ danh sách"}. Chỉ tính vận đơn Viettel Post
                  đã trả hàng xong cho người gửi — vận đơn đang trên đường về không bị đụng tới.
                  <br />
                  <br />
                  Thao tác này <strong>chưa cộng tồn kho</strong>: các kiện chuyển sang hàng đợi kiểm đếm. Hàng chỉ vào lại tồn ở trang
                  “Kiểm đếm hàng hoàn”, theo đúng số món kho đếm được và còn bán lại được. Bấm nhầm thì dùng “Huỷ xác nhận” — trừ kiện đã đếm.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Để sau</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    start(async () => {
                      const result = await confirmAllReturnedReceived({});
                      if ("error" in result) toast.error(result.error);
                      else {
                        toast.success(result.message);
                        setSelected(new Set());
                        router.refresh();
                      }
                    })
                  }
                >
                  Kho đã nhận, chuyển sang chờ đếm
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
      <ul className="divide-y rounded-lg border">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Checkbox checked={selected.has(row.id)} onCheckedChange={() => toggle(row.id)} aria-label={`Chọn ${row.label}`} />
            <div className="min-w-0 flex-1">
              <div className="numeric font-medium">{row.label}</div>
              {/* Kiện này chứa gì — kho đối chiếu ngay khi nhận, không phải mở từng đơn. */}
              {row.items ? <div className="truncate text-xs text-muted-foreground" title={row.items}>{row.items}</div> : null}
            </div>
            {row.receivedAt ? (
              <span className="ml-auto shrink-0 text-xs text-success">Đã nhận {row.receivedAt}</span>
            ) : (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">Chưa về kho</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
