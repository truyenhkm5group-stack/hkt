import { and, asc, eq, gte, inArray, isNotNull, isNull, like, lt, ne } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  CREATIVE_HARD_LIMITS,
  CREATIVE_RULE_VERSION,
  CREATIVE_WRITE_DENIAL_REASON,
  DESIGN_DNA_VERSION,
  DESIGN_NOVELTY,
  GENE_VOCAB,
  INSTANT_PUBLISH,
  MANUAL_DESIGN,
  MANUAL_GEN,
  MANUAL_GEN_RUN,
  designCode,
  normalizeCreativeConfig,
  parseDna,
  parseGenes,
  type CreativeLoopConfig,
  type DesignDna,
  type Genes,
  type ImageQuality,
  type ImageSize,
} from "@/lib/constants/creative-loop";
import type { AdsKillSwitchState } from "@/lib/constants/ads-kill-switch";
import { CAMPAIGN_SETUP_LIMITS, type CampaignSetup } from "@/lib/constants/campaign-setup";
import { applyCampaignSetup } from "@/lib/creative/campaign-setup";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import { approvalDigest } from "@/lib/creative/approval";
import { captionFromImage, type VariantCaptioner } from "@/lib/creative/caption";
import { describeDnaVi, designPromptEn, planDesigns, type DesignParent, type DesignPlanInput } from "@/lib/creative/design";
import { gatherPixels } from "@/lib/creative/generate";
import { readCreativeImage, storeCreativeImage } from "@/lib/creative/images";
import { insertManualVariant, type ManualActor } from "@/lib/creative/manual";
import { defaultNames, loadNamingContext, nextNameSeq, nextNameSeqOnDay } from "@/lib/creative/naming";
import { DESIGN_GENE_EXCLUDE } from "@/lib/creative/plan";
import { REAL_CREATIVE_WRITER, batchApprovalContent, batchConfig, committedTestSpendForDay, publishBatchNow, templateShapeError, type CreativeDeps, type CreativeWriteEnv, type PublishBatchReport } from "@/lib/creative/publish";
import { NEW_DESIGN_CLAUSE, PRESERVE_PRODUCT_CLAUSE, geneDirectives } from "@/lib/creative/writer";
import { adsWriteHardEnabled, adsWriteMode, readAdsKillSwitch } from "@/lib/integrations/facebook/ads-write";
import { editImage, type ImageEditClient, type ImageEditInputImage } from "@/lib/integrations/openai/images";
import { gateCreativeWritePrefix } from "@/lib/marketing/creative-write-gate";
import { loadDesignInputs } from "@/lib/queries/creative-design";
import { loadProductBrief, loadWinningExamples } from "@/lib/queries/creative-plan";

/**
 * ═══════════ GEN ẢNH BẰNG TAY → DUYỆT ẢNH → SOẠN BÀI → VÀO LÔ (chủ shop 25/09/2026, §5i) ═══════════
 *
 * Luồng:
 *
 *   người bấm "Gen ảnh"   `startManualGen` — kiểm nguồn (chỉ ảnh sản phẩm THẬT + tuỳ chọn quảng cáo cũ của
 *                         shop CÙNG mã + ảnh người tải lên), ghi MỘT lượt + đúng SỐ ẢNH NGƯỜI CHỌN dòng ảnh
 *                         `PLANNED`. KHÔNG gọi OpenAI. KHÔNG CÒN TRẦN ẢNH / NGÀY (chủ shop 26/09/2026) — thay
 *                         bằng tiền ước tính trước khi bấm và tiền thật từng ảnh / cả lượt sau khi vẽ.
 *   vẽ                    `drawManualGen` — từng ảnh: giữ chỗ (`DRAWING`) → `gatherPixels`
 *                         (đường điểm ảnh DUY NHẤT, kiểm loại nguồn lúc đọc) → gpt-image → lưu → `GENERATED`.
 *                         Server action giao việc vẽ cho `after()` (trả lời người bấm ngay), lượt vòng mẫu
 *                         vẽ nốt phần còn lại — cả hai giữ chỗ bằng câu `UPDATE … WHERE status = 'PLANNED'`
 *                         nên không ảnh nào bị vẽ hai lần.
 *   người Duyệt / Loại    `reviewManualGenImage` — duyệt ⇒ máy ĐỌC ẢNH và viết tiêu đề + nội dung chính
 *                         (`captionFromImage`, cùng luật giá của vòng). Viết hỏng ⇒ vẫn duyệt, người gõ tay.
 *   người "Đưa vào lô"    `promoteManualGenImage` — câu chữ + ba tên (mặc định theo khuôn, người sửa được) ⇒
 *                         MỘT mẫu `MANUAL` trong lô gần nhất còn hạn duyệt, đúng đường của mẫu tự làm.
 *   người "Đăng camp"     `publishManualGenImageInstant` — cùng câu chữ + ba tên, nhưng thay vì chờ lô 6:00 hôm
 *                         sau: MỘT lô `INSTANT` riêng cho đúng bài ấy, người bấm là lượt duyệt, đăng lên Facebook
 *                         NGAY (chạy ngay, hoặc `start_time` = giờ hẹn). Cùng cổng ghi và bốn lớp chặn tiêu quá.
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
  /**
   * Ý tưởng người gõ lúc bấm (rỗng = không có). Ý tưởng đè được thuộc tính thiết kế nó nói ra (xem
   * `manualDesignPrompt`), nên nhãn DNA của ảnh CÓ THỂ lệch đúng ở thuộc tính ấy — ghi lại để người đọc biết.
   */
  ownerIdea: string;
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
    ownerIdea: typeof r.ownerIdea === "string" ? r.ownerIdea : "",
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

