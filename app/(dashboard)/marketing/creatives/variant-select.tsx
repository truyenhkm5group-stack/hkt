"use client";

import { createContext, useContext, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CheckSquare, Loader2, XSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { applyVariantSelection } from "@/lib/actions/creative";

/**
 * TÍCH CHỌN BÀI trong lô chờ duyệt (§5i): ô tích trên từng bài + thanh "Loại các bài đã chọn" / "Giữ các bài
 * đã chọn". Lưới bài vẫn dựng ở máy chủ — ngữ cảnh chọn bọc quanh nó, mỗi thẻ chỉ gắn một ô tích.
 * Loại / giữ đổi TẬP BÀI trong phiếu duyệt ⇒ phiếu đã phát mất hiệu lực — thanh chọn nói ra.
 */

type Ctx = { selected: Set<string>; toggle: (id: string, on: boolean) => void; clear: () => void; setAll: (ids: string[]) => void };

const SelectionContext = createContext<Ctx | null>(null);

export function VariantSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const value = useMemo<Ctx>(
    () => ({
      selected,
      toggle: (id, on) =>
        setSelected((s) => {
          const n = new Set(s);
          if (on) n.add(id);
          else n.delete(id);
          return n;
        }),
      clear: () => setSelected(new Set()),
      setAll: (ids) => setSelected(new Set(ids)),
    }),
    [selected],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

function useSelection(): Ctx {
  const c = useContext(SelectionContext);
  if (!c) throw new Error("VariantSelectCheckbox phải nằm trong VariantSelectionProvider");
  return c;
}

export function VariantSelectCheckbox({ variantId, label }: { variantId: string; label: string }) {
  const { selected, toggle } = useSelection();
  return (
    <label className="flex cursor-pointer items-center gap-1.5 rounded bg-background/90 px-1.5 py-0.5 text-[11px] font-medium">
      <Checkbox checked={selected.has(variantId)} onCheckedChange={(v) => toggle(variantId, v === true)} aria-label={`Chọn ${label}`} />
      Chọn
    </label>
  );
}

export function VariantSelectionBar({ batchId, allIds, disabledReason }: { batchId: string; allIds: string[]; disabledReason: string | null }) {
  const router = useRouter();
  const { selected, clear, setAll } = useSelection();
  const [pending, start] = useTransition();
  const ids = [...selected].filter((id) => allIds.includes(id));

  const run = (mode: "REJECT_SELECTED" | "KEEP_SELECTED") =>
    start(async () => {
      const r = await applyVariantSelection({ batchId, variantIds: ids, mode, reason: "" });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã loại ${r.rejected} bài${r.restored ? `, khôi phục ${r.restored} bài` : ""} — lô còn ${r.kept} bài; cần bấm DUYỆT CẢ LÔ lại.`);
      clear();
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-[12.5px]">
      <span>
        Đã chọn <b className="numeric">{ids.length}</b> / {allIds.length} bài
      </span>
      <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setAll(allIds)} disabled={pending || allIds.length === 0}>
        Chọn tất cả
      </Button>
      <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={clear} disabled={pending || ids.length === 0}>
        Bỏ chọn
      </Button>
      <span className="flex-1" />
      <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => run("REJECT_SELECTED")} disabled={pending || ids.length === 0 || !!disabledReason} title={disabledReason ?? "Bài bị loại không đăng, không tiêu tiền"}>
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <XSquare className="size-3.5" />} Loại các bài đã chọn
      </Button>
      <Button size="sm" className="h-7 text-[12px]" onClick={() => run("KEEP_SELECTED")} disabled={pending || ids.length === 0 || !!disabledReason} title={disabledReason ?? "Giữ bài đã chọn (khôi phục nếu đã loại), loại MỌI bài còn lại"}>
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckSquare className="size-3.5" />} Giữ các bài đã chọn
      </Button>
    </div>
  );
}
