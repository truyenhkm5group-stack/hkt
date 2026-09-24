import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  CREATIVE_HARD_LIMITS,
  GENE_VOCAB,
  MANUAL_GEN,
  estimateImageUsd,
  normalizeCreativeConfig,
  parseGenes,
  type CreativeLoopConfig,
  type Genes,
  type ImageQuality,
  type ImageSize,
} from "@/lib/constants/creative-loop";
import { captionFromImage, type VariantCaptioner } from "@/lib/creative/caption";
import { gatherPixels, imageSpendToday, reservedImageSpend } from "@/lib/creative/generate";
import { readCreativeImage, storeCreativeImage } from "@/lib/creative/images";
import { insertManualVariant, type ManualActor } from "@/lib/creative/manual";
import { defaultNames, loadNamingContext, nextNameSeq } from "@/lib/creative/naming";
import { PRESERVE_PRODUCT_CLAUSE, geneDirectives } from "@/lib/creative/writer";
import { editImage, type ImageEditClient } from "@/lib/integrations/openai/images";
import { readCurrentCreativeConfig } from "@/lib/queries/creative-loop";
import { loadProductBrief, loadWinningExamples } from "@/lib/queries/creative-plan";

/**
 * ═══════════ GEN ẢNH BẰNG TAY → DUYỆT ẢNH → SOẠN BÀI → VÀO LÔ (chủ shop 25/09/2026, §5i) ═══════════
 *
 * Luồng:
 *
 *   người bấm "Gen ảnh"   `startManualGen` — kiểm nguồn (chỉ ảnh sản phẩm THẬT + tuỳ chọn quảng cáo cũ của
 *                         shop CÙNG mã), kiểm trần ảnh / ngày NGAY LÚC BẤM, ghi MỘT lượt + `imagesPerRun` dòng
 *                         ảnh `PLANNED` (dòng vượt trần ghi `GEN_FAILED` kèm lý do). KHÔNG gọi OpenAI.
 *   vẽ                    `drawManualGen` — từng ảnh: kiểm lại trần → giữ chỗ (`DRAWING`) → `gatherPixels`
 *                         (đường điểm ảnh DUY NHẤT, kiểm loại nguồn lúc đọc) → gpt-image → lưu → `GENERATED`.
 *                         Server action giao việc vẽ cho `after()` (trả lời người bấm ngay), lượt vòng mẫu
 *                         vẽ nốt phần còn lại — cả hai giữ chỗ bằng câu `UPDATE … WHERE status = 'PLANNED'`
 *                         nên không ảnh nào bị vẽ hai lần.
 *   người Duyệt / Loại    `reviewManualGenImage` — duyệt ⇒ máy ĐỌC ẢNH và viết tiêu đề + nội dung chính
 *                         (`captionFromImage`, cùng luật giá của vòng). Viết hỏng ⇒ vẫn duyệt, người gõ tay.
 *   người "Đưa vào lô"    `promoteManualGenImage` — câu chữ + ba tên (mặc định theo khuôn, người sửa được) ⇒
 *                         MỘT mẫu `MANUAL` trong lô gần nhất còn hạn duyệt, đúng đường của mẫu tự làm.
 *
 * Ảnh gen tay KHÔNG vào lô cho tới khi người đưa vào: vẽ 10 tấm để chọn 1–2 tấm là cách dùng đúng, và
 * một lô đầy ảnh chưa ai nhìn là một phiếu duyệt không ai đọc.
 *
 * ─── VÌ SAO KHÔNG VẼ TRONG SERVER ACTION ───
 *
 * Mười ảnh gọi ngay mất 1–10 phút (một ảnh có thể tới 180 giây). Chờ trong action là treo nút bấm và
 * phó mặc cho giới hạn thời gian của trình duyệt / proxy. Nên action chỉ ghi lượt rồi trả lời ngay; việc
 * vẽ chạy SAU phản hồi (`after()` của Next — tiến trình máy chủ Node trên VPS, không bị cắt như serverless)
 * và lượt vòng mẫu vẽ nốt nếu tiến trình ấy chết. Ảnh "đang vẽ" quá `staleDrawMinutes` ⇒ `GEN_FAILED`,
 * KHÔNG vẽ lại: OpenAI có thể đã tính tiền cho lượt đứt ấy.
 */

