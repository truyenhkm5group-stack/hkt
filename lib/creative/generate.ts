import { and, asc, eq, gt, gte, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import {
  CREATIVE_CONFIG_KEY,
  CREATIVE_HARD_LIMITS,
  CREATIVE_RULE_VERSION,
  GENE_VOCAB_VERSION,
  estimateImageUsd,
  normalizeCreativeConfig,
  parseGenes,
  type BatchStatus,
  type CreativeLoopConfig,
  type SlotMode,
} from "@/lib/constants/creative-loop";
import { readCreativeImage, storeCreativeImage } from "@/lib/creative/images";
import { planBatch } from "@/lib/creative/plan";
import { batchDayToBuild, batchWindow } from "@/lib/creative/schedule";
import { describeSource, type SourceDescriber } from "@/lib/creative/vision";
import { writeVariantCopy, type CopyWriter } from "@/lib/creative/writer";
import { editImage, type ImageEditClient, type ImageEditInputImage } from "@/lib/integrations/openai/images";
import { loadPlanInputs, loadProductBrief, loadWinningExamples } from "@/lib/queries/creative-plan";

/**
 * ═══════════ DỰNG LÔ: TỪ LÔ RỖNG TỚI ẢNH CHỜ DUYỆT ═══════════
 *
 * Tick gọi `buildBatch()` mỗi ~10 phút. Hàm phải LŨY ĐẲNG và CHẠY TIẾP ĐƯỢC:
 *
 *  · Lô mang khoá tự nhiên `batch_day` — tick thứ hai (kể cả chạy song song) không đẻ lô thứ hai;
 *    chèn trùng khoá thì đọc lô đã có.
 *  · Mỗi tick chỉ sinh tối đa `GEN_PER_TICK` mẫu `PLANNED`: một lượt gpt-image có thể mất cả phút,
 *    và một tick không được vượt watchdog 30 phút của runner. Mẫu đã có ảnh không bao giờ được sinh
 *    lại — chỉ mẫu còn `PLANNED` mới được chọn, và lượt ghi kết quả có điều kiện `status = 'PLANNED'`.
 *  · Hết `PLANNED` ⇒ lô `PENDING_APPROVAL` nếu có ít nhất một ảnh, không thì `FAILED` kèm lý do.
 *
 * ─── ĐƯỜNG ĐIỂM ẢNH (ranh giới 2 + 3 của vòng mẫu) ───
 *
 * `gatherPixels()` là chỗ DUY NHẤT trong tệp này đọc điểm ảnh, và nó chỉ nhận HAI khoá: nguồn ảnh
 * sản phẩm thật của ô và mẫu cha. Nguồn cảm hứng (spy / tay / R&D) không có đường nào tới đây — chỉ
 * `vision_summary` của nó đi vào người viết câu chữ. `tests/creative-generate.test.ts` quét mã nguồn
 * để giữ điều đó, và `editImage()` kiểm lại loại ảnh lúc chạy.
 *
 * ─── TRẦN NGÀY ───
 *
 * Trước MỖI ảnh: số ảnh đã sinh hôm nay (giờ VN) ≤ `CREATIVE_HARD_LIMITS.maxImagesPerDay` và tổng
 * USD + ước tính ảnh này ≤ `cfg.imageDailyCapUsd`. Chạm trần ⇒ mọi mẫu còn `PLANNED` của lô thành
 * `GEN_FAILED` với lý do nói rõ trần nào — lô đi tiếp tới duyệt với số ảnh đã có, không treo.
 */

/** Số mẫu sinh tối đa trong MỘT tick. */
export const GEN_PER_TICK = 4;
/** Số nguồn cảm hứng chưa đọc được đọc tối đa trước khi lập một lô. */
export const DESCRIBE_PER_BUILD = 5;

export type BuildBatchDeps = {
  imageClient?: ImageEditClient;
  writer?: CopyWriter;
  describe?: SourceDescriber;
  now?: Date;
  perTick?: number;
};

export type BuildBatchSummary = {
  batchDay: string | null;
  batchId: string | null;
  /** Tick này vừa TẠO lô. */
  created: boolean;
  generated: number;
  failed: number;
  /** Số mẫu bị đánh `GEN_FAILED` vì chạm trần ngày. */
  capped: number;
  /** Số nguồn cảm hứng vừa được đọc thành gen trước khi lập lô. */
  described: number;
  status: BatchStatus | null;
  skippedReason: string | null;
};

type BatchRow = typeof schema.creativeBatches.$inferSelect;
type VariantRow = typeof schema.creativeVariants.$inferSelect;

async function readConfig(db: Db): Promise<CreativeLoopConfig> {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, CREATIVE_CONFIG_KEY) }).catch(() => null);
  let raw: unknown = {};
  if (row) {
    try {
      raw = JSON.parse(row.value);
    } catch {
      raw = {};
    }
  }
  return normalizeCreativeConfig(raw).config;
}

