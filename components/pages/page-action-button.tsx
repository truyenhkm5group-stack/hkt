"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ButtonData } from "@/lib/pages/types";

/**
 * Kết quả một lượt `executePageAction` (G5). Trình duyệt CHỈ gửi `blockId` + đầu vào của lượt bấm; máy chủ đọc
 * lại cấu hình ĐÃ XUẤT BẢN theo `slug + blockId` rồi mới gọi handler — cấu hình phía client không bao giờ được tin.
 */
export type PageActionOutcome = { ok: true; redirectTo?: string; message?: string } | { ok: false; error: string };

/**
 * Server action đã buộc sẵn `slug` (trang máy chủ truyền `action.bind(null, slug)` — tham chiếu server action
 * tuần tự hoá được, khác một hàm thường mà AGENTS.md mục 2 cấm). `undefined` ⇒ XEM TRƯỚC: nút không chạy.
 */
export type PageActionRunner = (blockId: string, input: unknown) => Promise<PageActionOutcome>;

export const PREVIEW_ACTION_REASON = "Xem trước bản nháp — nút chỉ chạy trên trang đã xuất bản.";

/** Một lượt chạy action + phản hồi chung (thông báo / chuyển trang). Dùng cho cả nút lẫn kanban. */
export function usePageAction(run: PageActionRunner | undefined) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const fire = React.useCallback(
    (blockId: string, input: unknown, onDone?: (ok: boolean) => void) => {
      if (!run) {
        toast.info(PREVIEW_ACTION_REASON);
        return;
      }
      startTransition(async () => {
        try {
          const r = await run(blockId, input);
          if (!r.ok) {
            toast.error(r.error);
            onDone?.(false);
            return;
          }
          if (r.message) toast.success(r.message);
          onDone?.(true);
          // KHÔNG router.refresh(): action đã `revalidatePath` — gọi thêm là dựng trang hai lần (PR #272).
          if (r.redirectTo) router.push(r.redirectTo);
        } catch {
          toast.error("Không chạy được hành động — thử lại sau.");
          onDone?.(false);
        }
      });
    },
    [run, router],
  );
  return { pending, fire };
}

export function PageActionButton({ blockId, data, run }: { blockId: string; data: ButtonData; run?: PageActionRunner }) {
  const { pending, fire } = usePageAction(run);
  const [confirming, setConfirming] = React.useState(false);
  const disabledReason = !data.enabled ? (data.reason ?? "Hành động này đang không dùng được.") : !run ? PREVIEW_ACTION_REASON : null;

  const click = () => {
    if (data.confirm) setConfirming(true);
    else fire(blockId, {});
  };

  return (
    <div className="flex h-full flex-col justify-center gap-1.5">
      <Button type="button" onClick={click} disabled={pending || disabledReason !== null} title={disabledReason ?? undefined} className="self-start">
        {pending ? "Đang chạy…" : data.label}
      </Button>
      {disabledReason ? <p className="text-xs text-muted-foreground">{disabledReason}</p> : null}
      {data.confirm ? (
        <AlertDialog open={confirming} onOpenChange={(o) => !pending && setConfirming(o)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{data.label}?</AlertDialogTitle>
              <AlertDialogDescription>{data.confirm}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={(e) => {
                  e.preventDefault();
                  fire(blockId, {}, () => setConfirming(false));
                }}
              >
                Xác nhận
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