type GenRow = typeof schema.creativeManualGens.$inferSelect;
type ImageRow = typeof schema.creativeManualGenImages.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// ───────────────────────────── PHẦN THUẦN ─────────────────────────────

/** Người mẫu cho ảnh gen tay — shop thời trang nữ; `NONE` chỉ đi với ảnh trải phẳng. */
const MANUAL_GEN_MODELS: readonly Genes["model"][] = ["FEMALE_YOUNG", "FEMALE_YOUNG", "FEMALE_MATURE"];

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/**
 * Bộ gen cho `count` ảnh của MỘT lượt — hàm THUẦN, tất định theo `seed` (id lượt). Mỗi ảnh một tổ hợp bối
 * cảnh × bố cục khác nhau để 10 ảnh là 10 ý khác nhau thật (không phải 10 bản gần giống), và mỗi ảnh mang
 * ĐỦ sáu gen trong từ vựng đóng — vào lô rồi thì máy học được từ nó như mọi mẫu. Chữ trên ảnh luôn `NONE`:
 * ảnh gen tay chưa biết giá sẽ chạy, và chữ in sai trên ảnh không sửa được bằng câu chữ.
 */
export function manualGenGenes(seed: string, count: number = MANUAL_GEN.imagesPerRun): Genes[] {
  const h = hashSeed(seed);
  const V = GENE_VOCAB;
  const out: Genes[] = [];
  for (let i = 0; i < count; i += 1) {
    const scene = V.scene[(h + 3 * i) % V.scene.length];
    const model = scene === "FLATLAY" ? "NONE" : MANUAL_GEN_MODELS[(h + i) % MANUAL_GEN_MODELS.length];
    let composition = V.composition[(h + 2 * i) % V.composition.length];
    if (model === "NONE" && composition === "MIRROR_SELFIE") composition = "SINGLE_HERO";
    out.push({ angle: V.angle[(h + i) % V.angle.length], scene, model, composition, textOverlay: "NONE", palette: V.palette[(h + 2 * i + 1) % V.palette.length] });
  }
  return out;
}

/** Câu lệnh cho MỘT ảnh — hàm THUẦN: ý tưởng tự do của người + sáu chỉ thị gen tất định + giữ nguyên sản phẩm. */
export function manualGenPrompt(i: { idea: string; genes: Genes; productName: string; hasOwnAd: boolean }): string {
  return [
    `Facebook feed advertising photo for a Vietnamese fashion shop. Product: "${i.productName}" — exactly the garment in the attached REAL product photo.`,
    i.hasOwnAd ? "Another attached image is one of the shop's OWN previous ads — use it only as a layout and style reference, never copy its product." : "",
    i.idea.trim() ? `Creative direction from the shop owner (may be Vietnamese — follow it unless it conflicts with the rules below): ${i.idea.trim()}` : "",
    ...geneDirectives(i.genes, null, ""),
    PRESERVE_PRODUCT_CLAUSE,
  ]
    .filter(Boolean)
    .join("\n");
}

export type ManualGenCapacity = { allowed: number; reason: string | null };

/**
 * Bao nhiêu ảnh còn được vẽ HÔM NAY — hàm THUẦN, cùng hai trần với lô hằng ngày: số ảnh
 * (`maxImagesPerDay`) và USD (`imageDailyCapUsd`), tính cả phần đang giữ chỗ.
 */