async function batchByDay(db: Db, batchDay: string): Promise<BatchRow | null> {
  const [b] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, batchDay)).limit(1);
  return b ?? null;
}

/** Đọc các nguồn cảm hứng chưa từng được đọc — để gen của chúng vào kịp lô sắp lập. */
async function describePending(db: Db, describe: SourceDescriber): Promise<number> {
  const s = schema.creativeSources;
  const pending = await db
    .select({ id: s.id })
    .from(s)
    .where(and(eq(s.active, true), ne(s.kind, "PRODUCT_PHOTO"), isNull(s.visionAt), isNotNull(s.imageId)))
    .orderBy(asc(s.createdAt), asc(s.id))
    .limit(DESCRIBE_PER_BUILD);
  let ok = 0;
  for (const p of pending) if ((await describe(db, p.id)).ok) ok += 1;
  return ok;
}

async function createBatch(db: Db, batchDay: string, cfg: CreativeLoopConfig): Promise<{ batch: BatchRow; created: boolean }> {
  const plan = planBatch(await loadPlanInputs(db, batchDay, cfg));
  const w = batchWindow(batchDay, cfg);
  const created = await db.transaction(async (tx) => {
    const [b] = await tx
      .insert(schema.creativeBatches)
      .values({
        batchDay,
        status: "PLANNED",
        slotCount: plan.slots.length,
        startAt: w.startAt,
        endAt: w.endAt,
        approvalDeadline: w.approvalDeadline,
        plan: plan as unknown as Record<string, unknown>,
        configSnapshot: cfg as unknown as Record<string, unknown>,
        ruleVersion: CREATIVE_RULE_VERSION,
      })
      .onConflictDoNothing({ target: schema.creativeBatches.batchDay })
      .returning();
    if (!b) return null;
    if (plan.slots.length) {
      await tx.insert(schema.creativeVariants).values(
        plan.slots.map((s) => ({
          batchId: b.id,
          slot: s.slot,
          mode: s.mode,
          productId: s.productId,
          productPhotoSourceId: s.productPhotoSourceId,
          inspirationSourceId: s.inspirationSourceId,
          parentVariantId: s.parentVariantId,
          genes: s.genes as Record<string, string>,
          genesVersion: GENE_VOCAB_VERSION,
          mutatedGene: s.mutatedGene ?? "",
          why: s.why,
          status: "PLANNED",
        })),
      );
    }
    return b;
  });
  if (created) return { batch: created, created: true };
  // Một tick khác đã lập lô ngày này trước — đọc lô ấy, không lập lại.
  const existing = await batchByDay(db, batchDay);
  if (!existing) throw new Error(`Không lập được lô ${batchDay} và cũng không đọc được lô đã có.`);
  return { batch: existing, created: false };
}

/** Số ảnh đã sinh + USD đã chi cho sinh ảnh trong ngày Việt Nam chứa `now`. */
export async function imageSpendToday(db: Db, now: Date, unpricedUsd: number): Promise<{ images: number; usd: number }> {
  const from = dauNgayVN(now);
  const to = new Date(from.getTime() + 24 * 3_600_000);
  const v = schema.creativeVariants;
  const img = schema.creativeImages;
  const [r] = await db
    .select({
      images: sql<number>`count(*)::int`,
      usd: sql<string>`coalesce(sum(nullif(${v.genCostUsd}, '')::numeric), 0)`,
      unpriced: sql<number>`count(*) filter (where nullif(${v.genCostUsd}, '') is null)::int`,
    })
    .from(v)
    .innerJoin(img, eq(img.id, v.imageId))
    .where(and(gte(img.createdAt, from), lt(img.createdAt, to)));
  // Ảnh chưa định giá được (không có `usage`) tính theo giá ƯỚC TÍNH — với một cái phanh, CHƯA BIẾT
  // phải nghiêng về phía chặn sớm, không phải phía coi như miễn phí.
  return { images: Number(r?.images ?? 0), usd: Number(r?.usd ?? 0) + Number(r?.unpriced ?? 0) * unpricedUsd };
}

