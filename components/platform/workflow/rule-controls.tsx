"use client";

import { useState, useTransition } from "react";
import { Archive, FlaskConical, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { FieldErrors } from "@/components/platform/metadata/bits";
import { RuleModeBadge, RuleStatusBadge } from "@/components/platform/workflow/badges";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { previewWorkflowRuleAction, setWorkflowRuleModeAction, setWorkflowRuleStatusAction } from "@/lib/actions/workflow-admin";
import type { FieldError } from "@/lib/metadata/types";
import { ACTION_KIND_LABEL } from "@/lib/platform-ui/workflow-admin-shared";
import type { WorkflowAction, WorkflowMode, WorkflowRuleStatus } from "@/lib/workflow/types";
import { cn } from "@/lib/utils";

/**
 * ═══════════ ĐIỀU KHIỂN LUẬT ĐÃ LƯU ═══════════
 *
 * Bật / tạm dừng / lưu trữ, công tắc CHẠY THẬT, và khung chạy thử trên một bản ghi. Mọi nút tác động lên bản
 * ĐÃ LƯU của luật — không lên thứ đang gõ dở trong form bên dưới.
 *
 * CHẠY THẬT chỉ bật được khi luật ĐANG BẬT, và luôn qua hộp xác nhận liệt kê đúng những gì máy SẼ làm với luật
 * này (tạo việc / gửi báo / ghi giá trị). Tắt về chạy thử không cần xác nhận: đó là hướng an toàn.
 */

type Props = {
  ruleId: string;
  status: WorkflowRuleStatus;
  mode: WorkflowMode;
  /** Câu hậu quả của chạy thật — dựng ở máy chủ từ hành động ĐÃ LƯU (`liveConsequences`). */
  consequences: string[];
  /** Đối tượng mà chạy thử đọc bản ghi — `null` khi kích hoạt không gắn đối tượng nào trong sổ. */
  previewObject: { key: string; label: string } | null;
};

export function RuleControls({ ruleId, status, mode, consequences, previewObject }: Props) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [confirmLive, setConfirmLive] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const run = (fn: () => Promise<{ ok: true } | { ok: false; errors: FieldError[] }>, success: string) =>
    startTransition(async () => {
      try {
        const r = await fn();
        if (r.ok) {
          setErrors([]);
          toast.success(success);
        } else {
          setErrors(r.errors);
          toast.error(r.errors.map((e) => e.message).join(" · ") || "Không đổi được.");
        }
      } catch {
        setErrors([{ field: "_", message: "Không đổi được — thử lại." }]);
      }
    });

  const archived = status === "ARCHIVED";
  const canActivate = status === "DRAFT" || status === "PAUSED";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <RuleStatusBadge status={status} />
        <RuleModeBadge mode={mode} />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        {canActivate ? (
          <Button size="sm" disabled={pending} onClick={() => run(() => setWorkflowRuleStatusAction(ruleId, "ACTIVE"), "Đã bật luật")}>
            <Play /> {status === "PAUSED" ? "Bật lại" : "Bật"}
          </Button>
        ) : null}
        {status === "ACTIVE" ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setWorkflowRuleStatusAction(ruleId, "PAUSED"), "Đã tạm dừng luật")}>
            <Pause /> Tạm dừng
          </Button>
        ) : null}
        {archived ? null : (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmArchive(true)}>
            <Archive /> Lưu trữ
          </Button>
        )}
        {archived ? null : (
          <label className={cn("ml-auto inline-flex items-center gap-2 text-sm", status !== "ACTIVE" && "text-muted-foreground")} title={status !== "ACTIVE" ? "Chỉ luật đang bật mới chuyển sang chạy thật" : undefined}>
            <Switch
              checked={mode === "LIVE"}
              disabled={pending || (status !== "ACTIVE" && mode !== "LIVE")}
              aria-label="Chạy thật"
              onCheckedChange={(on) => {
                if (on) setConfirmLive(true);
                else run(() => setWorkflowRuleModeAction(ruleId, "DRY_RUN"), "Đã về chạy thử — máy thôi làm thật");
              }}
            />
            Chạy thật
          </label>
        )}
      </div>
      <FieldErrors errors={errors} />

      {previewObject && !archived ? <PreviewBox ruleId={ruleId} object={previewObject} /> : null}

      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Chuyển luật sang CHẠY THẬT?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>Từ lượt chạy kế tiếp, mỗi lần luật khớp máy sẽ:</p>
                <ul className="list-disc space-y-1 pl-5">
                  {consequences.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <p>Mọi lượt đều vào sổ lượt chạy. Tắt công tắc là quay về chạy thử ngay.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => {
                setConfirmLive(false);
                run(() => setWorkflowRuleModeAction(ruleId, "LIVE"), "Luật đang CHẠY THẬT");
              }}
            >
              Chạy thật
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Lưu trữ luật?</AlertDialogTitle>
            <AlertDialogDescription>Máy thôi chạy luật này. Luật và lịch sử lượt chạy vẫn giữ nguyên để tra lại; khoá luật không dùng lại được.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => {
                setConfirmArchive(false);
                run(() => setWorkflowRuleStatusAction(ruleId, "ARCHIVED"), "Đã lưu trữ luật");
              }}
            >
              Lưu trữ
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type PreviewState = { matched: boolean; wouldDo: { action: string; detail: string }[]; reason: string | null } | null;

