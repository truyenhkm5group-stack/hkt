import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { memo } from "@/lib/cache";
import { CREATIVE_HARD_LIMITS, INSTANT_PUBLISH, PIXEL_SAFE_SOURCE_KINDS, estimateImageUsd, normalizeCreativeConfig, usdToVndRounded, type ManualGenImageStatus, type ManualGenKind } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { manualGenSpendToday } from "@/lib/creative/generate";
import { resolveManualTargetDay } from "@/lib/creative/manual";
import { instantPublishBlockers, parseManualDesignSpec } from "@/lib/creative/manual-gen";
import { defaultNames, loadNamingContext, nextNameSeq, type DefaultNames } from "@/lib/creative/naming";
import { batchWindow } from "@/lib/creative/schedule";
import { loadDesignInputs } from "@/lib/queries/creative-design";
import { env } from "@/lib/env";
import { vnStartOfDay } from "@/lib/format";
import { fanpageDisplayName, readCurrentCreativeConfig } from "@/lib/queries/creative-loop";

/**
 * ═══════════ KHU "KẾT QUẢ GEN TAY" — CHỈ ĐỌC (§5i) ═══════════
 *
 * Mọi mốc là CHUỖI ISO; không kiểu nào mang điểm ảnh (chỉ `imageId` + `imageAvailable`). Tên mặc định
 * cho hộp "Đưa vào lô" dựng bằng ĐÚNG hàm của đường ghi (`defaultNames`) với số thứ tự DỰ KIẾN — đường ghi
 * tính lại với số thật và giữ tên người đã sửa.
 *
 * TIỀN (chủ shop 26/09/2026 — "tính tiền trên mỗi lượt gen và mỗi ảnh"): tiền THẬT của một ảnh là `cost_usd` máy vẽ
 * trả về (từ `usage`); ảnh đã vẽ mà không có giá là CHƯA BIẾT (`null`, in "—"), KHÔNG lấp bằng giá ước tính — con
 * số ước tính chỉ đứng ở chỗ ghi rõ "ước tính" (trước khi bấm). Quy ra đồng theo tỷ giá USD của shop
 * (`FACEBOOK_USD_VND`, cùng tỷ giá quy đổi tài khoản quảng cáo USD).
 */

export type ManualGenImageCard = {
  id: string;
  seq: number;
  status: ManualGenImageStatus;
  genes: Record<string, string>;
  imageId: string | null;
  imageAvailable: boolean;
  costUsd: string;
  /** Tiền thật của ảnh quy ra đồng. `null` = CHƯA BIẾT (chưa vẽ, vẽ hỏng, hoặc máy vẽ không trả giá). */
  costVnd: number | null;
  error: string;
  headline: string;
  primaryText: string;
  captionError: string;
  reviewedByName: string;
  variantId: string | null;
  /** Ảnh của lượt `DESIGN`: thiết kế mới trên ảnh. `null` ở lượt `MOCKUP`. */
  design: { dna: Record<string, string>; parentLabels: string[]; why: string; priceVnd: number | null } | null;
};

export type ManualGenRunCard = {
  id: string;
  kind: ManualGenKind;
  /** Lượt `DESIGN`: tên các mã cảm hứng người đã chọn. */
  inspirationLabels: string[];
  createdAt: string;
  createdByName: string;
  productId: string | null;
  productName: string | null;
  idea: string;
  requested: number;
  note: string;
  model: string;
  quality: string;
  size: string;
  photoTitle: string;
  ownAdTitle: string | null;
  /** Ảnh người tải lên làm đầu vào của lượt (id `creative_images`). */
  uploadImageIds: string[];
  /** Tiền THẬT của lượt: cộng các ảnh có giá. `unpricedImages` = ảnh đã vẽ mà không có giá (CHƯA BIẾT — tổng thiếu phần ấy). */
  cost: { usd: number; vnd: number | null; pricedImages: number; unpricedImages: number };
  images: ManualGenImageCard[];
  counts: Partial<Record<ManualGenImageStatus, number>>;
};