export function manualGenCapacity(x: { want: number; spentImages: number; spentUsd: number; reservedImages: number; reservedUsd: number; unitUsd: number; capUsd: number; maxImages: number }): ManualGenCapacity {
  const byCount = x.maxImages - x.spentImages - x.reservedImages;
  const byUsd = x.unitUsd > 0 ? Math.floor((x.capUsd - x.spentUsd - x.reservedUsd) / x.unitUsd + 1e-9) : x.want;
  const allowed = Math.max(0, Math.min(x.want, byCount, byUsd));
  if (allowed >= x.want) return { allowed, reason: null };
  const reason =
    byCount <= byUsd
      ? `Chạm trần ${x.maxImages} ảnh sinh / ngày (đã sinh ${x.spentImages}${x.reservedImages ? `, đang giữ chỗ ${x.reservedImages}` : ""}) — còn vẽ được ${allowed}/${x.want} ảnh.`
      : `Chạm trần chi sinh ảnh ${x.capUsd} USD / ngày (đã chi ~${x.spentUsd.toFixed(3)} USD${x.reservedUsd ? `, đang giữ chỗ ~${x.reservedUsd.toFixed(3)} USD` : ""}, mỗi ảnh ước tính ${x.unitUsd} USD) — còn vẽ được ${allowed}/${x.want} ảnh.`;
  return { allowed, reason };
}

// ───────────────────────────── ĐO TRẦN LÚC NÀY ─────────────────────────────

/** Trần USD thật của hôm nay: cấu hình chỉ LÀM HẸP trần cứng. */
export function manualGenCapUsd(cfg: Pick<CreativeLoopConfig, "imageDailyCapUsd">): number {
  return Math.min(cfg.imageDailyCapUsd, CREATIVE_HARD_LIMITS.maxImageUsdPerDay);
}

export async function manualGenCapacityNow(db: Db, cfg: Pick<CreativeLoopConfig, "imageModel" | "imageQuality" | "imageSize" | "imageDailyCapUsd">, now: Date, want: number, draw?: { model: string; quality: ImageQuality; size: ImageSize }): Promise<ManualGenCapacity & { unitUsd: number; spentUsd: number; spentImages: number; capUsd: number }> {
  const d = draw ?? { model: cfg.imageModel, quality: cfg.imageQuality, size: cfg.imageSize };
  const unitUsd = estimateImageUsd(d.model, d.quality, d.size);
  const [spent, reserved] = await Promise.all([imageSpendToday(db, now, unitUsd), reservedImageSpend(db, now)]);
  const capUsd = manualGenCapUsd(cfg);
  const cap = manualGenCapacity({ want, spentImages: spent.images, spentUsd: spent.usd, reservedImages: reserved.images, reservedUsd: reserved.usd, unitUsd, capUsd, maxImages: CREATIVE_HARD_LIMITS.maxImagesPerDay });
  return { ...cap, unitUsd, spentUsd: spent.usd, spentImages: spent.images, capUsd };
}

// ───────────────────────────── BẤM "GEN ẢNH" ─────────────────────────────

export type StartManualGenInput = { productPhotoSourceId: string; ownAdSourceId: string | null; idea: string };

export type StartManualGenResult = { ok: true; genId: string; requested: number; allowed: number; reason: string | null } | { ok: false; error: string };

/**
 * Ghi MỘT lượt gen + `imagesPerRun` dòng ảnh. Không gọi OpenAI. Trả `{ ok: false }` cho lỗi nghiệp vụ
 * (nguồn không an toàn điểm ảnh, không còn trần hôm nay) — không ném.
 */
