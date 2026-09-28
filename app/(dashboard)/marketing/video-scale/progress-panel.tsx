import Link from "next/link";
import { CheckCircle2, Circle, CircleAlert, Clapperboard, Loader2, PauseCircle } from "lucide-react";
import { VIDEO_ANGLE_LABEL, VIDEO_PROVIDER_LABEL, humanProviderError, isVideoAngle, jobStepState, type StepState, type VideoProviderId } from "@/lib/constants/video-scale";
import { formatDateTime } from "@/lib/format";
import type { ProgressJob, ProgressRun, ProgressVariant } from "@/lib/queries/video-scale";
import { cn } from "@/lib/utils";
import { CancelRunButton, RemakeVariantButton, RetryJobButton, SceneToPhotoButton } from "./small-actions";

const RUN_STATUS: Record<string, { label: string; cls: string }> = {
  SCRIPTING: { label: "Đang viết kịch bản", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  PRODUCING: { label: "Đang sản xuất video", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  REVIEW: { label: "Có video chờ duyệt", cls: "bg-amber-500/20 text-amber-800 dark:text-amber-300" },
  DONE: { label: "Xong", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  FAILED: { label: "Hỏng", cls: "bg-destructive/15 text-destructive" },
  CANCELLED: { label: "Đã huỷ", cls: "bg-muted text-muted-foreground" },
};

const TONE_CLS: Record<StepState["tone"], string> = {
  todo: "border-muted-foreground/30 text-muted-foreground",
  run: "border-sky-500/60 bg-sky-500/5",
  done: "border-emerald-500/60 bg-emerald-500/5",
  fail: "border-destructive/60 bg-destructive/5",
  block: "border-amber-500/60 bg-amber-500/5",
};

function ToneIcon({ tone }: { tone: StepState["tone"] }) {
  if (tone === "done") return <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />;
  if (tone === "run") return <Loader2 className="size-4 shrink-0 animate-spin text-sky-600" />;
  if (tone === "fail") return <CircleAlert className="size-4 shrink-0 text-destructive" />;
  if (tone === "block") return <PauseCircle className="size-4 shrink-0 text-amber-600" />;
  return <Circle className="size-4 shrink-0 text-muted-foreground" />;
}

function minutesAgo(at: Date | null, now: Date): string {
  if (!at) return "";
  const m = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (m < 1) return "vừa xong";
  if (m < 60) return `${m} phút trước`;
  return formatDateTime(at);
}

/** Một bước (việc) của video: nhãn, trạng thái, thời gian, tiền, clip xem trước, lối ra khi hỏng. */
function Step({ title, job, now, canEdit, canSpend, isClip }: { title: string; job: ProgressJob | null; now: Date; canEdit: boolean; canSpend: boolean; isClip?: boolean }) {
  const st: StepState = job ? jobStepState(job, now) : { tone: "todo", label: "Chưa tới lượt", since: null };
  const failed = job && (job.status === "FAILED" || job.status === "BLOCKED");
  return (
    <div className={cn("flex min-w-[9.5rem] flex-1 flex-col gap-1 rounded-md border p-2 text-[12px]", TONE_CLS[st.tone])}>
      <div className="flex items-center gap-1.5 font-medium">
        <ToneIcon tone={st.tone} />
        <span>{title}</span>
      </div>
      <div>
        {st.label}
        {st.tone === "run" ? <span className="text-muted-foreground"> · từ {minutesAgo(st.since, now)}</span> : null}
        {st.tone === "todo" && job ? <span className="text-muted-foreground"> · {formatDateTime(job.nextRunAt)}</span> : null}
      </div>
      {job && job.costUsd !== null && job.costUsd > 0 ? <div className="text-muted-foreground">{job.costUsd.toFixed(2)} USD (ước tính)</div> : null}
      {job && job.costUsd === null && job.reservedUsd ? <div className="text-muted-foreground">giữ chỗ {job.reservedUsd.toFixed(2)} USD</div> : null}
      {isClip && job?.status === "SUCCEEDED" && job.outputAssetId ? (
        <video className="mt-1 aspect-[9/16] w-24 rounded bg-black" src={`/api/video-scale/assets/${job.outputAssetId}#t=0.5`} controls muted playsInline preload="metadata" />
      ) : null}
      {failed && job.error ? <p className="text-[11.5px] leading-snug">{humanProviderError(job.error)}</p> : null}
      {failed && canEdit ? (
        <div className="flex flex-wrap gap-1">
          {isClip ? <SceneToPhotoButton jobId={job.id} /> : null}
          {job.errorKind !== "AMBIGUOUS" || canSpend ? <RetryJobButton jobId={job.id} ambiguous={job.errorKind === "AMBIGUOUS"} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function VariantRow({ v, run, now, canEdit, canSpend }: { v: ProgressVariant; run: ProgressRun; now: Date; canEdit: boolean; canSpend: boolean }) {
  const pick = (kind: string, scene?: number) => [...v.jobs].reverse().find((j) => j.kind === kind && (scene === undefined || j.sceneIndex === scene)) ?? null;
  const scenes = Math.max(v.scenes, ...v.jobs.filter((j) => j.kind === "CLIP").map((j) => (j.sceneIndex ?? 0) + 1), 0);
  const aiUntil = run.aiScenes === null ? scenes : run.aiScenes;
  const ready = ["REVIEW", "APPROVED", "REJECTED", "QC_FAILED"].includes(v.status);
  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
        <b>Video #{v.seq}</b>
        <span>{isVideoAngle(v.angle) ? VIDEO_ANGLE_LABEL[v.angle] : v.angle}</span>
        {v.hook ? <span className="text-muted-foreground">&ldquo;{v.hook}&rdquo;</span> : null}
        {ready ? (
          <Link href="?tab=duyet" className="ml-auto rounded bg-primary px-2 py-0.5 text-[12px] font-medium text-primary-foreground">
            Xem video & duyệt →
          </Link>
        ) : null}
        {canSpend && (v.status === "FAILED" || v.status === "QC_FAILED") ? <RemakeVariantButton variantId={v.id} /> : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: scenes }, (_, i) => {
          const job = pick("CLIP", i);
          const photo = job?.provider === "PHOTO" || i >= aiUntil;
          return <Step key={i} title={`Cảnh ${i + 1} · ${photo ? "ảnh động" : "AI"}`} job={job} now={now} canEdit={canEdit} canSpend={canSpend} isClip />;
        })}
        {v.jobs.some((j) => j.kind === "TTS") ? <Step title="Giọng đọc" job={pick("TTS")} now={now} canEdit={canEdit} canSpend={canSpend} /> : null}
        <Step title="Hậu kỳ (ghép, chữ, nhạc)" job={pick("RENDER")} now={now} canEdit={canEdit} canSpend={canSpend} />
        <Step title="Kiểm chất lượng" job={pick("QC")} now={now} canEdit={canEdit} canSpend={canSpend} />
      </div>
      {v.finalAssetId ? (
        <div className="flex flex-wrap items-end gap-3">
          <video className="aspect-[9/16] w-40 rounded bg-black" src={`/api/video-scale/assets/${v.finalAssetId}#t=0.5`} controls playsInline preload="metadata" />
          <p className="text-[12px] text-muted-foreground">
            Video hoàn chỉnh{v.qcVerdict ? ` · QC: ${v.qcVerdict === "PASS" ? "đạt" : v.qcVerdict === "FLAG" ? "nghi ngờ — xem kỹ" : "loại"}` : ""}. Duyệt / loại ở tab{" "}
            <Link href="?tab=duyet" className="underline">
              Duyệt video
            </Link>
            .
          </p>
        </div>
      ) : null}
      {/* Lỗi của video thường chính là lỗi của một bước đã in ở trên — chỉ in khi không bước nào mang lỗi. */}
      {v.error && v.status === "FAILED" && !v.jobs.some((j) => j.error && (j.status === "FAILED" || j.status === "BLOCKED")) ? <p className="text-[12px] text-destructive">{humanProviderError(v.error)}</p> : null}
    </div>
  );
}

/**
 * TIẾN TRÌNH từng lượt "Tạo chiến dịch media": mỗi lượt một thẻ, mỗi video một hàng bước (kịch bản → từng cảnh → hậu kỳ → QC →
 * chờ duyệt), clip xem được ngay khi xong, lỗi nói bằng tiếng người kèm lối ra. Đọc thẳng hàng đợi — không tự suy trạng thái.
 */
export function ProgressPanel({ runs, now, canEdit, canSpend }: { runs: ProgressRun[]; now: Date; canEdit: boolean; canSpend: boolean }) {
  if (!runs.length) {
    return (
      <p className="rounded-lg border p-3 text-[13px] text-muted-foreground">
        Chưa có lượt nào. Vào tab <Link href="?tab=ma-win" className="underline">Mã win</Link> → &ldquo;Tạo chiến dịch media&rdquo;.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {runs.map((r) => {
        const st = RUN_STATUS[r.status] ?? { label: r.status, cls: "bg-muted" };
        const live = ["SCRIPTING", "PRODUCING"].includes(r.status);
        const ai = r.aiScenes === null ? "mọi cảnh AI" : r.aiScenes === 0 ? "toàn ảnh động (miễn phí)" : `${r.aiScenes} cảnh AI, còn lại ảnh động`;
        return (
          <section key={r.id} className="space-y-2 rounded-lg border p-3">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <Clapperboard className="size-4 text-muted-foreground" />
              <b className="text-[14px]">{r.productName}</b>
              <span className={cn("rounded px-2 py-0.5 text-[12px] font-medium", st.cls)}>{st.label}</span>
              {r.isTest ? <span className="rounded bg-amber-500/20 px-1.5 text-[12px] font-medium">DỮ LIỆU THỬ</span> : null}
              <span className="text-muted-foreground">
                {VIDEO_PROVIDER_LABEL[r.provider as VideoProviderId] ?? r.provider}
                {r.model ? ` · ${r.model}` : ""} · {ai}
              </span>
              <span className="text-muted-foreground">
                Tạo {minutesAgo(r.createdAt, now)}
                {r.createdBy ? ` bởi ${r.createdBy}` : ""}
              </span>
              <span className="ml-auto tabular-nums">
                Đã chi {r.costUsd === null ? "0,00" : r.costUsd.toFixed(2)} USD{r.reservedUsd > 0 ? <span className="text-muted-foreground"> · đang giữ chỗ {r.reservedUsd.toFixed(2)}</span> : null}
              </span>
              {canSpend && live ? <CancelRunButton runId={r.id} /> : null}
            </header>
            {r.scriptJob && r.scriptJob.status !== "SUCCEEDED" ? (
              <div className="flex">
                <Step title="Viết kịch bản" job={r.scriptJob} now={now} canEdit={canEdit} canSpend={canSpend} />
              </div>
            ) : null}
            {r.error ? <p className="text-[12px] text-destructive">{humanProviderError(r.error)}</p> : null}
            <div className="space-y-2">
              {r.variants.map((v) => (
                <VariantRow key={v.id} v={v} run={r} now={now} canEdit={canEdit} canSpend={canSpend} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
