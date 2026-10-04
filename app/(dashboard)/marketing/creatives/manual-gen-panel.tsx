import Link from "next/link";
import { ImagePlus, Repeat2, Rocket, ScanEye, Wand2 } from "lucide-react";
import { ManualForm } from "@/app/(dashboard)/marketing/creatives/manual-form";
import { ManualGenAutoRefresh, ManualGenImageTile, PublishQueue, type ComposeCtx } from "@/app/(dashboard)/marketing/creatives/manual-gen";
import { IndustryPicker } from "@/app/(dashboard)/marketing/creatives/industry-picker";
import { StudioGenForm, type StudioAiInfo } from "@/app/(dashboard)/marketing/creatives/studio-form";
import { OUTPUT_STYLES, OUTPUT_STYLE_KEYS, outputStylesFor, type OutputStyle } from "@/lib/constants/creative-studio";
import { ReviewDayFilter } from "@/app/(dashboard)/marketing/creatives/review-day-filter";
import { VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb } from "@/db";
import { IMAGE_QUALITY_LABEL, MANUAL_GEN_IMAGE_STATUSES, MANUAL_GEN_IMAGE_STATUS_LABEL, MANUAL_GEN_KIND_LABEL, REVIEW_DAY, imagePriceKeyOf, type ImageQuality } from "@/lib/constants/creative-loop";
import { manualGenPreselect } from "@/lib/constants/stock-feedback";
import { formatDate, formatNumber, formatVND, vnShortStamp } from "@/lib/format";
import { listReviewDays, loadManualGenPanel, loadManualGenRemix, type ManualGenPanel, type ManualGenRunCard } from "@/lib/queries/creative-manual-gen";
import { listCreativeProductOptions } from "@/lib/queries/creative-sources";
import { CREATIVE_INDUSTRY_LABEL, type CreativeIndustry } from "@/lib/constants/creative-industry";
import { creativeAiStatus, readCreativeIndustry, type CreativeAiStatus } from "@/lib/creative/org-ai";

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
function composeCtxOf(p: ManualGenPanel, canPublish: boolean, industry: CreativeIndustry): ComposeCtx {
  return { canPublish, pricing: { unitVnd: p.pricing.unitVnd, unitUsd: p.pricing.unitUsd }, instant: p.instant, pageName: p.pageName, defaults: p.defaults, campDefaults: p.campDefaults, setup: p.setup, fanpageEvidence: p.fanpageEvidence, industry };
}

/** AI của tổ chức như form cần biết (không mang khoá). Nhà ⇒ `null` — form như trước. */
function studioAiOf(ai: CreativeAiStatus): StudioAiInfo | null {
  if (ai.mode === "HOME") return null;
  if (ai.mode === "NONE") return { mode: "NONE", label: "", imageModel: null, imageReady: false, reason: ai.reason, priced: false };
  return { mode: "BYOK", label: ai.label, imageModel: ai.imageModel, imageReady: ai.imageReady, reason: ai.imageReason, priced: ai.imageModel !== null && imagePriceKeyOf(ai.imageModel) !== null };
}

/** Dải thông tin ngành + máy vẽ của tổ chức khách (nhà không hiện gì — giữ nguyên màn hình cũ). */
function OrgAiBanner({ ai, industry, basis, canManage }: { ai: CreativeAiStatus; industry: CreativeIndustry; basis: string; canManage: boolean }) {
  if (ai.mode === "HOME") return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/30 px-2.5 py-1.5 text-[12px]">
      {canManage ? <IndustryPicker value={industry} basis={basis} /> : <span title={basis}>Ngành: <b>{CREATIVE_INDUSTRY_LABEL[industry]}</b></span>}
      {ai.mode === "BYOK" ? (
        <span>
          Vẽ ảnh: <b>{ai.imageReady ? `${ai.label} · ${ai.imageModel}` : "chưa vẽ được"}</b> · Câu chữ: <b>{ai.chatModel}</b> — tiền token trên khoá AI của tổ chức, ghi vào sổ dùng AI.
          {!ai.imageReady && ai.imageReason ? <span className="text-warning"> {ai.imageReason}</span> : null}
        </span>
      ) : (
        <span className="text-warning">
          {ai.reason} <Link href="/settings/connections" className="underline">Mở Kết nối dữ liệu</Link>
        </span>
      )}
      <span className="text-muted-foreground">Vòng mẫu tự động (lô hằng ngày, đọc gen nguồn) chỉ chạy ở tổ chức nhà — ở đây bạn gen bằng tay.</span>
    </div>
  );
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