export async function startManualGen(db: Db, input: StartManualGenInput, cfg: CreativeLoopConfig, actor: ManualActor, now: Date): Promise<StartManualGenResult> {
  const s = schema.creativeSources;
  const [photo] = await db.select().from(s).where(eq(s.id, input.productPhotoSourceId)).limit(1);
  // Ranh giới 2 + 3: gốc PHẢI là ảnh sản phẩm THẬT đang bật, có mã hàng và có điểm ảnh.
  if (!photo || photo.kind !== "PRODUCT_PHOTO" || !photo.active || !photo.productId || !photo.imageId) {
    return { ok: false, error: "Ảnh gốc phải là một ẢNH SẢN PHẨM THẬT đang bật, có mã hàng — máy chỉ vẽ sản phẩm nó nhìn thấy." };
  }
  let ownAdId: string | null = null;
  if (input.ownAdSourceId) {
    const [own] = await db.select().from(s).where(eq(s.id, input.ownAdSourceId)).limit(1);
    if (!own || own.kind !== "OWN_AD" || !own.active || !own.imageId) return { ok: false, error: "Ảnh tham chiếu thêm chỉ được là QUẢNG CÁO CŨ CỦA SHOP (nhập từ Facebook) đang bật." };
    if (own.productId !== photo.productId) return { ok: false, error: "Quảng cáo cũ phải gắn ĐÚNG mã hàng của ảnh sản phẩm — bố cục của một sản phẩm khác làm máy vẽ lẫn hai sản phẩm." };
    ownAdId = own.id;
  }
  const product = await loadProductBrief(db, photo.productId);
  if (!product) return { ok: false, error: "Không tìm thấy mã hàng của ảnh sản phẩm." };

  const want = MANUAL_GEN.imagesPerRun;
  const cap = await manualGenCapacityNow(db, cfg, now, want);
  if (cap.allowed === 0) return { ok: false, error: `Không vẽ được ảnh nào lúc này. ${cap.reason ?? ""}`.trim() };

  const idea = input.idea.trim().slice(0, MANUAL_GEN.ideaMaxChars);
  const genId = await db.transaction(async (tx) => {
    const [g] = await tx
      .insert(schema.creativeManualGens)
      .values({
        productId: photo.productId,
        productPhotoSourceId: photo.id,
        ownAdSourceId: ownAdId,
        idea,
        requested: want,
        model: cfg.imageModel,
        size: cfg.imageSize,
        quality: cfg.imageQuality,
        note: cap.reason ?? "",
        createdByUserId: actor.id,
        createdByName: actor.name,
      })
      .returning({ id: schema.creativeManualGens.id });
    const genes = manualGenGenes(g.id, want);
    await tx.insert(schema.creativeManualGenImages).values(
      genes.map((gg, i) => ({
        genId: g.id,
        seq: i + 1,
        genes: gg as Record<string, string>,
        prompt: manualGenPrompt({ idea, genes: gg, productName: product.name, hasOwnAd: ownAdId !== null }),
        status: i < cap.allowed ? "PLANNED" : "GEN_FAILED",
        error: i < cap.allowed ? "" : (cap.reason ?? ""),
      })),
    );
    return g.id;
  });
  return { ok: true, genId, requested: want, allowed: cap.allowed, reason: cap.reason };
}

// ───────────────────────────── VẼ ─────────────────────────────

export type DrawManualGenDeps = {
  imageClient?: ImageEditClient;
  /** Chỉ vẽ ảnh của lượt này (lượt `after()` của nút bấm). Bỏ trống ⇒ mọi lượt, cũ trước. */
  genId?: string;
  /** Số ảnh tối đa trong lần gọi này. */
  limit?: number;
  /** Đồng hồ — kiểm thử truyền mốc cố định; bỏ trống ⇒ giờ thật ở MỖI ảnh (lượt vẽ dài vài phút). */
  now?: Date;
  /** Cấu hình để đọc trần USD. Bỏ trống ⇒ đọc `creative.config` hiện tại. */
  config?: CreativeLoopConfig;
};

export type DrawManualGenSummary = { drawn: number; failed: number; capped: number; stale: number };

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 1000);
}