export type PixelSourceOption = { id: string; kind: "PRODUCT_PHOTO" | "OWN_AD"; productId: string; productLabel: string; title: string };

/**
 * Một mẫu BÁN TỐT chọn được làm cảm hứng cho gen tay kiểu thiết kế mới — đúng tập mã cha của ô thiết kế
 * trong lô (`loadDesignInputs`: bán tốt theo `ORDER_OUTCOME` / chi mỗi tin nhắn tốt, VÀ đã đọc được DNA).
 */
export type DesignInspirationOption = {
  productId: string;
  label: string;
  score: number;
  delivered: number;
  returned: number;
  /** `null` = chưa có dòng chi hạt AD nào của mã (CHƯA BIẾT, không phải 0). */
  spendVnd: number | null;
  messages: number | null;
  dna: Record<string, string>;
  /** Ảnh sản phẩm thật (gửi được máy vẽ). `null` ⇒ mã chỉ góp DNA, không làm được cha trội. */
  imageId: string | null;
  priceVnd: number | null;
};

export type ManualGenPanel = {
  runs: ManualGenRunCard[];
  sources: PixelSourceOption[];
  /** Mẫu cảm hứng, điểm cao trước. */
  inspirations: DesignInspirationOption[];
  /**
   * Giá để người bấm thấy TRƯỚC khi bấm (ước tính theo cấu hình ảnh đang chạy) và tiền gen tay HÔM NAY (thật).
   * `todayUnpriced` = ảnh đã vẽ hôm nay mà không có giá — tổng hôm nay THIẾU phần ấy, màn hình phải nói ra.
   */
  pricing: { model: string; quality: string; size: string; unitUsd: number; unitVnd: number | null; usdToVnd: number; todayImages: number; todayUsd: number; todayVnd: number | null; todayUnpriced: number };
  /** Hộp "Đăng camp": ngân sách / khung chạy của một bài lẻ + mọi lý do cổng sẽ chặn lúc này (rỗng = không thấy). */
  instant: { budgetVnd: number; testDays: number; leadSeconds: number; minScheduleLeadMinutes: number; maxScheduleDays: number; blockers: string[] };
  targetDay: string;
  deadline: string;
  predictedSeq: number;
  defaults: DefaultNames;
  pageName: string | null;
  /** Còn ảnh chờ vẽ / đang vẽ ⇒ màn hình tự tải lại để hiện tiến độ. */
  drawing: boolean;
  /** Ngày đang lọc (`YYYY-MM-DD`, giờ VN) — "Kết quả gen tay" và tiền trong ngày đều theo ngày này. */
  day: string;
  isToday: boolean;
};

/** Số lượt tối đa hiện cho MỘT ngày (mới → cũ) — một ngày bấm nhiều hơn thế là hiếm, và trang vẫn phải nhẹ. */
const RUNS_PER_DAY = 50;

/** Khoảng `[00:00, 24:00)` giờ Việt Nam của một ngày. */
function vnDayRange(day: string): { from: Date; to: Date } {
  const from = vnStartOfDay(day);
  return { from, to: vnStartOfDay(shiftDay(day, 1)) };
}

