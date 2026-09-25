"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { transitionModel } from "@/lib/actions/models";
import { MODEL_REASON_MIN_LENGTH, MODEL_STATE_LABELS, reasonIsEnough, type ModelState } from "@/lib/constants/model-lifecycle";

/**
 * Đề xuất CHUYỂN TRẠNG THÁI trên khối "Đề xuất" (Company OS · A2). Máy chỉ điền SẴN lý do; người đọc,
 * sửa và BẤM — không có gì tự áp (luật 23). Đi qua ĐÚNG `transitionModel` của Agent A (đường duy nhất
 * đổi `lifecycle_state`, có lịch sử + sự kiện + nhật ký).
 */
export function SuggestedTransition({ modelId, to, reason }: { modelId: string; to: ModelState; reason: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(reason);
  const [pending, start] = useNavTransition();
  const router = useRouter();

  const luu = () =>
    start(async () => {
      const r = await transitionModel({ modelId, to, reason: text });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã khai: ${MODEL_STATE_LABELS[to]}`);
      setOpen(false);
      router.refresh();
    });

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(true)}>
        Chuyển sang “{MODEL_STATE_LABELS[to]}”…
      </Button>
    );
  }
  return (
    <div className="w-full space-y-1.5">
      <Textarea rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-7" disabled={pending || !reasonIsEnough(text)} onClick={luu}>
          {pending ? "Đang lưu…" : `Xác nhận chuyển sang ${MODEL_STATE_LABELS[to]}`}
        </Button>
        <Button size="sm" variant="ghost" className="h-7" disabled={pending} onClick={() => setOpen(false)}>
          Thôi
        </Button>
        <span className="text-[11px] text-muted-foreground">Lý do ít nhất {MODEL_REASON_MIN_LENGTH} ký tự · ghi vào lịch sử vòng đời</span>
      </div>
    </div>
  );
}