/** Ảnh "đang vẽ" quá hạn ⇒ `GEN_FAILED`, không vẽ lại (có thể đã tốn tiền). */
async function failStaleDraws(db: Db, now: Date): Promise<number> {
  const g = schema.creativeManualGenImages;
  const rows = await db
    .update(g)
    .set({ status: "GEN_FAILED", error: `Lượt vẽ đứt giữa chừng (quá ${MANUAL_GEN.staleDrawMinutes} phút không xong) — KHÔNG vẽ lại vì OpenAI có thể đã tính tiền. Bấm Gen ảnh lượt mới nếu cần.`, updatedAt: now })
    .where(and(eq(g.status, "DRAWING"), lt(g.claimedAt, new Date(now.getTime() - MANUAL_GEN.staleDrawMinutes * 60_000))))
    .returning({ id: g.id });
  return rows.length;
}

/**
 * Vẽ các ảnh `PLANNED` — tuần tự, mỗi ảnh kiểm lại trần NGAY TRƯỚC khi giữ chỗ. Chạm trần ⇒ mọi ảnh còn
 * `PLANNED` của lượt ấy thành `GEN_FAILED` kèm lý do. Lỗi của một ảnh không chặn ảnh khác.
 */
export async function drawManualGen(db: Db, deps: DrawManualGenDeps = {}): Promise<DrawManualGenSummary> {
  const clock = () => deps.now ?? new Date();
  const imageClient = deps.imageClient ?? editImage;
  const cfg = deps.config ?? (await readCurrentCreativeConfig(db)).config;
  const limit = Math.max(1, Math.min(deps.limit ?? MANUAL_GEN.imagesPerRun, CREATIVE_HARD_LIMITS.maxImagesPerDay));
  const out: DrawManualGenSummary = { drawn: 0, failed: 0, capped: 0, stale: await failStaleDraws(db, clock()) };
  const g = schema.creativeManualGenImages;
  const gen = schema.creativeManualGens;

  for (let n = 0; n < limit; n += 1) {
    const [next] = await db
      .select({ img: g, run: gen })
      .from(g)
      .innerJoin(gen, eq(gen.id, g.genId))
      .where(and(eq(g.status, "PLANNED"), ...(deps.genId ? [eq(g.genId, deps.genId)] : [])))
      .orderBy(asc(gen.createdAt), asc(g.seq))
      .limit(1);
    if (!next) break;
    const at = clock();
    const size = next.run.size as ImageSize;
    const quality = next.run.quality as ImageQuality;
    const cap = await manualGenCapacityNow(db, cfg, at, 1, { model: next.run.model, quality, size });
    if (cap.allowed < 1) {
      const rows = await db
        .update(g)
        .set({ status: "GEN_FAILED", error: cap.reason ?? "Chạm trần ảnh / ngày.", updatedAt: at })
        .where(and(eq(g.genId, next.run.id), eq(g.status, "PLANNED")))
        .returning({ id: g.id });
      out.capped += rows.length;
      out.failed += rows.length;
      continue;
    }
    const claimed = await db
      .update(g)
      .set({ status: "DRAWING", claimedAt: at, updatedAt: at })
      .where(and(eq(g.id, next.img.id), eq(g.status, "PLANNED")))
      .returning({ id: g.id });
    if (claimed.length === 0) continue; // lượt khác vừa giữ chỗ ảnh này
    try {
      const images = await gatherPixels(db, { productPhotoSourceId: next.run.productPhotoSourceId, parentVariantId: null, ownAdSourceId: next.run.ownAdSourceId });
      const res = await imageClient({ model: next.run.model, prompt: next.img.prompt, images, size, quality });
      const stored = await storeCreativeImage(db, res.bytes);
      await db
        .update(g)
        .set({ status: "GENERATED", imageId: stored.id, costUsd: res.costUsd === null ? "" : res.costUsd.toFixed(6), drawnAt: clock(), error: "", updatedAt: clock() })
        .where(and(eq(g.id, next.img.id), eq(g.status, "DRAWING")));
      out.drawn += 1;
    } catch (e) {
      await db
        .update(g)
        .set({ status: "GEN_FAILED", error: `Sinh ảnh lỗi: ${errText(e)}`, updatedAt: clock() })
        .where(and(eq(g.id, next.img.id), eq(g.status, "DRAWING")));
      out.failed += 1;
    }
  }
  return out;
}