/**
 * VÌ SAO Ý TƯỞNG CỦA NGƯỜI TỪNG "KHÔNG ĂN" (chủ shop báo 26/09/2026: "phần câu lệnh đang không được áp dụng vào
 * kết quả gen ảnh"). Câu lệnh cũ đặt ý tưởng ở GIỮA, kèm lời dặn "làm theo TRỪ KHI mâu thuẫn với các luật bên
 * dưới" — mà ngay bên dưới là sáu chỉ thị gen mệnh lệnh ("Scene: studio…", "Palette: …") và, ở kiểu thiết kế,
 * cả chất liệu / màu của DNA. Ý tưởng "đi biển mùa thu" gặp gen bối cảnh "studio"; ý tưởng "chất liệu thun
 * rayon" gặp DNA "vải tổng hợp" — lần nào máy vẽ cũng được DẶN chọn phía máy. Ý tưởng không bị bỏ, nó bị THUA.
 *
 * Luật mới: có ý tưởng thì nó là chỉ thị ƯU TIÊN CAO NHẤT, đứng ĐẦU câu lệnh và nhắc lại ở CUỐI; sáu gen và DNA
 * lùi thành "mặc định — chỉ dùng ở chỗ người không nói gì". Hai giới hạn KHÔNG nhường ý tưởng: ảnh mockup vẫn giữ
 * ĐÚNG sản phẩm thật (đổi sản phẩm là quảng cáo một món shop không có), và không logo / thương hiệu / watermark.
 */
function ownerIdeaHead(idea: string, overrides: string): string {
  return `TOP PRIORITY — CREATIVE DIRECTION FROM THE SHOP OWNER (may be written in Vietnamese). Follow it faithfully; it OVERRIDES ${overrides} wherever they conflict: ${idea}`;
}

function uploadsLine(n: number): string {
  if (n <= 0) return "";
  const which = n === 1 ? "1 attached image was" : `${n} attached images were`;
  return `${which} uploaded by the shop owner as extra reference(s) — use them the way the owner's direction says (pose, setting, model, styling, mood, composition); if the direction does not mention them, use them only as mood / style references. Never copy any logo, text or watermark from them.`;
}

/** Câu lệnh cho MỘT ảnh mockup — hàm THUẦN: ý tưởng người (ưu tiên cao nhất) + sáu chỉ thị gen mặc định + giữ nguyên sản phẩm. */
export function manualGenPrompt(i: { idea: string; genes: Genes; productName: string; hasOwnAd: boolean; uploadCount?: number }): string {
  const idea = i.idea.trim();
  return [
    idea ? ownerIdeaHead(idea, "every default direction below (scene, pose, composition, model, colour palette, lighting, styling) — but never the product itself") : "",
    `Facebook feed advertising photo for a Vietnamese fashion shop. Product: "${i.productName}" — exactly the garment in the attached REAL product photo.`,
    i.hasOwnAd ? "Another attached image is one of the shop's OWN previous ads — use it only as a layout and style reference, never copy its product." : "",
    uploadsLine(i.uploadCount ?? 0),
    idea ? "Default directions (apply only where the owner's direction above says nothing):" : "",
    ...geneDirectives(i.genes, null, ""),
    PRESERVE_PRODUCT_CLAUSE,
    idea ? `Reminder — the owner's direction has priority over the defaults: ${idea}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Câu lệnh cho MỘT ảnh THIẾT KẾ MỚI — hàm THUẦN: mô tả thiết kế tất định theo DNA (`designPromptEn`, cùng hàm
 * của ô thiết kế trong lô) + sáu chỉ thị gen + "thiết kế mới, KHÔNG sao chép". Có ý tưởng thì ý tưởng đè cả bối
 * cảnh lẫn MỌI thuộc tính thiết kế mà nó NÓI RA (chất liệu, màu, độ dài, tay…); thuộc tính nó không nhắc vẫn đi
 * theo DNA. Hệ quả phải biết: nhãn DNA của ảnh ấy có thể lệch đúng ở thuộc tính người đã đè — `ownerIdea` được
 * lưu kèm bản mô tả thiết kế và ghi vào lý do của mã TK để người đọc sau biết.
 */
export function manualDesignPrompt(i: { idea: string; genes: Genes; dna: DesignDna; refCount: number; uploadCount?: number }): string {
  const idea = i.idea.trim();
  return [
    idea ? ownerIdeaHead(idea, "the default scene / pose / composition / palette directions below AND any attribute of the NEW GARMENT DESIGN below that it explicitly names (fabric, colour, pattern, length, sleeves, neckline, details…); keep the design's other attributes") : "",
    "Facebook feed advertising photo for a Vietnamese fashion shop, presenting one of its NEW garment designs.",
    i.refCount > 1
      ? `The ${i.refCount} attached photos are REAL best-selling products of the shop — the new design is inspired by them but is a different garment.`
      : "The attached photo is a REAL best-selling product of the shop — the new design is inspired by it but is a different garment.",
    uploadsLine(i.uploadCount ?? 0),
    idea ? "Defaults (apply only where the owner's direction above says nothing):" : "",
    designPromptEn(i.dna),
    ...geneDirectives(i.genes, null, ""),
    NEW_DESIGN_CLAUSE,
    idea ? `Reminder — the owner's direction has priority over the defaults: ${idea}` : "",
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
      ownerIdea: "",
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

/**
 * Số ảnh của MỘT lần bấm — hàm THUẦN. Người chọn trong `MANUAL_GEN_RUN.minImagesPerRun…maxImagesPerRun`;
 * thiếu / không phải số nguyên ⇒ mặc định `MANUAL_GEN.imagesPerRun`. Kẹp chứ không báo lỗi: đây là trần của một
 * lần bấm (chặn gõ nhầm), không phải một luật người phải thuộc.
 */
export function manualGenRunCount(count: number | null | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count)) return MANUAL_GEN.imagesPerRun;
  return Math.max(MANUAL_GEN_RUN.minImagesPerRun, Math.min(MANUAL_GEN_RUN.maxImagesPerRun, Math.round(count)));
}

/**
 * Lưu ảnh người tải lên — TRƯỚC khi ghi lượt, để ảnh hỏng dừng mọi thứ và không để lại một lượt nửa vời. Trả
 * id `creative_images` (trùng nội dung ⇒ `storeCreativeImage` trả đúng dòng cũ).
 */
async function storeUploads(db: Db, uploads: readonly Uint8Array[]): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  if (uploads.length > MANUAL_GEN_RUN.maxUploads) return { ok: false, error: `Tải lên tối đa ${MANUAL_GEN_RUN.maxUploads} ảnh đầu vào mỗi lượt.` };
  const ids: string[] = [];
  for (const [i, bytes] of uploads.entries()) {
    try {
      ids.push((await storeCreativeImage(db, bytes)).id);
    } catch (e) {
      return { ok: false, error: `Ảnh tải lên #${i + 1}: ${e instanceof Error && e.message ? e.message : "không lưu được."}` };
    }
  }
  return { ok: true, ids: [...new Set(ids)] };
}

