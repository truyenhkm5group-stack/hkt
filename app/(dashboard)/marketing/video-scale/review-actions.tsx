"use client";

import { Check, CheckCheck, Loader2, X } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { approveVideoVariantsAction, reviewVideoVariantAction } from "@/lib/actions/video-scale";

/** Duyệt / loại một video. Loại bắt buộc lý do — máy học từ lý do ấy. */
export function ReviewActions({ variantId }: { variantId: string }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const act = (decision: "APPROVE" | "REJECT") =>
    start(async () => {
      const r = await reviewVideoVariantAction({ variantId, decision, note });
      if ("error" in r) return void toast.error(r.error);
      toast.success(decision === "APPROVE" ? "Đã duyệt video." : "Đã loại video.");
      setNote("");
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input className="h-8 min-w-[12rem] flex-1" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú (bắt buộc khi loại: vd sai màu cổ áo)" aria-label="Ghi chú duyệt" />
      <Button size="sm" disabled={pending} onClick={() => act("APPROVE")}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Duyệt
      </Button>
      <Button size="sm" variant="destructive" disabled={pending || note.trim().length < 3} onClick={() => act("REJECT")}>
        <X className="size-4" /> Loại
      </Button>
    </div>
  );
}

/** "Duyệt tất cả video QC đạt" — máy chủ kiểm lại từng video; video QC nghi ngờ vẫn phải duyệt từng cái. */
export function BulkApproveButton({ variantIds }: { variantIds: string[] }) {
  const [pending, start] = useTransition();
  if (variantIds.length < 2) return null;
  const go = () => {
    if (!confirm(`Duyệt ${variantIds.length} video QC ĐẠT? Máy sẽ viết content cho từng video. Video QC nghi ngờ không nằm trong lượt này.`)) return;
    start(async () => {
      const r = await approveVideoVariantsAction({ variantIds });
      if ("error" in r) return void toast.error(r.error);
      toast.success(`Đã duyệt ${r.approved} video${r.skipped ? ` · ${r.skipped} video bỏ qua (đã đổi trạng thái hoặc không còn QC đạt)` : ""}.`);
    });
  };
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={go}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />} Duyệt tất cả {variantIds.length} video QC đạt
    </Button>
  );
}
