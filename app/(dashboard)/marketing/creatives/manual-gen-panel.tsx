import { ImagePlus, Rocket, ScanEye, Wand2 } from "lucide-react";
import { ManualForm } from "@/app/(dashboard)/marketing/creatives/manual-form";
import { ManualGenAutoRefresh, ManualGenForm, ManualGenImageTile, PublishQueue, type ComposeCtx } from "@/app/(dashboard)/marketing/creatives/manual-gen";
import { ReviewDayFilter } from "@/app/(dashboard)/marketing/creatives/review-day-filter";
import { VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb } from "@/db";
import { MANUAL_GEN_IMAGE_STATUSES, MANUAL_GEN_IMAGE_STATUS_LABEL, MANUAL_GEN_KIND_LABEL, MANUAL_GEN_RUN, REVIEW_DAY } from "@/lib/constants/creative-loop";
import { manualGenPreselect } from "@/lib/constants/stock-feedback";
import { formatDate, formatNumber, formatVND, vnShortStamp } from "@/lib/format";
import { listReviewDays, loadManualGenPanel, type ManualGenPanel, type ManualGenRunCard } from "@/lib/queries/creative-manual-gen";
import { listCreativeProductOptions } from "@/lib/queries/creative-sources";

/**
 * ═══════════ THƯ VIỆN MEDIA — LUỒNG TAY BA BƯỚC (chủ shop 26/09/2026: "thiết kế lại flow cho khoa học hơn, dễ quản lý và
 * sử dụng hơn" + "bỏ hẳn lô hằng ngày") ═══════════
 *
 *   ① TẠO ẢNH         `CreateStep` — gen tay (thiết kế mới / ảnh mới cho mẫu đang có: số ảnh · ảnh tải lên · ý tưởng ·
 *                      tiền ước tính) + "Mẫu tự làm" (ảnh tự vẽ vào THẲNG hàng đợi).
 *   ② DUYỆT ẢNH       `ReviewStep` — kết quả gen tay theo NGÀY (mặc định hôm nay), Duyệt / Loại từng ảnh, tiền từng ảnh /
 *                      lượt; ảnh đã duyệt ⇒ Soạn bài (Lưu vào hàng đợi · Đăng camp).
 *   ③ HÀNG ĐỢI & ĐĂNG `PublishStep` — bài đã soạn chờ đăng + setup camp (TKQC · fanpage · mục tiêu · ngân sách · vị trí ·
 *                      tuổi · giới tính) + Đăng ngay / Hẹn giờ.
 * Sau khi đăng: ④ Đang chạy (số đo, tắt theo luật) — tab riêng. Mọi luật vẫn ở `lib/creative/manual-gen.ts`.
 */

/** Bộ đồ nghề chung của hộp soạn bài — dựng một lần từ dữ liệu khu gen tay. */
function composeCtxOf(p: ManualGenPanel, canPublish: boolean): ComposeCtx {
  return { canPublish, instant: p.instant, pageName: p.pageName, defaults: p.defaults, campDefaults: p.campDefaults, setup: p.setup };
}

function SpendPill({ p }: { p: ManualGenPanel }) {
  const pr = p.pricing;
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground" title={pr.todayUnpriced ? `${pr.todayUnpriced} ảnh đã vẽ không có giá từ máy vẽ — tổng CHƯA gồm phần ấy.` : undefined}>
      {p.isToday ? "Hôm nay" : `Ngày ${formatDate(p.day)}`} đã chi <b className="numeric text-foreground">{formatVND(pr.todayImages ? pr.todayVnd : 0)}</b> · <span className="numeric">{formatNumber(pr.todayImages)}</span> ảnh
      {pr.todayUnpriced ? <span className="text-warning"> ({pr.todayUnpriced} ảnh chưa có giá)</span> : null}
    </span>
  );
}