// ───────────────────────────── DUYỆT / LOẠI ẢNH ─────────────────────────────

async function loadImage(db: Db, id: string): Promise<{ img: ImageRow; run: GenRow } | null> {
  const [r] = await db
    .select({ img: schema.creativeManualGenImages, run: schema.creativeManualGens })
    .from(schema.creativeManualGenImages)
    .innerJoin(schema.creativeManualGens, eq(schema.creativeManualGens.id, schema.creativeManualGenImages.genId))
    .where(eq(schema.creativeManualGenImages.id, id))
    .limit(1);
  return r ?? null;
}

export type CaptionOutcome = { ok: true; headline: string; primaryText: string; model: string } | { ok: false; error: string };

/**
 * Máy ĐỌC ẢNH và viết tiêu đề + nội dung chính cho ảnh đã duyệt — dùng lại `captionFromImage` (cùng luật
 * giá: sai giá ERP ⇒ viết lại ⇒ vẫn sai thì bỏ con số). Ghi vào dòng ảnh (người còn sửa trước khi đưa vào lô).
 * Hỏng ⇒ ghi lý do, giữ câu cũ; không ném.
 */
export async function captionManualGenImage(db: Db, id: string, now: Date, deps: { caption?: VariantCaptioner } = {}): Promise<CaptionOutcome> {
  const r = await loadImage(db, id);
  if (!r) return { ok: false, error: "Không tìm thấy ảnh." };
  if (r.img.status !== "APPROVED") return { ok: false, error: "Chỉ viết câu chữ cho ảnh đã duyệt, chưa đưa vào lô." };
  const product = r.run.productId ? await loadProductBrief(db, r.run.productId) : null;
  const pixels = r.img.imageId ? await readCreativeImage(db, r.img.imageId) : null;
  const genes = parseGenes(r.img.genes);
  const fail = async (error: string): Promise<CaptionOutcome> => {
    await db.update(schema.creativeManualGenImages).set({ captionError: error.slice(0, 1000), updatedAt: now }).where(eq(schema.creativeManualGenImages.id, id));
    return { ok: false, error };
  };
  if (!product) return fail("Không tìm thấy mã hàng — không biết giá để viết câu chữ.");
  if (!pixels) return fail("Ảnh đã mất điểm ảnh.");
  const caption = deps.caption ?? captionFromImage;
  const res = await caption(
    db,
    {
      image: { bytes: new Uint8Array(pixels.bytes), contentType: pixels.contentType },
      product: { name: product.name, code: product.code, priceVnd: product.priceVnd },
      genes: genes ?? {},
      draft: r.img.headline || r.img.primaryText ? { headline: r.img.headline, primaryText: r.img.primaryText } : null,
      winningExamples: await loadWinningExamples(db, r.run.productId),
      options: 1,
    },
    { now, entityId: id },
  ).catch((e: unknown) => ({ ok: false as const, error: errText(e) }));
  if (!res.ok) return fail(res.error);
  await db
    .update(schema.creativeManualGenImages)
    .set({ headline: res.headline, primaryText: res.primaryText, captionModel: res.model, captionError: "", updatedAt: now })
    .where(and(eq(schema.creativeManualGenImages.id, id), eq(schema.creativeManualGenImages.status, "APPROVED")));
  return { ok: true, headline: res.headline, primaryText: res.primaryText, model: res.model };
}

export type ReviewResult = { ok: true; status: "APPROVED" | "REJECTED"; caption: CaptionOutcome | null } | { ok: false; error: string };

