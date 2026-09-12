"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ITEM_CONDITIONS, ITEM_CONDITION_LABEL, ITEM_CONDITION_NEEDS_NOTE, ITEM_CONDITION_RESTOCKS, type ItemCondition } from "@/lib/constants/return-lifecycle";
import { submitItemInspection } from "@/lib/actions/returns-warehouse";
import type { ItemsBasis } from "@/lib/returns/product-context";
import { cn } from "@/lib/utils";

/**
 * ═══════════ ĐẾM TỪNG MÓN NGAY TẠI CHỖ ═══════════
 *
 * Người kho mở kiện ra, nhìn thấy gì thì bấm đúng cái đó cho TỪNG món. Không có nút "xong tất cả":
 * một kiện ba món có thể vừa đủ một món, vừa thiếu một món, vừa hỏng một món, và ép cả kiện về
 * một kết luận là vứt đúng phần thông tin họ vừa bỏ công đếm.
 *
 * Mặc định mỗi món là "Đủ" với số ĐÚNG BẰNG số kỳ vọng — đó là trường hợp thường gặp nhất nên
 * không bắt gõ lại. Nhưng đổi số hay đổi kết luận là phải nêu lý do, và nút lưu khoá cho tới khi
 * nêu: phần hàng mất không được phép biến mất không dấu vết.
 */

export type DrawerItem = {
  variantId: string | null;
  sku: string;
  name: string;
  color: string;
  size: string;
  quantity: number;
};

type Dong = {
  expectedVariantId: string | null;
  expectedSku: string;
  expectedName: string;
  expectedColor: string;
  expectedSize: string;
  expectedQty: number;
  actualQty: string;
  condition: ItemCondition;
  note: string;
};