// ───────────────────────────── BẤM "GEN ẢNH" ─────────────────────────────

export type StartManualGenInput = {
  productPhotoSourceId: string;
  ownAdSourceId: string | null;
  idea: string;
  /** Số ảnh người chọn. Bỏ trống ⇒ `MANUAL_GEN.imagesPerRun`. */
  count?: number;
  /** Điểm ảnh người tải lên ngay trong khối gen tay — gửi máy vẽ KÈM ảnh sản phẩm thật. */
  uploads?: Uint8Array[];
};

export type StartManualGenResult = { ok: true; genId: string; requested: number; allowed: number; reason: string | null } | { ok: false; error: string };

/**
 * Ghi MỘT lượt gen + đúng số ảnh người chọn. Không gọi OpenAI. Trả `{ ok: false }` cho lỗi nghiệp vụ (nguồn
 * không an toàn điểm ảnh, ảnh tải lên hỏng) — không ném. Không còn trần ảnh / ngày (chủ shop 26/09/2026).
 */
export async function startManualGen(db: Db, input: StartManualGenInput, cfg: CreativeLoopConfig, actor: ManualActor): Promise<StartManualGenResult> {
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
  const up = await storeUploads(db, input.uploads ?? []);
  if (!up.ok) return up;

  const want = manualGenRunCount(input.count);
  const idea = input.idea.trim().slice(0, MANUAL_GEN.ideaMaxChars);
  const genId = await db.transaction(async (tx) => {
    const [g] = await tx
      .insert(schema.creativeManualGens)
      .values({
        kind: "MOCKUP",
        productId: photo.productId,
        productPhotoSourceId: photo.id,
        ownAdSourceId: ownAdId,
        uploadImageIds: up.ids,
        idea,
        requested: want,
        model: cfg.imageModel,
        size: cfg.imageSize,
        quality: cfg.imageQuality,
        note: "",
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
        prompt: manualGenPrompt({ idea, genes: gg, productName: product.name, hasOwnAd: ownAdId !== null, uploadCount: up.ids.length }),
        status: "PLANNED",
      })),
    );
    return g.id;
  });
  return { ok: true, genId, requested: want, allowed: want, reason: null };
}

// ───────────────────────────── BẤM "GEN THIẾT KẾ MỚI" ─────────────────────────────

export type StartManualDesignInput = { inspirationProductIds: string[]; idea: string; count?: number; uploads?: Uint8Array[] };

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
 * Ghi MỘT lượt `DESIGN` + tới số ảnh người chọn, mỗi dòng một THIẾT KẾ MỚI đã lập sẵn (DNA, mã cha, ảnh tham
 * chiếu). Không gọi OpenAI. Mã cảm hứng phải CÒN đủ điều kiện mã cha (bán tốt + có DNA) lúc bấm — danh sách trên
 * màn hình có thể đã cũ. Lập được ít thiết kế đủ mới lạ hơn số người chọn ⇒ ghi bấy nhiêu và NÓI RA vì sao
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

  const want = manualGenRunCount(input.count);
  const genId = crypto.randomUUID();
  // Hạt giống = id lượt. Kiểm thử truyền hạt giống cố định để chứng minh lượt sau không lặp lượt trước vì LUẬT,
  // không vì hai id ngẫu nhiên tình cờ khác nhau.
  const seed = deps.seed ?? genId;
  const plan = planManualDesigns({ seed, day, count: want, parents: chosen, existingDna: inputs.existingDna, recentDesigns: [...inputs.recentDesigns, ...(await recentManualDesignDna(db, now))], stats: inputs.stats });
  if (plan.specs.length === 0) return { ok: false, error: `Không lập được thiết kế nào đủ mới lạ. ${plan.reasons.join(" ")}`.trim() };
  const note = plan.specs.length < want ? `Chỉ lập được ${plan.specs.length}/${want} thiết kế đủ khác mọi mẫu đang có. ${plan.reasons.join(" ")}`.trim() : "";
  const up = await storeUploads(db, input.uploads ?? []);
  if (!up.ok) return up;

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
      uploadImageIds: up.ids,
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
      plan.specs.map((spec0, i) => {
        const spec: ManualDesignSpec = { ...spec0, ownerIdea: idea };
        return {
          genId,
          seq: i + 1,
          genes: genes[i] as Record<string, string>,
          prompt: manualDesignPrompt({ idea, genes: genes[i], dna: spec.dna, refCount: spec.photoSourceIds.length, uploadCount: up.ids.length }),
          design: spec as unknown as Record<string, unknown>,
          status: "PLANNED",
        };
      }),
    );
  });
  return { ok: true, genId, requested: want, allowed: plan.specs.length, reason: note || null };
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
};

export type DrawManualGenSummary = { drawn: number; failed: number; stale: number };

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
 * Ảnh NGƯỜI TẢI LÊN của lượt — gửi máy vẽ dưới nhãn `OWN_VARIANT` (ảnh CỦA SHOP): người có quyền biên tập đã
 * CHỦ Ý chọn và tải nó lên ngay trong lượt này, id chỉ do đường ghi của nút bấm điền (không nhận từ trình duyệt).
 * Ảnh đã mất thì bỏ qua — mất một tham chiếu, không mất lượt vẽ.
 */
async function uploadPixels(db: Db, run: GenRow): Promise<ImageEditInputImage[]> {
  const out: ImageEditInputImage[] = [];
  for (const id of run.uploadImageIds ?? []) {
    const px = await readCreativeImage(db, id);
    if (px) out.push({ kind: "OWN_VARIANT", bytes: new Uint8Array(px.bytes), contentType: px.contentType });
  }
  return out;
}

/**
 * Điểm ảnh gửi máy vẽ cho MỘT ảnh — nguồn của shop đi qua `gatherPixels` (đường điểm ảnh DUY NHẤT, kiểm lại loại
 * nguồn lúc đọc). Thiết kế: ảnh sản phẩm thật của cha trội (bắt buộc) + của mẹ (mất thì vẫn vẽ từ ảnh cha
 * trội — mất một tham chiếu cảm hứng, không mất thiết kế). Cả hai kiểu: cộng ảnh người tải lên ở CUỐI — ảnh sản
 * phẩm thật luôn đứng đầu (ranh giới 3).
 */
