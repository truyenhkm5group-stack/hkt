"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { InstallPanel } from "@/components/blueprints/install-panel";
import { previewBlueprintFileAction } from "@/lib/actions/blueprints";
import type { BlueprintIssue, BlueprintPlan } from "@/lib/blueprints/types";

/** Cùng trần với máy chủ (`BLUEPRINT_FILE_MAX_BYTES`) — chặn sớm ở trình duyệt, máy chủ vẫn kiểm lại. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * CÀI TỪ TỆP JSON (Phase 11 · H3): chọn tệp → máy chủ KIỂM + lập kế hoạch (chưa ghi gì) → bảng kế hoạch y như cài một
 * mẫu → Xác nhận. Đường khôi phục cấu hình của một tổ chức từ tệp tải ở «Xuất cấu hình».
 */
export function BlueprintFileInstall() {
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [plan, setPlan] = useState<BlueprintPlan | null>(null);
  const [errors, setErrors] = useState<BlueprintIssue[]>([]);
  const [pending, startTransition] = useTransition();

  const choose = (file: File | undefined) => {
    setPlan(null);
    setErrors([]);
    setText(null);
    setFileName(file?.name ?? null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setErrors([{ path: "", message: "Tệp lớn hơn 2 MB — không phải một gói cấu hình." }]);
      return;
    }
    startTransition(async () => {
      try {
        const content = await file.text();
        const r = await previewBlueprintFileAction(content, {});
        if (r.ok) {
          setText(content);
          setPlan(r.plan);
        } else setErrors(r.errors);
      } catch {
        setErrors([{ path: "", message: "Không đọc được tệp — thử lại." }]);
      }
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input ref={input} type="file" accept="application/json,.json" className="hidden" onChange={(e) => choose(e.target.files?.[0])} aria-label="Chọn tệp gói cấu hình JSON" />
        <Button size="sm" variant="outline" disabled={pending} onClick={() => input.current?.click()}>
          {pending ? "Đang kiểm tệp…" : "Chọn tệp JSON…"}
        </Button>
        <span className="text-muted-foreground">{fileName ?? "Chưa chọn tệp nào."}</span>
      </div>
      {errors.length > 0 ? (
        <div className="max-h-60 overflow-y-auto rounded-lg border border-rose-300/70 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200" role="alert">
          <p className="font-medium">Tệp không cài được — máy chưa ghi gì.</p>
          {errors.slice(0, 30).map((e, i) => (
            <p key={i} className="text-xs">
              {e.path ? <span className="font-mono">{e.path}: </span> : null}
              {e.message}
            </p>
          ))}
        </div>
      ) : null}
      {plan && text !== null ? (
        <div className="space-y-2">
          <p className="text-sm">
            Gói <b>{plan.blueprint.name}</b> <span className="font-mono text-xs text-muted-foreground">({plan.blueprint.key} · {plan.blueprint.version})</span>
          </p>
          <InstallPanel key={plan.planHash} templateKey={plan.blueprint.key} initialPlan={plan} fileJson={text} />
        </div>
      ) : null}
    </div>
  );
}