/** Các lượt gen tay TẠO trong ngày `day` (giờ VN), mới → cũ. `day = null` ⇒ các lượt gần nhất bất kể ngày. */
export async function listManualGenRuns(db: Db, limit = RUNS_PER_DAY, rate: number = env.facebook.usdToVnd, day: string | null = null): Promise<ManualGenRunCard[]> {
  const g = schema.creativeManualGens;
  const s = schema.creativeSources;
  const range = day ? vnDayRange(day) : null;
  const runs = await db
    .select({ run: g, productName: schema.products.name })
    .from(g)
    .leftJoin(schema.products, eq(schema.products.id, g.productId))
    .where(range ? and(gte(g.createdAt, range.from), lt(g.createdAt, range.to)) : undefined)
    .orderBy(desc(g.createdAt))
    .limit(Math.max(1, Math.min(RUNS_PER_DAY, limit)));
  if (runs.length === 0) return [];
  const ids = runs.map((r) => r.run.id);
  const srcIds = [...new Set(runs.flatMap((r) => [r.run.productPhotoSourceId, r.run.ownAdSourceId].filter((x): x is string => !!x)))];
  const inspIds = [...new Set(runs.flatMap((r) => r.run.inspirationProductIds))];
  const [imgs, srcs, insp] = await Promise.all([
    db
      .select({ i: schema.creativeManualGenImages, purgedAt: schema.creativeImages.purgedAt, imageRow: schema.creativeImages.id })
      .from(schema.creativeManualGenImages)
      .leftJoin(schema.creativeImages, eq(schema.creativeImages.id, schema.creativeManualGenImages.imageId))
      .where(inArray(schema.creativeManualGenImages.genId, ids))
      .orderBy(schema.creativeManualGenImages.seq),
    srcIds.length ? db.select({ id: s.id, title: s.title }).from(s).where(inArray(s.id, srcIds)) : Promise.resolve([] as { id: string; title: string }[]),
    inspIds.length ? db.select({ id: schema.products.id, name: schema.products.name, customId: schema.products.customId }).from(schema.products).where(inArray(schema.products.id, inspIds)) : Promise.resolve([] as { id: string; name: string; customId: string | null }[]),
  ]);
  const titleOf = new Map(srcs.map((x) => [x.id, x.title]));
  const labelOf = new Map(insp.map((x) => [x.id, x.customId || x.name]));
  return runs.map(({ run, productName }) => {
    const images: ManualGenImageCard[] = imgs
      .filter((x) => x.i.genId === run.id)
      .map(({ i, purgedAt, imageRow }) => ({
        id: i.id,
        seq: i.seq,
        status: i.status as ManualGenImageStatus,
        genes: { ...(i.genes ?? {}) },
        imageId: i.imageId,
        imageAvailable: i.imageId !== null && imageRow !== null && purgedAt === null,
        costUsd: i.costUsd,
        costVnd: usdToVndRounded(i.costUsd === "" ? null : Number(i.costUsd), rate),
        error: i.error,
        headline: i.headline,
        primaryText: i.primaryText,
        captionError: i.captionError,
        reviewedByName: i.reviewedByName,
        variantId: i.variantId,
        design: (() => {
          const d = parseManualDesignSpec(i.design);
          return d ? { dna: { ...d.dna }, parentLabels: d.parentLabels, why: d.why, priceVnd: d.priceVnd } : null;
        })(),
      }));
    const counts: Partial<Record<ManualGenImageStatus, number>> = {};
    for (const im of images) counts[im.status] = (counts[im.status] ?? 0) + 1;
    const priced = images.filter((im) => im.costUsd !== "" && Number.isFinite(Number(im.costUsd)));
    const usd = priced.reduce((t, im) => t + Number(im.costUsd), 0);
    return {
      id: run.id,
      kind: run.kind === "DESIGN" ? "DESIGN" : "MOCKUP",
      inspirationLabels: run.inspirationProductIds.map((x) => labelOf.get(x) ?? "Mã đã xoá"),
      createdAt: run.createdAt.toISOString(),
      createdByName: run.createdByName,
      productId: run.productId,
      productName: productName ?? null,
      idea: run.idea,
      requested: run.requested,
      note: run.note,
      model: run.model,
      quality: run.quality,
      size: run.size,
      photoTitle: (run.productPhotoSourceId && titleOf.get(run.productPhotoSourceId)) || "Ảnh sản phẩm",
      ownAdTitle: run.ownAdSourceId ? titleOf.get(run.ownAdSourceId) || "Quảng cáo cũ" : null,
      uploadImageIds: run.uploadImageIds,
      cost: { usd, vnd: priced.length ? usdToVndRounded(usd, rate) : null, pricedImages: priced.length, unpricedImages: images.filter((im) => im.costUsd === "" && im.imageId !== null).length },
      images,
      counts,
    };
  });
}