async function pixelsFor(db: Db, run: GenRow, img: ImageRow): Promise<ImageEditInputImage[]> {
  if (run.kind !== "DESIGN") {
    const base = await gatherPixels(db, { productPhotoSourceId: run.productPhotoSourceId, parentVariantId: null, ownAdSourceId: run.ownAdSourceId });
    return [...base, ...(await uploadPixels(db, run))];
  }
  const spec = parseManualDesignSpec(img.design);
  if (!spec) throw new Error("Ảnh thiết kế mất bản mô tả thiết kế (DNA / ảnh tham chiếu) — không vẽ.");
  const [dominant, ...rest] = spec.photoSourceIds;
  const out = await gatherPixels(db, { productPhotoSourceId: dominant, parentVariantId: null, ownAdSourceId: null });
  for (const id of rest) {
    const more = await gatherPixels(db, { productPhotoSourceId: id, parentVariantId: null, ownAdSourceId: null }).catch(() => []);
    out.push(...more);
  }
  out.push(...(await uploadPixels(db, run)));
  return out;
}

/**
 * Vẽ các ảnh `PLANNED` — tuần tự, cũ trước. Không còn trần ảnh / ngày (chủ shop 26/09/2026): mỗi ảnh là một
 * lượt người đã bấm và đã thấy tiền ước tính. Lỗi của một ảnh không chặn ảnh khác.
 */
export async function drawManualGen(db: Db, deps: DrawManualGenDeps = {}): Promise<DrawManualGenSummary> {
  const clock = () => deps.now ?? new Date();
  const imageClient = deps.imageClient ?? editImage;
  const limit = Math.max(1, Math.min(deps.limit ?? MANUAL_GEN_RUN.maxImagesPerRun, MANUAL_GEN_RUN.maxImagesPerRun));
  const out: DrawManualGenSummary = { drawn: 0, failed: 0, stale: await failStaleDraws(db, clock()) };
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
    // Loại ⇒ rời hàng đợi đăng camp (bản nháp câu chữ vẫn giữ — duyệt lại thì soạn tiếp được, nhưng phải bấm Lưu lại).
    .set({ status: target, reviewedByUserId: actor.id, reviewedByName: actor.name, reviewedAt: now, rejectReason: input.decision === "REJECT" ? input.reason : "", ...(input.decision === "REJECT" ? { queuedAt: null } : {}), updatedAt: now })
    .where(and(eq(g.id, input.imageId), inArray(g.status, from)))
    .returning({ id: g.id });
  if (rows.length === 0) return { ok: false, error: "Ảnh vừa đổi trạng thái — tải lại để xem." };
  if (target === "REJECTED") return { ok: true, status: target, caption: null };
  // Ảnh đã có câu chữ (duyệt lại sau khi loại) thì không viết lại — người bấm "AI viết lại" nếu muốn.
  const caption = r.img.headline || r.img.primaryText ? null : await captionManualGenImage(db, input.imageId, now, deps);
  return { ok: true, status: target, caption };
}

// ───────────────────────────── HÀNG ĐỢI ĐĂNG CAMP ─────────────────────────────

export type DraftInput = { imageId: string; headline: string; primaryText: string; names: { campaign: string; adset: string; ad: string }; setup?: CampaignSetup | null };

export type DraftResult = { ok: true; queuedAt: Date } | { ok: false; error: string };

/**
 * "LƯU" (chủ shop 26/09/2026: "duyệt ảnh mẫu → sửa content và lưu vào hàng đợi đăng camp, có thể ấn lưu sau đó ấn
 * đăng camp luôn"): ghi câu chữ + ba tên vào CHÍNH dòng ảnh đã duyệt và đặt dấu "đang ở hàng đợi" — không dựng lô,
 * không gọi Facebook, không tốn đồng nào. Bấm lại ⇒ ghi đè bản nháp (mốc lưu = lần bấm cuối). Ba tên rỗng = tên
 * mặc định theo khuôn lúc đăng. Điều kiện "ảnh còn ĐÃ DUYỆT" nằm TRONG câu UPDATE: ảnh vừa được đăng / loại thì
 * không ghi gì.
 */
export async function saveManualGenDraft(db: Db, input: DraftInput, actor: ManualActor, now: Date): Promise<DraftResult> {
  const g = schema.creativeManualGenImages;
  const rows = await db
    .update(g)
    .set({
      headline: input.headline,
      primaryText: input.primaryText,
      campaignName: input.names.campaign.trim(),
      adsetName: input.names.adset.trim(),
      adName: input.names.ad.trim(),
      queuedAt: now,
      queuedByUserId: actor.id,
      queuedByName: actor.name,
      ...(input.setup !== undefined ? { campaignSetup: input.setup as unknown as Record<string, unknown> | null } : {}),
      updatedAt: now,
    })
    .where(and(eq(g.id, input.imageId), eq(g.status, "APPROVED")))
    .returning({ id: g.id });
  if (rows.length > 0) return { ok: true, queuedAt: now };
  const [cur] = await db.select({ status: g.status }).from(g).where(eq(g.id, input.imageId)).limit(1);
  if (!cur) return { ok: false, error: "Không tìm thấy ảnh." };
  return { ok: false, error: cur.status === "PROMOTED" ? "Ảnh đã được đăng / đưa vào lô — không còn ở hàng đợi." : "Chỉ lưu được bài của ảnh ĐÃ DUYỆT." };
}

/** Bỏ một bài khỏi hàng đợi — bản nháp câu chữ vẫn nằm trên ảnh, bấm Lưu lại là quay về hàng đợi. */
export async function unqueueManualGenDraft(db: Db, imageId: string, now: Date): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = schema.creativeManualGenImages;
  const rows = await db
    .update(g)
    .set({ queuedAt: null, updatedAt: now })
    .where(and(eq(g.id, imageId), isNotNull(g.queuedAt)))
    .returning({ id: g.id });
  return rows.length ? { ok: true } : { ok: false, error: "Bài không còn ở hàng đợi — tải lại để xem." };
}

// ───────────────────────────── MẪU TỰ LÀM ⇒ HÀNG ĐỢI ─────────────────────────────

export type UploadDraftInput = { productId: string; genes: Genes; headline: string; primaryText: string; note: string; imageBytes: Uint8Array };

