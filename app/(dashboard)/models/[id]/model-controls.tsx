"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { setModelOwner, transitionModel } from "@/lib/actions/models";
import { checkModelTransition, MODEL_REASON_MIN_LENGTH, MODEL_STATE_LABELS, MODEL_STATES, MODEL_TRANSITIONS, reasonIsEnough, type ModelState } from "@/lib/constants/model-lifecycle";

/**
 * ĐỔI TRẠNG THÁI KHAI. Hiện cả khi mẫu CHƯA KHAI (`state = null`) — đó chính là lúc người cần khai.
 *
 * Cạnh "tiến" trong bảng đứng đầu danh sách; mọi trạng thái khác vẫn chọn được nhưng ô lý do bật lên và
 * bắt buộc (cùng `checkModelTransition` mà máy chủ dùng để chặn thật).
 */
export function TransitionControl({ modelId, state }: { modelId: string; state: ModelState | null }) {
  const tien = state ? MODEL_TRANSITIONS[state] : [];
  const conLai = MODEL_STATES.filter((s) => s !== state && !tien.includes(s));
  const [to, setTo] = useState<ModelState | "">(tien[0] ?? "");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  const kiem = to ? checkModelTransition(state, to) : null;
  const canLyDo = !!kiem && kiem.ok && kiem.needsReason;
  const duoc = !!kiem && kiem.ok && (!kiem.needsReason || reasonIsEnough(reason));

  const luu = () =>
    start(async () => {
      if (!to) return;
      const r = await transitionModel({ modelId, to, reason });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã khai: ${MODEL_STATE_LABELS[to]}`);
      setReason("");
      router.refresh();
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px]">
          <Label className="text-xs">{state ? "Chuyển sang" : "Khai trạng thái đầu tiên"}</Label>
          <Select value={to} onValueChange={(v) => setTo(v as ModelState)}>
            <SelectTrigger className="h-8">
              <SelectValue placeholder="Chọn trạng thái" />
            </SelectTrigger>
            <SelectContent>
              {tien.map((s) => (
                <SelectItem key={s} value={s}>
                  {MODEL_STATE_LABELS[s]} · bước tiếp
                </SelectItem>
              ))}
              {conLai.map((s) => (
                <SelectItem key={s} value={s}>
                  {MODEL_STATE_LABELS[s]}
                  {state ? " · cần lý do" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" className="h-8" disabled={pending || !duoc} onClick={luu}>
          {pending ? "Đang lưu…" : "Lưu trạng thái"}
        </Button>
      </div>
      {canLyDo ? (
        <div className="space-y-1">
          <Label className="text-xs">
            Lý do (bắt buộc, ít nhất {MODEL_REASON_MIN_LENGTH} ký tự) — {state ? "đây là lùi bước hoặc nhảy cóc" : "đây là lần khai đầu tiên của mẫu"}
          </Label>
          <Textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Vì sao mẫu đang ở trạng thái này…" />
        </div>
      ) : null}
    </div>
  );
}

const KHONG_AI = "__none__";

/** Người phụ trách — do NGƯỜI chọn trong danh sách tài khoản đang hoạt động. */
export function OwnerControl({ modelId, ownerUserId, options }: { modelId: string; ownerUserId: string | null; options: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Select
      value={ownerUserId ?? KHONG_AI}
      disabled={pending}
      onValueChange={(v) =>
        start(async () => {
          const r = await setModelOwner({ modelId, ownerUserId: v === KHONG_AI ? null : v });
          if ("error" in r) {
            toast.error(r.error);
            return;
          }
          toast.success("Đã đổi người phụ trách");
          router.refresh();
        })
      }
    >
      <SelectTrigger className="h-8 min-w-[200px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={KHONG_AI}>— Chưa có người phụ trách</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