/**
 * ĐƯỜNG ĐIỂM ẢNH DUY NHẤT của đường sinh. Chỉ nhận nguồn ảnh sản phẩm thật và mẫu cha — xem đầu tệp.
 */
async function gatherPixels(db: Db, ref: { productPhotoSourceId: string | null; parentVariantId: string | null }): Promise<ImageEditInputImage[]> {
  if (!ref.productPhotoSourceId) throw new Error("Ô không có ảnh sản phẩm thật làm gốc.");
  const [photo] = await db
    .select({ kind: schema.creativeSources.kind, imageId: schema.creativeSources.imageId })
    .from(schema.creativeSources)
    .where(eq(schema.creativeSources.id, ref.productPhotoSourceId))
    .limit(1);
  // Kiểm lại LOẠI lúc đọc: cột khoá ngoại không nói gì về loại nguồn.
  if (!photo || photo.kind !== "PRODUCT_PHOTO") throw new Error("Nguồn gốc của ô không phải ảnh sản phẩm thật — từ chối gửi điểm ảnh.");
  const productPixels = photo.imageId ? await readCreativeImage(db, photo.imageId) : null;
  if (!productPixels) throw new Error("Ảnh sản phẩm thật của ô đã mất hoặc đã bị xoá điểm ảnh.");
  const out: ImageEditInputImage[] = [{ kind: "PRODUCT_PHOTO", bytes: new Uint8Array(productPixels.bytes), contentType: productPixels.contentType }];

  if (ref.parentVariantId) {
    const [parent] = await db.select({ imageId: schema.creativeVariants.imageId }).from(schema.creativeVariants).where(eq(schema.creativeVariants.id, ref.parentVariantId)).limit(1);
    const parentPixels = parent?.imageId ? await readCreativeImage(db, parent.imageId) : null;
    // Ảnh mẫu cha đã mất thì ô vẫn sinh được từ ảnh sản phẩm — mất tham chiếu bố cục, không mất sản phẩm.
    if (parentPixels) out.push({ kind: "OWN_VARIANT", bytes: new Uint8Array(parentPixels.bytes), contentType: parentPixels.contentType });
  }
  return out;
}

/** Mô tả CHỮ của nguồn cảm hứng — thứ duy nhất của nguồn ấy được đi tiếp. */
async function inspirationSummaryOf(db: Db, sourceId: string | null): Promise<string | null> {
  if (!sourceId) return null;
  const [r] = await db.select({ summary: schema.creativeSources.visionSummary }).from(schema.creativeSources).where(eq(schema.creativeSources.id, sourceId)).limit(1);
  return r?.summary ? r.summary : null;
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 1000);
}

async function markFailed(db: Db, id: string, error: string, extra: Partial<VariantRow> = {}): Promise<boolean> {
  const rows = await db
    .update(schema.creativeVariants)
    .set({ ...extra, status: "GEN_FAILED", genError: error })
    .where(and(eq(schema.creativeVariants.id, id), eq(schema.creativeVariants.status, "PLANNED")))
    .returning({ id: schema.creativeVariants.id });
  return rows.length > 0;
}