/** ① TẠO ẢNH — gen tay + mẫu tự làm. */
export async function CreateStep({ canEdit, preselectProductId = null }: { canEdit: boolean; preselectProductId?: string | null }) {
  const db = await getDb();
  const [p, products] = await Promise.all([loadManualGenPanel(db, new Date()), canEdit ? listCreativeProductOptions() : Promise.resolve([])]);
  // `?product=` chỉ CHỌN SẴN ô ảnh gốc — không vẽ gì cho tới khi người bấm Gen (vẽ ảnh tốn tiền).
  const chon = manualGenPreselect(p.sources, preselectProductId);
  const pr = p.pricing;
  return (
    <div className="space-y-4">
      <SectionCard
        title={
          <span className="flex flex-wrap items-center gap-2">
            <Wand2 className="size-4" /> Gen ảnh bằng máy <ManualGenAutoRefresh active={p.drawing} /> <SpendPill p={p} />
          </span>
        }
        description={`Chọn mẫu cảm hứng (hoặc ảnh sản phẩm thật), gõ ý tưởng, chọn ${MANUAL_GEN_RUN.minImagesPerRun}–${MANUAL_GEN_RUN.maxImagesPerRun} ảnh rồi bấm Gen. Ảnh vẽ xong hiện ở bước ② Duyệt ảnh.`}
        hint={
          <>
            Giá ước tính mỗi ảnh theo cấu hình đang chạy ({pr.model} · {pr.quality} · {pr.size}): ~{formatVND(pr.unitVnd)} ({pr.unitUsd} USD, tỷ giá {formatNumber(pr.usdToVnd)} ₫/USD). Tiền từng ảnh là tiền THẬT máy vẽ báo về; ảnh không có giá hiện “—” và
            không cộng vào tổng. Máy vẽ sau khi bạn bấm (không bắt chờ); tiến trình chết giữa chừng thì lượt vòng mẫu vẽ nốt.
          </>
        }
      >
        <div className="space-y-3">
          {canEdit && chon.note ? <p className="rounded-md border border-dashed px-2.5 py-1.5 text-[12px] text-muted-foreground">{chon.note}</p> : null}
          {canEdit ? (
            <ManualGenForm key={chon.photoId} initialKind={preselectProductId ? "MOCKUP" : "DESIGN"} inspirations={p.inspirations} sources={p.sources} unitVnd={pr.unitVnd} unitUsd={pr.unitUsd} initialPhotoId={chon.photoId} />
          ) : (
            <EmptyState title="Bạn chỉ có quyền xem" description="Gen ảnh cần quyền soạn nội dung (ideas:write)." />
          )}
        </div>
      </SectionCard>
      {canEdit ? (
        <SectionCard
          title={
            <span className="flex items-center gap-2">
              <ImagePlus className="size-4" /> Mẫu tự làm
            </span>
          }
          description="Ảnh bạn tự vẽ (ChatGPT, Grok…) hoặc tự chụp: tải lên kèm câu chữ ⇒ vào THẲNG ③ Hàng đợi & Đăng."
          actions={<ManualForm products={products} />}
          padded={false}
        >
          <span className="sr-only">Tải mẫu tự làm vào hàng đợi đăng camp</span>
        </SectionCard>
      ) : null}
    </div>
  );
}