/** Số lượt mới nhất hiện ngay dưới form Tạo ảnh — đủ để thấy lượt vừa bấm vẽ tới đâu mà không phải sang ② Duyệt ảnh. */
const LATEST_RUNS = 2;

/** ① TẠO ẢNH — studio gen tay + kết quả mới nhất + mẫu tự làm. `remixId` = "Tạo lại tương tự" (chỉ điền sẵn form). */
export async function CreateStep({ canEdit, canPublish = false, preselectProductId = null, remixId = null, canManage = false }: { canEdit: boolean; canPublish?: boolean; preselectProductId?: string | null; remixId?: string | null; canManage?: boolean }) {
  const db = await getDb();
  const [p, products, remix, ind] = await Promise.all([loadManualGenPanel(db, new Date()), canEdit ? listCreativeProductOptions() : Promise.resolve([]), remixId ? loadManualGenRemix(db, remixId) : Promise.resolve(null), readCreativeIndustry(db)]);
  const ai = await creativeAiStatus(p.pricing.model);
  // `?product=` chỉ CHỌN SẴN ô ảnh gốc — không vẽ gì cho tới khi người bấm Gen (vẽ ảnh tốn tiền).
  const chon = manualGenPreselect(p.sources, preselectProductId);
  const pr = p.pricing;
  const latest = p.runs.filter((r) => r.kind !== "UPLOAD").slice(0, LATEST_RUNS);
  const ctx = composeCtxOf(p, canPublish, ind.industry);
  return (
    <div className="space-y-4">
      <OrgAiBanner ai={ai} industry={ind.industry} basis={ind.detail} canManage={canManage} />
      <SectionCard
        title={
          <span className="flex flex-wrap items-center gap-2">
            <Wand2 className="size-4" /> Gen ảnh bằng máy <ManualGenAutoRefresh active={p.drawing} /> <SpendPill p={p} />
          </span>
        }
description={undefined}
        hint={
          <>
            Giá ước tính mỗi ảnh theo model {pr.model} và ĐÚNG khổ + chất lượng bạn chọn (mặc định của cấu hình: {pr.quality} · {pr.size} ~{formatVND(pr.unitVnd)}; tỷ giá {formatNumber(pr.usdToVnd)} ₫/USD). Tiền từng ảnh là tiền THẬT máy vẽ báo về; ảnh không có giá hiện “—” và
            không cộng vào tổng. Máy vẽ sau khi bạn bấm (không bắt chờ); tiến trình chết giữa chừng thì lượt vòng mẫu vẽ nốt.
          </>
        }
      >
        <div className="space-y-3">
          {canEdit && chon.note ? <p className="rounded-md border border-dashed px-2.5 py-1.5 text-[12px] text-muted-foreground">{chon.note}</p> : null}
          {canEdit ? (
            <StudioGenForm
              key={remix?.genId ?? chon.photoId}
              initialKind={preselectProductId ? "MOCKUP" : "DESIGN"}
              inspirations={p.inspirations}
              sources={p.sources}
              pricing={{ model: pr.model, quality: pr.quality, size: pr.size, usdToVnd: pr.usdToVnd }}
              recentIdeas={p.recentIdeas}
              remix={remix}
              initialPhotoId={remix?.productPhotoSourceId ?? chon.photoId}
              industry={ind.industry}
              ai={studioAiOf(ai)}
            />
          ) : (
            <EmptyState title="Bạn chỉ có quyền xem" description="Gen ảnh cần quyền soạn nội dung (ideas:write)." />
          )}
          {remixId && !remix ? <p className="text-[12px] text-warning">Không điền lại được lượt cũ (lượt sửa ảnh / mẫu tự làm, hoặc đã bị xoá) — form đang ở mặc định.</p> : null}
        </div>
      </SectionCard>
      {latest.length ? (
        <SectionCard
          title={
            <span className="flex flex-wrap items-center gap-2">
              <ScanEye className="size-4" /> Kết quả mới nhất <ManualGenAutoRefresh active={p.drawing} />
            </span>
          }
          description="Hai lượt gần nhất hôm nay. Duyệt / Loại / Soạn bài ngay tại đây; mọi lượt của ngày ở ② Duyệt ảnh."
        >
          <div className="space-y-3">
            {latest.map((run) => (
              <RunBlock key={run.id} run={run} canEdit={canEdit} ctx={ctx} />
            ))}
          </div>
        </SectionCard>
      ) : null}
      {canEdit ? (
        <SectionCard
          title={
            <span className="flex items-center gap-2">
              <ImagePlus className="size-4" /> Mẫu tự làm
            </span>
          }
          description="Ảnh bạn tự vẽ (ChatGPT, Grok…) hoặc tự chụp: tải lên kèm câu chữ ⇒ vào THẲNG ③ Hàng đợi & Đăng."
          actions={<ManualForm products={products} industry={ind.industry} />}
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
  const [p, days, ind] = await Promise.all([loadManualGenPanel(db, new Date(), day), listReviewDays(db, today, REVIEW_DAY.stripDays), readCreativeIndustry(db)]);
  const ctx = composeCtxOf(p, canPublish, ind.industry);
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
  const [p, ind] = await Promise.all([loadManualGenPanel(db, new Date()), readCreativeIndustry(db)]);
  const ctx = composeCtxOf(p, canPublish, ind.industry);
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
        ) : run.kind === "EDIT" ? (
          <p className="flex flex-wrap items-center gap-1.5">
            {run.editSource?.imageId ? <VariantImage imageId={run.editSource.imageId} available alt={`Ảnh gốc #${run.editSource.seq}`} className="size-8 rounded" iconClassName="size-3" zoomable /> : null}
            <span>
              <b>Sửa ảnh</b>
              {run.editSource ? ` #${run.editSource.seq}` : " (ảnh gốc đã xoá)"} · {run.productName ?? (run.editSource?.isDesign || !run.productId ? "Thiết kế mới" : "Mã đã xoá")} · {run.createdByName || "—"} · {vnShortStamp(run.createdAt)}
            </span>
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
          <StudioSummary run={run} industry={ctx.industry} />
          {canEdit && (run.kind === "MOCKUP" || run.kind === "DESIGN") ? (
            <Link href={`/marketing/creatives?tab=tao&remix=${encodeURIComponent(run.id)}`} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] hover:bg-muted" title="Mở ① Tạo ảnh với đúng thiết lập của lượt này — chưa vẽ gì cho tới khi bấm Gen">
              <Repeat2 className="size-3" /> Tạo lại tương tự
            </Link>
          ) : null}
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
          {run.kind === "EDIT" ? "Yêu cầu sửa" : "Ý tưởng"}: {run.idea}
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

/** "2 mẫu × 3 màu × 1 kiểu · Dọc 4:5 · Vừa" — chỉ lượt có studio (từ 29/09/2026). */
function StudioSummary({ run, industry }: { run: ManualGenRunCard; industry: CreativeIndustry }) {
  const table = outputStylesFor(industry);
  const o = run.options;
  if (typeof o.units !== "number") return null;
  const colors = Array.isArray(o.colors) ? o.colors.filter((x): x is string => typeof x === "string") : [];
  const styles = (Array.isArray(o.styles) ? o.styles : []).filter((x): x is OutputStyle => typeof x === "string" && (OUTPUT_STYLE_KEYS as readonly string[]).includes(x));
  const q = run.quality as ImageQuality;
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px]" title={[styles.length ? `Kiểu: ${styles.map((s) => (table[s] ?? OUTPUT_STYLES[s]).label).join(", ")}` : "Kiểu: tự động", colors.length ? `Màu: ${colors.join(", ")}` : "Giữ màu"].join(" · ")}>
      <span className="numeric">{o.units}</span> mẫu × <span className="numeric">{Math.max(1, colors.length)}</span> màu × <span className="numeric">{Math.max(1, styles.length)}</span> kiểu · {run.size} · {IMAGE_QUALITY_LABEL[q] ?? run.quality}
    </span>
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
