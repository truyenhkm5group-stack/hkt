import { Badge } from "@/components/ui/badge";
import { VIDEO_ANGLE_LABEL, VIDEO_QC_CHECK_LABEL, VIDEO_VARIANT_STATUS_LABEL, isVideoAngle, type VideoQcCheck, type VideoVariantStatus } from "@/lib/constants/video-scale";
import type { VariantCard } from "@/lib/queries/video-scale";
import { cn } from "@/lib/utils";
import { BulkApproveButton, ReviewActions } from "./review-actions";
import { RemakeVariantButton } from "./small-actions";
import { ContentEditor } from "./content-editor";
import { VideoEditor } from "./video-editor";
import { captionOptionsOf } from "@/lib/video-scale/publish";
import { VIDEO_POST_STATUS_LABEL, type VideoPostStatus } from "@/lib/constants/video-scale";
import { formatDateTime } from "@/lib/format";

const VERDICT_LABEL = { PASS: "QC đạt", FLAG: "QC nghi ngờ — xem kỹ", FAIL: "QC loại" } as const;

type Qc = {
  technical?: { verdict?: string; problems?: string[] };
  visual?: { ran?: boolean; reason?: string; summary?: string; checks?: { check: string; result: string; note: string }[] };
};

function QcBlock({ v }: { v: VariantCard }) {
  const qc = v.qc as Qc;
  return (
    <div className="space-y-1 text-[12.5px]">
      {v.qcVerdict ? (
        <Badge variant={v.qcVerdict === "FAIL" ? "destructive" : v.qcVerdict === "FLAG" ? "secondary" : "outline"}>{VERDICT_LABEL[v.qcVerdict]}</Badge>
      ) : null}
      {qc.technical?.problems?.length ? <p className="text-destructive">Kỹ thuật: {qc.technical.problems.join("; ")}</p> : qc.technical ? <p className="text-muted-foreground">Kỹ thuật: đạt (H.264, AAC 48 kHz, 9:16, độ dài đúng)</p> : null}
      {qc.visual?.ran === false ? <p className="text-muted-foreground">QC hình ảnh chưa chạy: {qc.visual.reason}</p> : null}
      {qc.visual?.checks?.length ? (
        <ul className="space-y-0.5">
          {qc.visual.checks.map((c) => (
            <li key={c.check} className={cn(c.result === "FAIL" && "text-destructive", c.result === "UNSURE" && "text-amber-700 dark:text-amber-400")}>
              {c.result === "PASS" ? "✓" : c.result === "FAIL" ? "✗" : "?"} {VIDEO_QC_CHECK_LABEL[c.check as VideoQcCheck] ?? c.check}: {c.note}
            </li>
          ))}
        </ul>
      ) : null}
      {qc.visual?.summary ? <p className="text-muted-foreground">{qc.visual.summary}</p> : null}
    </div>
  );
}

