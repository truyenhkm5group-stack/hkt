import { Wand2 } from "lucide-react";
import { ManualGenAutoRefresh, ManualGenForm, ManualGenImageTile, PublishQueue } from "@/app/(dashboard)/marketing/creatives/manual-gen";
import { VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb } from "@/db";
import { MANUAL_GEN_IMAGE_STATUSES, MANUAL_GEN_IMAGE_STATUS_LABEL, MANUAL_GEN_KIND_LABEL, MANUAL_GEN_RUN } from "@/lib/constants/creative-loop";
import { manualGenPreselect } from "@/lib/constants/stock-feedback";
import { formatDate, formatNumber, formatVND, vnShortStamp } from "@/lib/format";
import { loadManualGenPanel, type ManualGenRunCard } from "@/lib/queries/creative-manual-gen";

/**
 * ═══════════ GEN ẢNH BẰNG TAY + KHU "KẾT QUẢ GEN TAY" (chủ shop 25–26/09/2026, §5i) ═══════════
 *
 * Mặc định THIẾT KẾ MỚI: người chọn các mẫu bán tốt làm cảm hứng + ý tưởng (+ ảnh tải lên) + SỐ ẢNH → máy vẽ vào
 * khu này (KHÔNG vào lô). Kiểu phụ "ảnh mới cho mẫu đang có": ảnh sản phẩm thật (+ quảng cáo cũ cùng mã) → ảnh
 * của CHÍNH mẫu ấy — `?product=` (đề xuất đẩy tồn) mở thẳng kiểu này. Sau đó như nhau: người Duyệt / Loại từng
 * ảnh → máy viết câu chữ theo ảnh → người soạn tên + câu chữ rồi "Đưa vào lô" (chờ duyệt lô) hoặc "Đăng camp"
 * (lên Facebook ngay / hẹn giờ). Gen tay KHÔNG còn trần ảnh / ngày: màn hình in tiền ước tính trước khi bấm,
 * tiền thật từng ảnh, từng lượt và cả ngày.
 */