/**
 * "MẪU TỰ LÀM" (ảnh người vẽ trên ChatGPT / Grok hay chụp tay) — chủ shop 26/09/2026 bỏ hẳn lô hằng ngày, nên mẫu tự làm
 * không vào lô nữa mà vào THẲNG hàng đợi đăng camp: một lượt `UPLOAD` một ảnh, ảnh ở trạng thái ĐÃ DUYỆT (người tải lên
 * chính là người đã chọn nó) kèm câu chữ + dấu hàng đợi. Từ đó đi đúng đường Soạn bài → Đăng camp như ảnh gen tay. Ảnh
 * hỏng ⇒ dừng trước khi ghi dòng nào. Trả `{ ok: false }` cho lỗi nghiệp vụ — không ném.
 */
export async function addUploadedDraft(db: Db, input: UploadDraftInput, actor: ManualActor, now: Date): Promise<{ ok: true; genId: string; imageId: string } | { ok: false; error: string }> {
  const product = await loadProductBrief(db, input.productId);
  if (!product) return { ok: false, error: "Không tìm thấy mã hàng đã chọn — tải lại trang rồi chọn lại." };
  let stored: Awaited<ReturnType<typeof storeCreativeImage>>;
  try {
    stored = await storeCreativeImage(db, input.imageBytes);
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? e.message : "Không lưu được ảnh." };
  }
  const genId = crypto.randomUUID();
  const imageRowId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(schema.creativeManualGens).values({ id: genId, kind: "UPLOAD", productId: input.productId, idea: input.note.slice(0, MANUAL_GEN.ideaMaxChars), requested: 1, model: "MANUAL", size: "", quality: "", note: "", createdByUserId: actor.id, createdByName: actor.name });
    await tx.insert(schema.creativeManualGenImages).values({
      id: imageRowId,
      genId,
      seq: 1,
      genes: input.genes as Record<string, string>,
      prompt: "",
      imageId: stored.id,
      status: "APPROVED",
      drawnAt: now,
      headline: input.headline,
      primaryText: input.primaryText,
      reviewedByUserId: actor.id,
      reviewedByName: actor.name,
      reviewedAt: now,
      queuedAt: now,
      queuedByUserId: actor.id,
      queuedByName: actor.name,
    });
  });
  return { ok: true, genId, imageId: imageRowId };
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

type PromoteOk = {
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
};

export type PromoteResult = PromoteOk | { ok: false; error: string };

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

type LoadedImage = NonNullable<Awaited<ReturnType<typeof loadImage>>>;
type ReadyImage = { r: LoadedImage; genes: Genes; spec: ManualDesignSpec | null; imageId: string; priceVnd: number | null };

/** Ảnh đã duyệt có đủ thứ để thành MỘT bài chưa — kiểm chung của "Đưa vào lô" và "Đăng camp". */
async function readyImage(db: Db, imageId: string): Promise<ReadyImage | { ok: false; error: string }> {
  const r = await loadImage(db, imageId);
  if (!r) return { ok: false, error: "Không tìm thấy ảnh." };
  if (r.img.status === "PROMOTED") return { ok: false, error: "Ảnh đã được đưa vào lô / đã đăng." };
  if (r.img.status !== "APPROVED") return { ok: false, error: "Chỉ dùng được ảnh ĐÃ DUYỆT." };
  if (!r.img.imageId) return { ok: false, error: "Ảnh chưa có điểm ảnh." };
  const genes = parseGenes(r.img.genes);
  if (!genes) return { ok: false, error: "Bộ gen của ảnh hỏng — máy không học được từ bài này." };
  const spec = r.run.kind === "DESIGN" ? parseManualDesignSpec(r.img.design) : null;
  if (r.run.kind === "DESIGN" && !spec) return { ok: false, error: "Ảnh thiết kế mất bản mô tả thiết kế (DNA) — không lập được mã TK cho bài này." };
  if (!spec && !r.run.productId) return { ok: false, error: "Lượt gen không còn gắn mã hàng." };
  const priceVnd = spec ? spec.priceVnd : ((await loadProductBrief(db, r.run.productId as string))?.priceVnd ?? null);
  return { r, genes, spec, imageId: r.img.imageId, priceVnd };
}

/**
 * Chèn MỘT mẫu từ ảnh đã duyệt + đánh dấu ảnh `PROMOTED` — chạy TRONG giao dịch của nơi gọi. `target` rỗng ⇒ lô
 * hằng ngày gần nhất còn hạn duyệt (đường "Đưa vào lô"); có ⇒ đúng lô ấy (lô `INSTANT` của "Đăng camp"). Lô
 * `INSTANT` lấy số thứ tự theo NGÀY (`nextNameSeqOnDay`) để tên không trùng tên của lô hằng ngày cùng ngày.
 * Ném `PROMOTE_RACE` khi ảnh vừa đổi trạng thái — nơi gọi dịch ra câu cho người.
 */
async function insertImageVariant(tx: Tx, x: ReadyImage, input: PromoteInput, cfg: CreativeLoopConfig, actor: ManualActor, now: Date, target?: typeof schema.creativeBatches.$inferSelect): Promise<PromoteResult> {
  const { r, genes, spec, imageId, priceVnd } = x;
  const db = tx as unknown as Db;
  const dc = schema.designConcepts;
  const who = r.run.createdByName || actor.name;
  const ideaNote = r.run.idea ? `: ${r.run.idea.slice(0, 200)}` : "";
  let finalNames = { campaign: "", adset: "", ad: "" };
  let finalSeq = 0;
  let code: string | null = null;
  const ins = await insertManualVariant(
    db,
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
            // Ý tưởng người có thể đã đè thuộc tính thiết kế nó nói ra (`manualDesignPrompt`) — ghi vào lý do để
            // người đọc mã TK biết nhãn DNA có thể lệch ở đúng thuộc tính ấy.
            const override = spec.ownerIdea ? ` Ý tưởng người đè lên DNA: "${spec.ownerIdea.slice(0, 200)}".` : "";
            const [c] = await tx
              .insert(dc)
              .values({ code, batchId: batch.id, dna: spec.dna as Record<string, string>, dnaVersion: spec.dnaVersion, parentProductIds: spec.parentProductIds, why: `Gen tay — ${who}: ${spec.why}${override}`, imageId, priceVnd: spec.priceVnd, status: "DRAFT" })
              .returning({ id: dc.id });
            return { designConceptId: c.id, why: `Thiết kế mới ${code} (gen tay — ${who}${ideaNote}): ${spec.why}` };
          }
        : undefined,
      names: async (batch) => {
        const seq = batch.kind === "INSTANT" ? await nextNameSeqOnDay(db, batch.batchDay) : await nextNameSeq(db, batch.id);
        const ctx = await loadNamingContext(db, normalizeCreativeConfig(batch.configSnapshot).config);
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
    target,
  );
  if (!ins.ok) return ins;
  const upd = await tx
    .update(schema.creativeManualGenImages)
    .set({ status: "PROMOTED", variantId: ins.variantId, headline: input.headline, primaryText: input.primaryText, campaignName: finalNames.campaign, adsetName: finalNames.adset, adName: finalNames.ad, updatedAt: now })
    .where(and(eq(schema.creativeManualGenImages.id, input.imageId), eq(schema.creativeManualGenImages.status, "APPROVED")))
    .returning({ id: schema.creativeManualGenImages.id });
  if (upd.length === 0) throw new Error("PROMOTE_RACE");
  return { ok: true, variantId: ins.variantId, batchId: ins.batchId, batchDay: ins.batchDay, slot: ins.slot, nameSeq: finalSeq, names: finalNames, designCode: code, priceVnd };
}