async function generateOne(db: Db, variant: VariantRow, cfg: CreativeLoopConfig, deps: { imageClient: ImageEditClient; writer: CopyWriter; now: Date }): Promise<boolean> {
  const genes = parseGenes(variant.genes);
  const precheck = !genes ? "Bộ gen của ô hỏng — không viết được câu lệnh." : !variant.productId ? "Ô không còn gắn mã hàng." : null;
  const product = !precheck && variant.productId ? await loadProductBrief(db, variant.productId) : null;
  if (!genes || !variant.productId || !product) {
    await markFailed(db, variant.id, precheck ?? "Không tìm thấy mã hàng của ô.");
    return false;
  }

  let copy: Awaited<ReturnType<CopyWriter>>;
  try {
    copy = await deps.writer(
      {
        genes,
        mode: variant.mode as SlotMode,
        why: variant.why,
        product: { name: product.name, code: product.code, priceVnd: product.priceVnd },
        inspirationSummary: await inspirationSummaryOf(db, variant.inspirationSourceId),
        winningExamples: await loadWinningExamples(db, variant.productId),
      },
      { now: deps.now, entityId: variant.id },
    );
  } catch (e) {
    await markFailed(db, variant.id, `Viết câu chữ lỗi: ${errText(e)}`);
    return false;
  }
  const written = { imagePrompt: copy.imagePrompt, primaryText: copy.primaryText, headline: copy.headline, writerModel: copy.model, writerCostUsd: copy.costUsd === null ? "" : copy.costUsd.toFixed(6) };

  try {
    const images = await gatherPixels(db, { productPhotoSourceId: variant.productPhotoSourceId, parentVariantId: variant.parentVariantId });
    const out = await deps.imageClient({ model: cfg.imageModel, prompt: copy.imagePrompt, images, size: cfg.imageSize, quality: cfg.imageQuality });
    const stored = await storeCreativeImage(db, out.bytes);
    const rows = await db
      .update(schema.creativeVariants)
      .set({ ...written, imageId: stored.id, genModel: cfg.imageModel, genCostUsd: out.costUsd === null ? "" : out.costUsd.toFixed(6), genError: "", status: "GENERATED" })
      .where(and(eq(schema.creativeVariants.id, variant.id), eq(schema.creativeVariants.status, "PLANNED")))
      .returning({ id: schema.creativeVariants.id });
    return rows.length > 0;
  } catch (e) {
    await markFailed(db, variant.id, `Sinh ảnh lỗi: ${errText(e)}`, written);
    return false;
  }
}

/** Hết `PLANNED` ⇒ chốt trạng thái lô. Có điều kiện `status = 'PLANNED'` để không đè lên lượt duyệt. */
async function settleBatch(db: Db, batchId: string): Promise<BatchStatus> {
  const v = schema.creativeVariants;
  const [c] = await db
    .select({ planned: sql<number>`count(*) filter (where ${v.status} = 'PLANNED')::int`, generated: sql<number>`count(*) filter (where ${v.status} = 'GENERATED')::int`, total: sql<number>`count(*)::int` })
    .from(v)
    .where(eq(v.batchId, batchId));
  if (Number(c?.planned ?? 0) > 0) return "PLANNED";
  const [b] = await db.select({ status: schema.creativeBatches.status, plan: schema.creativeBatches.plan }).from(schema.creativeBatches).where(eq(schema.creativeBatches.id, batchId)).limit(1);
  if (!b || b.status !== "PLANNED") return (b?.status as BatchStatus) ?? "FAILED";
  const generated = Number(c?.generated ?? 0);
  let error = "";
  if (generated === 0) {
    const shortfall = (b.plan as { shortfall?: { reasons?: unknown } }).shortfall;
    const reasons = Array.isArray(shortfall?.reasons) ? shortfall.reasons.filter((x): x is string => typeof x === "string") : [];
    error = Number(c?.total ?? 0) === 0 ? `Lô không có ô nào. ${reasons.join(" ")}`.trim() : "Không mẫu nào sinh được ảnh — xem lý do ở từng mẫu.";
  }
  const status: BatchStatus = generated > 0 ? "PENDING_APPROVAL" : "FAILED";
  await db
    .update(schema.creativeBatches)
    .set({ status, error })
    .where(and(eq(schema.creativeBatches.id, batchId), eq(schema.creativeBatches.status, "PLANNED")));
  return status;
}

