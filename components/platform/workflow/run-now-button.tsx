"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { FieldErrors } from "@/components/platform/metadata/bits";
import { Button } from "@/components/ui/button";
import { runWorkflowsNowAction } from "@/lib/actions/workflow-admin";
import type { FieldError } from "@/lib/metadata/types";

type Counts = { events: number; runs: number; executed: number; waiting: number; failed: number };

/**
 * «Chạy lượt kiểm tra ngay» — một lượt của bộ máy luật cho tổ chức người bấm. Máy vốn chạy ké job cảnh báo
 * (10 phút); tổ chức tắt module Cần xử lý thì không có lượt tự động, và đây là đường chạy của họ mà không đổi
 * lịch. Kết quả in đủ năm con số — «0 sự kiện» là câu trả lời thật (chưa có gì mới từ lượt trước), không phải lỗi.
 */
export function RunNowButton() {
  const [pending, startTransition] = useTransition();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);

  const run = () =>
    startTransition(async () => {
      try {
        const r = await runWorkflowsNowAction();
        if (r.ok) {
          setErrors([]);
          setCounts({ events: r.events, runs: r.runs, executed: r.executed, waiting: r.waiting, failed: r.failed });
          toast.success("Đã chạy một lượt kiểm tra luật");
        } else setErrors(r.errors);
      } catch {
        setErrors([{ field: "_", message: "Không chạy được — thử lại." }]);
      }
    });

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" disabled={pending} onClick={run} title="Một lượt kiểm tra sự kiện mới cho tổ chức của bạn — cùng bộ máy với lượt tự động, không làm hai lần việc đã làm">
        <RefreshCw className={pending ? "animate-spin" : undefined} /> Chạy lượt kiểm tra ngay
      </Button>
      {counts ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {counts.events} sự kiện · {counts.runs} lượt chạy · {counts.executed} đã làm · {counts.waiting} chờ duyệt · {counts.failed} lỗi
        </p>
      ) : null}
      <FieldErrors errors={errors} />
    </div>
  );
}