export function ItemInspectionDrawer({
  shipmentId,
  code,
  orderCode,
  items,
  disabled,
  onDone,
  itemsBasis,
}: {
  shipmentId: string;
  code: string | null;
  orderCode: string | null;
  items: DrawerItem[];
  disabled?: boolean;
  onDone?: () => void;
  /** Căn cứ danh sách kỳ vọng: có phiếu trả từng món, hay chỉ suy từ cả đơn. Mặc định ORDER_ONLY (thận trọng). */
  itemsBasis?: ItemsBasis;
}) {
  const [open, setOpen] = React.useState(false);
  const [daDoiChieu, setDaDoiChieu] = React.useState(false);
  const [pending, start] = React.useTransition();
  const router = useRouter();
  const [dong, setDong] = React.useState<Dong[]>([]);

  // Dựng lại mỗi lần mở: kiện có thể đã đổi, và bản nháp cũ của kiện trước không được lẫn sang.
  React.useEffect(() => {
    if (!open) return;
    setDaDoiChieu(false);
    setDong(
      items.map((it) => ({
        expectedVariantId: it.variantId,
        expectedSku: it.sku,
        expectedName: it.name,
        expectedColor: it.color,
        expectedSize: it.size,
        expectedQty: it.quantity,
        actualQty: String(it.quantity),
        condition: "OK" as ItemCondition,
        note: "",
      })),
    );
  }, [open, items]);

  const set = (i: number, patch: Partial<Dong>) => setDong((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));

  const soVaoTon = dong.reduce((t, d) => t + (ITEM_CONDITION_RESTOCKS[d.condition] ? Math.max(0, Math.trunc(Number(d.actualQty) || 0)) : 0), 0);
  const thieuLyDo = dong.filter((d) => ITEM_CONDITION_NEEDS_NOTE[d.condition] && !d.note.trim());
  const coLech = dong.some((d) => d.condition !== "OK" || Math.trunc(Number(d.actualQty) || 0) !== d.expectedQty);

  const luu = () =>
    start(async () => {
      const r = await submitItemInspection({
        shipmentId,
        orderOnlyConfirmed: daDoiChieu,
        items: dong.map((d) => ({
          expectedVariantId: d.expectedVariantId,
          expectedSku: d.expectedSku,
          expectedName: d.expectedName,
          expectedColor: d.expectedColor,
          expectedSize: d.expectedSize,
          expectedQty: d.expectedQty,
          actualVariantId: null,
          actualSku: "",
          actualQty: Math.max(0, Math.trunc(Number(d.actualQty) || 0)),
          condition: d.condition,
          note: d.note.trim(),
        })),
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message);
      setOpen(false);
      onDone?.();
      router.refresh();
    });

  return (
    <>
      <Button size="sm" variant="outline" className="h-8" disabled={disabled} onClick={() => setOpen(true)}>
        <ClipboardCheck className="size-3.5" /> Kiểm từng món
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Đếm kiện {code ?? shipmentId}</SheetTitle>
            <SheetDescription>
              {orderCode ? `Đơn gốc ${orderCode} · ` : ""}
              {items.length} dòng hàng kỳ vọng. Chỉ món kết luận “Đủ” mới vào lại tồn.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-3 px-4 pb-6">
            {!dong.length ? (
              <p className="text-[13px] text-muted-foreground">
                Kiện này chưa ghép được dòng hàng nào từ đơn gốc. Dùng đường đếm nhanh cả kiện ở danh sách bên ngoài và ghi rõ thực tế vào ô lý do.
              </p>
            ) : null}

            {dong.map((d, i) => {
              const soThuc = Math.max(0, Math.trunc(Number(d.actualQty) || 0));
              const lechSo = soThuc !== d.expectedQty;
              return (
                <div key={`${d.expectedSku}-${i}`} className={cn("rounded-xl border p-3", d.condition !== "OK" && "border-amber-400/60 bg-amber-50/40 dark:bg-amber-950/10")}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-mono text-[13px] font-semibold">{d.expectedSku || d.expectedName || "—"}</span>
                      {[d.expectedColor, d.expectedSize].filter(Boolean).length ? (
                        <span className="text-[12px] text-muted-foreground"> · {[d.expectedColor, d.expectedSize].filter(Boolean).join(" / ")}</span>
                      ) : null}
                    </div>
                    <span className="text-[12px] text-muted-foreground">kỳ vọng × {d.expectedQty}</span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[12px]">
                      Thực nhận
                      <Input
                        inputMode="numeric"
                        value={d.actualQty}
                        onChange={(e) => set(i, { actualQty: e.target.value.replace(/[^\d]/g, "") })}
                        className={cn("h-8 w-16 text-center", lechSo && "border-amber-500")}
                      />
                    </label>
                    {lechSo ? <span className="text-[11.5px] font-medium text-amber-700 dark:text-amber-300">lệch {soThuc - d.expectedQty > 0 ? "+" : ""}{soThuc - d.expectedQty}</span> : null}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {ITEM_CONDITIONS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => set(i, { condition: c })}
                        className={cn(
                          "rounded-md border px-2 py-0.5 text-[11.5px] transition-colors",
                          d.condition === c ? (ITEM_CONDITION_RESTOCKS[c] ? "border-emerald-600 bg-emerald-600 text-white" : "border-amber-500 bg-amber-500/15 font-semibold") : "hover:bg-accent",
                        )}
                      >
                        {ITEM_CONDITION_LABEL[c]}
                      </button>
                    ))}
                  </div>

                  {ITEM_CONDITION_NEEDS_NOTE[d.condition] ? (
                    <Input
                      value={d.note}
                      onChange={(e) => set(i, { note: e.target.value })}
                      placeholder={`Vì sao ${ITEM_CONDITION_LABEL[d.condition].toLowerCase()}? (bắt buộc)`}
                      className={cn("mt-2 h-8 text-[12.5px]", !d.note.trim() && "border-destructive/60")}
                    />
                  ) : null}
                </div>
              );
            })}

            {dong.length ? (
              <>
                <div className="rounded-xl bg-muted px-3 py-2 text-[12.5px]">
                  <b>{soVaoTon}</b> món sẽ vào lại tồn
                  {coLech ? <span className="text-amber-700 dark:text-amber-300"> · có lệch so với hàng kỳ vọng</span> : null}
                  <div className="mt-0.5 text-muted-foreground">Phần còn lại được ghi là thất thoát có tên, không lặng lẽ biến mất khỏi sổ.</div>
                </div>
                {(itemsBasis ?? "ORDER_ONLY") === "ORDER_ONLY" ? (
                  <label className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    <input type="checkbox" className="mt-0.5" checked={daDoiChieu} onChange={(e) => setDaDoiChieu(e.target.checked)} />
                    <span>
                      Đơn này <b>không có phiếu trả từng món</b> — danh sách trên chỉ suy từ cả đơn. Tôi đã đối chiếu thực tế với hàng trong kiện trước khi lưu.
                    </span>
                  </label>
                ) : null}
                <Button className="w-full" disabled={pending || thieuLyDo.length > 0 || ((itemsBasis ?? "ORDER_ONLY") === "ORDER_ONLY" && !daDoiChieu)} onClick={luu}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />}
                  {thieuLyDo.length ? `Còn ${thieuLyDo.length} món chưa nêu lý do` : (itemsBasis ?? "ORDER_ONLY") === "ORDER_ONLY" && !daDoiChieu ? "Xác nhận đã đối chiếu để lưu" : "Lưu kết quả đếm"}
                </Button>
              </>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
