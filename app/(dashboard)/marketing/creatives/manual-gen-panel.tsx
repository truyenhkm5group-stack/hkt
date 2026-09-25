import { Wand2 } from "lucide-react";
import { ManualGenAutoRefresh, ManualGenForm, ManualGenImageTile } from "@/app/(dashboard)/marketing/creatives/manual-gen";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb } from "@/db";
import { MANUAL_GEN_IMAGE_STATUSES, MANUAL_GEN_IMAGE_STATUS_LABEL } from "@/lib/constants/creative-loop";
import { manualGenPreselect } from "@/lib/constants/stock-feedback";
import { formatNumber, vnShortStamp } from "@/lib/format";
import { loadManualGenPanel } from "@/lib/queries/creative-manual-gen";

/**
 * ═══════════ GEN ẢNH BẰNG TAY + KHU "KẾT QUẢ GEN TAY" (chủ shop 25/09/2026, §5i) ═══════════
 *
 * Người chọn ảnh sản phẩm thật (+ tuỳ chọn quảng cáo cũ cùng mã) và ý tưởng → máy vẽ 10 ảnh vào khu này
 * (KHÔNG vào lô) → người Duyệt / Loại từng ảnh → ảnh duyệt được máy viết câu chữ theo ảnh → người soạn
 * tên + câu chữ rồi "Đưa vào lô" chờ duyệt đăng. Trần chi ảnh là trần chung với lô hằng ngày.
 */
export async function ManualGenPanel({ canEdit, preselectProductId = null }: { canEdit: boolean; preselectProductId?: string | null }) {
  const db = await getDb();
  const now = new Date();
  const p = await loadManualGenPanel(db, now);
  // `?product=` chỉ CHỌN SẴN ô ảnh gốc — không vẽ gì cho tới khi người bấm Gen (vẽ ảnh tốn tiền).
  const chon = manualGenPreselect(p.sources, preselectProductId);
  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Wand2 className="size-4" /> Gen ảnh bằng tay <ManualGenAutoRefresh active={p.drawing} />
        </span>
      }
      description={`Mỗi lần bấm máy vẽ ${p.capacity.perRun} ảnh vào "Kết quả gen tay" — duyệt ảnh nào thì ảnh ấy mới được soạn bài và đưa vào lô ${p.targetDay} (hạn duyệt ${vnShortStamp(p.deadline)}).`}
      hint={
        <>
          Trần chi ảnh CHUNG với lô hằng ngày: hôm nay đã sinh {formatNumber(p.capacity.spentImages)} ảnh · ~{p.capacity.spentUsd.toFixed(2)} / {p.capacity.capUsd} USD, mỗi ảnh ước tính {p.capacity.unitUsd} USD. Vượt trần thì máy vẽ được
          bao nhiêu báo bấy nhiêu. Máy vẽ sau khi bạn bấm (không bắt chờ) và tự cập nhật trang; tiến trình chết giữa chừng thì lượt vòng mẫu vẽ nốt. Ảnh vào lô vẫn phải qua DUYỆT CẢ LÔ.
        </>
      }
    >
      <div className="space-y-4">
        {canEdit && chon.note ? <p className="rounded-md border border-dashed px-2.5 py-1.5 text-[12px] text-muted-foreground">{chon.note}</p> : null}
        {canEdit ? <ManualGenForm key={chon.photoId} sources={p.sources} allowedNow={p.capacity.allowedNow} capReason={p.capacity.reason} disabledReason={null} initialPhotoId={chon.photoId} /> : null}
        <div className="space-y-3">
          <p className="text-[12.5px] font-semibold">Kết quả gen tay</p>
          {p.runs.length === 0 ? (
            <EmptyState title="Chưa có lượt gen nào" description="Chọn ảnh sản phẩm thật, gõ ý tưởng (tuỳ chọn) rồi bấm Gen." />
          ) : (
            p.runs.map((run) => (
              <div key={run.id} className="space-y-2 rounded-lg border p-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                  <p>
                    <b>{run.productName ?? "Mã đã xoá"}</b> · {run.photoTitle}
                    {run.ownAdTitle ? ` + ${run.ownAdTitle}` : ""} · {run.createdByName || "—"} · {vnShortStamp(run.createdAt)}
                  </p>
                  <p className="flex flex-wrap gap-1">
                    {MANUAL_GEN_IMAGE_STATUSES.filter((s) => (run.counts[s] ?? 0) > 0).map((s) => (
                      <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px]">
                        {MANUAL_GEN_IMAGE_STATUS_LABEL[s]} <b className="numeric">{run.counts[s]}</b>
                      </span>
                    ))}
                  </p>
                </div>
                {run.idea ? <p className="line-clamp-2 text-[11.5px] text-muted-foreground" title={run.idea}>Ý tưởng: {run.idea}</p> : null}
                {run.note ? <p className="text-[11.5px] text-warning">{run.note}</p> : null}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  {run.images.map((img) => (
                    <ManualGenImageTile key={img.id} img={img} canEdit={canEdit} pageName={p.pageName} defaults={p.defaults} predictedSeq={p.predictedSeq} targetDay={p.targetDay} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </SectionCard>
  );
}