/**
 * Người DUYỆT hoặc LOẠI một ảnh gen tay. Duyệt ⇒ máy viết câu chữ theo ảnh ngay (một lời gọi, không tự lưu
 * vào lô). Loại ⇒ ảnh ra khỏi khu kết quả, không vào lô. Bấm lại cùng quyết định ⇒ không ghi gì thêm.
 */
export async function reviewManualGenImage(db: Db, input: { imageId: string; decision: "APPROVE" | "REJECT"; reason: string }, actor: ManualActor, now: Date, deps: { caption?: VariantCaptioner } = {}): Promise<ReviewResult> {
  const r = await loadImage(db, input.imageId);
  if (!r) return { ok: false, error: "Không tìm thấy ảnh." };
  const g = schema.creativeManualGenImages;
  const target = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
  if (r.img.status === target) return { ok: true, status: target, caption: null };
  const from = input.decision === "APPROVE" ? ["GENERATED", "REJECTED"] : ["GENERATED", "APPROVED"];
  if (!from.includes(r.img.status)) return { ok: false, error: `Ảnh đang ở trạng thái ${r.img.status} — không ${input.decision === "APPROVE" ? "duyệt" : "loại"} được.` };
  if (input.decision === "APPROVE" && !r.img.imageId) return { ok: false, error: "Ảnh chưa có điểm ảnh." };
  const rows = await db
    .update(g)
    .set({ status: target, reviewedByUserId: actor.id, reviewedByName: actor.name, reviewedAt: now, rejectReason: input.decision === "REJECT" ? input.reason : "", updatedAt: now })
    .where(and(eq(g.id, input.imageId), inArray(g.status, from)))
    .returning({ id: g.id });
  if (rows.length === 0) return { ok: false, error: "Ảnh vừa đổi trạng thái — tải lại để xem." };
  if (target === "REJECTED") return { ok: true, status: target, caption: null };
  // Ảnh đã có câu chữ (duyệt lại sau khi loại) thì không viết lại — người bấm "AI viết lại" nếu muốn.
  const caption = r.img.headline || r.img.primaryText ? null : await captionManualGenImage(db, input.imageId, now, deps);
  return { ok: true, status: target, caption };
}

// ───────────────────────────── ĐƯA VÀO LÔ ─────────────────────────────

export type PromoteInput = {
  imageId: string;
  headline: string;
  primaryText: string;
  /** Tên người đã xem / sửa. Rỗng ⇒ tên mặc định theo khuôn. */
  names: { campaign: string; adset: string; ad: string };
  /** Số thứ tự màn hình đã dùng để dựng tên mặc định lúc hiển thị (`null` = không biết). */
  predictedSeq: number | null;
};

export type PromoteResult = { ok: true; variantId: string; batchId: string; batchDay: string; slot: number; nameSeq: number; names: { campaign: string; adset: string; ad: string } } | { ok: false; error: string };

/**
 * Chọn tên sẽ lưu cho MỘT ô: người để trống ⇒ mặc định; người giữ NGUYÊN tên mặc định mà màn hình dựng với
 * số thứ tự dự kiến (và số thật đã khác vì có bài khác vào lô trước) ⇒ mặc định với số THẬT; người đã sửa
 * ⇒ đúng chữ người gõ. Hàm THUẦN.
 */
export function pickName(submitted: string, dflt: string, predictedDefault: string | null): string {
  const s = submitted.trim();
  if (!s) return dflt;
  if (predictedDefault !== null && s === predictedDefault) return dflt;
  return s;
}

/**
 * Đưa ảnh đã duyệt vào lô chờ duyệt đăng — một mẫu `MANUAL` (cùng đường, cùng trần của mẫu tự làm),
 * kèm câu chữ + ba tên. Chèn mẫu và đánh dấu ảnh `PROMOTED` trong CÙNG giao dịch: hai người bấm cùng lúc
 * thì một người nhận lỗi, không có hai mẫu cho một ảnh.
 */