function VariantBlock({ v, canEdit, canSpend, pageLabel, music }: { v: VariantCard; canEdit: boolean; canSpend: boolean; pageLabel: string | null; music: { id: string; title: string; assetId: string }[] }) {
  return (
    <article className="space-y-3 rounded-lg border p-3">
      <header className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-semibold">
          {v.productName} #{v.seq}
        </span>
        <Badge variant="secondary">{isVideoAngle(v.angle) ? VIDEO_ANGLE_LABEL[v.angle] : v.angle}</Badge>
        <Badge variant="outline">{VIDEO_VARIANT_STATUS_LABEL[v.status as VideoVariantStatus] ?? v.status}</Badge>
        {v.isTest ? <Badge variant="destructive">DỮ LIỆU THỬ — không đăng</Badge> : null}
        {v.durationMs ? <span className="text-muted-foreground">{(v.durationMs / 1000).toFixed(1)} giây</span> : null}
      </header>
      {/* So video với ảnh gốc: hai cột trên máy tính, chồng dọc trên điện thoại. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-[12px] text-muted-foreground">Video</p>
          {v.finalAssetId ? (
            <video controls playsInline preload="metadata" poster={v.thumbnailAssetId ? `/api/video-scale/assets/${v.thumbnailAssetId}` : undefined} className="aspect-[9/16] w-full max-w-xs rounded bg-black">
              <source src={`/api/video-scale/assets/${v.finalAssetId}`} type="video/mp4" />
            </video>
          ) : null}
          {v.finalAssetId ? (
            <a href={`/api/video-scale/assets/${v.finalAssetId}`} download={`video-${v.seq}.mp4`} className="mt-1 inline-block text-[12px] text-primary underline underline-offset-2">
              Tải video (mp4)
            </a>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">Chưa có bản hoàn chỉnh.</p>
          )}
        </div>
        <div>
          <p className="mb-1 text-[12px] text-muted-foreground">Ảnh gốc (sản phẩm thật)</p>
          {v.sourceImageId ? (
            // eslint-disable-next-line @next/next/no-img-element -- ảnh trong CSDL qua route có kiểm quyền
            <img src={`/api/creative/images/${v.sourceImageId}`} alt="Ảnh sản phẩm gốc" className="aspect-[9/16] w-full max-w-xs rounded object-cover" loading="lazy" />
          ) : (
            <p className="text-[12.5px] text-muted-foreground">Không đọc được ảnh gốc.</p>
          )}
        </div>
      </div>
      <QcBlock v={v} />
      <details className="text-[12.5px]">
        <summary className="cursor-pointer font-medium">Kịch bản</summary>
        <div className="mt-1 space-y-1">
          <p>
            <b>Móc câu:</b> {v.script.hook}
          </p>
          {v.script.scenes.map((s, i) => (
            <div key={i} className="rounded bg-muted/50 p-2">
              <p>
                <b>Cảnh {i + 1} — chữ trên hình:</b> {s.overlay || "—"}
              </p>
              <p>
                <b>Lời đọc:</b> {s.voiceover || "—"}
              </p>
              <p className="text-muted-foreground">
                <b>Câu lệnh video:</b> {s.prompt}
              </p>
            </div>
          ))}
          <p>
            <b>CTA:</b> {v.script.cta}
          </p>
        </div>
      </details>
      {v.reviewedBy ? (
        <p className="text-[12px] text-muted-foreground">
          {v.autoApproved ? "Máy tự duyệt (QC đạt, mã bật tự duyệt)" : `Người quyết: ${v.reviewedBy}`}
          {v.reviewNote ? ` — ${v.reviewNote}` : ""}
        </p>
      ) : null}
      {canEdit && v.status === "REVIEW" ? <ReviewActions variantId={v.id} /> : null}
      {canEdit && !v.isTest && !v.hasAd && (!v.post || ["FAILED", "CANCELLED"].includes(v.post.status)) && ["REVIEW", "APPROVED", "REJECTED", "QC_FAILED"].includes(v.status) ? (
        <VideoEditor variantId={v.id} productId={v.productId} script={v.script} render={v.render} music={music} approved={v.status === "APPROVED"} sceneClips={v.sceneClips} posterUrl={v.sourceImageId ? `/api/creative/images/${v.sourceImageId}` : v.thumbnailAssetId ? `/api/video-scale/assets/${v.thumbnailAssetId}` : null} />
      ) : null}
      {v.post ? (
        <p className="text-[12.5px]">
          Reel: <b>{VIDEO_POST_STATUS_LABEL[v.post.status as VideoPostStatus] ?? v.post.status}</b>
          {v.post.publishedAt ? ` · ${formatDateTime(v.post.publishedAt)}` : v.post.publishAt ? ` · hẹn ${formatDateTime(v.post.publishAt)}` : ""}
          {v.post.permalink ? (
            <a className="ml-1 text-primary underline" href={v.post.permalink} target="_blank" rel="noreferrer">
              mở
            </a>
          ) : null}
          {v.post.error ? <span className="block text-destructive">{v.post.error}</span> : null}
        </p>
      ) : null}
      {v.status === "APPROVED" && !v.isTest && (!v.post || ["FAILED", "CANCELLED"].includes(v.post.status)) ? (
        <ContentEditor variantId={v.id} options={captionOptionsOf(v.captionOptions)} caption={v.caption} captionState={v.captionState} captionBy={v.captionBy} canPost={canEdit && Boolean(pageLabel)} pageLabel={pageLabel} />
      ) : null}
      {canSpend && (v.status === "QC_FAILED" || v.status === "REJECTED") ? <RemakeVariantButton variantId={v.id} /> : null}
    </article>
  );
}

/** Tab "Duyệt video": chờ duyệt ở trên, đã quyết gần đây ở dưới. */
export function ReviewPanel({ review, decided, pageOf, canEdit, canSpend, music }: { review: VariantCard[]; decided: VariantCard[]; pageOf: Record<string, string | null>; canEdit: boolean; canSpend: boolean; music: { id: string; title: string; assetId: string }[] }) {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[14px] font-semibold">
            Chờ duyệt ({review.length})
            {review.length ? (
              <span className="ml-2 text-[12px] font-normal text-muted-foreground">
                {review.filter((v) => v.qcVerdict === "PASS").length} QC đạt · {review.filter((v) => v.qcVerdict === "FLAG").length} nghi ngờ — xem kỹ
              </span>
            ) : null}
          </h2>
          {canEdit ? <BulkApproveButton variantIds={review.filter((v) => v.qcVerdict === "PASS").map((v) => v.id)} /> : null}
        </div>
        {review.length === 0 ? <p className="text-[13px] text-muted-foreground">Không có video chờ duyệt.</p> : <div className="grid gap-3 lg:grid-cols-2">{review.map((v) => <VariantBlock key={v.id} v={v} canEdit={canEdit} canSpend={canSpend} pageLabel={pageOf[v.productId] ?? null} music={music} />)}</div>}
      </section>
      <section className="space-y-3">
        <h2 className="text-[14px] font-semibold">Đã quyết gần đây</h2>
        {decided.length === 0 ? <p className="text-[13px] text-muted-foreground">Chưa có.</p> : <div className="grid gap-3 lg:grid-cols-2">{decided.map((v) => <VariantBlock key={v.id} v={v} canEdit={canEdit} canSpend={canSpend} pageLabel={pageOf[v.productId] ?? null} music={music} />)}</div>}
      </section>
    </div>
  );
}
