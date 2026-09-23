"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { parseAsString, useQueryState } from "nuqs";
import { Loader2, Pencil, Target } from "lucide-react";
import { toast } from "sonner";
import { ReturnRateOverride } from "@/app/(dashboard)/reports/assumptions-form";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { clearEstimatedCost, setEstimatedCost } from "@/lib/actions/estimated-cost";
import type { EstimatedCost } from "@/lib/constants/estimated-cost";
import type { ProfitAssumptions } from "@/lib/constants/profit";
import { formatVND } from "@/lib/format";

/** Nhận cả "150.000", "150,000" lẫn "150000" — người Việt gõ dấu chấm ngăn nghìn. */
function docSoTien(v: string): number {
  return Math.round(Number(v.replace(/[.,\s₫đ]/g, "")));
}

/**
 * Ô đặt GIÁ VỐN DỰ TÍNH cho một mã. Chỉ hiện ở mã THẬT SỰ có sản phẩm chưa có giá vốn — mã đã có
 * phiếu nhập thì giá thật thắng, và một ô đặt tay ở đó chỉ gợi ý sai rằng nó có tác dụng.
 */
export function EstimatedCostControl({
  productId,
  current,
  canWrite,
}: {
  productId: string;
  current: EstimatedCost | null;
  canWrite: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState(current ? String(current.unitCost) : "");
  const [reason, setReason] = React.useState(current?.reason ?? "");
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();
  const so = docSoTien(value);
  const hopLe = Number.isFinite(so) && so > 0 && reason.trim().length >= 3;

  if (!canWrite) return current ? <span className="text-[10.5px] text-muted-foreground">dự tính · {current.setBy ?? "—"}</span> : null;

  const luu = () =>
    startTransition(async () => {
      const r = await setEstimatedCost({ productId, unitCost: so, reason: reason.trim() });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(`Đã đặt giá vốn dự tính ${formatVND(so)}/sp`);
        setOpen(false);
        router.refresh();
      }
    });
  const go = () =>
    startTransition(async () => {
      const r = await clearEstimatedCost(productId);
      if ("error" in r) toast.error(r.error);
      else {
        setValue("");
        setReason("");
        toast.success("Đã bỏ giá vốn dự tính — mã quay về “chưa biết giá vốn”");
        setOpen(false);
        router.refresh();
      }
    });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Chưa có giá thì nút là LỜI MỜI, có chữ; đã đặt rồi thì chỉ còn một cây bút cạnh con số. */}
        {current ? (
          <Button type="button" variant="ghost" size="icon" className="size-6" title="Sửa giá vốn dự tính" aria-label="Sửa giá vốn dự tính">
            <Pencil className="size-3" />
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]">
            <Pencil className="size-3" /> Đặt giá dự tính
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2 text-xs">
        <p className="text-muted-foreground">
          Giá nhập DỰ TÍNH cho mỗi sản phẩm chưa có phiếu nhập / giá Pancake. Có giá thật là con số này tự đứng sang một bên.
          Chỉ báo cáo lợi nhuận danh nghĩa dùng nó — lương và dòng tiền thực không đọc.
        </p>
        <Input
          type="text"
          inputMode="numeric"
          className="numeric h-8"
          placeholder="Giá vốn / sp, ví dụ 150000"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Input type="text" className="h-8" placeholder="Căn cứ: báo giá xưởng, lô thử…" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={luu} disabled={pending || !hopLe}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
          </Button>
          {current ? (
            <Button type="button" size="sm" variant="ghost" onClick={go} disabled={pending}>
              Bỏ giá dự tính
            </Button>
          ) : null}
        </div>
        {current ? (
          <p className="text-muted-foreground">
            Đang dùng {formatVND(current.unitCost)}/sp{current.setBy ? ` · ${current.setBy}` : ""}
            {current.reason ? ` · “${current.reason}”` : ""}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Ô đặt tỷ lệ GTC hiện có (`ReturnRateOverride`) gói trong một popover để vừa một ô bảng — cùng một đường ghi, không có bản thứ hai. */
export function RateOverridePopover(props: {
  productId: string;
  assumptions: ProfitAssumptions;
  current: number;
  source: string;
  canWrite: boolean;
  mature?: boolean;
}) {
  if (!props.canWrite) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-6" title="Đặt tay tỷ lệ giao thành công cho mã này" aria-label="Đặt tỷ lệ giao thành công">
          <Pencil className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem]">
        <ReturnRateOverride {...props} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * BIÊN MỤC TIÊU là thứ NGƯỜI XEM gõ, không phải hằng số (AGENTS.md mục 38) — và nó sống ở URL
 * (`?bien=`), không ở `settings`: đây là câu hỏi "nếu tôi muốn giữ X% thì được chi bao nhiêu",
 * không phải một đích đã chốt để chấm ai.
 */
export function TargetMarginControl({ value }: { value: number | null }) {
  const [, startTransition] = useNavTransition();
  const [, setBien] = useQueryState("bien", parseAsString.withOptions({ shallow: false, history: "replace", startTransition }));
  const [tu, setTu] = React.useState(value === null ? "" : String(value));
  React.useEffect(() => setTu(value === null ? "" : String(value)), [value]);
  const apDung = () => void setBien(tu.trim() === "" ? null : tu.trim());
  return (
    <form
      className="flex items-center gap-1.5 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        apDung();
      }}
    >
      <Target className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">Biên LN muốn giữ</span>
      <Input type="text" inputMode="decimal" className="numeric h-7 w-16" placeholder="%" value={tu} onChange={(e) => setTu(e.target.value)} onBlur={apDung} />
      <span className="text-muted-foreground">% DT GTC ƯT</span>
    </form>
  );
}