/** Lỗi ghi đã biết ⇒ câu cho người; lỗi lạ ⇒ `null` (nơi gọi ném tiếp). */
function promoteErrorText(msg: string): string | null {
  if (msg === "PROMOTE_RACE") return "Ảnh vừa được đưa vào lô / đăng hoặc đổi trạng thái — tải lại để xem.";
  if (/name_seq/.test(msg)) return "Vừa có bài khác lấy đúng số thứ tự trong ngày — bấm lại để lấy số mới.";
  if (/design_concepts_code/.test(msg)) return "Vừa có thiết kế khác lấy đúng mã TK — bấm lại để lấy mã mới.";
  return null;
}

/**
 * Đưa ảnh đã duyệt vào lô chờ duyệt đăng — một mẫu `MANUAL` (cùng đường, cùng trần của mẫu tự làm),
 * kèm câu chữ + ba tên. Chèn mẫu và đánh dấu ảnh `PROMOTED` trong CÙNG giao dịch: hai người bấm cùng lúc
 * thì một người nhận lỗi, không có hai mẫu cho một ảnh.
 */
export async function promoteManualGenImage(db: Db, input: PromoteInput, cfg: CreativeLoopConfig, actor: ManualActor, now: Date): Promise<PromoteResult> {
  const x = await readyImage(db, input.imageId);
  if ("ok" in x) return x;
  try {
    return await db.transaction((tx: Tx) => insertImageVariant(tx, x, input, cfg, actor, now));
  } catch (e) {
    const known = promoteErrorText(errText(e));
    if (known) return { ok: false, error: known };
    throw e;
  }
}

// ───────────────────────────── ĐĂNG CAMP (NGAY / HẸN GIỜ) ─────────────────────────────

export type InstantWindow = { ok: true; startAt: Date; endAt: Date; batchDay: string; scheduled: boolean } | { ok: false; error: string };

/**
 * Khung chạy của MỘT bài "Đăng camp" — hàm THUẦN. Không hẹn ⇒ chạy sau lúc bấm `leadSeconds` giây; hẹn ⇒ đúng
 * giờ hẹn (sau lúc bấm ít nhất `minScheduleLeadMinutes` phút, không quá `maxScheduleDays` ngày). Dài `testDays`
 * ngày (kẹp theo trần cứng) — `end_time` của nhóm, Facebook tự dừng. Ngày chạy (`batchDay`) theo giờ VN của mốc
 * bắt đầu: trần cam kết / ngày đếm vào đúng ngày camp chạy.
 */
export function instantWindow(now: Date, scheduleAt: Date | null, cfg: Pick<CreativeLoopConfig, "testDays">): InstantWindow {
  const days = Math.max(1, Math.min(cfg.testDays, CREATIVE_HARD_LIMITS.maxTestDays));
  let startAt: Date;
  if (scheduleAt === null) {
    startAt = new Date(now.getTime() + INSTANT_PUBLISH.leadSeconds * 1000);
  } else {
    if (!Number.isFinite(scheduleAt.getTime())) return { ok: false, error: "Giờ hẹn không hợp lệ." };
    if (scheduleAt.getTime() < now.getTime() + INSTANT_PUBLISH.minScheduleLeadMinutes * 60_000) return { ok: false, error: `Giờ hẹn phải sau lúc này ít nhất ${INSTANT_PUBLISH.minScheduleLeadMinutes} phút — muốn chạy luôn thì chọn "Chạy ngay".` };
    if (scheduleAt.getTime() > now.getTime() + INSTANT_PUBLISH.maxScheduleDays * 86_400_000) return { ok: false, error: `Chỉ hẹn giờ trong vòng ${INSTANT_PUBLISH.maxScheduleDays} ngày tới.` };
    startAt = scheduleAt;
  }
  return { ok: true, startAt, endAt: new Date(startAt.getTime() + days * 86_400_000), batchDay: vnDay(startAt), scheduled: scheduleAt !== null };
}

export type InstantPublishDeps = CreativeDeps & { killSwitch?: () => Promise<AdsKillSwitchState> };

/**
 * Mọi lý do cổng ghi SẼ chặn nếu đăng một bài lẻ vào ngày chạy `batchDay` lúc này — CHỈ ĐỌC, không gọi Facebook.
 * Cùng các chốt của hộp duyệt lô (`proposeBatchApproval`): đường ghi / nấc quyền hạn / cấu hình đủ · ngân sách một
 * mẫu · trần cam kết / ngày (lô hằng ngày và bài lẻ CHUNG một trần — đếm trên sổ) · công tắc khẩn. Rỗng ⇒ không
 * thấy lý do chặn nào. Màn hình gọi hàm này để khoá nút TRƯỚC khi người soạn bài; đường ghi gọi lại lúc bấm.
 */
