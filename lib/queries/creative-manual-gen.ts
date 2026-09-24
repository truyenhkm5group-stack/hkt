import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { MANUAL_GEN, PIXEL_SAFE_SOURCE_KINDS, normalizeCreativeConfig, type ManualGenImageStatus } from "@/lib/constants/creative-loop";
import { manualTargetDay } from "@/lib/creative/manual";
import { manualGenCapacityNow } from "@/lib/creative/manual-gen";
import { defaultNames, loadNamingContext, nextNameSeq, type DefaultNames } from "@/lib/creative/naming";
import { batchWindow } from "@/lib/creative/schedule";
import { fanpageDisplayName, readCurrentCreativeConfig } from "@/lib/queries/creative-loop";

/**
 * ═══════════ KHU "KẾT QUẢ GEN TAY" — CHỈ ĐỌC (§5i) ═══════════
 *
 * Mọi mốc là CHUỖI ISO; không kiểu nào mang điểm ảnh (chỉ `imageId` + `imageAvailable`). Tên mặc định
 * cho hộp "Đưa vào lô" dựng bằng ĐÚNG hàm của đường ghi (`defaultNames`) với số thứ tự DỰ KIẾN — đường ghi
 * tính lại với số thật và giữ tên người đã sửa.
 */

export type ManualGenImageCard = {
  id: string;
  seq: number;
  status: ManualGenImageStatus;
  genes: Record<string, string>;
  imageId: string | null;
  imageAvailable: boolean;
  costUsd: string;
  error: string;
  headline: string;
  primaryText: string;
  captionError: string;
  reviewedByName: string;
  variantId: string | null;
};

export type ManualGenRunCard = {
  id: string;
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
  images: ManualGenImageCard[];
  counts: Partial<Record<ManualGenImageStatus, number>>;
};

export type PixelSourceOption = { id: string; kind: "PRODUCT_PHOTO" | "OWN_AD"; productId: string; productLabel: string; title: string };

export type ManualGenPanel = {
  runs: ManualGenRunCard[];
  sources: PixelSourceOption[];
  capacity: { allowedNow: number; perRun: number; spentImages: number; spentUsd: number; capUsd: number; unitUsd: number; reason: string | null };
  targetDay: string;
  deadline: string;
  predictedSeq: number;
  defaults: DefaultNames;
  pageName: string | null;
  /** Còn ảnh chờ vẽ / đang vẽ ⇒ màn hình tự tải lại để hiện tiến độ. */
  drawing: boolean;
};

const RECENT_RUNS = 8;

export async function listManualGenRuns(db: Db, limit = RECENT_RUNS): Promise<ManualGenRunCard[]> {
  const g = schema.creativeManualGens;
  const s = schema.creativeSources;
  const runs = await db
    .select({ run: g, productName: schema.products.name })
    .from(g)
    .leftJoin(schema.products, eq(schema.products.id, g.productId))
    .orderBy(desc(g.createdAt))
    .limit(Math.max(1, Math.min(50, limit)));
  if (runs.length === 0) return [];
  const ids = runs.map((r) => r.run.id);
  const srcIds = [...new Set(runs.flatMap((r) => [r.run.productPhotoSourceId, r.run.ownAdSourceId].filter((x): x is string => !!x)))];
  const [imgs, srcs] = await Promise.all([
    db
      .select({ i: schema.creativeManualGenImages, purgedAt: schema.creativeImages.purgedAt, imageRow: schema.creativeImages.id })
      .from(schema.creativeManualGenImages)
      .leftJoin(schema.creativeImages, eq(schema.creativeImages.id, schema.creativeManualGenImages.imageId))
      .where(inArray(schema.creativeManualGenImages.genId, ids))
      .orderBy(schema.creativeManualGenImages.seq),
    srcIds.length ? db.select({ id: s.id, title: s.title }).from(s).where(inArray(s.id, srcIds)) : Promise.resolve([] as { id: string; title: string }[]),
  ]);
  const titleOf = new Map(srcs.map((x) => [x.id, x.title]));
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
        error: i.error,
        headline: i.headline,
        primaryText: i.primaryText,
        captionError: i.captionError,
        reviewedByName: i.reviewedByName,
        variantId: i.variantId,
      }));
    const counts: Partial<Record<ManualGenImageStatus, number>> = {};
    for (const im of images) counts[im.status] = (counts[im.status] ?? 0) + 1;
    return {
      id: run.id,
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

/** Toàn bộ dữ liệu của khu gen tay cho tab Duyệt lô. */
export async function loadManualGenPanel(db: Db, now: Date): Promise<ManualGenPanel> {
  const { config } = await readCurrentCreativeConfig(db);
  const targetDay = manualTargetDay(now, config);
  const [batch] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, targetDay)).limit(1);
  const namingCfg = batch ? normalizeCreativeConfig(batch.configSnapshot).config : config;
  const [runs, sources, capacity, ctx, predictedSeq, pageName] = await Promise.all([
    listManualGenRuns(db),
    listPixelSafeSourceOptions(db),
    manualGenCapacityNow(db, config, now, MANUAL_GEN.imagesPerRun),
    loadNamingContext(db, namingCfg),
    batch ? nextNameSeq(db, batch.id) : Promise.resolve(1),
    fanpageDisplayName(db, namingCfg.pageId),
  ]);
  return {
    runs,
    sources,
    capacity: { allowedNow: capacity.allowed, perRun: MANUAL_GEN.imagesPerRun, spentImages: capacity.spentImages, spentUsd: capacity.spentUsd, capUsd: capacity.capUsd, unitUsd: capacity.unitUsd, reason: capacity.reason },
    targetDay,
    deadline: (batch?.approvalDeadline ?? batchWindow(targetDay, config).approvalDeadline).toISOString(),
    predictedSeq,
    defaults: defaultNames(ctx, targetDay, predictedSeq),
    pageName,
    drawing: runs.some((r) => (r.counts.PLANNED ?? 0) + (r.counts.DRAWING ?? 0) > 0),
  };
}