/** ② DUYỆT ẢNH — kết quả gen tay theo ngày. */
export async function ReviewStep({ canEdit, canPublish, day, today }: { canEdit: boolean; canPublish: boolean; day: string; today: string }) {
  const db = await getDb();
  const [p, days] = await Promise.all([loadManualGenPanel(db, new Date(), day), listReviewDays(db, today, REVIEW_DAY.stripDays)]);
  const ctx = composeCtxOf(p, canPublish);
  return (
    <div className="space-y-4">
      <ReviewDayFilter day={day} today={today} days={days} />
      <SectionCard
        title={
          <span className="flex flex-wrap items-center gap-2">
            <ScanEye className="size-4" /> Ảnh {p.isToday ? "hôm nay" : `ngày ${formatDate(p.day)}`} <ManualGenAutoRefresh active={p.drawing} /> <SpendPill p={p} />
          </span>
        }
        description="Duyệt ảnh ưng ý (máy tự viết câu chữ theo ảnh) rồi bấm Soạn bài: sửa câu chữ, chọn setup camp, Lưu vào hàng đợi hoặc Đăng camp ngay. Ảnh không dùng thì Loại."
      >
        {p.runs.length === 0 ? (
          <EmptyState
            title={p.isToday ? "Hôm nay chưa có lượt gen nào" : `Không có lượt gen nào ngày ${formatDate(p.day)}`}
            description={p.isToday ? "Tạo ảnh ở bước ① Tạo ảnh. Kết quả các ngày trước: chọn ngày ở thanh “Kết quả ngày”." : "Chọn ngày khác ở thanh “Kết quả ngày”, hoặc bấm Hôm nay."}
          />
        ) : (
          <div className="space-y-3">
            {p.runs.map((run) => (
              <RunBlock key={run.id} run={run} canEdit={canEdit} ctx={ctx} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/** ③ HÀNG ĐỢI & ĐĂNG — bài đã soạn, chờ đăng. */
export async function PublishStep({ canEdit, canPublish }: { canEdit: boolean; canPublish: boolean }) {
  const db = await getDb();
  const p = await loadManualGenPanel(db, new Date());
  const ctx = composeCtxOf(p, canPublish);
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <Rocket className="size-4" /> Hàng đợi đăng camp <span className="numeric text-[12px] font-normal text-muted-foreground">({p.queue.length} bài)</span>
        </span>
      }
      description={
        canPublish
          ? "Mỗi bài: bấm Mở · Đăng camp để xem lại câu chữ, chọn setup camp (TKQC, fanpage, mục tiêu, ngân sách, vị trí, tuổi, giới tính) rồi Đăng ngay hoặc Hẹn giờ. Đăng xong bài tự rời hàng đợi và sang tab ④ Đang chạy."
          : "Bài đã soạn chờ người có quyền duyệt chi quảng cáo (expenses:write) bấm Đăng camp."
      }
    >
      {p.queue.length === 0 ? (
        <EmptyState title="Hàng đợi trống" description="Duyệt ảnh ở bước ② rồi bấm Soạn bài → Lưu vào hàng đợi, hoặc tải Mẫu tự làm ở bước ①." />
      ) : (
        <PublishQueue items={p.queue} canEdit={canEdit} ctx={ctx} />
      )}
    </SectionCard>
  );
}

function RunBlock({ run, canEdit, ctx }: { run: ManualGenRunCard; canEdit: boolean; ctx: ComposeCtx }) {
  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
        {run.kind === "DESIGN" ? (
          <p>
            <b>{MANUAL_GEN_KIND_LABEL.DESIGN}</b> từ {run.inspirationLabels.join(", ") || "—"} · {run.createdByName || "—"} · {vnShortStamp(run.createdAt)}
          </p>
        ) : run.kind === "UPLOAD" ? (
          <p>
            <b>Mẫu tự làm</b> · {run.productName ?? "Mã đã xoá"} · {run.createdByName || "—"} · {vnShortStamp(run.createdAt)}
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
            <VariantImage key={id} imageId={id} available alt={`Ảnh tải lên #${i + 1}`} className="size-9 rounded" iconClassName="size-3" zoomable />
          ))}
        </div>
      ) : null}
      {run.note ? <p className="text-[11.5px] text-warning">{run.note}</p> : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {run.images.map((img) => (
          <ManualGenImageTile key={img.id} img={img} canEdit={canEdit} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

/** Tiền THẬT của một lượt: cộng ảnh có giá; ảnh chưa có giá nói riêng (tổng thiếu phần ấy — không lấp bằng ước tính). */
function RunCost({ run }: { run: ManualGenRunCard }) {
  const { cost } = run;
  if (run.kind === "UPLOAD") return <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">Tự làm — không tốn tiền vẽ</span>;
  if (cost.pricedImages === 0 && cost.unpricedImages === 0) return <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">Chi phí: —</span>;
  return (
    <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10.5px] text-brand" title={`${cost.usd.toFixed(4)} USD cho ${cost.pricedImages} ảnh có giá${cost.unpricedImages ? ` · ${cost.unpricedImages} ảnh đã vẽ chưa có giá (không cộng)` : ""}`}>
      Chi phí lượt <b className="numeric">{formatVND(cost.vnd)}</b>
      {cost.unpricedImages ? <span className="text-warning"> · {cost.unpricedImages} ảnh chưa có giá</span> : null}
    </span>
  );
}
