import { and, asc, eq, gte, inArray, isNotNull, like, lt, ne } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  CREATIVE_HARD_LIMITS,
  DESIGN_DNA_VERSION,
  DESIGN_NOVELTY,
  GENE_VOCAB,
  MANUAL_DESIGN,
  MANUAL_GEN,
  designCode,
  estimateImageUsd,
  normalizeCreativeConfig,
  parseDna,
  parseGenes,
  type CreativeLoopConfig,
  type DesignDna,
  type Genes,
  type ImageQuality,
  type ImageSize,
} from "@/lib/constants/creative-loop";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import { captionFromImage, type VariantCaptioner } from "@/lib/creative/caption";
import { describeDnaVi, designPromptEn, planDesigns, type DesignParent, type DesignPlanInput } from "@/lib/creative/design";
import { gatherPixels, imageSpendToday, reservedImageSpend } from "@/lib/creative/generate";
import { readCreativeImage, storeCreativeImage } from "@/lib/creative/images";
import { insertManualVariant, type ManualActor } from "@/lib/creative/manual";
import { defaultNames, loadNamingContext, nextNameSeq } from "@/lib/creative/naming";
import { DESIGN_GENE_EXCLUDE } from "@/lib/creative/plan";
import { NEW_DESIGN_CLAUSE, PRESERVE_PRODUCT_CLAUSE, geneDirectives } from "@/lib/creative/writer";
import { editImage, type ImageEditClient, type ImageEditInputImage } from "@/lib/integrations/openai/images";
import { loadDesignInputs } from "@/lib/queries/creative-design";
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
 * ─── HAI KIỂU LƯỢT (migration 0143) ───
 *
 *   `DESIGN` (mặc định)  chủ shop 25/09/2026: *"gen các mẫu MỚI HOÀN TOÀN, sáng tạo từ các ảnh đầu vào (mẫu
 *                        đã win và mẫu có chỉ số tốt), không phải tạo mockup mới cho các mẫu cũ"*. Người chọn
 *                        các mã BÁN TỐT làm cảm hứng (`loadDesignInputs` — cùng điều kiện mã cha của ô thiết
 *                        kế trong lô); `startManualDesignGen` lập tới 10 THIẾT KẾ khác nhau bằng ĐÚNG
 *                        `planDesigns` (lai DNA hai mã + đột biến, bắt buộc khác mọi mã đang có, mọi thiết kế
 *                        30 ngày và mọi thiết kế gen tay 30 ngày ở ≥ 2 thuộc tính). Máy vẽ nhận ảnh sản phẩm
 *                        THẬT của hai mã cha (ranh giới 2 không nới) cùng câu "thiết kế mới, KHÔNG sao chép".
 *                        Đưa vào lô ⇒ máy cấp mã `TK-…` (dải 101+), ghi `design_concepts` và nối mẫu vào nó —
 *                        từ đó đơn, chấm, MOQ đi đúng đường của ô thiết kế máy lập.
 *   `MOCKUP`             kiểu cũ: ảnh quảng cáo mới cho ĐÚNG sản phẩm của ảnh thật. Còn lại cho đề xuất đẩy
 *                        tồn (`?product=`): xả hàng đang có cần ảnh của chính mẫu ấy, không phải mẫu mới.
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

/**
 * Bản mô tả một THIẾT KẾ MỚI của lượt gen tay `DESIGN` — lưu ở `creative_manual_gen_images.design`. Đủ để
 * vẽ (DNA + ảnh tham chiếu), viết câu chữ (giá đề nghị) và ghi `design_concepts` lúc đưa vào lô.
 */
