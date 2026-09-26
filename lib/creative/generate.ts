import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import {
  CREATIVE_CONFIG_KEY,
  CREATIVE_HARD_LIMITS,
  CREATIVE_RULE_VERSION,
  DESIGN_DNA_VERSION,
  GENE_VOCAB_VERSION,
  estimateImageUsd,
  normalizeCreativeConfig,
  parseDna,
  parseGenes,
  type DesignDna,
  type BatchStatus,
  type CreativeLoopConfig,
  type Genes,
  type SlotMode,
} from "@/lib/constants/creative-loop";
import { CAPTION_FALLBACK_PREFIX, captionFromImage, type VariantCaptioner } from "@/lib/creative/caption";
import { describeDnaVi } from "@/lib/creative/design";
import { describePendingProducts, readProductDna, type ProductDnaReader } from "@/lib/creative/dna";
import { IMAGE_BATCH_CANCEL_GRACE_MINUTES, RESERVING_PHASES, describeImageBatch, emptyImageBatchState, parseImageBatchState, type ImageBatchState } from "@/lib/creative/image-batch";
import { readCreativeImage, storeCreativeImage } from "@/lib/creative/images";
import { isManualSeed } from "@/lib/creative/manual";
import { composeDailyBatch, selectMockupParents, type ComposedSlot } from "@/lib/creative/plan";
import { batchDayToBuild, batchWindow, imageBatchFallbackAt } from "@/lib/creative/schedule";
import { describeSource, type SourceDescriber } from "@/lib/creative/vision";
import { writeVariantCopy, type CopyWriter } from "@/lib/creative/writer";
import { IMAGE_EDITS_BATCH_ENDPOINT, imageEditBatchLine, isBatchTerminal, openAiBatchClient, parseImageBatchResults, uploadEditReferences, type ImageBatchClient, type ImageBatchLineResult, type OpenAiBatch } from "@/lib/integrations/openai/batch";
import { editImage, type ImageEditClient, type ImageEditInputImage } from "@/lib/integrations/openai/images";
import { env } from "@/lib/env";
import { loadDesignInputs, productAdCostHistory } from "@/lib/queries/creative-design";
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
 * `gatherPixels()` là chỗ DUY NHẤT trong tệp này đọc điểm ảnh, và nó chỉ nhận BA khoá: nguồn ảnh
 * sản phẩm thật của ô, mẫu cha, và nguồn QUẢNG CÁO CŨ CỦA SHOP (`ownAdSourceId`). Khoá thứ ba được
 * điền từ `inspiration_source_id` của ô, nhưng điểm ảnh chỉ được đọc khi LOẠI đọc lại từ CSDL đúng là
 * `OWN_AD` VÀ nguồn ấy gắn đúng mã hàng của ảnh sản phẩm — spy / tay / R&D đi qua khoá này cũng không
 * lấy được một byte nào, chỉ `vision_summary` của chúng đi vào người viết câu chữ.
 * `tests/creative-generate.test.ts` quét mã nguồn để giữ điều đó, và `editImage()` kiểm lại nhãn ảnh lúc chạy.
 *
 * ─── TRẦN NGÀY ───
 *
 * Trước MỖI ảnh: số ảnh đã sinh hôm nay (giờ VN) ≤ `CREATIVE_HARD_LIMITS.maxImagesPerDay` và tổng
 * USD + ước tính ảnh này ≤ `cfg.imageDailyCapUsd`. Chạm trần ⇒ mọi mẫu còn `PLANNED` của lô thành
 * `GEN_FAILED` với lý do nói rõ trần nào — lô đi tiếp tới duyệt với số ảnh đã có, không treo.
 *
 * ─── HAI CÁCH GỬI YÊU CẦU VẼ (`imageMode`, chủ shop chốt 24/09/2026 "Cao + Batch, giữ 2 USD") ───
 *
 * `SYNC`  — gọi ngay từng ảnh, tối đa `GEN_PER_TICK` ảnh một lượt (hành vi cũ, giữ nguyên).
 * `BATCH` — lượt dựng lô viết câu chữ cho MỌI ô `PLANNED`, kiểm trần NGÀY theo giá Batch, rồi gửi MỘT lô
 *           Batch (`custom_id` = id mẫu). Các lượt sau đọc trạng thái; `completed` ⇒ lưu ảnh + viết câu chữ
 *           theo ảnh y như đường gọi ngay. Tới `imageBatchFallbackAt()` (2:00 ngày chạy) mà lô Batch còn
 *           chưa xong ⇒ huỷ, và ô nào còn thiếu ảnh được VẼ NỐT bằng gọi ngay ở `fallbackImageQuality`, vẫn
 *           trong trần ngày. Gửi Batch hỏng ngay (OpenAI từ chối) ⇒ vẽ nốt NGAY, không đợi tới 2:00: đợi
 *           không đổi được kết quả, chỉ bớt thời gian cho người duyệt. Trạng thái lô Batch: `image-batch.ts`.
 *
 * Tiền của lô Batch đã gửi mà chưa về ảnh GIỮ CHỖ trong trần ngày (`reservedImageSpend`) — một lượt
 * vẽ nốt không được tiêu phần tiền mà lô Batch có thể vẫn đang tiêu.
 *
 * ─── CÂU CHỮ VIẾT LẠI THEO ẢNH ───
 *
 * `writer.ts` viết câu chữ TRƯỚC khi có ảnh (nó cần câu lệnh ảnh), nên câu ấy chỉ là NHÁP. Ngay sau
 * khi ảnh được lưu, `captionFromImage()` NHÌN chính ảnh ấy và viết lại tiêu đề + nội dung chính.
 * Điểm ảnh đi vào đó là ĐẦU RA của máy vẽ (đang nằm trong bộ nhớ) — không đọc lại CSDL, nên
 * `gatherPixels()` vẫn là chỗ duy nhất đọc điểm ảnh. Viết lại hỏng ⇒ GIỮ câu nháp, mẫu vẫn
 * `GENERATED`, lý do nằm ở `gen_error` (bắt đầu bằng `CAPTION_FALLBACK_PREFIX`) để màn hình nói ra.
 */

/** Số mẫu sinh tối đa trong MỘT tick. */
export const GEN_PER_TICK = 4;
/** Số nguồn cảm hứng chưa đọc được đọc tối đa trước khi lập một lô. */
export const DESCRIBE_PER_BUILD = 5;