/** Nguồn ĐƯỢC gửi điểm ảnh sang máy vẽ (`PIXEL_SAFE_SOURCE_KINDS`), đang bật, có ảnh và có mã hàng. */
export async function listPixelSafeSourceOptions(db: Db): Promise<PixelSourceOption[]> {
  const s = schema.creativeSources;
  const p = schema.products;
  const rows = await db
    .select({ id: s.id, kind: s.kind, productId: s.productId, title: s.title, name: p.name, customId: p.customId })
    .from(s)
    .innerJoin(p, eq(p.id, s.productId))
    .where(and(inArray(s.kind, [...PIXEL_SAFE_SOURCE_KINDS]), eq(s.active, true), isNotNull(s.imageId)))
    .orderBy(p.name, s.kind, desc(s.createdAt))
    .limit(400);
  return rows.map((r) => ({ id: r.id, kind: r.kind === "OWN_AD" ? "OWN_AD" : "PRODUCT_PHOTO", productId: r.productId ?? "", productLabel: r.customId ? `${r.customId} · ${r.name}` : r.name, title: r.title }));
}

/**
 * Mẫu cảm hứng cho gen tay kiểu thiết kế mới — ĐÚNG `loadDesignInputs` của lô (không viết điều kiện "bán tốt"
 * thứ hai), bỏ mã chưa đọc được nhóm hàng (`planDesigns` không lai được). Đệm 120 giây: khối gen tay tự tải
 * lại mỗi vài giây khi đang vẽ, còn phép đo bán tốt quét đơn 90 ngày.
 */
export async function listDesignInspirations(db: Db, now: Date): Promise<DesignInspirationOption[]> {
  const day = vnDay(now);
  return memo(`creative-manual-design-inspirations:${day}`, 120_000, async () => {
    const { parents } = await loadDesignInputs(db, day);
    const usable = parents.filter((p) => p.dna.category !== undefined);
    const photoIds = usable.flatMap((p) => (p.photoSourceId ? [p.photoSourceId] : []));
    const s = schema.creativeSources;
    const photos = photoIds.length
      ? await db
          .select({ id: s.id, imageId: s.imageId })
          .from(s)
          .innerJoin(schema.creativeImages, eq(schema.creativeImages.id, s.imageId))
          .where(and(inArray(s.id, photoIds), isNull(schema.creativeImages.purgedAt)))
      : [];
    const imageOf = new Map(photos.map((x) => [x.id, x.imageId]));
    return usable
      .map((p) => ({
        productId: p.productId,
        label: p.label,
        score: p.score,
        delivered: p.metrics?.delivered ?? 0,
        returned: p.metrics?.returned ?? 0,
        spendVnd: p.metrics?.spendVnd ?? null,
        messages: p.metrics?.messages ?? null,
        dna: { ...p.dna } as Record<string, string>,
        imageId: (p.photoSourceId && imageOf.get(p.photoSourceId)) || null,
        priceVnd: p.priceVnd,
      }))
      .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  });
}

/** Một ngày CÓ kết quả ở tab "Duyệt mẫu": số lượt gen tay · số ảnh đã vẽ · số lô chạy ngày ấy. */
export type ReviewDayOption = { day: string; runs: number; images: number; batches: number };

/**
 * Dải ngày của bộ lọc "Duyệt mẫu" — các ngày gần nhất CÓ kết quả (lượt gen tay tạo trong ngày, hoặc lô có ngày chạy
 * là ngày ấy), mới → cũ, tối đa `REVIEW_DAY.stripDays` ngày; HÔM NAY luôn có mặt (kể cả khi chưa có gì) để người
 * luôn có đường về. Chỉ đếm, không đọc ảnh.
 */
