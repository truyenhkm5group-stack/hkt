"use client";

import { ClipboardCheck, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { submitReturnInspection } from "@/lib/actions/returns-warehouse";
import { CONDITION_LABEL, RETURN_CONDITIONS, type ReturnCondition } from "@/lib/constants/returns-condition";
import { cn } from "@/lib/utils";

/**
 * Một dòng đếm hàng hoàn.
 *
 * Ô "còn bán được" mặc định bằng số ERP đã xuất — nhưng người đếm phải tự bấm xác nhận, và sửa được.
 * KHÔNG tự lưu: số vào tồn phải là số người đếm nhìn thấy, không phải số máy đoán.
 */
export function InspectionRow({
  shipmentId,
  code,
  expectedQty,
  ageDays,
  receivedBy,
}: {
  shipmentId: string;
  code: string;
  expectedQty: number;
  ageDays: number;
  receivedBy: string;
}) {
  const [condition, setCondition] = useState<ReturnCondition>("RESTOCKABLE");
  const [restock, setRestock] = useState(String(expectedQty));
  const [unsellable, setUnsellable] = useState("0");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  const needsNote = condition !== "RESTOCKABLE";
  const restockNum = Number(restock) || 0;
  const short = expectedQty > 0 && restockNum < expectedQty;

  function submit() {
    start(async () => {
      const result = await submitReturnInspection({ shipmentId, condition, restockQty: restockNum, unsellableQty: Number(unsellable) || 0, note });
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(result.message);
        router.refresh();
      }
    });
  }

  return (
    <div className="grid gap-2 border-b px-3 py-3 text-sm last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="numeric font-medium">{code}</span>
          <span className="text-xs text-muted-foreground">
            ERP đã xuất {expectedQty} món · chờ đếm {ageDays} ngày · {receivedBy || "không rõ người nhận"}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select value={condition} onValueChange={(v) => setCondition(v as ReturnCondition)}>
            <SelectTrigger className="h-8 w-[170px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RETURN_CONDITIONS.map((c) => (
                <SelectItem key={c} value={c} className="text-xs">
                  {CONDITION_LABEL[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            Còn bán được
            <Input className="numeric h-8 w-16" inputMode="numeric" value={restock} onChange={(e) => setRestock(e.target.value)} />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            Không bán được
            <Input className="numeric h-8 w-16" inputMode="numeric" value={unsellable} onChange={(e) => setUnsellable(e.target.value)} />
          </label>
          <Input
            className={cn("h-8 min-w-[220px] flex-1 text-xs", needsNote && !note.trim() && "border-destructive")}
            placeholder={needsNote ? "Bắt buộc: hàng sao, thiếu gì" : "Ghi chú (không bắt buộc)"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {short ? (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            Đếm được {restockNum}/{expectedQty} món — phần chênh {expectedQty - restockNum} món sẽ hiện thành hàng hụt trên sổ kho.
          </p>
        ) : null}
      </div>
      <Button size="sm" className="md:mt-6" disabled={pending || (needsNote && !note.trim())} onClick={submit}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />}
        Xác nhận đã đếm
      </Button>
    </div>
  );
}