export type BuildBatchDeps = {
  imageClient?: ImageEditClient;
  writer?: CopyWriter;
  describe?: SourceDescriber;
  /** Viết lại câu chữ theo ảnh vừa sinh. Bỏ trống ⇒ `captionFromImage` (OpenAI thật). */
  caption?: VariantCaptioner;
  /** Files + Batch API. Bỏ trống ⇒ OpenAI thật (`OPENAI_API_KEY`). */
  batchClient?: ImageBatchClient;
  /**
   * Đọc DNA của sản phẩm đang có trước khi lập lô (ô THIẾT KẾ cần DNA của mã cha). Bỏ trống ⇒ mô hình đọc
   * ảnh thật NẾU máy chủ có `OPENAI_API_KEY`, không thì bỏ qua bước này (không ghi gì).
   */
  dna?: ProductDnaReader;
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
  /** Số mã vừa được đọc DNA trước khi lập lô. */
  dnaRead: number;
  status: BatchStatus | null;
  skippedReason: string | null;
  /** Lô Batch ảnh đang ở đâu (`imageMode = BATCH`) — một câu cho `sync_runs.detail`. */
  imageBatch: string | null;
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

/** Lô HẰNG NGÀY của một ngày chạy — lô đăng lẻ (`INSTANT`) cùng ngày không phải lô của vòng. */
async function batchByDay(db: Db, batchDay: string): Promise<BatchRow | null> {
  const [b] = await db.select().from(schema.creativeBatches).where(and(eq(schema.creativeBatches.batchDay, batchDay), eq(schema.creativeBatches.kind, "LOOP"))).limit(1);
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

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function vnMidnight(day: string): Date {
  return new Date(`${day}T00:00:00+07:00`);
}

/**
 * LẬP LÔ HẰNG NGÀY (chủ shop 24/09/2026): gom đầu vào (chỉ đọc) rồi gọi hàm THUẦN `composeDailyBatch` —
 * thiết kế mới → mockup mẫu thắng được chọn (luật riêng theo mã) → thăm dò. `manual` = số mẫu tự làm đã
 * có trong lô: chúng đăng TRƯỚC và chiếm chỗ của ô máy lập.
 */
async function composeFor(db: Db, batchDay: string, cfg: CreativeLoopConfig, manual: number) {
  const plan = await loadPlanInputs(db, batchDay, cfg);
  const design = await loadDesignInputs(db, batchDay);
  const mockup = { sourceIds: cfg.mockupSourceIds, productIds: cfg.mockupProductIds };
  const sel = selectMockupParents(plan.parents, mockup, new Set(plan.products.map((p) => p.productId)));
  const mockupHistory = await productAdCostHistory(db, [...new Set(sel.parents.map((p) => p.productId))], vnMidnight(batchDay));
  return composeDailyBatch({ batchDay, budget: cfg.batchSize + cfg.extraCandidates - manual, designSlots: cfg.designSlots + cfg.extraCandidates, exploreSlots: cfg.exploreSlots, plan, mockup, design, mockupHistory });
}

/**
 * Ô máy lập ⇒ dòng `creative_variants` PLANNED (+ một dòng `design_concepts` cho mỗi ô THIẾT KẾ), trong
 * CÙNG giao dịch với lô. Dùng chung cho lô mới và lô dựng sẵn bởi mẫu tự làm. Mã `TK-…` đã tồn tại (không
 * thể xảy ra với một lô mỗi ngày, nhưng khoá duy nhất là hàng rào) ⇒ bỏ ô ấy, không ghi đè thiết kế cũ.
 * Trả số ô đã ghi.
 */
async function insertComposed(tx: Tx, batchId: string, slots: ComposedSlot[]): Promise<number> {
  const designs = slots.flatMap((s) => (s.design ? [s.design] : []));
  const dc = schema.designConcepts;
  const inserted = designs.length
    ? await tx
        .insert(dc)
        .values(designs.map((d) => ({ code: d.code, batchId, dna: d.dna as Record<string, string>, dnaVersion: DESIGN_DNA_VERSION, parentProductIds: d.parentProductIds, why: d.why, priceVnd: d.priceVnd, status: "DRAFT" })))
        .onConflictDoNothing({ target: dc.code })
        .returning({ id: dc.id, code: dc.code })
    : [];
  const idOf = new Map(inserted.map((r) => [r.code, r.id]));
  const rows = slots
    .filter((s) => !s.design || idOf.has(s.design.code))
    .map((s) => ({
      batchId,
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
      designConceptId: s.design ? (idOf.get(s.design.code) as string) : null,
      rulesSnapshot: s.rulesSnapshot ? (s.rulesSnapshot as unknown as Record<string, unknown>) : null,
      status: "PLANNED" as const,
    }));
  if (rows.length) await tx.insert(schema.creativeVariants).values(rows);
  return rows.length;
}

/**
 * Lô đã được MẪU TỰ LÀM dựng sẵn (`plan.manualSeed`, chưa có `slots`) ⇒ máy chỉ lập PHẦN CÒN THIẾU:
 * `batchSize + extraCandidates − số mẫu tự làm` ô, theo thứ tự thiết kế → mockup → thăm dò (`composeFor`).
 * Không đụng mẫu của người, không đổi số ô của nó (ô máy lập 1…n, ô tự làm 1001+).
 *
 * Chỉ điền MỘT lần: điều kiện "plan còn là bản dựng sẵn" nằm trong WHERE, nên hai lượt chạy chồng
 * không lập hai lần.
 */
async function fillManualSeed(db: Db, batch: BatchRow, cfg: CreativeLoopConfig): Promise<BatchRow> {
  const v = schema.creativeVariants;
  const [c] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(v)
    .where(and(eq(v.batchId, batch.id), eq(v.mode, "MANUAL"), eq(v.status, "GENERATED")));
  const plan = await composeFor(db, batch.batchDay, cfg, Number(c?.n ?? 0));
  const filled = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.creativeBatches)
      .set({
        plan: { ...plan, manualSeed: true } as unknown as Record<string, unknown>,
        configSnapshot: cfg as unknown as Record<string, unknown>,
        status: plan.slots.length > 0 ? "PLANNED" : batch.status,
      })
      .where(
        and(
          eq(schema.creativeBatches.id, batch.id),
          sql`${schema.creativeBatches.plan} ->> 'manualSeed' = 'true' and not (${schema.creativeBatches.plan} ? 'slots')`,
          sql`${schema.creativeBatches.status} in ('PLANNED', 'PENDING_APPROVAL')`,
        ),
      )
      .returning();
    if (!u) return null;
    const n = await insertComposed(tx, batch.id, plan.slots);
    if (n === 0) return u;
    const [u2] = await tx
      .update(schema.creativeBatches)
      .set({ slotCount: sql`${schema.creativeBatches.slotCount} + ${n}` })
      .where(eq(schema.creativeBatches.id, batch.id))
      .returning();
    return u2 ?? u;
  });
  return filled ?? (await batchByDay(db, batch.batchDay)) ?? batch;
}

