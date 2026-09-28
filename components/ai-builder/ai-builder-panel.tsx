"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import { applyAiDraftAction, createAiDraftAction, discardAiDraftAction, previewAiDraftAction } from "@/lib/actions/ai-builder";
import { AI_BUILDER_EDIT_EXAMPLES, AI_BUILDER_EXAMPLES, AI_BUILDER_MODE_LABEL, AI_DRAFT_STATUS_LABEL, AI_SOURCE_LABEL, type AiBuilderMode, type AiBuilderView, type AiDraftView } from "@/lib/ai-builder/types";
import { BLUEPRINT_ITEM_KIND_LABEL, OVERRIDABLE_ACTIONS, PLAN_ACTION_LABEL, stepKey, type ApplyResult, type BlueprintPlan, type PlanAction } from "@/lib/blueprints/types";

const ACTION_TONE: Record<PlanAction, string> = {
  CREATE: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200",
  UPDATE: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200",
  UNCHANGED: "border-border bg-muted/40 text-muted-foreground",
  SKIP_CUSTOMIZED: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200",
  SKIP_DELETED: "border-border bg-muted/40 text-muted-foreground",
  CONFLICT: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200",
  BLOCKED: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200",
};

const ALERT = "rounded-lg border border-rose-300/70 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200";
const WARN = "rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200";

function usd(v: number | null): string {
  // Chưa định giá được ⇒ «chưa biết», không in 0 (mục 42).
  return v === null ? "chưa biết" : `~$${v.toFixed(4)}`;
}

/**
 * Mô tả → Tạo bản nháp (AI soạn) → bỏ chọn từng mục → Xem trước (kế hoạch Phase 7, máy chủ lập) → Áp dụng (xác nhận).
 *
 * Trình duyệt KHÔNG giữ gói cấu hình: nó chỉ gửi mã nháp + danh sách khoá bỏ chọn + lựa chọn ghi đè + `planHash`. Đổi
 * lựa chọn sau khi xem trước ⇒ kế hoạch bị xoá, phải xem trước lại — người bấm Áp dụng chỉ xác nhận thứ đang THẤY.
 */