export async function buildBatch(db: Db, now: Date = new Date(), deps: BuildBatchDeps = {}): Promise<BuildBatchSummary> {
  const at = deps.now ?? now;
  const imageClient = deps.imageClient ?? editImage;
  const writer = deps.writer ?? writeVariantCopy;
  const describe = deps.describe ?? ((d: Db, id: string) => describeSource(d, id, { now: at }));
  const perTick = Math.max(1, Math.min(deps.perTick ?? GEN_PER_TICK, CREATIVE_HARD_LIMITS.maxImagesPerDay));
  const summary: BuildBatchSummary = { batchDay: null, batchId: null, created: false, generated: 0, failed: 0, capped: 0, described: 0, status: null, skippedReason: null };

  const cfg = await readConfig(db);
  if (!cfg.enabled) return { ...summary, skippedReason: "Vòng mẫu đang TẮT (creative.config.enabled = false)." };

  let batch: BatchRow | null = null;
  const day = batchDayToBuild(at, cfg);
  if (day) {
    summary.batchDay = day;
    batch = await batchByDay(db, day);
    if (!batch) {
      summary.described = await describePending(db, describe);
      const r = await createBatch(db, day, cfg);
      batch = r.batch;
      summary.created = r.created;
    }
  } else {
    // Ngoài giờ dựng lô: chỉ sinh tiếp cho lô còn dở và còn trước hạn duyệt.
    const [open] = await db
      .select()
      .from(schema.creativeBatches)
      .where(and(eq(schema.creativeBatches.status, "PLANNED"), gt(schema.creativeBatches.approvalDeadline, at)))
      .orderBy(asc(schema.creativeBatches.batchDay))
      .limit(1);
    if (!open) return { ...summary, skippedReason: "Chưa tới giờ dựng lô và không có lô nào đang dở." };
    batch = open;
    summary.batchDay = open.batchDay;
  }
  summary.batchId = batch.id;

  if (batch.status !== "PLANNED") return { ...summary, status: batch.status as BatchStatus, skippedReason: `Lô ${batch.batchDay} đã ở trạng thái ${batch.status} — không còn gì để sinh.` };
  if (at >= batch.approvalDeadline) return { ...summary, status: "PLANNED", skippedReason: `Lô ${batch.batchDay} đã quá hạn duyệt — không sinh thêm ảnh.` };

  // Cấu hình ẢNH đọc từ ảnh chụp của lô: đổi cấu hình giữa chừng không làm một lô mang hai kiểu ảnh.
  const snap = normalizeCreativeConfig(batch.configSnapshot).config;
  const unitUsd = estimateImageUsd(snap.imageModel, snap.imageQuality, snap.imageSize);
  const capUsd = Math.min(cfg.imageDailyCapUsd, snap.imageDailyCapUsd, CREATIVE_HARD_LIMITS.maxImageUsdPerDay);

  const todo = await db
    .select()
    .from(schema.creativeVariants)
    .where(and(eq(schema.creativeVariants.batchId, batch.id), eq(schema.creativeVariants.status, "PLANNED")))
    .orderBy(asc(schema.creativeVariants.slot))
    .limit(perTick);

  for (const variant of todo) {
    const spent = await imageSpendToday(db, at, unitUsd);
    let capReason: string | null = null;
    if (spent.images + 1 > CREATIVE_HARD_LIMITS.maxImagesPerDay) capReason = `Chạm trần ${CREATIVE_HARD_LIMITS.maxImagesPerDay} ảnh sinh / ngày (đã sinh ${spent.images}).`;
    else if (spent.usd + unitUsd > capUsd) capReason = `Chạm trần chi sinh ảnh ${capUsd} USD / ngày (đã chi ~${spent.usd.toFixed(3)} USD, ảnh tiếp theo ước tính ${unitUsd} USD).`;
    if (capReason) {
      const rows = await db
        .update(schema.creativeVariants)
        .set({ status: "GEN_FAILED", genError: capReason })
        .where(and(eq(schema.creativeVariants.batchId, batch.id), eq(schema.creativeVariants.status, "PLANNED")))
        .returning({ id: schema.creativeVariants.id });
      summary.capped += rows.length;
      summary.failed += rows.length;
      break;
    }
    let ok = false;
    try {
      ok = await generateOne(db, variant, snap, { imageClient, writer, now: at });
    } catch (e) {
      // Lỗi ngoài dự kiến (đọc CSDL…) của MỘT mẫu không được chặn các mẫu còn lại.
      await markFailed(db, variant.id, `Lỗi khi dựng mẫu: ${errText(e)}`).catch(() => false);
    }
    if (ok) summary.generated += 1;
    else summary.failed += 1;
  }

  summary.status = await settleBatch(db, batch.id);
  return summary;
}