export async function instantPublishBlockers(db: Db, cfg: CreativeLoopConfig, batchDay: string, deps: InstantPublishDeps = {}): Promise<string[]> {
  const env: CreativeWriteEnv = deps.env ?? { hardEnabled: adsWriteHardEnabled(), mode: adsWriteMode() };
  const bc = batchConfig(cfg as unknown as Record<string, unknown>);
  const out: string[] = [];
  const pre = gateCreativeWritePrefix({ hardEnabled: env.hardEnabled, mode: env.mode, action: "CREATE_ADSET", configComplete: bc.configComplete, approved: true, approvalMatches: true });
  if (!pre.ok) out.push(pre.reason);
  if (bc.budgetPerVariantVnd <= 0) out.push("Chưa khai ngân sách một mẫu ở Cấu hình & luật.");
  if (bc.budgetPerVariantVnd > CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd) out.push(CREATIVE_WRITE_DENIAL_REASON.OVER_VARIANT_BUDGET);
  const committed = await committedTestSpendForDay(db, batchDay);
  if (committed + bc.budgetPerVariantVnd > CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd) {
    out.push(`${CREATIVE_WRITE_DENIAL_REASON.OVER_DAILY_CAP} (Sổ đã ghi ${committed.toLocaleString("vi-VN")}đ cho ngày ${batchDay}.)`);
  }
  const kill = await (deps.killSwitch ?? readAdsKillSwitch)();
  if (kill.killed) out.push(`${CREATIVE_WRITE_DENIAL_REASON.KILL_SWITCH} ${kill.reason ?? ""}`.trim());
  return out;
}

/** Lỗi nghiệp vụ giữa giao dịch "Đăng camp" — ném để HUỶ giao dịch (không để lại lô rỗng), bắt lại thành câu cho người. */
class InstantAbort extends Error {}

export type InstantPublishInput = PromoteInput & { scheduleAt: Date | null; setup?: CampaignSetup | null };

/**
 * Setup camp người chọn ⇒ cấu hình hiệu lực của MỘT bài lẻ: TKQC · fanpage · ngân sách thay cho cấu hình chung (lô
 * `INSTANT` chụp đúng cấu hình này, nên digest, trần cam kết, tên theo khuôn đều theo nó). Ngân sách kẹp trong trần cứng
 * (chủ shop 26/09/2026: GIỮ trần cũ). Sai hình dạng ⇒ câu lỗi. Hàm THUẦN.
 */
export function instantConfig(cfg: CreativeLoopConfig, setup: CampaignSetup | null | undefined): { ok: true; cfg: CreativeLoopConfig } | { ok: false; error: string } {
  if (!setup) return { ok: true, cfg };
  const acc = setup.adAccountId.replace(/^act_/, "");
  if (!/^[0-9]+$/.test(acc)) return { ok: false, error: "Tài khoản quảng cáo đã chọn không hợp lệ." };
  if (!/^[0-9]+$/.test(setup.pageId)) return { ok: false, error: "Fanpage đã chọn không hợp lệ." };
  if (setup.budgetVnd < CAMPAIGN_SETUP_LIMITS.minBudgetVnd || setup.budgetVnd > CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd) {
    return { ok: false, error: `Ngân sách phải trong ${CAMPAIGN_SETUP_LIMITS.minBudgetVnd.toLocaleString("vi-VN")}đ – ${CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd.toLocaleString("vi-VN")}đ (trần một camp).` };
  }
  const tuoi = [setup.ageMin, setup.ageMax].filter((x): x is number => x !== null);
  if (tuoi.some((a) => a < CAMPAIGN_SETUP_LIMITS.minAge || a > CAMPAIGN_SETUP_LIMITS.maxAge)) return { ok: false, error: `Tuổi phải trong ${CAMPAIGN_SETUP_LIMITS.minAge}–${CAMPAIGN_SETUP_LIMITS.maxAge}.` };
  if (setup.ageMin !== null && setup.ageMax !== null && setup.ageMin > setup.ageMax) return { ok: false, error: "Tuổi từ phải nhỏ hơn tuổi đến." };
  if (setup.geo && setup.geo.length > CAMPAIGN_SETUP_LIMITS.maxGeo) return { ok: false, error: `Chọn tối đa ${CAMPAIGN_SETUP_LIMITS.maxGeo} vị trí.` };
  return { ok: true, cfg: { ...cfg, adAccountId: acc, pageId: setup.pageId, budgetPerVariantVnd: setup.budgetVnd } };
}

/** `LIVE` = đã bật, chạy ngay · `SCHEDULED` = đã lên Facebook, chờ giờ hẹn · `PENDING` = đăng dở, lượt vòng mẫu đi tiếp tới giờ chạy · `FAILED`. */
export type InstantOutcome = "LIVE" | "SCHEDULED" | "PENDING" | "FAILED";

export type InstantPublishResult = (PromoteOk & { startAt: Date; endAt: Date; scheduled: boolean; outcome: InstantOutcome; detail: string; report: PublishBatchReport | null }) | { ok: false; error: string };

/**
 * "ĐĂNG CAMP" — ảnh đã duyệt ⇒ MỘT lô `INSTANT` chỉ chứa bài ấy ⇒ duyệt (người bấm) ⇒ đăng lên Facebook NGAY.
 *
 *  1. Kiểm ảnh + khung giờ + MỌI chốt của cổng (`instantPublishBlockers`) TRƯỚC khi ghi một dòng nào: bị chặn thì
 *     không để lại lô rỗng, ảnh vẫn "Đã duyệt".
 *  2. MỘT giao dịch: dựng lô (`PENDING_APPROVAL`) → chèn mẫu qua ĐÚNG đường của "Đưa vào lô" → tính digest từ CSDL →
 *     lô `APPROVED` với dấu duyệt của người bấm (ràng buộc `creative_batches_approval_check` giữ ở CSDL).
 *  3. `publishBatchNow` — ĐÚNG `publishOneBatch` của lượt tick: tính lại digest, công tắc khẩn, cổng từng bước, sổ
 *     ghi, dấu "đang gửi". Hẹn giờ vẫn đăng ngay với `start_time` = giờ hẹn (Facebook giữ lịch).
 *  4. Hỏng mà CHƯA gửi được gì lên Facebook (không có id nào, không có dấu "đang gửi") ⇒ trả ảnh về "Đã duyệt"
 *     (bấm lại được), lô `FAILED` có lý do, mẫu gạt khỏi lô. Đã gửi được một phần ⇒ giữ nguyên để lượt vòng mẫu đi
 *     tiếp / người tìm tay — đúng tính chất 4 của `publish.ts`, không tự thử lại một lời gọi tạo.
 */