export async function listReviewDays(db: Db, today: string, limit: number): Promise<ReviewDayOption[]> {
  const g = schema.creativeManualGens;
  const im = schema.creativeManualGenImages;
  const b = schema.creativeBatches;
  const vnDate = sql<string>`to_char(${g.createdAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;
  const [genDays, batchDays] = await Promise.all([
    db
      .select({ day: vnDate, runs: sql<number>`count(distinct ${g.id})::int`, images: sql<number>`count(${im.imageId})::int` })
      .from(g)
      .leftJoin(im, eq(im.genId, g.id))
      .groupBy(vnDate)
      .orderBy(desc(vnDate))
      .limit(limit),
    db.select({ day: b.batchDay, batches: sql<number>`count(*)::int` }).from(b).where(sql`${b.batchDay} <= ${today}`).groupBy(b.batchDay).orderBy(desc(b.batchDay)).limit(limit),
  ]);
  const byDay = new Map<string, ReviewDayOption>([[today, { day: today, runs: 0, images: 0, batches: 0 }]]);
  for (const r of genDays) byDay.set(r.day, { ...(byDay.get(r.day) ?? { day: r.day, runs: 0, images: 0, batches: 0 }), runs: Number(r.runs), images: Number(r.images) });
  for (const r of batchDays) byDay.set(r.day, { ...(byDay.get(r.day) ?? { day: r.day, runs: 0, images: 0, batches: 0 }), batches: Number(r.batches) });
  return [...byDay.values()].sort((x, y) => (x.day < y.day ? 1 : x.day > y.day ? -1 : 0)).slice(0, limit);
}

/** Toàn bộ dữ liệu của khu gen tay cho tab Duyệt mẫu — "Kết quả gen tay" và tiền trong ngày theo ngày `day` (giờ VN). */
export async function loadManualGenPanel(db: Db, now: Date, day: string = vnDay(now)): Promise<ManualGenPanel> {
  const { config } = await readCurrentCreativeConfig(db);
  const rate = env.facebook.usdToVnd;
  const targetDay = await resolveManualTargetDay(db, now, config);
  const B = schema.creativeBatches;
  const [batch] = await db.select().from(B).where(and(eq(B.batchDay, targetDay), eq(B.kind, "LOOP"))).limit(1);
  const namingCfg = batch ? normalizeCreativeConfig(batch.configSnapshot).config : config;
  const [runs, sources, inspirations, today, ctx, predictedSeq, pageName, blockers] = await Promise.all([
    listManualGenRuns(db, RUNS_PER_DAY, rate, day),
    listPixelSafeSourceOptions(db),
    listDesignInspirations(db, now),
    // Tiền gen tay của NGÀY ĐANG LỌC: hàm đo "ngày VN chứa mốc này", nên đưa trưa ngày ấy.
    manualGenSpendToday(db, day === vnDay(now) ? now : new Date(`${day}T12:00:00+07:00`)),
    loadNamingContext(db, namingCfg),
    batch ? nextNameSeq(db, batch.id) : Promise.resolve(1),
    fanpageDisplayName(db, namingCfg.pageId),
    instantPublishBlockers(db, config, vnDay(now)),
  ]);
  const unitUsd = estimateImageUsd(config.imageModel, config.imageQuality, config.imageSize);
  return {
    runs,
    sources,
    inspirations,
    pricing: {
      model: config.imageModel,
      quality: config.imageQuality,
      size: config.imageSize,
      unitUsd,
      unitVnd: usdToVndRounded(unitUsd, rate),
      usdToVnd: rate,
      todayImages: today.images,
      todayUsd: today.usd,
      todayVnd: usdToVndRounded(today.usd, rate),
      todayUnpriced: today.unpriced,
    },
    instant: {
      budgetVnd: config.budgetPerVariantVnd,
      testDays: Math.max(1, Math.min(config.testDays, CREATIVE_HARD_LIMITS.maxTestDays)),
      leadSeconds: INSTANT_PUBLISH.leadSeconds,
      minScheduleLeadMinutes: INSTANT_PUBLISH.minScheduleLeadMinutes,
      maxScheduleDays: INSTANT_PUBLISH.maxScheduleDays,
      blockers,
    },
    targetDay,
    deadline: (batch?.approvalDeadline ?? batchWindow(targetDay, config).approvalDeadline).toISOString(),
    predictedSeq,
    defaults: defaultNames(ctx, targetDay, predictedSeq),
    pageName,
    drawing: runs.some((r) => (r.counts.PLANNED ?? 0) + (r.counts.DRAWING ?? 0) > 0),
    day,
    isToday: day === vnDay(now),
  };
}