async function createBatch(db: Db, batchDay: string, cfg: CreativeLoopConfig): Promise<{ batch: BatchRow; created: boolean } | { batch: null; emptyReasons: string[] }> {
  const plan = await composeFor(db, batchDay, cfg, 0);
  /*
    LẬP KHÔNG ĐƯỢC Ô NÀO ⇒ KHÔNG GHI LÔ.

    Mỗi ngày chỉ có MỘT lô (khoá `batch_day`). Ghi một lô rỗng thành FAILED là khoá chết cả ngày ấy:
    chủ shop tải ảnh sản phẩm lúc 15:00 thì lượt 15:10 vẫn thấy "đã có lô" và không lập lại. Không ghi
    gì thì lượt sau tự thử lại, cho tới hạn duyệt — lý do vẫn đi vào sổ `sync_runs` qua `skippedReason`.
  */
  if (plan.slots.length === 0) return { batch: null, emptyReasons: plan.shortfall?.reasons ?? ["Lập lô không ra ô nào."] };
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
      .onConflictDoNothing({ target: schema.creativeBatches.batchDay, where: sql`${schema.creativeBatches.kind} = 'LOOP'` })
      .returning();
    if (!b) return null;
    const n = await insertComposed(tx, b.id, plan.slots);
    if (n === plan.slots.length) return b;
    const [b2] = await tx.update(schema.creativeBatches).set({ slotCount: n }).where(eq(schema.creativeBatches.id, b.id)).returning();
    return b2 ?? b;
  });
  if (created) return { batch: created, created: true };
  // Một tick khác đã lập lô ngày này trước — đọc lô ấy, không lập lại.
  const existing = await batchByDay(db, batchDay);
  if (!existing) throw new Error(`Không lập được lô ${batchDay} và cũng không đọc được lô đã có.`);
  return { batch: existing, created: false };
}

/**
 * Số ảnh đã sinh + USD đã chi cho sinh ảnh CỦA LÔ HẰNG NGÀY trong ngày Việt Nam chứa `now` — SỔ ĐẾM DUY NHẤT
 * của trần ảnh / ngày của lô. Ảnh của mẫu trong lô (`creative_variants`) TRỪ ảnh đến từ gen tay: chủ shop
 * 26/09/2026 gỡ trần gen tay, nên gen tay không còn ăn vào chỗ của lô (trước đó hai bên chung một sổ, và một
 * buổi gen tay nhiều làm lô ngày mai "chạm trần" — xem `MANUAL_GEN_RUN`). Tiền gen tay đo riêng ở
 * `manualGenSpendToday`. (Mẫu tự làm tải tay có `gen_cost_usd` rỗng nên vẫn tính theo giá ước tính — hành
 * vi cũ, giữ nguyên.)
 */
export async function imageSpendToday(db: Db, now: Date, unpricedUsd: number): Promise<{ images: number; usd: number }> {
  const from = dauNgayVN(now);
  const to = new Date(from.getTime() + 24 * 3_600_000);
  const v = schema.creativeVariants;
  const img = schema.creativeImages;
  const g = schema.creativeManualGenImages;
  const [r] = await db
    .select({
      images: sql<number>`count(*)::int`,
      usd: sql<string>`coalesce(sum(nullif(${v.genCostUsd}, '')::numeric), 0)`,
      unpriced: sql<number>`count(*) filter (where nullif(${v.genCostUsd}, '') is null)::int`,
    })
    .from(v)
    .innerJoin(img, eq(img.id, v.imageId))
    .where(and(gte(img.createdAt, from), lt(img.createdAt, to), sql`not exists (select 1 from ${g} where ${g.imageId} = ${v.imageId})`));
  // Ảnh chưa định giá được (không có `usage`) tính theo giá ƯỚC TÍNH — với một cái phanh, CHƯA BIẾT
  // phải nghiêng về phía chặn sớm, không phải phía coi như miễn phí.
  return { images: Number(r?.images ?? 0), usd: Number(r?.usd ?? 0) + Number(r?.unpriced ?? 0) * unpricedUsd };
}

/**
 * Tiền GEN TAY trong ngày Việt Nam chứa `now` — để HIỂN THỊ, không để chặn. `usd` chỉ cộng ảnh có giá thật
 * (máy vẽ trả `usage`); ảnh đã vẽ mà không có giá đếm riêng ở `unpriced` — CHƯA BIẾT, không phải 0 (mục 42).
 */
export async function manualGenSpendToday(db: Db, now: Date): Promise<{ images: number; usd: number; unpriced: number }> {
  const from = dauNgayVN(now);
  const to = new Date(from.getTime() + 24 * 3_600_000);
  const g = schema.creativeManualGenImages;
  const [m] = await db
    .select({
      images: sql<number>`count(*)::int`,
      usd: sql<string>`coalesce(sum(nullif(${g.costUsd}, '')::numeric), 0)`,
      unpriced: sql<number>`count(*) filter (where nullif(${g.costUsd}, '') is null)::int`,
    })
    .from(g)
    .where(and(isNotNull(g.drawnAt), gte(g.drawnAt, from), lt(g.drawnAt, to)));
  return { images: Number(m?.images ?? 0), usd: Number(m?.usd ?? 0), unpriced: Number(m?.unpriced ?? 0) };
}