export type ManualDesignSpec = {
  dna: DesignDna;
  dnaVersion: number;
  /** Mã cha — TRỘI đứng đầu (giá đề nghị và giọng văn đi theo mã này). */
  parentProductIds: string[];
  /** Ảnh chụp tên mã cha lúc lập — chỉ để người đọc. */
  parentLabels: string[];
  /** Nguồn `PRODUCT_PHOTO` gửi máy vẽ — cha trội trước, rồi mẹ nếu mẹ có ảnh thật. */
  photoSourceIds: string[];
  /** Giá đề nghị = giá của cha trội; `null` = không suy được (câu chữ không ghi giá). */
  priceVnd: number | null;
  mutated: string[];
  minDiff: number;
  why: string;
};

/** Đọc lại bản mô tả thiết kế từ cột JSON — thiếu DNA đủ mười thuộc tính hoặc ảnh tham chiếu ⇒ `null`. */
export function parseManualDesignSpec(raw: unknown): ManualDesignSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const dna = parseDna(r.dna);
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.length > 0) : []);
  const photoSourceIds = strs(r.photoSourceIds);
  if (!dna || photoSourceIds.length === 0) return null;
  return {
    dna,
    dnaVersion: typeof r.dnaVersion === "number" ? r.dnaVersion : DESIGN_DNA_VERSION,
    parentProductIds: strs(r.parentProductIds),
    parentLabels: strs(r.parentLabels),
    photoSourceIds,
    priceVnd: typeof r.priceVnd === "number" && Number.isInteger(r.priceVnd) && r.priceVnd > 0 ? r.priceVnd : null,
    mutated: strs(r.mutated),
    minDiff: typeof r.minDiff === "number" ? r.minDiff : 0,
    why: typeof r.why === "string" ? r.why : "",
  };
}

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
export function manualGenGenes(seed: string, count: number = MANUAL_GEN.imagesPerRun, opts: { design?: boolean } = {}): Genes[] {
  const h = hashSeed(seed);
  const V = GENE_VOCAB;
  const out: Genes[] = [];
  // Ảnh THIẾT KẾ MỚI: có người mẫu mặc, không trải phẳng (cùng luật gen của ô thiết kế trong lô). Bước 1 trên
  // 6 bối cảnh × bước 2 trên 5 bố cục ⇒ 10 ảnh đầu là 10 tổ hợp khác nhau (bước 3 trên 6 chỉ ra 2 bối cảnh).
  const excluded: readonly string[] = DESIGN_GENE_EXCLUDE.scene ?? [];
  const scenes = opts.design ? V.scene.filter((x) => !excluded.includes(x)) : V.scene;
  for (let i = 0; i < count; i += 1) {
    const scene = scenes[(h + (opts.design ? 1 : 3) * i) % scenes.length];
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

/**
 * Câu lệnh cho MỘT ảnh THIẾT KẾ MỚI — hàm THUẦN: mô tả thiết kế tất định theo DNA (`designPromptEn`, cùng hàm
 * của ô thiết kế trong lô) + sáu chỉ thị gen + "thiết kế mới, KHÔNG sao chép". Ý tưởng của người chỉ lái bối
 * cảnh / không khí / cách phối: thiết kế trên ảnh phải khớp DNA, nếu không nhãn "cổ vuông" đi kèm một ảnh cổ
 * tròn và mọi phép học sau đó đếm sai.
 */
export function manualDesignPrompt(i: { idea: string; genes: Genes; dna: DesignDna; refCount: number }): string {
  return [
    "Facebook feed advertising photo for a Vietnamese fashion shop, presenting one of its NEW garment designs.",
    i.refCount > 1
      ? `The ${i.refCount} attached photos are REAL best-selling products of the shop — the new design is inspired by them but is a different garment.`
      : "The attached photo is a REAL best-selling product of the shop — the new design is inspired by it but is a different garment.",
    i.idea.trim() ? `Creative direction from the shop owner (may be Vietnamese) — apply it to the scene, mood and styling; the garment itself must follow the NEW GARMENT DESIGN below: ${i.idea.trim()}` : "",
    designPromptEn(i.dna),
    ...geneDirectives(i.genes, null, ""),
    NEW_DESIGN_CLAUSE,
  ]
    .filter(Boolean)
    .join("\n");
}

export type ManualDesignPlan = { specs: ManualDesignSpec[]; reasons: string[] };

/**
 * Lập `count` THIẾT KẾ cho một lượt gen tay — hàm THUẦN, tất định theo `seed` (id lượt). Chỉ các mã NGƯỜI
 * CHỌN được làm cha mẹ; phép lai / đột biến / kiểm mới lạ là ĐÚNG `planDesigns` của lô (không bản sao luật).
 * `recentDesigns` phải gồm cả thiết kế gen tay gần đây — hai lượt liên tiếp không được vẽ lại cùng một mẫu.
 */
export function planManualDesigns(i: Omit<DesignPlanInput, "batchDay" | "firstIndex" | "seed"> & { seed: string; day: string }): ManualDesignPlan {
  const plan = planDesigns({ batchDay: i.day, count: i.count, parents: i.parents, existingDna: i.existingDna, recentDesigns: i.recentDesigns, stats: i.stats, seed: `manual:${i.seed}` });
  const byId = new Map<string, DesignParent>(i.parents.map((p) => [p.productId, p]));
  const specs = plan.designs.map((d): ManualDesignSpec => {
    const photos = [d.photoSourceId, ...d.parentProductIds.slice(1).map((id) => byId.get(id)?.photoSourceId ?? null)].filter((x): x is string => x !== null);
    return {
      dna: d.dna,
      dnaVersion: DESIGN_DNA_VERSION,
      parentProductIds: d.parentProductIds,
      parentLabels: d.parentProductIds.map((id) => byId.get(id)?.label ?? id),
      photoSourceIds: [...new Set(photos)].slice(0, MANUAL_DESIGN.refPhotos),
      priceVnd: d.priceVnd,
      mutated: d.mutated,
      minDiff: d.minDiff,
      why: d.why,
    };
  });
  return { specs, reasons: plan.shortfall?.reasons ?? [] };
}

/**
 * Mã `TK-…` cho thiết kế NGƯỜI đưa vào lô ngày `batchDay` — hàm THUẦN: số lớn nhất đã dùng trong dải
 * `MANUAL_DESIGN.codeBase + 1…` của ngày ấy, cộng một. Dải 01… của ô thiết kế máy lập không bị đụng.
 */
export function manualDesignCode(batchDay: string, existingCodes: readonly string[]): string {
  const prefix = designCode(batchDay, 0).slice(0, -2);
  let top: number = MANUAL_DESIGN.codeBase;
  for (const c of existingCodes) {
    if (!c.startsWith(prefix)) continue;
    const n = Number(c.slice(prefix.length));
    if (Number.isInteger(n) && n > top) top = n;
  }
  return designCode(batchDay, top + 1);
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
        kind: "MOCKUP",
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

// ───────────────────────────── BẤM "GEN THIẾT KẾ MỚI" ─────────────────────────────

export type StartManualDesignInput = { inspirationProductIds: string[]; idea: string };

/** DNA các thiết kế gen tay gần đây (trừ ảnh vẽ hỏng — chưa ai thấy nó) — để lượt sau không lặp lại lượt trước. */
async function recentManualDesignDna(db: Db, now: Date): Promise<DesignDna[]> {
  const g = schema.creativeManualGenImages;
  const rows = await db
    .select({ design: g.design })
    .from(g)
    .where(and(isNotNull(g.design), ne(g.status, "GEN_FAILED"), gte(g.createdAt, new Date(now.getTime() - DESIGN_NOVELTY.recentDesignDays * 86_400_000))));
  return rows.map((r) => parseManualDesignSpec(r.design)?.dna ?? null).filter((d): d is DesignDna => d !== null);
}

/**
 * Ghi MỘT lượt `DESIGN` + tới `imagesPerRun` dòng ảnh, mỗi dòng một THIẾT KẾ MỚI đã lập sẵn (DNA, mã cha, ảnh
 * tham chiếu). Không gọi OpenAI. Mã cảm hứng phải CÒN đủ điều kiện mã cha (bán tốt + có DNA) lúc bấm — danh
 * sách trên màn hình có thể đã cũ. Lập được ít hơn 10 thiết kế đủ mới lạ ⇒ ghi bấy nhiêu và NÓI RA vì sao
 * (không nhồi thiết kế trùng). Trả `{ ok: false }` cho lỗi nghiệp vụ — không ném.
 */
export async function startManualDesignGen(db: Db, input: StartManualDesignInput, cfg: CreativeLoopConfig, actor: ManualActor, now: Date, deps: { seed?: string } = {}): Promise<StartManualGenResult> {
  const ids = [...new Set(input.inspirationProductIds.map((x) => x.trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Chọn ít nhất một mẫu bán tốt làm cảm hứng." };
  if (ids.length > MANUAL_DESIGN.maxInspirations) return { ok: false, error: `Chọn tối đa ${MANUAL_DESIGN.maxInspirations} mẫu cảm hứng mỗi lượt.` };

  const day = vnDay(now);
  const inputs = await loadDesignInputs(db, day);
  const byId = new Map(inputs.parents.map((p) => [p.productId, p]));
  const lost = ids.filter((id) => byId.get(id)?.dna.category === undefined);
  if (lost.length) return { ok: false, error: `${lost.length} mẫu đã chọn không còn đủ điều kiện làm cảm hứng (bán tốt + đã đọc được DNA) — tải lại trang rồi chọn lại.` };
  const chosen = ids.map((id) => byId.get(id) as DesignParent);
  if (!chosen.some((p) => p.photoSourceId !== null)) {
    return { ok: false, error: "Cần ít nhất một mẫu có ẢNH SẢN PHẨM THẬT (nguồn PRODUCT_PHOTO) — máy vẽ chỉ nhận ảnh thật của shop làm tham chiếu. Nhập ảnh ở tab Nguồn ảnh." };
  }

  const want = MANUAL_GEN.imagesPerRun;
  const cap = await manualGenCapacityNow(db, cfg, now, want);
  if (cap.allowed === 0) return { ok: false, error: `Không vẽ được ảnh nào lúc này. ${cap.reason ?? ""}`.trim() };

  const genId = crypto.randomUUID();
  // Hạt giống = id lượt. Kiểm thử truyền hạt giống cố định để chứng minh lượt sau không lặp lượt trước vì LUẬT,
  // không vì hai id ngẫu nhiên tình cờ khác nhau.
  const seed = deps.seed ?? genId;
  const plan = planManualDesigns({ seed, day, count: want, parents: chosen, existingDna: inputs.existingDna, recentDesigns: [...inputs.recentDesigns, ...(await recentManualDesignDna(db, now))], stats: inputs.stats });
  if (plan.specs.length === 0) return { ok: false, error: `Không lập được thiết kế nào đủ mới lạ. ${plan.reasons.join(" ")}`.trim() };
  const allowed = Math.min(cap.allowed, plan.specs.length);
  const shortNote = plan.specs.length < want ? `Chỉ lập được ${plan.specs.length}/${want} thiết kế đủ khác mọi mẫu đang có. ${plan.reasons.join(" ")}`.trim() : "";
  const note = [shortNote, cap.allowed < plan.specs.length ? (cap.reason ?? "") : ""].filter(Boolean).join(" ");

  const idea = input.idea.trim().slice(0, MANUAL_GEN.ideaMaxChars);
  const genes = manualGenGenes(seed, plan.specs.length, { design: true });
  await db.transaction(async (tx) => {
    await tx.insert(schema.creativeManualGens).values({
      id: genId,
      kind: "DESIGN",
      productId: null,
      productPhotoSourceId: null,
      ownAdSourceId: null,
      inspirationProductIds: ids,
      idea,
      requested: want,
      model: cfg.imageModel,
      size: cfg.imageSize,
      quality: cfg.imageQuality,
      note,
      createdByUserId: actor.id,
      createdByName: actor.name,
    });
    await tx.insert(schema.creativeManualGenImages).values(
      plan.specs.map((spec, i) => ({
        genId,
        seq: i + 1,
        genes: genes[i] as Record<string, string>,
        prompt: manualDesignPrompt({ idea, genes: genes[i], dna: spec.dna, refCount: spec.photoSourceIds.length }),
        design: spec as unknown as Record<string, unknown>,
        status: i < allowed ? "PLANNED" : "GEN_FAILED",
        error: i < allowed ? "" : (cap.reason ?? ""),
      })),
    );
  });
  return { ok: true, genId, requested: want, allowed, reason: note || null };
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
 * Điểm ảnh gửi máy vẽ cho MỘT ảnh — mọi nguồn đi qua `gatherPixels` (đường điểm ảnh DUY NHẤT, kiểm lại loại
 * nguồn lúc đọc). Thiết kế: ảnh sản phẩm thật của cha trội (bắt buộc) + của mẹ (mất thì vẫn vẽ từ ảnh cha
 * trội — mất một tham chiếu cảm hứng, không mất thiết kế).
 */
async function pixelsFor(db: Db, run: GenRow, img: ImageRow): Promise<ImageEditInputImage[]> {
  if (run.kind !== "DESIGN") return gatherPixels(db, { productPhotoSourceId: run.productPhotoSourceId, parentVariantId: null, ownAdSourceId: run.ownAdSourceId });
  const spec = parseManualDesignSpec(img.design);
  if (!spec) throw new Error("Ảnh thiết kế mất bản mô tả thiết kế (DNA / ảnh tham chiếu) — không vẽ.");
  const [dominant, ...rest] = spec.photoSourceIds;
  const out = await gatherPixels(db, { productPhotoSourceId: dominant, parentVariantId: null, ownAdSourceId: null });
  for (const id of rest) {
    const more = await gatherPixels(db, { productPhotoSourceId: id, parentVariantId: null, ownAdSourceId: null }).catch(() => []);
    out.push(...more);
  }
  return out;
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
      const images = await pixelsFor(db, next.run, next.img);
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
  // Thiết kế mới: "sản phẩm" là thiết kế chưa có mã — giá = GIÁ ĐỀ NGHỊ (null ⇒ câu chữ không ghi con số giá),
  // giọng văn học từ cha trội (cùng cách ô thiết kế của lô viết câu chữ).
  const spec = r.run.kind === "DESIGN" ? parseManualDesignSpec(r.img.design) : null;
  const product = spec ? { name: "Mẫu mới", code: "", priceVnd: spec.priceVnd } : r.run.productId ? await loadProductBrief(db, r.run.productId) : null;
  const pixels = r.img.imageId ? await readCreativeImage(db, r.img.imageId) : null;
  const genes = parseGenes(r.img.genes);
  const fail = async (error: string): Promise<CaptionOutcome> => {
    await db.update(schema.creativeManualGenImages).set({ captionError: error.slice(0, 1000), updatedAt: now }).where(eq(schema.creativeManualGenImages.id, id));
    return { ok: false, error };
  };
  if (r.run.kind === "DESIGN" && !spec) return fail("Ảnh thiết kế mất bản mô tả thiết kế — không biết giá đề nghị để viết câu chữ.");
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
      winningExamples: await loadWinningExamples(db, spec ? (spec.parentProductIds[0] ?? null) : r.run.productId),
      options: 1,
      ...(spec ? { productNote: `Đây là MẪU MỚI của shop — thiết kế: ${describeDnaVi(spec.dna)}. Có thể nói "mẫu mới"; không hứa ngày giao cụ thể.` } : {}),
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

export type PromoteResult =
  | {
      ok: true;
      variantId: string;
      batchId: string;
      batchDay: string;
      slot: number;
      nameSeq: number;
      names: { campaign: string; adset: string; ad: string };
      /** Lượt `DESIGN`: mã `TK-…` vừa cấp — chủ shop tạo sản phẩm Pancake đúng mã này để nhận đơn. */
      designCode: string | null;
      /** Giá dùng để cảnh báo câu chữ: giá ERP của mã (mockup) hoặc giá đề nghị của thiết kế. */
      priceVnd: number | null;
    }
  | { ok: false; error: string };

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
  const spec = r.run.kind === "DESIGN" ? parseManualDesignSpec(r.img.design) : null;
  if (r.run.kind === "DESIGN" && !spec) return { ok: false, error: "Ảnh thiết kế mất bản mô tả thiết kế (DNA) — không lập được mã TK cho bài này." };
  if (!spec && !r.run.productId) return { ok: false, error: "Lượt gen không còn gắn mã hàng." };
  const imageId = r.img.imageId;
  const who = r.run.createdByName || actor.name;
  const ideaNote = r.run.idea ? `: ${r.run.idea.slice(0, 200)}` : "";
  const priceVnd = spec ? spec.priceVnd : ((await loadProductBrief(db, r.run.productId as string))?.priceVnd ?? null);

  let finalNames = { campaign: "", adset: "", ad: "" };
  let finalSeq = 0;
  let code: string | null = null;
  try {
    const res = await db.transaction(async (tx: Tx) => {
      const dc = schema.designConcepts;
      const ins = await insertManualVariant(
        tx as unknown as Db,
        {
          // Thiết kế mới KHÔNG gắn mã cha: đơn / chấm / MOQ của nó đi theo `design_concept_id`, không cộng vào mã cũ.
          productId: spec ? null : r.run.productId,
          genes,
          primaryText: input.primaryText,
          headline: input.headline,
          why: `Gen tay — ${who}${ideaNote}`,
          imageId,
          genModel: r.run.model,
          extra: { imagePrompt: r.img.prompt, genCostUsd: r.img.costUsd, productPhotoSourceId: spec ? spec.photoSourceIds[0] : r.run.productPhotoSourceId, inspirationSourceId: spec ? null : r.run.ownAdSourceId },
          design: spec
            ? async (batch) => {
                const taken = await tx.select({ code: dc.code }).from(dc).where(like(dc.code, `${designCode(batch.batchDay, 0).slice(0, -2)}%`));
                code = manualDesignCode(
                  batch.batchDay,
                  taken.map((t) => t.code),
                );
                const [c] = await tx
                  .insert(dc)
                  .values({ code, batchId: batch.id, dna: spec.dna as Record<string, string>, dnaVersion: spec.dnaVersion, parentProductIds: spec.parentProductIds, why: `Gen tay — ${who}: ${spec.why}`, imageId, priceVnd: spec.priceVnd, status: "DRAFT" })
                  .returning({ id: dc.id });
                return { designConceptId: c.id, why: `Thiết kế mới ${code} (gen tay — ${who}${ideaNote}): ${spec.why}` };
              }
            : undefined,
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
    return { ok: true, variantId: res.variantId, batchId: res.batchId, batchDay: res.batchDay, slot: res.slot, nameSeq: finalSeq, names: finalNames, designCode: code, priceVnd };
  } catch (e) {
    const msg = errText(e);
    if (msg === "PROMOTE_RACE") return { ok: false, error: "Ảnh vừa được đưa vào lô hoặc đổi trạng thái — tải lại để xem." };
    if (/name_seq/.test(msg)) return { ok: false, error: "Vừa có bài khác lấy đúng số thứ tự trong ngày — bấm lại để lấy số mới." };
    if (/design_concepts_code/.test(msg)) return { ok: false, error: "Vừa có thiết kế khác lấy đúng mã TK — bấm lại để lấy mã mới." };
    throw e;
  }
}
