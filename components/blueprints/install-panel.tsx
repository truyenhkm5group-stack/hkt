"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/ui-bits";
import { installBlueprintFileAction, installTemplateAction, previewBlueprintFileAction, previewTemplateAction } from "@/lib/actions/blueprints";
import {
  BLUEPRINT_ITEM_KIND_LABEL,
  OVERRIDABLE_ACTIONS,
  PLAN_ACTION_LABEL,
  stepKey,
  type ApplyResult,
  type BlueprintIssue,
  type BlueprintPlan,
  type PlanAction,
  type PlanStep,
} from "@/lib/blueprints/types";

const ACTION_TONE: Record<PlanAction, string> = {
  CREATE: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200",
  UPDATE: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200",
  UNCHANGED: "border-border bg-muted/40 text-muted-foreground",
  SKIP_CUSTOMIZED: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200",
  SKIP_DELETED: "border-border bg-muted/40 text-muted-foreground line-through decoration-muted-foreground/40",
  CONFLICT: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200",
  BLOCKED: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200",
};

function ActionBadge({ action }: { action: PlanAction }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11.5px] font-medium ${ACTION_TONE[action]}`}>{PLAN_ACTION_LABEL[action]}</span>;
}

function short(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function DiffList({ step }: { step: PlanStep }) {
  if (step.diff.length === 0) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-primary">Khác biệt ({step.diff.length})</summary>
      <ul className="mt-1 space-y-0.5">
        {step.diff.map((d) => (
          <li key={d.path} className="font-mono text-[11.5px]">
            <span className="text-muted-foreground">{d.path}:</span> <span className="text-amber-800 dark:text-amber-300">{short(d.current)}</span> → <span className="text-emerald-800 dark:text-emerald-300">{short(d.template)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Kế hoạch từng thao tác + lựa chọn ghi đè từng mục + nút Cài (xác nhận) + kết quả từng bước.
 *
 * Đổi một lựa chọn ghi đè ⇒ máy chủ lập LẠI kế hoạch (không tự tính ở trình duyệt). Nút Cài gửi `planHash` của kế
 * hoạch đang hiện: máy chủ lập lại lần nữa và từ chối nếu tổ chức đã đổi giữa chừng.
 *
 * `fileJson` (Phase 11 · H3): gói đến từ TỆP tải lên chứ không từ sổ mẫu — cùng bảng, cùng xác nhận; máy chủ đọc và
 * kiểm lại nội dung tệp ở mỗi lượt xem trước / cài.
 */
export function InstallPanel({ templateKey, initialPlan, fileJson }: { templateKey: string; initialPlan: BlueprintPlan; fileJson?: string }) {
  const [plan, setPlan] = useState(initialPlan);
  const [resolutions, setResolutions] = useState<Record<string, "overwrite" | "skip">>({});
  const [errors, setErrors] = useState<BlueprintIssue[]>([]);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const writes = plan.counts.CREATE + plan.counts.UPDATE;
  const pages = plan.steps.filter((s) => s.kind === "page");

  const replan = (next: Record<string, "overwrite" | "skip">) =>
    startTransition(async () => {
      try {
        const r = fileJson !== undefined ? await previewBlueprintFileAction(fileJson, next) : await previewTemplateAction(templateKey, next);
        if (r.ok) {
          setPlan(r.plan);
          setErrors([]);
        } else setErrors(r.errors);
      } catch {
        setErrors([{ path: "", message: "Không lập lại được kế hoạch — thử lại." }]);
      }
    });

  const toggle = (step: PlanStep, on: boolean) => {
    const k = stepKey(step.kind, step.key);
    const next = { ...resolutions };
    if (on) next[k] = "overwrite";
    else delete next[k];
    setResolutions(next);
    replan(next);
  };

  const install = () =>
    startTransition(async () => {
      try {
        const r = fileJson !== undefined ? await installBlueprintFileAction(fileJson, { planHash: plan.planHash, resolutions }) : await installTemplateAction(templateKey, { planHash: plan.planHash, resolutions });
        setResult(r);
        setConfirming(false);
        if (r.ok) {
          toast.success(`Đã cài «${plan.blueprint.name}» phiên bản ${r.version}`);
          setResolutions({});
          const fresh = fileJson !== undefined ? await previewBlueprintFileAction(fileJson, {}) : await previewTemplateAction(templateKey, {});
          if (fresh.ok) setPlan(fresh.plan);
        } else setErrors(r.errors);
      } catch {
        setConfirming(false);
        setErrors([{ path: "", message: "Không cài được — thử lại." }]);
      }
    });

  return (
    <SectionCard
      title="Kế hoạch cài"
      description={`${plan.steps.length} mục · ${(Object.entries(plan.counts) as [PlanAction, number][])
        .filter(([, n]) => n > 0)
        .map(([a, n]) => `${PLAN_ACTION_LABEL[a]} ${n}`)
        .join(" · ")}`}
      actions={
        <Button size="sm" disabled={pending || !plan.ok || writes === 0} onClick={() => setConfirming(true)} title={!plan.ok ? "Còn mục bị chặn" : writes === 0 ? "Tổ chức đã khớp mẫu" : undefined}>
          {writes === 0 ? "Không có gì để cài" : plan.installedVersion ? `Cập nhật lên ${plan.blueprint.version}` : "Cài mẫu"}
        </Button>
      }
      padded={false}
      contentClassName="space-y-3 p-3"
    >
      {plan.issues.length > 0 || errors.length > 0 ? (
        <div className="rounded-lg border border-rose-300/70 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200" role="alert">
          {[...plan.issues, ...errors].map((e, i) => (
            <p key={i}>{e.message}</p>
          ))}
        </div>
      ) : null}
      {plan.warnings.length > 0 ? (
        <div className="rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          {plan.warnings.map((w, i) => (
            <p key={i}>{w.message}</p>
          ))}
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Loại</th>
              <th className="px-3 py-2">Mục</th>
              <th className="px-3 py-2">Thao tác</th>
              <th className="px-3 py-2">Vì sao</th>
              <th className="px-3 py-2 text-right">Ghi đè</th>
            </tr>
          </thead>
          <tbody>
            {plan.steps.map((s) => {
              const k = stepKey(s.kind, s.key);
              const overridable = OVERRIDABLE_ACTIONS.includes(s.action) || resolutions[k] === "overwrite";
              return (
                <tr key={k} className="border-t border-hairline align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{BLUEPRINT_ITEM_KIND_LABEL[s.kind]}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{s.label}</div>
                    <div className="font-mono text-[11.5px] text-muted-foreground">{s.key}</div>
                  </td>
                  <td className="px-3 py-2">
                    <ActionBadge action={s.action} />
                    {s.publish ? <div className="mt-1 text-[11.5px] text-muted-foreground">+ xuất bản</div> : null}
                  </td>
                  <td className="max-w-[380px] px-3 py-2 text-xs text-muted-foreground">
                    {s.reason ?? "—"}
                    <DiffList step={s} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {overridable ? <Switch checked={resolutions[k] === "overwrite"} disabled={pending} onCheckedChange={(v) => toggle(s, v)} aria-label={`Ghi đè ${s.label}`} /> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {result ? (
        <div className={`rounded-lg border px-3 py-2 text-sm ${result.ok ? "border-emerald-300/70 bg-emerald-50 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200" : "border-rose-300/70 bg-rose-50 text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200"}`} aria-live="polite">
          <p className="font-medium">{result.ok ? `Đã cài xong — ${result.outcomes.filter((o) => o.status === "DONE").length} bước đã ghi.` : `Dừng ở bước: ${result.failedStep ? `${BLUEPRINT_ITEM_KIND_LABEL[result.failedStep.kind]} ${result.failedStep.key}` : "trước khi ghi"}`}</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {result.outcomes
              .filter((o) => o.status === "DONE" || o.status === "FAILED")
              .map((o) => (
                <li key={stepKey(o.kind, o.key)}>
                  {o.status === "DONE" ? "✓" : "✗"} {BLUEPRINT_ITEM_KIND_LABEL[o.kind]} · {o.label} — {PLAN_ACTION_LABEL[o.action]}
                  {o.status === "FAILED" && o.message ? `: ${o.message}` : ""}
                </li>
              ))}
          </ul>
          {result.ok && pages.length > 0 ? (
            <p className="mt-2 text-xs">
              Mở trang của mẫu:{" "}
              {pages.map((p, i) => (
                <span key={p.key}>
                  {i > 0 ? " · " : ""}
                  <Link href={`/p/${p.key}`} className="font-medium underline underline-offset-2">
                    {p.label}
                  </Link>
                </span>
              ))}
              {" · "}
              <Link href="/settings/workflows" className="font-medium underline underline-offset-2">
                Luật tự động (NHÁP)
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      <AlertDialog open={confirming} onOpenChange={(o) => !pending && setConfirming(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {plan.installedVersion ? "Cập nhật" : "Cài"} «{plan.blueprint.name}» {plan.blueprint.version}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Máy sẽ ghi {plan.counts.CREATE} mục mới và cập nhật {plan.counts.UPDATE} mục cho CẢ tổ chức, theo đúng bảng kế hoạch. Luật tự động luôn ở NHÁP + CHẠY THỬ. Mục tổ chức đã sửa / đã bỏ giữ nguyên
              trừ khi bạn bật «Ghi đè». Hỏng giữa chừng thì dừng và báo bước hỏng; cài lại sẽ đi tiếp.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                install();
              }}
            >
              {pending ? "Đang cài…" : "Xác nhận cài"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