/**
 * ĐƯỜNG ĐIỂM ẢNH DUY NHẤT của đường sinh. Chỉ nhận nguồn ảnh sản phẩm thật, mẫu cha và nguồn quảng cáo
 * cũ của shop — xem đầu tệp.
 */
export async function gatherPixels(db: Db, ref: { productPhotoSourceId: string | null; parentVariantId: string | null; ownAdSourceId: string | null }): Promise<ImageEditInputImage[]> {
  if (!ref.productPhotoSourceId) throw new Error("Ô không có ảnh sản phẩm thật làm gốc.");
  const [photo] = await db
    .select({ kind: schema.creativeSources.kind, imageId: schema.creativeSources.imageId, productId: schema.creativeSources.productId })
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

  if (ref.ownAdSourceId) {
    const [ownAd] = await db
      .select({ kind: schema.creativeSources.kind, imageId: schema.creativeSources.imageId, productId: schema.creativeSources.productId })
      .from(schema.creativeSources)
      .where(eq(schema.creativeSources.id, ref.ownAdSourceId))
      .limit(1);
    // Kiểm lại LOẠI lúc đọc: khoá này điền từ một cột trỏ được tới MỌI loại nguồn. Chỉ quảng cáo cũ CỦA
    // SHOP được gửi điểm ảnh, và chỉ khi nó quảng cáo ĐÚNG mã của ảnh sản phẩm — bố cục của một chiếc
    // váy khác làm tham chiếu là mời máy vẽ lẫn hai sản phẩm.
    const allowed = ownAd && ownAd.kind === "OWN_AD" && ownAd.imageId && ownAd.productId !== null && ownAd.productId === photo.productId;
    const ownAdPixels = allowed && ownAd.imageId ? await readCreativeImage(db, ownAd.imageId) : null;
    if (ownAdPixels) out.push({ kind: "OWN_VARIANT", bytes: new Uint8Array(ownAdPixels.bytes), contentType: ownAdPixels.contentType });
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

/** Cộng hai chi phí USD dạng chuỗi của cột; một vế CHƯA BIẾT ⇒ tổng CHƯA BIẾT (`""`), không phải vế kia. */
function sumCostText(a: number | null, b: number | null): string {
  return a === null || b === null ? "" : (a + b).toFixed(6);
}

type ProductBrief = NonNullable<Awaited<ReturnType<typeof loadProductBrief>>>;
type WrittenCopy = { imagePrompt: string; primaryText: string; headline: string; model: string; costUsd: number | null };
type DesignBrief = { conceptId: string; code: string; dna: DesignDna };
type Prepared = { genes: Genes; product: ProductBrief; design: DesignBrief | null; winningExamples: Awaited<ReturnType<typeof loadWinningExamples>>; copy: WrittenCopy; written: Partial<VariantRow> };

/**
 * Ô THIẾT KẾ: "sản phẩm" là thiết kế chưa tồn tại — tên "Mẫu mới TK-…", mã `TK-…`, giá = GIÁ ĐỀ NGHỊ của
 * thiết kế (`price_vnd`, `null` ⇒ câu chữ không ghi con số giá nào). Câu chữ học giọng văn của mã cha trội.
 */
async function designBriefOf(db: Db, variant: VariantRow): Promise<{ product: ProductBrief; design: DesignBrief; exampleProductId: string | null } | null> {
  if (!variant.designConceptId) return null;
  const [c] = await db.select().from(schema.designConcepts).where(eq(schema.designConcepts.id, variant.designConceptId)).limit(1);
  const dna = c ? parseDna(c.dna) : null;
  if (!c || !dna) return null;
  return { product: { productId: "", name: `Mẫu mới ${c.code}`, code: c.code, priceVnd: c.priceVnd }, design: { conceptId: c.id, code: c.code, dna }, exampleProductId: c.parentProductIds[0] ?? null };
}

/**
 * Bước chung của hai đường vẽ: kiểm ô, đọc mã hàng, VIẾT câu chữ nháp + câu lệnh ảnh. Ô đã được viết ở
 * lượt gửi Batch (còn `PLANNED`, đã có câu lệnh) thì DÙNG LẠI — vẽ nốt không trả tiền viết lần hai, và
 * ảnh vẽ nốt đi theo đúng câu lệnh đã gửi. Hỏng ⇒ `GEN_FAILED` có lý do, trả `null`.
 */
async function prepareVariant(db: Db, variant: VariantRow, deps: { writer: CopyWriter; now: Date }): Promise<Prepared | null> {
  const genes = parseGenes(variant.genes);
  const isDesign = variant.mode === "DESIGN";
  const precheck = !genes ? "Bộ gen của ô hỏng — không viết được câu lệnh." : !isDesign && !variant.productId ? "Ô không còn gắn mã hàng." : null;
  const designInfo = !precheck && isDesign ? await designBriefOf(db, variant) : null;
  const product = precheck ? null : isDesign ? (designInfo?.product ?? null) : variant.productId ? await loadProductBrief(db, variant.productId) : null;
  if (!genes || !product) {
    await markFailed(db, variant.id, precheck ?? (isDesign ? "Ô thiết kế không còn nối được về một thiết kế có DNA đủ mười thuộc tính." : "Không tìm thấy mã hàng của ô."));
    return null;
  }
  const design = designInfo?.design ?? null;

  const winningExamples = await loadWinningExamples(db, isDesign ? (designInfo?.exampleProductId ?? null) : variant.productId);
  let copy: WrittenCopy;
  if (variant.imagePrompt.trim() && variant.writerModel) {
    copy = { imagePrompt: variant.imagePrompt, primaryText: variant.primaryText, headline: variant.headline, model: variant.writerModel, costUsd: variant.writerCostUsd === "" ? null : Number(variant.writerCostUsd) };
  } else {
    try {
      copy = await deps.writer(
        {
          genes,
          mode: variant.mode as SlotMode,
          why: variant.why,
          product: { name: product.name, code: product.code, priceVnd: product.priceVnd },
          inspirationSummary: await inspirationSummaryOf(db, variant.inspirationSourceId),
          winningExamples,
          ...(design ? { design: { code: design.code, dna: design.dna } } : {}),
        },
        { now: deps.now, entityId: variant.id },
      );
    } catch (e) {
      await markFailed(db, variant.id, `Viết câu chữ lỗi: ${errText(e)}`);
      return null;
    }
  }
  const written = { imagePrompt: copy.imagePrompt, primaryText: copy.primaryText, headline: copy.headline, writerModel: copy.model, writerCostUsd: copy.costUsd === null ? "" : copy.costUsd.toFixed(6) };
  return { genes, product, design, winningExamples, copy, written };
}

/**
 * Ảnh đã có (và đã tốn tiền) ⇒ lưu, viết lại câu chữ THEO ẢNH, chuyển mẫu sang `GENERATED`. Dùng chung cho
 * gọi ngay và cho từng dòng kết quả Batch. Từ đây mọi lỗi của lượt viết lại chỉ làm mất phần "theo ảnh",
 * không làm mất mẫu. Lỗi lưu ảnh thì NÉM — nơi gọi quyết định.
 */
async function saveGenerated(db: Db, variant: VariantRow, prep: Prepared, out: { bytes: Uint8Array; contentType: string; costUsd: number | null }, genModel: string, deps: { caption: VariantCaptioner; now: Date }): Promise<boolean> {
  const { copy, product, genes, winningExamples, written, design } = prep;
  const stored = await storeCreativeImage(db, out.bytes);
  let captioned: { primaryText: string; headline: string; writerModel: string; writerCostUsd: string } | null = null;
  let captionError = "";
  try {
    const cap = await deps.caption(
      db,
      {
        image: { bytes: out.bytes, contentType: out.contentType },
        product: { name: product.name, code: product.code, priceVnd: product.priceVnd },
        genes,
        draft: { headline: copy.headline, primaryText: copy.primaryText },
        winningExamples,
        options: 1,
        ...(design ? { productNote: `Đây là MẪU MỚI của shop (mã ${design.code}) — thiết kế: ${describeDnaVi(design.dna)}. Có thể nói "mẫu mới"; không hứa ngày giao cụ thể.` } : {}),
      },
      { now: deps.now, entityId: variant.id },
    );
    if (cap.ok) captioned = { primaryText: cap.primaryText, headline: cap.headline, writerModel: `${copy.model} → ${cap.model}`, writerCostUsd: sumCostText(copy.costUsd, cap.costUsd) };
    else captionError = cap.error;
  } catch (e) {
    captionError = errText(e);
  }
  const rows = await db
    .update(schema.creativeVariants)
    .set({ ...written, ...(captioned ?? {}), imageId: stored.id, genModel, genCostUsd: out.costUsd === null ? "" : out.costUsd.toFixed(6), genError: captioned ? "" : `${CAPTION_FALLBACK_PREFIX}${captionError}`.slice(0, 1000), status: "GENERATED" })
    .where(and(eq(schema.creativeVariants.id, variant.id), eq(schema.creativeVariants.status, "PLANNED")))
    .returning({ id: schema.creativeVariants.id });
  // Ảnh đầu tiên của một thiết kế là ảnh ĐẠI DIỆN của nó (tab Thiết kế mới) — không đè ảnh đã có.
  if (rows.length > 0 && design) await db.update(schema.designConcepts).set({ imageId: stored.id, updatedAt: deps.now }).where(and(eq(schema.designConcepts.id, design.conceptId), isNull(schema.designConcepts.imageId)));
  return rows.length > 0;
}

async function generateOne(db: Db, variant: VariantRow, cfg: CreativeLoopConfig, deps: { imageClient: ImageEditClient; writer: CopyWriter; caption: VariantCaptioner; now: Date }): Promise<boolean> {
  const prep = await prepareVariant(db, variant, deps);
  if (!prep) return false;
  const { copy, written } = prep;
  try {
    const images = await gatherPixels(db, { productPhotoSourceId: variant.productPhotoSourceId, parentVariantId: variant.parentVariantId, ownAdSourceId: variant.inspirationSourceId });
    const out = await deps.imageClient({ model: cfg.imageModel, prompt: copy.imagePrompt, images, size: cfg.imageSize, quality: cfg.imageQuality });
    return await saveGenerated(db, variant, prep, out, cfg.imageModel, deps);
  } catch (e) {
    await markFailed(db, variant.id, `Sinh ảnh lỗi: ${errText(e)}`, written);
    return false;
  }
}

// ───────────────────────────── ĐƯỜNG BATCH ─────────────────────────────

/**
 * Tiền + số ảnh đang GIỮ CHỖ bởi các lô Batch đã gửi mà chưa về ảnh. Chỉ lô còn `PLANNED` và còn hạn
 * duyệt: lô đã hết hạn không bao giờ được đọc lại, để nó giữ chỗ là khoá trần của mọi ngày sau.
 */
export async function reservedImageSpend(db: Db, now: Date): Promise<{ usd: number; images: number }> {
  const b = schema.creativeBatches;
  const [r] = await db
    .select({
      usd: sql<string>`coalesce(sum(nullif(${b.plan} -> 'imageBatch' ->> 'reservedUsd', '')::numeric), 0)`,
      images: sql<number>`coalesce(sum(nullif(${b.plan} -> 'imageBatch' ->> 'reservedImages', '')::numeric), 0)::int`,
    })
    .from(b)
    .where(and(eq(b.status, "PLANNED"), gt(b.approvalDeadline, now), sql`${b.plan} -> 'imageBatch' ->> 'phase' in ('SUBMITTING', 'SUBMITTED', 'CANCELLING')`));
  return { usd: Number(r?.usd ?? 0), images: Number(r?.images ?? 0) };
}

/** Ghi trạng thái lô Batch vào `plan.imageBatch`. `claim` ⇒ chỉ ghi khi CHƯA có (chống gửi hai lô). */
async function writeImageBatchState(db: Db, batchId: string, state: ImageBatchState, claim = false): Promise<boolean> {
  const b = schema.creativeBatches;
  const rows = await db
    .update(b)
    .set({ plan: sql`${b.plan} || jsonb_build_object('imageBatch', ${JSON.stringify(state)}::jsonb)` })
    .where(and(eq(b.id, batchId), ...(claim ? [eq(b.status, "PLANNED"), sql`not (${b.plan} ? 'imageBatch')`] : [])))
    .returning({ id: b.id });
  return rows.length > 0;
}

/** Dọn tệp trên OpenAI — nuốt lỗi: tệp còn sót không làm hỏng ảnh đã về. */
async function cleanupFiles(client: ImageBatchClient, ids: (string | null)[]): Promise<void> {
  for (const id of ids) if (id) await client.deleteFile(id).catch(() => undefined);
}

type BatchCtx = { at: Date; writer: CopyWriter; caption: VariantCaptioner; client: ImageBatchClient; summary: BuildBatchSummary };

/**
 * Gửi lô Batch: kiểm trần NGÀY theo giá Batch (ô vượt trần ⇒ `GEN_FAILED` có lý do), giữ chỗ bằng
 * `SUBMITTING`, viết câu chữ, gom điểm ảnh qua `gatherPixels` (đường điểm ảnh duy nhất), tải ảnh tham
 * chiếu (hàng rào `assertPixelSafe` chạy lại trong `uploadEditReferences` + `imageEditBatchLine`), tạo lô.
 * Trả `null` khi không còn ô nào để gửi hoặc lượt khác đã giữ chỗ trước.
 */
async function submitImageBatch(db: Db, batch: BatchRow, snap: CreativeLoopConfig, capUsd: number, ctx: BatchCtx): Promise<ImageBatchState | null> {
  const v = schema.creativeVariants;
  const { at, summary, client } = ctx;
  const todo = await db.select().from(v).where(and(eq(v.batchId, batch.id), eq(v.status, "PLANNED"))).orderBy(asc(v.slot));
  if (todo.length === 0) return null;

  const unit = estimateImageUsd(snap.imageModel, snap.imageQuality, snap.imageSize, "BATCH");
  const spent = await imageSpendToday(db, at, estimateImageUsd(snap.imageModel, snap.imageQuality, snap.imageSize));
  const reserved = await reservedImageSpend(db, at);
  const byCount = CREATIVE_HARD_LIMITS.maxImagesPerDay - spent.images - reserved.images;
  const byUsd = Math.floor((capUsd - spent.usd - reserved.usd) / unit + 1e-9);
  const allow = Math.max(0, Math.min(todo.length, byCount, byUsd));
  const kept = todo.slice(0, allow);
  const over = todo.slice(allow);
  if (over.length) {
    const capReason =
      byCount < todo.length && byCount <= byUsd
        ? `Chạm trần ${CREATIVE_HARD_LIMITS.maxImagesPerDay} ảnh sinh / ngày (đã sinh ${spent.images}, đang chờ Batch ${reserved.images}) — lô Batch chỉ gửi ${allow} ô.`
        : `Chạm trần chi sinh ảnh ${capUsd} USD / ngày (đã chi ~${spent.usd.toFixed(3)} USD, đang chờ Batch ~${reserved.usd.toFixed(3)} USD, mỗi ảnh qua Batch ước tính ${unit} USD) — lô Batch chỉ gửi ${allow} ô.`;
    const rows = await db
      .update(v)
      .set({ status: "GEN_FAILED", genError: capReason })
      .where(and(inArray(v.id, over.map((x) => x.id)), eq(v.status, "PLANNED")))
      .returning({ id: v.id });
    summary.capped += rows.length;
    summary.failed += rows.length;
  }
  if (kept.length === 0) return null;

  const nowIso = at.toISOString();
  let state: ImageBatchState = { ...emptyImageBatchState({ model: snap.imageModel, quality: snap.imageQuality, size: snap.imageSize }), claimedAt: nowIso, variantIds: kept.map((x) => x.id), reservedUsd: Math.round(kept.length * unit * 1e6) / 1e6, reservedImages: kept.length };
  if (!(await writeImageBatchState(db, batch.id, state, true))) return null;

  const lines: string[] = [];
  const included: string[] = [];
  const cache = new Map<string, string>();
  let sendError = "";
  for (const variant of kept) {
    const prep = await prepareVariant(db, variant, { writer: ctx.writer, now: at });
    if (!prep) {
      summary.failed += 1;
      continue;
    }
    // Câu chữ nháp + câu lệnh lưu NGAY (mẫu vẫn PLANNED): lượt đọc kết quả và lượt vẽ nốt dùng lại đúng chúng.
    await db.update(v).set(prep.written).where(and(eq(v.id, variant.id), eq(v.status, "PLANNED")));
    let images: ImageEditInputImage[];
    try {
      images = await gatherPixels(db, { productPhotoSourceId: variant.productPhotoSourceId, parentVariantId: variant.parentVariantId, ownAdSourceId: variant.inspirationSourceId });
    } catch (e) {
      await markFailed(db, variant.id, `Sinh ảnh lỗi: ${errText(e)}`, prep.written);
      summary.failed += 1;
      continue;
    }
    try {
      const refs = await uploadEditReferences(client, images, cache);
      lines.push(imageEditBatchLine({ customId: variant.id, model: snap.imageModel, prompt: prep.copy.imagePrompt, images: refs, size: snap.imageSize, quality: snap.imageQuality }));
      included.push(variant.id);
    } catch (e) {
      // Lỗi tải lên là lỗi của ĐƯỜNG GỬI, không phải của ô: dừng gửi, cả lô vẽ nốt bằng gọi ngay.
      sendError = errText(e);
      break;
    }
  }
  const fileIds = [...cache.values()];

  if (!sendError && lines.length === 0) {
    state = { ...state, phase: "SETTLED", settledAt: nowIso, variantIds: [], reservedUsd: 0, reservedImages: 0, error: "Không ô nào đủ điều kiện gửi Batch." };
  } else if (!sendError) {
    try {
      const input = await client.uploadFile({ purpose: "batch", filename: `creative-${batch.batchDay}-${batch.id.slice(0, 8)}.jsonl`, bytes: new TextEncoder().encode(`${lines.join("\n")}\n`), contentType: "application/jsonl" });
      fileIds.push(input.id);
      const ob = await client.createBatch({ inputFileId: input.id, endpoint: IMAGE_EDITS_BATCH_ENDPOINT, metadata: { creative_batch_id: batch.id, batch_day: batch.batchDay } });
      state = { ...state, phase: "SUBMITTED", openaiBatchId: ob.id, openaiStatus: ob.status, submittedAt: nowIso, checkedAt: nowIso, variantIds: included, fileIds, reservedUsd: Math.round(included.length * unit * 1e6) / 1e6, reservedImages: included.length };
    } catch (e) {
      sendError = errText(e);
    }
  }
  if (sendError) {
    state = { ...state, phase: "FAILED", fileIds, variantIds: included, reservedUsd: 0, reservedImages: 0, settledAt: nowIso, error: `${sendError} — vẽ nốt ngay bằng gọi ngay.` };
    await cleanupFiles(client, fileIds);
  }
  await writeImageBatchState(db, batch.id, state);
  return state;
}

/**
 * Lô Batch đã dừng ở OpenAI (`completed` · `failed` · `expired` · `cancelled`) ⇒ nối từng dòng về ô.
 *
 *  · Dòng có ảnh ⇒ `saveGenerated` (lưu ảnh + câu chữ theo ảnh), chi phí theo `usage` × giá Batch.
 *  · Dòng lỗi ⇒ `GEN_FAILED` CHỈ khi lô `completed` VÀ có ít nhất một dòng ra ảnh. Lô huỷ / hết hạn / hỏng,
 *    hoặc `completed` mà KHÔNG dòng nào ra ảnh (dấu hiệu mô hình không nhận Batch, không phải lỗi của
 *    từng ô) ⇒ ô ở lại `PLANNED` để vẽ nốt bằng gọi ngay.
 *  · Ô không có dòng nào ⇒ ở lại `PLANNED`, vẽ nốt.
 */
async function settleImageBatch(db: Db, state: ImageBatchState, info: OpenAiBatch, ctx: BatchCtx): Promise<ImageBatchState> {
  const { client, summary, at } = ctx;
  const results: ImageBatchLineResult[] = [];
  for (const fid of [info.outputFileId, info.errorFileId]) if (fid) results.push(...parseImageBatchResults(await client.fileContent(fid), state.model, "BATCH"));
  const mine = new Set(state.variantIds);
  const byId = new Map<string, ImageBatchLineResult>();
  for (const r of results) if (mine.has(r.customId) && byId.get(r.customId)?.ok !== true) byId.set(r.customId, r);
  const anyOk = [...byId.values()].some((r) => r.ok);
  const lineErrorsAreFinal = info.status === "completed" && anyOk;

  const v = schema.creativeVariants;
  const planned = state.variantIds.length ? await db.select().from(v).where(and(inArray(v.id, state.variantIds), eq(v.status, "PLANNED"))).orderBy(asc(v.slot)) : [];
  let generated = 0;
  let failed = 0;
  for (const variant of planned) {
    const r = byId.get(variant.id);
    if (r?.ok) {
      const prep = await prepareVariant(db, variant, { writer: ctx.writer, now: at });
      if (!prep) {
        failed += 1;
        continue;
      }
      try {
        if (await saveGenerated(db, variant, prep, r.image, state.model, { caption: ctx.caption, now: at })) generated += 1;
      } catch (e) {
        await markFailed(db, variant.id, `Lưu ảnh Batch lỗi: ${errText(e)}`, prep.written);
        failed += 1;
      }
    } else if (r && !r.ok && lineErrorsAreFinal) {
      if (await markFailed(db, variant.id, `OpenAI Batch báo lỗi dòng này: ${r.error}`)) failed += 1;
    }
  }
  summary.generated += generated;
  summary.failed += failed;
  const firstLineError = results.find((r): r is Extract<ImageBatchLineResult, { ok: false }> => !r.ok)?.error ?? "";
  const why = info.errors.length ? info.errors.join(" · ").slice(0, 300) : firstLineError;
  await cleanupFiles(client, [...state.fileIds, info.outputFileId, info.errorFileId]);
  return { ...state, phase: "SETTLED", openaiStatus: info.status, settledAt: at.toISOString(), reservedUsd: 0, reservedImages: 0, generated, failed, error: anyOk ? "" : `Không dòng nào ra ảnh${why ? ` (${why})` : ""}.` };
}

/** Một lượt của lô Batch đang giữ chỗ: đọc trạng thái, xong thì nối kết quả, tới mốc vẽ nốt thì huỷ. */
async function pollImageBatch(db: Db, batch: BatchRow, snap: CreativeLoopConfig, state: ImageBatchState, ctx: BatchCtx): Promise<ImageBatchState> {
  const { at, client } = ctx;
  const fallbackAt = imageBatchFallbackAt(batch.batchDay, snap);
  const nowIso = at.toISOString();
  const abandon = (from: ImageBatchState, why: string): ImageBatchState => ({ ...from, phase: "ABANDONED", reservedUsd: 0, reservedImages: 0, settledAt: nowIso, error: why });
  let next: ImageBatchState = state;

  if (state.phase === "SUBMITTING" || !state.openaiBatchId) {
    if (at >= fallbackAt) next = abandon(state, "Lượt gửi Batch trước đứt giữa chừng — không biết OpenAI đã nhận lô hay chưa nên KHÔNG gửi lại; tới mốc vẽ nốt nên vẽ bằng gọi ngay.");
  } else {
    let info: OpenAiBatch | null = null;
    try {
      info = await client.retrieveBatch(state.openaiBatchId);
    } catch (e) {
      next = { ...state, error: `Đọc trạng thái lô Batch lỗi: ${errText(e)}` };
    }
    if (info) {
      next = { ...state, openaiStatus: info.status, checkedAt: nowIso, error: "" };
      if (isBatchTerminal(info.status)) {
        try {
          next = await settleImageBatch(db, next, info, ctx);
        } catch (e) {
          next = { ...next, error: `Đọc kết quả lô Batch lỗi: ${errText(e)}` };
        }
      } else if (state.phase === "SUBMITTED" && at >= fallbackAt) {
        try {
          const c = await client.cancelBatch(state.openaiBatchId);
          next = { ...next, phase: "CANCELLING", openaiStatus: c.status, cancelRequestedAt: nowIso };
        } catch (e) {
          next = { ...next, phase: "CANCELLING", cancelRequestedAt: nowIso, error: `Huỷ lô Batch lỗi: ${errText(e)}` };
        }
      }
    }
    // Đã qua mốc vẽ nốt mà lô vẫn giữ chỗ quá lâu (đang huỷ, hoặc không đọc được OpenAI) ⇒ bỏ, vẽ nốt.
    const since = Date.parse(next.cancelRequestedAt || fallbackAt.toISOString());
    if (RESERVING_PHASES.includes(next.phase) && at >= fallbackAt && at.getTime() >= since + IMAGE_BATCH_CANCEL_GRACE_MINUTES * 60_000) {
      next = abandon(next, `Quá ${IMAGE_BATCH_CANCEL_GRACE_MINUTES} phút sau mốc vẽ nốt mà lô Batch chưa dừng${next.error ? ` (${next.error})` : ""} — bỏ, vẽ nốt bằng gọi ngay.`);
    }
  }
  if (next !== state) await writeImageBatchState(db, batch.id, next);
  return next;
}

/**
 * Chế độ BATCH của một lượt. Trả `true` khi các ô còn `PLANNED` phải được VẼ NỐT bằng gọi ngay ngay trong
 * lượt này (lô Batch đã dừng / gửi hỏng / đã qua mốc vẽ nốt mà chưa từng gửi).
 */
async function runBatchMode(db: Db, batch: BatchRow, snap: CreativeLoopConfig, capUsd: number, ctx: BatchCtx): Promise<boolean> {
  let state = parseImageBatchState(batch.plan);
  if (!state) {
    if (ctx.at >= imageBatchFallbackAt(batch.batchDay, snap)) {
      ctx.summary.imageBatch = "Batch ảnh: lô dựng sau mốc vẽ nốt — không gửi Batch, vẽ bằng gọi ngay.";
      return true;
    }
    state = await submitImageBatch(db, batch, snap, capUsd, ctx);
    // Không còn ô nào để gửi (hết trần / hết ô), hoặc lượt khác vừa giữ chỗ: đọc lại cái đang có.
    if (!state) state = parseImageBatchState((await batchByDay(db, batch.batchDay))?.plan);
  } else if (RESERVING_PHASES.includes(state.phase)) {
    state = await pollImageBatch(db, batch, snap, state, ctx);
  }
  ctx.summary.imageBatch = describeImageBatch(state, snap.fallbackImageQuality) || ctx.summary.imageBatch;
  return !state || !RESERVING_PHASES.includes(state.phase);
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
  const caption: VariantCaptioner = deps.caption ?? captionFromImage;
  const perTick = Math.max(1, Math.min(deps.perTick ?? GEN_PER_TICK, CREATIVE_HARD_LIMITS.maxImagesPerDay));
  const summary: BuildBatchSummary = { batchDay: null, batchId: null, created: false, generated: 0, failed: 0, capped: 0, described: 0, dnaRead: 0, status: null, skippedReason: null, imageBatch: null };
  // Không có khoá API và không ai tiêm bộ đọc ⇒ bỏ hẳn bước đọc DNA (không một câu truy vấn, không một dòng ghi).
  const dnaReader: ProductDnaReader | null = deps.dna ?? (env.openaiRest.apiKey ? (d: Db, t) => readProductDna(d, t, { now: at }) : null);
  const readDna = async () => {
    if (dnaReader) summary.dnaRead = (await describePendingProducts(db, dnaReader, at)).read;
  };

  const cfg = await readConfig(db);
  if (!cfg.enabled) return { ...summary, skippedReason: "Vòng mẫu đang TẮT (creative.config.enabled = false)." };

  let batch: BatchRow | null = null;
  const day = batchDayToBuild(at, cfg);
  if (day) {
    summary.batchDay = day;
    batch = await batchByDay(db, day);
    if (batch && isManualSeed(batch.plan) && ["PLANNED", "PENDING_APPROVAL"].includes(batch.status)) {
      summary.described = await describePending(db, describe);
      await readDna();
      batch = await fillManualSeed(db, batch, cfg);
    }
    if (!batch) {
      summary.described = await describePending(db, describe);
      await readDna();
      const r = await createBatch(db, day, cfg);
      if (!r.batch) return { ...summary, skippedReason: `Chưa lập được lô ${day}: ${r.emptyReasons.join(" ")} Lượt sau thử lại.` };
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
  const capUsd = Math.min(cfg.imageDailyCapUsd, snap.imageDailyCapUsd, CREATIVE_HARD_LIMITS.maxImageUsdPerDay);

  // BATCH: gửi / đọc lô Batch. Chưa tới lúc vẽ nốt ⇒ dừng ở đây; tới lúc ⇒ vẽ nốt ở chất lượng dự phòng.
  let draw = snap;
  if (snap.imageMode === "BATCH") {
    const goSync = await runBatchMode(db, batch, snap, capUsd, { at, writer, caption, client: deps.batchClient ?? openAiBatchClient(), summary });
    if (!goSync) {
      summary.status = await settleBatch(db, batch.id);
      return summary;
    }
    draw = { ...snap, imageQuality: snap.fallbackImageQuality };
  }
  const unitUsd = estimateImageUsd(draw.imageModel, draw.imageQuality, draw.imageSize);

  const todo = await db
    .select()
    .from(schema.creativeVariants)
    .where(and(eq(schema.creativeVariants.batchId, batch.id), eq(schema.creativeVariants.status, "PLANNED")))
    .orderBy(asc(schema.creativeVariants.slot))
    .limit(perTick);

  for (const variant of todo) {
    const spent = await imageSpendToday(db, at, unitUsd);
    // Lô Batch khác còn đang giữ chỗ (vd lô của ngày khác) — phần tiền ấy chưa được tiêu nhưng sẽ tiêu.
    const reserved = await reservedImageSpend(db, at);
    let capReason: string | null = null;
    if (spent.images + reserved.images + 1 > CREATIVE_HARD_LIMITS.maxImagesPerDay) capReason = `Chạm trần ${CREATIVE_HARD_LIMITS.maxImagesPerDay} ảnh sinh / ngày (đã sinh ${spent.images}${reserved.images ? `, đang chờ Batch ${reserved.images}` : ""}).`;
    else if (spent.usd + reserved.usd + unitUsd > capUsd) capReason = `Chạm trần chi sinh ảnh ${capUsd} USD / ngày (đã chi ~${spent.usd.toFixed(3)} USD${reserved.usd ? `, đang chờ Batch ~${reserved.usd.toFixed(3)} USD` : ""}, ảnh tiếp theo ước tính ${unitUsd} USD).`;
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
      ok = await generateOne(db, variant, draw, { imageClient, writer, caption, now: at });
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