/** Chạy thử bản ĐÃ LƯU trên một bản ghi — máy chủ KHÔNG ghi gì. */
function PreviewBox({ ruleId, object }: { ruleId: string; object: { key: string; label: string } }) {
  const [recordId, setRecordId] = useState("");
  const [result, setResult] = useState<PreviewState>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    if (!recordId.trim()) {
      setErrors([{ field: "preview.recordId", message: "Nhập mã bản ghi để chạy thử." }]);
      return;
    }
    startTransition(async () => {
      try {
        const r = await previewWorkflowRuleAction(ruleId, { objectKey: object.key, recordId: recordId.trim() });
        if (r.ok) {
          setErrors([]);
          setResult({ matched: r.matched, wouldDo: r.wouldDo, reason: r.reason });
        } else {
          setResult(null);
          setErrors(r.errors);
        }
      } catch {
        setErrors([{ field: "_", message: "Không chạy thử được — thử lại." }]);
      }
    });
  };

  const actionLabel = (a: string) => ACTION_KIND_LABEL[a as WorkflowAction["kind"]] ?? a;

  return (
    <div className="rounded-xl border border-dashed p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Chạy thử trên một {object.label.toLowerCase()} (mã bản ghi)</span>
          <Input
            className="h-8 w-64 font-mono"
            value={recordId}
            onChange={(e) => setRecordId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <Button size="sm" variant="outline" disabled={pending} onClick={submit}>
          <FlaskConical /> Chạy thử
        </Button>
        <span className="text-xs text-muted-foreground">Dùng bản ĐÃ LƯU của luật. Không tạo việc, không gửi báo, không ghi giá trị.</span>
      </div>
      <FieldErrors errors={errors} />
      {result ? (
        <div className="mt-2 text-sm" aria-live="polite">
          {result.matched ? (
            <>
              <p className="font-medium text-emerald-700 dark:text-emerald-300">Khớp — nếu chạy, máy SẼ làm:</p>
              {result.wouldDo.length === 0 ? (
                <p className="text-muted-foreground">Không có bước nào.</p>
              ) : (
                <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                  {result.wouldDo.map((w, i) => (
                    <li key={i}>
                      <b>{actionLabel(w.action)}</b>
                      {w.detail ? ` — ${w.detail}` : ""}
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : (
            <p className="font-medium text-muted-foreground">
              Không khớp — bản ghi này không làm luật chạy.
              {result.reason ? <span className="block font-normal">{result.reason}</span> : null}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