export async function ManualGenPanel({ canEdit, canPublish = false, preselectProductId = null, day }: { canEdit: boolean; canPublish?: boolean; preselectProductId?: string | null; day?: string }) {
  const db = await getDb();
  const now = new Date();
  const p = await loadManualGenPanel(db, now, day);
  // `?product=` chỉ CHỌN SẴN ô ảnh gốc — không vẽ gì cho tới khi người bấm Gen (vẽ ảnh tốn tiền).
  const chon = manualGenPreselect(p.sources, preselectProductId);
  const pr = p.pricing;
  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Wand2 className="size-4" /> Gen ảnh bằng tay <ManualGenAutoRefresh active={p.drawing} />
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground" title={pr.todayUnpriced ? `${pr.todayUnpriced} ảnh đã vẽ hôm nay không có giá từ máy vẽ — tổng CHƯA gồm phần ấy.` : undefined}>
            {p.isToday ? "Hôm nay" : `Ngày ${formatDate(p.day)}`} đã chi <b className="numeric text-foreground">{formatVND(pr.todayImages ? pr.todayVnd : 0)}</b> · <span className="numeric">{formatNumber(pr.todayImages)}</span> ảnh
            {pr.todayUnpriced ? <span className="text-warning"> ({pr.todayUnpriced} ảnh chưa có giá)</span> : null}
          </span>
        </span>
      }
      description={`Chọn số ảnh mỗi lần bấm (${MANUAL_GEN_RUN.minImagesPerRun}–${MANUAL_GEN_RUN.maxImagesPerRun}). Duyệt ảnh nào thì ảnh ấy mới soạn bài được: "Đưa vào lô" ${p.targetDay} (hạn duyệt ${vnShortStamp(p.deadline)}) hoặc "Đăng camp" lên Facebook ngay / hẹn giờ.`}
      hint={
        <>
          Gen tay không còn trần ảnh / ngày — trần của lô hằng ngày tính riêng, không bị gen tay ăn mất. Giá ước tính mỗi ảnh theo cấu hình đang chạy ({pr.model} · {pr.quality} · {pr.size}): ~{formatVND(pr.unitVnd)} ({pr.unitUsd} USD, tỷ giá{" "}
          {formatNumber(pr.usdToVnd)} ₫/USD). Tiền từng ảnh là tiền THẬT máy vẽ báo về; ảnh không có giá hiện “—” và không cộng vào tổng. Máy vẽ sau khi bạn bấm (không bắt chờ) và tự cập nhật trang; tiến trình chết giữa chừng thì lượt vòng mẫu vẽ nốt.
        </>
      }
    >
      <div className="space-y-4">
        {canEdit && chon.note ? <p className="rounded-md border border-dashed px-2.5 py-1.5 text-[12px] text-muted-foreground">{chon.note}</p> : null}
        {canEdit ? <ManualGenForm key={chon.photoId} initialKind={preselectProductId ? "MOCKUP" : "DESIGN"} inspirations={p.inspirations} sources={p.sources} unitVnd={pr.unitVnd} unitUsd={pr.unitUsd} initialPhotoId={chon.photoId} /> : null}
        <PublishQueue items={p.queue} canEdit={canEdit} canPublish={canPublish} instant={p.instant} pageName={p.pageName} defaults={p.defaults} predictedSeq={p.predictedSeq} targetDay={p.targetDay} />
        <div className="space-y-3">
          <p className="text-[12.5px] font-semibold">
            Kết quả gen tay — {p.isToday ? "hôm nay" : `ngày ${formatDate(p.day)}`}
            {p.runs.length ? <span className="ml-1 font-normal text-muted-foreground">({p.runs.length} lượt, mới nhất trước)</span> : null}
          </p>
          {p.runs.length === 0 ? (
            <EmptyState
              title={p.isToday ? "Hôm nay chưa có lượt gen nào" : `Không có lượt gen nào ngày ${formatDate(p.day)}`}
              description={p.isToday ? "Chọn các mẫu bán tốt làm cảm hứng, gõ ý tưởng (tuỳ chọn) rồi bấm Gen thiết kế mới. Kết quả các ngày trước: chọn ngày ở thanh “Kết quả ngày”." : "Chọn ngày khác ở thanh “Kết quả ngày”, hoặc bấm Hôm nay."}
            />
          ) : (
            p.runs.map((run) => (
              <div key={run.id} className="space-y-2 rounded-lg border p-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                  {run.kind === "DESIGN" ? (
                    <p>
                      <b>{MANUAL_GEN_KIND_LABEL.DESIGN}</b> từ {run.inspirationLabels.join(", ") || "—"} · {run.createdByName || "—"} · {vnShortStamp(run.createdAt)}
                    </p>
                  ) : (
                    <p>
                      <b>{run.productName ?? "Mã đã xoá"}</b> · {run.photoTitle}
                      {run.ownAdTitle ? ` + ${run.ownAdTitle}` : ""} · {run.createdByName || "—"} · {vnShortStamp(run.createdAt)}
                    </p>
                  )}
                  <p className="flex flex-wrap items-center gap-1">
                    <RunCost run={run} />
                    {MANUAL_GEN_IMAGE_STATUSES.filter((s) => (run.counts[s] ?? 0) > 0).map((s) => (
                      <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px]">
                        {MANUAL_GEN_IMAGE_STATUS_LABEL[s]} <b className="numeric">{run.counts[s]}</b>
                      </span>
                    ))}
                  </p>
                </div>
                {run.idea ? (
                  <p className="line-clamp-2 text-[11.5px] text-muted-foreground" title={run.idea}>
                    Ý tưởng: {run.idea}
                  </p>
                ) : null}
                {run.uploadImageIds.length ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    Ảnh tải lên:
                    {run.uploadImageIds.map((id, i) => (
                      <VariantImage key={id} imageId={id} available alt={`Ảnh tải lên #${i + 1}`} className="size-9 rounded" iconClassName="size-3" />
                    ))}
                  </div>
                ) : null}
                {run.note ? <p className="text-[11.5px] text-warning">{run.note}</p> : null}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  {run.images.map((img) => (
                    <ManualGenImageTile key={img.id} img={img} canEdit={canEdit} canPublish={canPublish} instant={p.instant} pageName={p.pageName} defaults={p.defaults} predictedSeq={p.predictedSeq} targetDay={p.targetDay} />
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

/** Tiền THẬT của một lượt: cộng ảnh có giá; ảnh chưa có giá nói riêng (tổng thiếu phần ấy — không lấp bằng ước tính). */
function RunCost({ run }: { run: ManualGenRunCard }) {
  const { cost } = run;
  if (cost.pricedImages === 0 && cost.unpricedImages === 0) return <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">Chi phí: —</span>;
  return (
    <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10.5px] text-brand" title={`${cost.usd.toFixed(4)} USD cho ${cost.pricedImages} ảnh có giá${cost.unpricedImages ? ` · ${cost.unpricedImages} ảnh đã vẽ chưa có giá (không cộng)` : ""}`}>
      Chi phí lượt <b className="numeric">{formatVND(cost.vnd)}</b>
      {cost.unpricedImages ? <span className="text-warning"> · {cost.unpricedImages} ảnh chưa có giá</span> : null}
    </span>
  );
}