export async function publishManualGenImageInstant(db: Db, input: InstantPublishInput, baseCfg: CreativeLoopConfig, actor: ManualActor, now: Date, deps: InstantPublishDeps = {}): Promise<InstantPublishResult> {
  const x = await readyImage(db, input.imageId);
  if ("ok" in x) return x;
  const eff = instantConfig(baseCfg, input.setup);
  if (!eff.ok) return eff;
  const cfg = eff.cfg;
  const setup = input.setup ?? null;
  const w = instantWindow(now, input.scheduleAt, cfg);
  if (!w.ok) return w;
  const blockers = await instantPublishBlockers(db, cfg, w.batchDay, deps);
  if (blockers.length) return { ok: false, error: `Chưa đăng được: ${blockers.join(" ")}` };
  // Quảng cáo mẫu kiểm TRƯỚC khi ghi dòng nào (một lượt ĐỌC Facebook): mẫu không dùng được thì không dựng lô, không
  // cấp mã TK, ảnh vẫn "Đã duyệt". 26/09/2026 lần bấm đầu tiên của chủ shop cấp mã TK-260926-103 rồi mới vấp ở đây.
  const writer = deps.writer ?? REAL_CREATIVE_WRITER;
  let shape: string | null;
  try {
    const tpl = await writer.readTemplateAd(cfg.templateAdId);
    shape = templateShapeError(setup ? applyCampaignSetup(tpl, setup) : tpl, cfg.pageId, true);
  } catch (e) {
    shape = `không đọc được (${errText(e)})`;
  }
  if (shape) return { ok: false, error: `Chưa đăng được — quảng cáo mẫu ${cfg.templateAdId || "(chưa khai)"} ở tab Cấu hình & luật: ${shape} Chưa có gì lên Facebook, ảnh vẫn ở "Đã duyệt".` };

  const B = schema.creativeBatches;
  let made: PromoteOk & { batchId: string };
  try {
    const res = await db.transaction(async (tx: Tx) => {
      const [batch] = await tx
        .insert(B)
        .values({
          kind: "INSTANT",
          batchDay: w.batchDay,
          status: "PENDING_APPROVAL",
          slotCount: 1,
          startAt: w.startAt,
          endAt: w.endAt,
          approvalDeadline: w.startAt,
          // Setup camp nằm trong lô: lượt đăng (và lượt tick đi tiếp nếu đăng dở) áp ĐÚNG setup người đã bấm.
          plan: { instant: true, scheduled: w.scheduled, manualGenImageId: input.imageId, ...(setup ? { setup } : {}) },
          configSnapshot: cfg as unknown as Record<string, unknown>,
          ruleVersion: CREATIVE_RULE_VERSION,
        })
        .returning();
      const ins = await insertImageVariant(tx, x, input, cfg, actor, now, batch);
      if (!ins.ok) throw new InstantAbort(ins.error);
      const digest = approvalDigest(await batchApprovalContent(tx as unknown as Db, batch));
      await tx.update(B).set({ status: "APPROVED", approvalDigest: digest, approvedAt: now, approvedByUserId: actor.id, approvedByName: actor.name, updatedAt: now }).where(eq(B.id, batch.id));
      return ins;
    });
    made = res;
  } catch (e) {
    if (e instanceof InstantAbort) return { ok: false, error: e.message };
    const known = promoteErrorText(errText(e));
    if (known) return { ok: false, error: known };
    throw e;
  }

  let report: PublishBatchReport | null = null;
  let publishError = "";
  try {
    report = await publishBatchNow(db, made.batchId, now, deps);
  } catch (e) {
    publishError = errText(e);
  }

  const V = schema.creativeVariants;
  const [v] = await db.select().from(V).where(eq(V.id, made.variantId)).limit(1);
  const base = { ...made, startAt: w.startAt, endAt: w.endAt, scheduled: w.scheduled, report };
  if (v?.status === "LIVE") {
    return { ...base, outcome: w.scheduled ? "SCHEDULED" : "LIVE", detail: w.scheduled ? "Camp đã lên Facebook, tự chạy đúng giờ hẹn." : "Camp đã lên Facebook và đang chạy." };
  }
  const why = publishError || report?.detail || "Không rõ lý do — xem sổ ghi Facebook của lô.";
  const sentNothing = !!v && !v.fbImageHash && !v.fbCampaignId && !v.fbAdsetId && !v.fbPendingStep;
  if (sentNothing) {
    // Chưa có gì trên Facebook ⇒ trả ảnh về cho người bấm lại. Điều kiện nằm TRONG câu UPDATE: lượt vòng mẫu vừa
    // chạm vào mẫu (đã tải ảnh / đang gửi) thì không gạt gì cả.
    const unwound = await db.transaction(async (tx) => {
      const rows = await tx
        .update(V)
        .set({ status: "REJECTED", genError: `Đăng camp chưa được: ${why}`.slice(0, 1000), updatedAt: new Date() })
        .where(and(eq(V.id, made.variantId), eq(V.status, "GENERATED"), eq(V.fbPendingStep, ""), eq(V.fbImageHash, ""), isNull(V.fbCampaignId), isNull(V.fbAdsetId)))
        .returning({ id: V.id });
      if (rows.length === 0) return false;
      await tx.update(B).set({ status: "FAILED", error: `Đăng camp chưa được: ${why}`.slice(0, 2000), updatedAt: new Date() }).where(eq(B.id, made.batchId));
      await tx
        .update(schema.creativeManualGenImages)
        .set({ status: "APPROVED", variantId: null, updatedAt: new Date() })
        .where(and(eq(schema.creativeManualGenImages.id, input.imageId), eq(schema.creativeManualGenImages.status, "PROMOTED")));
      return true;
    });
    if (unwound) return { ...base, outcome: "FAILED", detail: `Chưa đăng được, chưa có gì lên Facebook — ảnh vẫn ở "Đã duyệt", sửa xong bấm lại. Lý do: ${why}` };
  }
  if (v?.status === "PUBLISH_FAILED") return { ...base, outcome: "FAILED", detail: `Đăng hỏng giữa chừng: ${why} Xem sổ ghi Facebook của lô (Lịch sử lô → Đăng lẻ) — chiến dịch đã tạo vẫn TẮT, không đồng nào chảy.` };
  return { ...base, outcome: "PENDING", detail: `Chưa đăng xong: ${why} Lượt vòng mẫu (10 phút / lần) đi tiếp tới giờ chạy.` };
}