export async function promoteManualGenImage(db: Db, input: PromoteInput, cfg: CreativeLoopConfig, actor: ManualActor, now: Date): Promise<PromoteResult> {
  const r = await loadImage(db, input.imageId);
  if (!r) return { ok: false, error: "Không tìm thấy ảnh." };
  if (r.img.status === "PROMOTED") return { ok: false, error: "Ảnh đã được đưa vào lô." };
  if (r.img.status !== "APPROVED") return { ok: false, error: "Chỉ đưa vào lô ảnh ĐÃ DUYỆT." };
  if (!r.img.imageId) return { ok: false, error: "Ảnh chưa có điểm ảnh." };
  const genes = parseGenes(r.img.genes);
  if (!genes) return { ok: false, error: "Bộ gen của ảnh hỏng — máy không học được từ bài này." };
  if (!r.run.productId) return { ok: false, error: "Lượt gen không còn gắn mã hàng." };
  const imageId = r.img.imageId;
  const productId = r.run.productId;

  let finalNames = { campaign: "", adset: "", ad: "" };
  let finalSeq = 0;
  try {
    const res = await db.transaction(async (tx: Tx) => {
      const ins = await insertManualVariant(
        tx as unknown as Db,
        {
          productId,
          genes,
          primaryText: input.primaryText,
          headline: input.headline,
          why: `Gen tay — ${r.run.createdByName || actor.name}${r.run.idea ? `: ${r.run.idea.slice(0, 200)}` : ""}`,
          imageId,
          genModel: r.run.model,
          extra: { imagePrompt: r.img.prompt, genCostUsd: r.img.costUsd, productPhotoSourceId: r.run.productPhotoSourceId, inspirationSourceId: r.run.ownAdSourceId },
          names: async (batch) => {
            const seq = await nextNameSeq(tx as unknown as Db, batch.id);
            const ctx = await loadNamingContext(tx as unknown as Db, normalizeCreativeConfig(batch.configSnapshot).config);
            const d = defaultNames(ctx, batch.batchDay, seq);
            const p = input.predictedSeq !== null && input.predictedSeq !== seq ? defaultNames(ctx, batch.batchDay, input.predictedSeq) : null;
            finalSeq = seq;
            finalNames = { campaign: pickName(input.names.campaign, d.campaign, p?.campaign ?? null), adset: pickName(input.names.adset, d.adset, p?.adset ?? null), ad: pickName(input.names.ad, d.ad, p?.ad ?? null) };
            return { nameSeq: seq, campaignName: finalNames.campaign, adsetName: finalNames.adset, adName: finalNames.ad };
          },
        },
        cfg,
        actor,
        now,
      );
      if (!ins.ok) return ins;
      const upd = await tx
        .update(schema.creativeManualGenImages)
        .set({ status: "PROMOTED", variantId: ins.variantId, headline: input.headline, primaryText: input.primaryText, updatedAt: now })
        .where(and(eq(schema.creativeManualGenImages.id, input.imageId), eq(schema.creativeManualGenImages.status, "APPROVED")))
        .returning({ id: schema.creativeManualGenImages.id });
      if (upd.length === 0) throw new Error("PROMOTE_RACE");
      return ins;
    });
    if (!res.ok) return res;
    return { ok: true, variantId: res.variantId, batchId: res.batchId, batchDay: res.batchDay, slot: res.slot, nameSeq: finalSeq, names: finalNames };
  } catch (e) {
    const msg = errText(e);
    if (msg === "PROMOTE_RACE") return { ok: false, error: "Ảnh vừa được đưa vào lô hoặc đổi trạng thái — tải lại để xem." };
    if (/name_seq/.test(msg)) return { ok: false, error: "Vừa có bài khác lấy đúng số thứ tự trong ngày — bấm lại để lấy số mới." };
    throw e;
  }
}