export function AiBuilderPanel({ view, initialDraft }: { view: AiBuilderView; initialDraft: AiDraftView | null }) {
  const [mode, setMode] = useState<AiBuilderMode>(initialDraft?.mode ?? "new");
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState<AiDraftView | null>(initialDraft);
  const [excluded, setExcluded] = useState<string[]>(initialDraft?.excludedKeys ?? []);
  const [resolutions, setResolutions] = useState<Record<string, "overwrite">>({});
  const [plan, setPlan] = useState<BlueprintPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const editable = draft?.status === "DRAFT" && draft.groups.length > 0;
  const examples = mode === "new" ? AI_BUILDER_EXAMPLES : AI_BUILDER_EDIT_EXAMPLES;

  const create = () =>
    startTransition(async () => {
      setError(null);
      setResult(null);
      setPlan(null);
      try {
        const r = await createAiDraftAction({ mode, prompt });
        if (!r.ok) return setError(r.error);
        setDraft(r.value);
        setExcluded([]);
        setResolutions({});
        if (r.value.valid) toast.success("AI đã soạn xong bản nháp — xem lại từng mục rồi bấm Xem trước.");
        else toast.warning("Bản nháp còn lỗi — xem lỗi bên dưới.");
      } catch {
        setError("Không tạo được bản nháp — thử lại.");
      }
    });

  const preview = (nextResolutions = resolutions) =>
    startTransition(async () => {
      if (!draft) return;
      setError(null);
      try {
        const r = await previewAiDraftAction(draft.id, { excludedKeys: excluded, resolutions: nextResolutions });
        if (!r.ok) return setError(r.error);
        setPlan(r.value.plan);
      } catch {
        setError("Không lập được kế hoạch — thử lại.");
      }
    });

  const toggleItem = (key: string, keep: boolean) => {
    setPlan(null);
    setExcluded((cur) => (keep ? cur.filter((k) => k !== key) : [...new Set([...cur, key])]));
  };

  const toggleOverwrite = (key: string, on: boolean) => {
    const next = { ...resolutions };
    if (on) next[key] = "overwrite";
    else delete next[key];
    setResolutions(next);
    preview(next);
  };

  const apply = () =>
    startTransition(async () => {
      if (!draft || !plan) return;
      try {
        const r = await applyAiDraftAction(draft.id, { planHash: plan.planHash, excludedKeys: excluded, resolutions });
        setResult(r);
        setConfirming(false);
        if (r.ok) {
          toast.success(`Đã áp dụng — ${r.outcomes.filter((o) => o.status === "DONE").length} bước đã ghi.`);
          setDraft({ ...draft, status: "APPLIED", installId: r.installId });
          setPlan(null);
        } else setError(r.errors.map((e) => e.message).join(" · "));
      } catch {
        setConfirming(false);
        setError("Không áp dụng được — thử lại.");
      }
    });

  const discard = () =>
    startTransition(async () => {
      if (!draft) return;
      try {
        const r = await discardAiDraftAction(draft.id);
        if (!r.ok) return setError(r.error);
        setDraft(r.value);
        setPlan(null);
        toast.success("Đã bỏ bản nháp.");
      } catch {
        setError("Không bỏ được bản nháp — thử lại.");
      }
    });

  return (
    <div className="space-y-5">
      <SectionCard
        title="Mô tả cho AI"
        description={
          view.ai.available
            ? `${view.ai.source ? AI_SOURCE_LABEL[view.ai.source] : ""} · ${view.ai.model ?? ""} · hôm nay đã dùng ${view.usedToday}/${view.limits.maxDraftsPerDay} lượt`
            : "Chưa có kết nối AI"
        }
      >
        {!view.ai.available ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">Chưa có kết nối AI cho tổ chức này.</p>
            <p className="text-muted-foreground">{view.ai.reason}</p>
            <p>
              <Link href="/settings/connections" className="font-medium text-primary underline underline-offset-2">
                Mở Kết nối theo tổ chức
              </Link>{" "}
              để khai khoá Anthropic hoặc OpenAI của tổ chức — tổ chức trả tiền token của chính mình. Mẫu cấu hình dựng sẵn vẫn dùng được ở{" "}
              <Link href="/settings/templates" className="font-medium text-primary underline underline-offset-2">
                Mẫu cấu hình
              </Link>
              .
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Chế độ">
              {(["new", "edit"] as const).map((m) => (
                <Button key={m} type="button" size="sm" variant={mode === m ? "default" : "outline"} aria-pressed={mode === m} onClick={() => setMode(m)} disabled={pending}>
                  {m === "new" ? "Dựng mới từ mô tả doanh nghiệp" : "Yêu cầu thay đổi (sửa lặp)"}
                </Button>
              ))}
            </div>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={view.limits.maxPromptChars}
              rows={4}
              placeholder={mode === "new" ? "Ví dụ: công ty bán buôn có CRM, đơn hàng, mua hàng, kho và tài chính…" : "Ví dụ: thêm bước trưởng phòng duyệt đơn trên 20 triệu…"}
              aria-label={mode === "new" ? "Mô tả doanh nghiệp" : "Yêu cầu thay đổi"}
            />
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Ví dụ:</span>
              {examples.map((ex) => (
                <button key={ex} type="button" className="rounded-full border px-2 py-0.5 hover:bg-muted" onClick={() => setPrompt(ex)} disabled={pending}>
                  {ex}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={create} disabled={pending || prompt.trim().length < 10}>
                {pending ? "AI đang soạn… (có thể mất 1–2 phút)" : "Tạo bản nháp"}
              </Button>
              <p className="text-xs text-muted-foreground">
                AI chỉ SOẠN — không ghi gì. {mode === "edit" ? "Chế độ sửa gửi kèm tóm tắt cấu hình (tên + khoá), không gửi dữ liệu, người dùng hay bí mật." : ""}
              </p>
            </div>
          </div>
        )}
        {error ? (
          <div className={`${ALERT} mt-3`} role="alert">
            {error}
          </div>
        ) : null}
      </SectionCard>

      {draft ? (
        <SectionCard
          title={draft.name ?? "Bản nháp chưa có gói"}
          description={`${AI_BUILDER_MODE_LABEL[draft.mode]} · ${AI_DRAFT_STATUS_LABEL[draft.status]} · ${draft.aiCalls} lượt gọi AI · ${draft.inputTokens + draft.outputTokens} token · ${usd(draft.costUsd)}`}
          actions={
            draft.status === "DRAFT" ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={discard} disabled={pending}>
                  Bỏ nháp
                </Button>
                <Button size="sm" variant="outline" onClick={() => preview()} disabled={pending || !editable}>
                  Xem trước
                </Button>
                <Button size="sm" onClick={() => setConfirming(true)} disabled={pending || !plan || !plan.ok || plan.counts.CREATE + plan.counts.UPDATE === 0} title={!plan ? "Xem trước trước khi áp dụng" : !plan.ok ? "Còn mục bị chặn" : undefined}>
                  Áp dụng
                </Button>
              </div>
            ) : null
          }
          padded={false}
          contentClassName="space-y-3 p-4"
        >
          <p className="text-xs text-muted-foreground">
            <b>Yêu cầu:</b> {draft.prompt}
          </p>
          {draft.error ? <div className={ALERT}>{draft.error}</div> : null}
          {draft.errors.length > 0 ? (
            <details className={WARN} open={!draft.valid}>
              <summary className="cursor-pointer font-medium">Bộ kiểm báo {draft.errors.length} lỗi — mục có lỗi sẽ BỊ CHẶN khi xem trước; bỏ chọn mục đó hoặc soạn lại.</summary>
              <ul className="mt-1 list-disc pl-5">
                {draft.errors.slice(0, 40).map((e, i) => (
                  <li key={i}>
                    <span className="font-mono">{e.path || "(gói)"}</span>: {e.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {draft.groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">Không có mục nào để xem — AI chưa nộp gói hợp lệ.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {draft.groups.map((g) => (
                <div key={g.kind} className="rounded-xl border p-3">
                  <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {g.label} ({g.items.length})
                  </p>
                  <ul className="space-y-1.5">
                    {g.items.map((it) => {
                      const keep = !excluded.includes(it.key);
                      return (
                        <li key={it.key} className="flex items-start gap-2 text-sm">
                          <Checkbox checked={it.context || keep} disabled={it.context || !editable || pending} onCheckedChange={(v) => toggleItem(it.key, v === true)} aria-label={`Giữ ${it.label}`} className="mt-0.5" />
                          <div className="min-w-0">
                            <span className={keep || it.context ? "font-medium" : "font-medium text-muted-foreground line-through"}>{it.label}</span>
                            {it.context ? <span className="ml-1.5 rounded-full border px-1.5 text-[11px] text-muted-foreground">đã có — tham chiếu</span> : null}
                            {it.detail ? <div className="truncate text-xs text-muted-foreground">{it.detail}</div> : null}
                            {it.issues.map((m, i) => (
                              <div key={i} className="text-xs text-rose-700 dark:text-rose-300">
                                {m}
                              </div>
                            ))}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {draft.warnings.length > 0 ? (
            <div className={WARN}>
              {draft.warnings.map((w, i) => (
                <p key={i}>{w.message}</p>
              ))}
            </div>
          ) : null}

          {plan ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold">
                Kế hoạch (chưa ghi gì) —{" "}
                {(Object.entries(plan.counts) as [PlanAction, number][])
                  .filter(([, n]) => n > 0)
                  .map(([a, n]) => `${PLAN_ACTION_LABEL[a]} ${n}`)
                  .join(" · ")}
              </p>
              {plan.issues.length ? <div className={ALERT}>{plan.issues.map((e) => e.message).join(" · ")}</div> : null}
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full min-w-[760px] text-sm">
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
                            <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11.5px] font-medium ${ACTION_TONE[s.action]}`}>{PLAN_ACTION_LABEL[s.action]}</span>
                            {s.publish ? <div className="mt-1 text-[11.5px] text-muted-foreground">+ xuất bản</div> : null}
                          </td>
                          <td className="max-w-[360px] px-3 py-2 text-xs text-muted-foreground">{s.reason ?? "—"}</td>
                          <td className="px-3 py-2 text-right">{overridable ? <Switch checked={resolutions[k] === "overwrite"} disabled={pending} onCheckedChange={(v) => toggleOverwrite(k, v)} aria-label={`Ghi đè ${s.label}`} /> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : draft.status === "DRAFT" && editable ? (
            <p className="text-xs text-muted-foreground">Bỏ chọn mục không muốn, rồi bấm «Xem trước» để máy lập kế hoạch (Tạo mới / Cập nhật / Trùng thứ có sẵn / Bị chặn).</p>
          ) : null}

          {result ? (
            <div className={result.ok ? "rounded-lg border border-emerald-300/70 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200" : ALERT} aria-live="polite">
              <p className="font-medium">{result.ok ? `Đã áp dụng — ${result.outcomes.filter((o) => o.status === "DONE").length} bước đã ghi. Luật ở NHÁP + CHẠY THỬ.` : "Chưa áp dụng được."}</p>
              {result.ok ? (
                <p className="mt-1 text-xs">
                  <Link href="/settings/workflows" className="underline underline-offset-2">
                    Luật tự động
                  </Link>{" "}
                  ·{" "}
                  <Link href="/settings/pages" className="underline underline-offset-2">
                    Trang tuỳ biến
                  </Link>{" "}
                  ·{" "}
                  <Link href="/settings/templates" className="underline underline-offset-2">
                    Lịch sử cài
                  </Link>
                </p>
              ) : null}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      <AlertDialog open={confirming} onOpenChange={(o) => !pending && setConfirming(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Áp dụng bản nháp «{draft?.name ?? ""}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Máy sẽ ghi {plan?.counts.CREATE ?? 0} mục mới và cập nhật {plan?.counts.UPDATE ?? 0} mục cho CẢ tổ chức, đúng theo kế hoạch đang hiện, qua bộ cài mẫu cấu hình. Luật luôn ở NHÁP + CHẠY THỬ; trang sửa lại
              chỉ vào NHÁP. Mục trùng thứ có sẵn giữ nguyên trừ khi bạn bật «Ghi đè».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                apply();
              }}
            >
              {pending ? "Đang áp dụng…" : "Xác nhận áp dụng"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
