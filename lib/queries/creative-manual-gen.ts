import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { CAMPAIGN_OBJECTIVES, parseCampaignSetup, type CampaignSetup, type MarketerOption, type ProductWinCode } from "@/lib/constants/campaign-setup";
import { productWinCodes } from "@/lib/creative/win-code";
import { schema, type Db } from "@/db";
import { memo } from "@/lib/cache";
import { BID_STRATEGY_LABEL, CREATIVE_HARD_LIMITS, INSTANT_PUBLISH, PIXEL_SAFE_SOURCE_KINDS, estimateImageUsd, normalizeCreativeConfig, usdToVndRounded, type ManualGenImageStatus, type ManualGenKind } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { manualGenSpendToday } from "@/lib/creative/generate";
import { resolveManualTargetDay } from "@/lib/creative/manual";
import { instantPublishBlockers, parseManualDesignSpec } from "@/lib/creative/manual-gen";
import { agePart, defaultNames, genderPart, geoPart, loadNamingContext, nextNameSeq, nextNameSeqOnDay, readNamingTemplate, type DefaultNames } from "@/lib/creative/naming";
import { marketerOptions, readPayrollEmployees } from "@/lib/creative/marketer-code";
import { batchWindow } from "@/lib/creative/schedule";
import { loadDesignInputs } from "@/lib/queries/creative-design";
import { env } from "@/lib/env";
import type { TokenPage } from "@/lib/integrations/facebook/ads-write";
import { readTokenPages } from "@/lib/queries/facebook-pages";
import { CONFIRMED_ORDER } from "@/lib/queries/metrics";
import type { FanpageEvidence } from "@/lib/constants/fanpage-rank";
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
  /** Mẫu VIDEO (migration 0179): video người tải lên; `imageId` lúc ấy là ảnh bìa. `null` = mẫu ảnh. */
  videoAssetId: string | null;
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
  /** Bản nháp ba tên (rỗng = tên mặc định theo khuôn lúc đăng). */
  campaignName: string;
  adsetName: string;
  adName: string;
  /** ISO — bài đang ở HÀNG ĐỢI ĐĂNG CAMP từ lúc này; `null` = không ở hàng đợi. */
  queuedAt: string | null;
  queuedByName: string;
  /** Setup camp đã lưu cùng bản nháp. `null` = chưa chọn (hộp đăng điền mặc định dùng nhiều). */
  campaignSetup: CampaignSetup | null;
  /**
   * Ảnh đã bấm đăng mà bài HỎNG / bị gạt: lô để xem sổ ghi + có trả về hàng đợi được không (chưa có chiến dịch / nhóm / mẩu
   * nào trên Facebook). `null` = không hỏng.
   */
  /** `emptyCampaignId` = chiến dịch riêng đã tạo mà chưa có nhóm (TẮT, không tiêu được tiền) — đăng lại sẽ tạo chiến dịch mới. */
  publishFailure: { batchId: string; canRequeue: boolean; emptyCampaignId: string | null } | null;
  /** Mã win của mã hàng ảnh thuộc về (camp mã win ghi mã này thay cho TEST). `null` = ảnh thiết kế mới / mã hàng không có mã đọc được. */
  winCode: ProductWinCode | null;
  /** Mã hàng ảnh thể hiện — để xếp fanpage theo đơn / mẫu tương tự của mã. `null` = ảnh thiết kế mới / lượt không gắn mã. */
  productId: string | null;
  /** Studio (migration 0174): biến thể màu + kiểu ảnh đầu ra của ảnh này. Rỗng = ảnh cũ / giữ màu. Câu lệnh đọc riêng khi mở. */
  color: string;
  outputStyle: string;
  /** Lượt sinh ra ảnh — cho "Tạo lại tương tự". */
  genId: string;
};

type VariantBrief = { status: string | null; batchId: string | null; fbCampaignId: string | null; fbAdsetId: string | null; fbAdId: string | null; fbPendingStep: string | null };

type ImageRow = typeof schema.creativeManualGenImages.$inferSelect;

/** Một dòng ảnh ⇒ thẻ màn hình. Dùng chung cho "Kết quả gen tay" và "Hàng đợi đăng camp" — một cách dựng, không hai. */
function toImageCard(i: ImageRow, imageRowId: string | null, purgedAt: Date | null, rate: number, vb: VariantBrief | null = null, winCode: ProductWinCode | null = null, productId: string | null = null): ManualGenImageCard {
  const d = parseManualDesignSpec(i.design);
  return {
    id: i.id,
    seq: i.seq,
    status: i.status as ManualGenImageStatus,
    genes: { ...(i.genes ?? {}) },
    imageId: i.imageId,
    imageAvailable: i.imageId !== null && imageRowId !== null && purgedAt === null,
    videoAssetId: i.videoAssetId,
    costUsd: i.costUsd,
    costVnd: usdToVndRounded(i.costUsd === "" ? null : Number(i.costUsd), rate),
    error: i.error,
    headline: i.headline,
    primaryText: i.primaryText,
    captionError: i.captionError,
    reviewedByName: i.reviewedByName,
    variantId: i.variantId,
    design: d ? { dna: { ...d.dna }, parentLabels: d.parentLabels, why: d.why, priceVnd: d.priceVnd } : null,
    campaignName: i.campaignName,
    adsetName: i.adsetName,
    adName: i.adName,
    queuedAt: i.status === "APPROVED" && i.queuedAt ? i.queuedAt.toISOString() : null,
    queuedByName: i.queuedByName,
    campaignSetup: parseCampaignSetup(i.campaignSetup),
    publishFailure:
      i.status === "PROMOTED" && vb && vb.batchId && (vb.status === "PUBLISH_FAILED" || vb.status === "REJECTED")
        ? { batchId: vb.batchId, canRequeue: !vb.fbAdsetId && !vb.fbAdId && !vb.fbPendingStep, emptyCampaignId: vb.fbCampaignId ?? null }
        : null,
    // Ảnh thiết kế mới không mang mã hàng cha (đơn / chấm đi theo mã TK) ⇒ không có camp mã win.
    winCode: d ? null : winCode,
    productId: d ? null : productId,
    color: i.color,
    outputStyle: i.outputStyle,
    genId: i.genId,
  };
}

export type ManualGenRunCard = {
  id: string;
  /** `UPLOAD` = "Mẫu tự làm" người tải lên (vào thẳng hàng đợi) · `EDIT` = sửa từ một ảnh đã tạo. */
  kind: ManualGenKind | "UPLOAD" | "EDIT";
  /** Lượt `EDIT`: ảnh gốc được sửa (số thứ tự trong lượt của nó + điểm ảnh). `null` ở kiểu khác / ảnh gốc đã xoá. */
  editSource: { seq: number; imageId: string | null; isDesign: boolean } | null;
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
  /** Tuỳ chọn studio lúc bấm (`{}` = lượt cũ) — thẻ lượt in ra "2 mẫu × 3 màu × 1 kiểu". */
  options: Record<string, unknown>;
};

export type PixelSourceOption = { id: string; kind: "PRODUCT_PHOTO" | "OWN_AD"; productId: string; productLabel: string; title: string; imageId: string | null };

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
  /** Hàng đợi đăng camp — không theo ngày đang lọc. */
  queue: PublishQueueItem[];
  /** Lựa chọn + mặc định cho khối Setup camp của hộp Đăng camp. */
  setup: CampaignSetupOptions;
  /** Bằng chứng xếp fanpage theo camp của từng ảnh (`rankFanpagesForCamp`). */
  fanpageEvidence: FanpageEvidence;
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
  /**
   * Ba tên ĐIỀN SẴN cho "Đăng camp" (chủ shop 26/09/2026: "cần điền sẵn để sẵn sàng đăng ngay, tôi có thể sửa") — theo
   * khuôn, NGÀY CHẠY = hôm nay, số thứ tự = kế tiếp trong ngày trên MỌI lô (`nextNameSeqOnDay`, đúng số đường ghi sẽ
   * cấp nếu không ai đăng xen giữa). Người không sửa ⇒ màn hình gửi rỗng ⇒ đường ghi tính lại với số THẬT lúc bấm.
   */
  campDefaults: DefaultNames;
  pageName: string | null;
  /** Còn ảnh chờ vẽ / đang vẽ ⇒ màn hình tự tải lại để hiện tiến độ. */
  drawing: boolean;
  /** Ngày đang lọc (`YYYY-MM-DD`, giờ VN) — "Kết quả gen tay" và tiền trong ngày đều theo ngày này. */
  day: string;
  isToday: boolean;
  /** Ý tưởng đã dùng gần đây (mới trước, không trùng) — chọn nhanh lại ở form Tạo ảnh. */
  recentIdeas: string[];
};

/** Số ý tưởng gần đây hiện ở form — đủ để nhận ra, không thành một danh sách phải cuộn. */
const RECENT_IDEAS = 8;

/** Ý tưởng người đã gõ ở các lượt gen gần đây (mockup + thiết kế), mới trước, bỏ trùng. */
export async function listRecentIdeas(db: Db, limit = RECENT_IDEAS): Promise<string[]> {
  const g = schema.creativeManualGens;
  const rows = await db
    .select({ idea: g.idea })
    .from(g)
    .where(and(inArray(g.kind, ["MOCKUP", "DESIGN"]), sql`btrim(${g.idea}) <> ''`))
    .orderBy(desc(g.createdAt))
    .limit(limit * 4);
  const out: string[] = [];
  for (const r of rows) {
    const x = r.idea.trim();
    if (!out.includes(x)) out.push(x);
    if (out.length >= limit) break;
  }
  return out;
}

/** Thiết lập để "Tạo lại tương tự" điền lại form Tạo ảnh — chỉ lượt gen (mockup / thiết kế), không lượt sửa / tự làm. */
export type ManualGenRemix = {
  genId: string;
  kind: "MOCKUP" | "DESIGN";
  idea: string;
  units: number;
  styles: string[];
  colors: string[];
  size: string;
  quality: string;
  productPhotoSourceId: string | null;
  ownAdSourceId: string | null;
  inspirationProductIds: string[];
};

export async function loadManualGenRemix(db: Db, genId: string): Promise<ManualGenRemix | null> {
  const g = schema.creativeManualGens;
  const [r] = await db.select().from(g).where(eq(g.id, genId)).limit(1);
  if (!r || (r.kind !== "MOCKUP" && r.kind !== "DESIGN")) return null;
  const o = (r.options ?? {}) as Record<string, unknown>;
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
  const units = typeof o.units === "number" && Number.isInteger(o.units) && o.units > 0 ? o.units : r.requested;
  return {
    genId: r.id,
    kind: r.kind,
    idea: r.idea,
    units,
    styles: strs(o.styles),
    colors: strs(o.colors),
    size: r.size,
    quality: r.quality,
    productPhotoSourceId: r.productPhotoSourceId,
    ownAdSourceId: r.ownAdSourceId,
    inspirationProductIds: r.inspirationProductIds,
  };
}

/** Câu lệnh ĐÃ GỬI máy vẽ của một ảnh (đọc khi người mở "Câu lệnh" — không chở theo mọi thẻ). */
export async function loadManualGenImagePrompt(db: Db, imageId: string): Promise<{ prompt: string; idea: string; size: string; quality: string; model: string } | null> {
  const im = schema.creativeManualGenImages;
  const g = schema.creativeManualGens;
  const [r] = await db.select({ prompt: im.prompt, idea: g.idea, size: g.size, quality: g.quality, model: g.model }).from(im).innerJoin(g, eq(g.id, im.genId)).where(eq(im.id, imageId)).limit(1);
  return r ?? null;
}

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
      .select({
        i: schema.creativeManualGenImages,
        purgedAt: schema.creativeImages.purgedAt,
        imageRow: schema.creativeImages.id,
        vb: {
          status: schema.creativeVariants.status,
          batchId: schema.creativeVariants.batchId,
          fbCampaignId: schema.creativeVariants.fbCampaignId,
          fbAdsetId: schema.creativeVariants.fbAdsetId,
          fbAdId: schema.creativeVariants.fbAdId,
          fbPendingStep: schema.creativeVariants.fbPendingStep,
        },
      })
      .from(schema.creativeManualGenImages)
      .leftJoin(schema.creativeImages, eq(schema.creativeImages.id, schema.creativeManualGenImages.imageId))
      .leftJoin(schema.creativeVariants, eq(schema.creativeVariants.id, schema.creativeManualGenImages.variantId))
      .where(inArray(schema.creativeManualGenImages.genId, ids))
      .orderBy(schema.creativeManualGenImages.seq),
    srcIds.length ? db.select({ id: s.id, title: s.title }).from(s).where(inArray(s.id, srcIds)) : Promise.resolve([] as { id: string; title: string }[]),
    inspIds.length ? db.select({ id: schema.products.id, name: schema.products.name, customId: schema.products.customId }).from(schema.products).where(inArray(schema.products.id, inspIds)) : Promise.resolve([] as { id: string; name: string; customId: string | null }[]),
  ]);
  const titleOf = new Map(srcs.map((x) => [x.id, x.title]));
  const labelOf = new Map(insp.map((x) => [x.id, x.customId || x.name]));
  // Lượt SỬA ẢNH: ảnh gốc (số thứ tự + điểm ảnh) để thẻ lượt nói "sửa từ ảnh nào".
  const editIds = [...new Set(runs.map((r) => r.run.sourceGenImageId).filter((x): x is string => !!x))];
  const editRows = editIds.length ? await db.select({ id: schema.creativeManualGenImages.id, seq: schema.creativeManualGenImages.seq, imageId: schema.creativeManualGenImages.imageId, design: schema.creativeManualGenImages.design }).from(schema.creativeManualGenImages).where(inArray(schema.creativeManualGenImages.id, editIds)) : [];
  const srcOf = new Map(editRows.map((x) => [x.id, { seq: x.seq, imageId: x.imageId, isDesign: x.design !== null }]));
  // Mã win chỉ cần cho ảnh ĐÃ DUYỆT (thứ mở được hộp Đăng camp) — không dựng chỉ mục mã hàng khi không có ảnh nào như thế.
  const needWin = runs.filter((r) => r.run.kind !== "DESIGN" && r.run.productId && imgs.some((x) => x.i.genId === r.run.id && x.i.status === "APPROVED")).map((r) => r.run.productId as string);
  const wins = await productWinCodes(db, needWin);
  return runs.map(({ run, productName }) => {
    const win = run.productId ? (wins.get(run.productId) ?? null) : null;
    const images: ManualGenImageCard[] = imgs
      .filter((x) => x.i.genId === run.id)
      .map(({ i, purgedAt, imageRow, vb }) => toImageCard(i, imageRow, purgedAt, rate, vb, win, run.kind === "DESIGN" ? null : run.productId));
    const counts: Partial<Record<ManualGenImageStatus, number>> = {};
    for (const im of images) counts[im.status] = (counts[im.status] ?? 0) + 1;
    const priced = images.filter((im) => im.costUsd !== "" && Number.isFinite(Number(im.costUsd)));
    const usd = priced.reduce((t, im) => t + Number(im.costUsd), 0);
    return {
      id: run.id,
      kind: run.kind === "DESIGN" ? "DESIGN" : run.kind === "UPLOAD" ? "UPLOAD" : run.kind === "EDIT" ? "EDIT" : "MOCKUP",
      editSource: run.sourceGenImageId ? (srcOf.get(run.sourceGenImageId) ?? null) : null,
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
      options: run.options ?? {},
    };
  });
}

/** Nguồn ĐƯỢC gửi điểm ảnh sang máy vẽ (`PIXEL_SAFE_SOURCE_KINDS`), đang bật, có ảnh và có mã hàng. */
export async function listPixelSafeSourceOptions(db: Db): Promise<PixelSourceOption[]> {
  const s = schema.creativeSources;
  const p = schema.products;
  const rows = await db
    .select({ id: s.id, kind: s.kind, productId: s.productId, title: s.title, name: p.name, customId: p.customId, imageId: s.imageId })
    .from(s)
    .innerJoin(p, eq(p.id, s.productId))
    .where(and(inArray(s.kind, [...PIXEL_SAFE_SOURCE_KINDS]), eq(s.active, true), isNotNull(s.imageId)))
    .orderBy(p.name, s.kind, desc(s.createdAt))
    .limit(400);
  return rows.map((r) => ({ id: r.id, kind: r.kind === "OWN_AD" ? "OWN_AD" : "PRODUCT_PHOTO", productId: r.productId ?? "", productLabel: r.customId ? `${r.customId} · ${r.name}` : r.name, title: r.title, imageId: r.imageId }));
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

/** Một TKQC chọn được khi "Đăng camp" — tài khoản ĐÃ ĐỒNG BỘ chi tiêu vào ERP (`ad_spends`). `spend30dVnd` để xếp hạng. */
export type AdAccountOption = { id: string; name: string; spend30dVnd: number };
/**
 * Một fanpage chọn được — sổ fanpage (`fanpages`, khoá = id page Facebook) gộp với page token ERP được giao. `orders30d` để
 * xếp hạng; `viaToken` = token của ERP thấy page này (đăng camp / đăng Reel dùng được quyền của nó).
 */
export type FanpageOption = { id: string; name: string; orders30d: number; viaToken: boolean };

export type CampaignSetupOptions = {
  accounts: AdAccountOption[];
  pages: FanpageOption[];
  /** Không đọc được danh sách page của token (câu lỗi Facebook) — ô chọn chỉ còn page của sổ fanpage. `null` = đọc được / không có token. */
  tokenPagesError: string | null;
  /** MKTer chọn được (trang Lương, còn làm, có bí danh) + mã vào tên chiến dịch. Mặc định KHÔNG chọn ai — máy không đoán người. */
  marketers: MarketerOption[];
  /** Mặc định = lựa chọn DÙNG NHIỀU: TKQC chi nhiều nhất 30 ngày · page ra nhiều đơn nhất 30 ngày · mục tiêu / vị trí / tuổi / giới tính như quảng cáo mẫu. */
  defaults: CampaignSetup;
  /** TKQC / fanpage của CẤU HÌNH — tên theo khuôn điền sẵn dựng với hai cái này (hộp soạn bài thay khi người chọn cái khác). */
  configAccountId: string;
  configPageId: string;
  /** Quảng cáo mẫu đang nhắm gì (đọc từ bản đệm cài đặt nhóm mẫu) — để ô "như mẫu" nói ra cụ thể. `null` = chưa đọc được. */
  template: { geo: string; age: string; gender: string; optimizationGoal: string | null; bid: string | null } | null;
};

/**
 * TKQC đã đồng bộ, CHI NHIỀU NHẤT 30 ngày trước (chủ shop 26/09/2026: "dùng các TKQC và fanpage sync được", mặc định theo
 * lựa chọn dùng nhiều). Tài khoản của cấu hình luôn có mặt (kể cả khi 30 ngày chưa chi). Dòng đã loại (`excluded`) không tính.
 */
export async function listAdAccountOptions(db: Db, now: Date, configAccountId: string): Promise<AdAccountOption[]> {
  const a = schema.adSpends;
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const rows = await db
    .select({ id: a.accountId, name: sql<string>`max(${a.accountName})`, spend: sql<number>`coalesce(sum(${a.spend}) filter (where ${a.spendDate} >= ${since}), 0)::bigint` })
    .from(a)
    .where(and(isNotNull(a.accountId), eq(a.excluded, false)))
    .groupBy(a.accountId)
    .orderBy(desc(sql`3`));
  const out = rows.filter((r) => r.id).map((r) => ({ id: String(r.id).replace(/^act_/, ""), name: r.name || String(r.id), spend30dVnd: Number(r.spend ?? 0) }));
  const cfgId = configAccountId.replace(/^act_/, "");
  if (cfgId && !out.some((x) => x.id === cfgId)) out.push({ id: cfgId, name: `TK ${cfgId} (cấu hình)`, spend30dVnd: 0 });
  return out.sort((x, y) => y.spend30dVnd - x.spend30dVnd);
}

/**
 * GỘP HAI NGUỒN FANPAGE — hàm THUẦN. Sổ `fanpages` chỉ có page TỪNG RA ĐƠN trên Pancake (job quy kết dựng từ
 * `orders.page_id`), nên page mới share cho System User mà chưa ra đơn không bao giờ vào sổ (chủ shop 28/09/2026: "tôi chọn
 * được ít fanpage vậy?"). Page của token được THÊM vào (0 đơn/30 ngày, tên theo Facebook); page chủ shop đã TẮT trong sổ
 * (`inactiveIds`) vẫn tắt — token thấy nó không có nghĩa là người muốn dùng lại. Page trùng thì giữ dòng của sổ (tên người
 * đặt thắng tên API), chỉ đánh dấu `viaToken`.
 */
export function mergeFanpageOptions(fromLedger: readonly FanpageOption[], tokenPages: readonly TokenPage[], inactiveIds: ReadonlySet<string> = new Set()): FanpageOption[] {
  const seen = new Map(tokenPages.map((p) => [p.id, p]));
  const out: FanpageOption[] = fromLedger.map((p) => ({ ...p, viaToken: seen.has(p.id) }));
  for (const p of tokenPages) {
    if (inactiveIds.has(p.id) || out.some((x) => x.id === p.id)) continue;
    out.push({ id: p.id, name: p.name || p.id, orders30d: 0, viaToken: true });
  }
  return out.sort((x, y) => y.orders30d - x.orders30d || x.name.localeCompare(y.name));
}

/**
 * Fanpage chọn được: sổ fanpage (đang bật, RA NHIỀU ĐƠN NHẤT 30 ngày trước) GỘP với page mà token ERP được giao
 * (`mergeFanpageOptions`). Fanpage của cấu hình luôn có mặt.
 */
export async function listFanpageOptions(db: Db, now: Date, configPageId: string, tokenPages: readonly TokenPage[] = []): Promise<FanpageOption[]> {
  const f = schema.fanpages;
  const o = schema.orders;
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const counts = db
    .select({ pageId: o.pageId, n: sql<number>`count(*)::int`.as("n") })
    .from(o)
    .where(and(isNotNull(o.pageId), gte(o.insertedAt, since)))
    .groupBy(o.pageId)
    .as("c");
  const rows = await db
    .select({ id: f.externalPageId, name: f.name, alias: f.alias, active: f.active, n: sql<number>`coalesce(${counts.n}, 0)::int` })
    .from(f)
    .leftJoin(counts, eq(counts.pageId, f.externalPageId));
  const ledger = rows.filter((r) => r.active).map((r) => ({ id: r.id, name: r.alias || r.name || r.id, orders30d: Number(r.n ?? 0), viaToken: false }));
  const out = mergeFanpageOptions(ledger, tokenPages, new Set(rows.filter((r) => !r.active).map((r) => r.id)));
  if (configPageId && !out.some((x) => x.id === configPageId)) out.push({ id: configPageId, name: `Page ${configPageId} (cấu hình)`, orders30d: 0, viaToken: false });
  return out;
}

/**
 * Phần bằng chứng fanpage KHÔNG phụ thuộc mã đang xem: page đã có đơn xác nhận + page chưa có đơn đã chạy ads mã nào.
 * Đệm 120 giây (một lượt mở hộp soạn bài không đổi được sổ đơn / sổ ads).
 *
 * Page của một chiến dịch = page trong `story_id` của các mẩu thuộc chiến dịch ấy (`fb_ads`), lấy DISTINCT (chiến dịch,
 * page) TRƯỚC khi nối vào `ad_spends` — nối thẳng từng mẩu sẽ nhân tiền chiến dịch lên theo số mẩu.
 */
async function fanpageAdHistory(db: Db): Promise<{ orderedPages: string[]; ranByPage: FanpageEvidence["ranByPage"] }> {
  return memo("creative-manual-fanpage-history", 120_000, async () => {
    const o = schema.orders;
    const s = schema.adSpends;
    const fa = schema.fbAds;
    const cp = db
      .selectDistinct({ campaignId: fa.campaignId, pageId: sql<string>`split_part(${fa.storyId}, '_', 1)`.as("page_id") })
      .from(fa)
      .where(and(isNotNull(fa.campaignId), sql`${fa.storyId} like '%\\_%'`))
      .as("cp");
    const [ordered, ran] = await Promise.all([
      db.selectDistinct({ pageId: o.pageId }).from(o).where(and(CONFIRMED_ORDER, isNotNull(o.pageId))),
      db
        .select({ pageId: cp.pageId, productId: s.productId, spend: sql<number>`sum(${s.spend})::bigint` })
        .from(s)
        .innerJoin(cp, eq(cp.campaignId, s.campaignId))
        .where(and(isNotNull(s.productId), eq(s.excluded, false), sql`${s.spend} > 0`))
        .groupBy(cp.pageId, s.productId),
    ]);
    const orderedPages = ordered.map((r) => r.pageId).filter((x): x is string => !!x);
    const has = new Set(orderedPages);
    const ranByPage: FanpageEvidence["ranByPage"] = {};
    for (const r of ran) {
      if (!r.pageId || !r.productId || has.has(r.pageId)) continue;
      (ranByPage[r.pageId] ??= []).push({ productId: r.productId, spendVnd: Number(r.spend) });
    }
    return { orderedPages, ranByPage };
  });
}

/**
 * BẰNG CHỨNG XẾP FANPAGE cho các mã đang hiện (`rankFanpagesForCamp` — chủ shop 28/09/2026): đơn xác nhận theo (mã, page),
 * page chưa ra đơn đã chạy mã nào, và DNA của các mã liên quan. Không có mã nào ⇒ vẫn trả phần lịch sử ads (ảnh thiết kế
 * mới so bằng DNA của chính nó).
 */
export async function loadFanpageEvidence(db: Db, productIds: readonly string[]): Promise<FanpageEvidence> {
  const ids = [...new Set(productIds.filter((x) => !!x))];
  const o = schema.orders;
  const oi = schema.orderItems;
  const [hist, byProduct] = await Promise.all([
    fanpageAdHistory(db),
    ids.length
      ? db
          .select({ productId: oi.productId, pageId: o.pageId, n: sql<number>`count(distinct ${o.id})::int` })
          .from(oi)
          .innerJoin(o, eq(o.id, oi.orderId))
          .where(and(inArray(oi.productId, ids), CONFIRMED_ORDER, isNotNull(o.pageId), eq(oi.isBonus, false)))
          .groupBy(oi.productId, o.pageId)
      : Promise.resolve([] as { productId: string | null; pageId: string | null; n: number }[]),
  ]);
  const ordersByProduct: FanpageEvidence["ordersByProduct"] = {};
  for (const r of byProduct) if (r.productId && r.pageId) (ordersByProduct[r.productId] ??= {})[r.pageId] = Number(r.n);
  const related = [...new Set([...ids, ...Object.values(hist.ranByPage).flatMap((xs) => xs.map((x) => x.productId))])];
  const [dnaRows, labelRows] = related.length
    ? await Promise.all([
        db.select({ productId: schema.productDna.productId, dna: schema.productDna.dna }).from(schema.productDna).where(inArray(schema.productDna.productId, related)),
        db.select({ id: schema.products.id, name: schema.products.name, customId: schema.products.customId }).from(schema.products).where(inArray(schema.products.id, related)),
      ])
    : [[], []];
  return {
    orderedPages: hist.orderedPages,
    ordersByProduct,
    ranByPage: hist.ranByPage,
    dna: Object.fromEntries(dnaRows.map((r) => [r.productId, { ...(r.dna ?? {}) }])),
    productLabel: Object.fromEntries(labelRows.map((r) => [r.id, r.customId || r.name])),
  };
}

/** Lựa chọn + mặc định cho khối "Setup camp" của hộp Đăng camp. */
export async function loadCampaignSetupOptions(db: Db, now: Date, cfg: { adAccountId: string; pageId: string; budgetPerVariantVnd: number }): Promise<CampaignSetupOptions> {
  const token = await readTokenPages();
  const [accounts, pages, tpl, employees] = await Promise.all([listAdAccountOptions(db, now, cfg.adAccountId), listFanpageOptions(db, now, cfg.pageId, token.pages), readNamingTemplate(db), readPayrollEmployees(db)]);
  const t = tpl?.targeting ?? null;
  return {
    accounts,
    pages,
    tokenPagesError: token.error,
    marketers: marketerOptions(employees),
    configAccountId: cfg.adAccountId.replace(/^act_/, ""),
    configPageId: cfg.pageId,
    defaults: { adAccountId: accounts[0]?.id ?? cfg.adAccountId, pageId: pages[0]?.id ?? cfg.pageId, objective: CAMPAIGN_OBJECTIVES[0], performanceGoal: null, budgetVnd: cfg.budgetPerVariantVnd, geo: null, ageMin: null, ageMax: null, gender: null, marketerId: null, marketerCode: null, startAt: null, campaignKind: "TEST", bid: null, bidAmountVnd: null },
    template: tpl && t ? { geo: geoPart(t).text, age: agePart(t).text, gender: genderPart(t).text, optimizationGoal: tpl.optimizationGoal, bid: tpl.bidStrategy ? (BID_STRATEGY_LABEL[tpl.bidStrategy] ?? tpl.bidStrategy) : null } : null,
  };
}

/** Một bài ở HÀNG ĐỢI ĐĂNG CAMP: thẻ ảnh + nhãn lượt gen sinh ra nó (để người nhận ra bài). */
export type PublishQueueItem = { img: ManualGenImageCard; runLabel: string; runCreatedAt: string };

/** Số bài tối đa hiện ở hàng đợi — một hàng đợi dài hơn thế là hàng đợi không ai đọc hết. */
const QUEUE_MAX = 50;

/**
 * HÀNG ĐỢI ĐĂNG CAMP — ảnh ĐÃ DUYỆT mà người đã bấm "Lưu" (`queued_at`), mới lưu trước. KHÔNG lọc theo ngày: đây là
 * việc phải làm, không phải kết quả của một ngày. Đăng / đưa vào lô xong ⇒ ảnh `PROMOTED`, tự rời hàng đợi.
 */
export async function listPublishQueue(db: Db, rate: number = env.facebook.usdToVnd): Promise<PublishQueueItem[]> {
  const im = schema.creativeManualGenImages;
  const g = schema.creativeManualGens;
  const rows = await db
    .select({ i: im, purgedAt: schema.creativeImages.purgedAt, imageRow: schema.creativeImages.id, run: { kind: g.kind, createdAt: g.createdAt, productId: g.productId }, productName: schema.products.name })
    .from(im)
    .innerJoin(g, eq(g.id, im.genId))
    .leftJoin(schema.creativeImages, eq(schema.creativeImages.id, im.imageId))
    .leftJoin(schema.products, eq(schema.products.id, g.productId))
    .where(and(eq(im.status, "APPROVED"), isNotNull(im.queuedAt)))
    .orderBy(desc(im.queuedAt))
    .limit(QUEUE_MAX);
  const wins = await productWinCodes(
    db,
    rows.filter((r) => r.run.kind !== "DESIGN" && r.run.productId).map((r) => r.run.productId as string),
  );
  return rows.map((r) => ({
    img: toImageCard(r.i, r.imageRow, r.purgedAt, rate, null, r.run.productId ? (wins.get(r.run.productId) ?? null) : null, r.run.kind === "DESIGN" ? null : r.run.productId),
    runLabel: r.run.kind === "DESIGN" || (r.run.kind === "EDIT" && !r.run.productId) ? "Thiết kế mới" : (r.productName ?? "Mã đã xoá"),
    runCreatedAt: r.run.createdAt.toISOString(),
  }));
}

/** Số việc đang chờ ở từng bước của Thư viện Media — cho thanh tab và tab mặc định. */
export type MediaCounts = { drawing: number; review: number; approvedUnqueued: number; queue: number; live: number };

/**
 * Đếm việc đang chờ: ảnh đang vẽ · ảnh chờ duyệt · ảnh đã duyệt chưa soạn vào hàng đợi · bài trong hàng đợi · mẫu đang chạy.
 * Chỉ đếm, không đọc ảnh — chạy mỗi lần mở trang.
 */
export async function loadMediaCounts(db: Db): Promise<MediaCounts> {
  const g = schema.creativeManualGenImages;
  const v = schema.creativeVariants;
  const [[a], [b]] = await Promise.all([
    db
      .select({
        drawing: sql<number>`count(*) filter (where ${g.status} in ('PLANNED', 'DRAWING'))::int`,
        review: sql<number>`count(*) filter (where ${g.status} = 'GENERATED')::int`,
        approvedUnqueued: sql<number>`count(*) filter (where ${g.status} = 'APPROVED' and ${g.queuedAt} is null)::int`,
        queue: sql<number>`count(*) filter (where ${g.status} = 'APPROVED' and ${g.queuedAt} is not null)::int`,
      })
      .from(g),
    db.select({ live: sql<number>`count(*)::int` }).from(v).where(eq(v.status, "LIVE")),
  ]);
  return { drawing: Number(a?.drawing ?? 0), review: Number(a?.review ?? 0), approvedUnqueued: Number(a?.approvedUnqueued ?? 0), queue: Number(a?.queue ?? 0), live: Number(b?.live ?? 0) };
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
  const [runs, queue, sources, inspirations, today, ctx, predictedSeq, pageName, blockers, setup, recentIdeas] = await Promise.all([
    listManualGenRuns(db, RUNS_PER_DAY, rate, day),
    listPublishQueue(db, rate),
    listPixelSafeSourceOptions(db),
    listDesignInspirations(db, now),
    // Tiền gen tay của NGÀY ĐANG LỌC: hàm đo "ngày VN chứa mốc này", nên đưa trưa ngày ấy.
    manualGenSpendToday(db, day === vnDay(now) ? now : new Date(`${day}T12:00:00+07:00`)),
    loadNamingContext(db, namingCfg),
    batch ? nextNameSeq(db, batch.id) : Promise.resolve(1),
    fanpageDisplayName(db, namingCfg.pageId),
    instantPublishBlockers(db, config, vnDay(now)),
    loadCampaignSetupOptions(db, now, config),
    listRecentIdeas(db),
  ]);
  const unitUsd = estimateImageUsd(config.imageModel, config.imageQuality, config.imageSize);
  const shownImages = [...runs.flatMap((r) => r.images), ...queue.map((q) => q.img)];
  const fanpageEvidence = await loadFanpageEvidence(db, shownImages.filter((im) => im.status === "APPROVED" && im.productId).map((im) => im.productId as string));
  // Bài lẻ đứng tên theo cấu hình HIỆN TẠI (lô `INSTANT` chụp cấu hình lúc bấm), không theo ảnh chụp của lô hằng ngày.
  const [campCtx, campSeq] = await Promise.all([namingCfg === config ? Promise.resolve(ctx) : loadNamingContext(db, config), nextNameSeqOnDay(db, vnDay(now))]);
  return {
    runs,
    queue,
    setup,
    fanpageEvidence,
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
    campDefaults: defaultNames(campCtx, vnDay(now), campSeq),
    pageName,
    drawing: runs.some((r) => (r.counts.PLANNED ?? 0) + (r.counts.DRAWING ?? 0) > 0),
    day,
    isToday: day === vnDay(now),
    recentIdeas,
  };
}

/**
 * Bộ đồ nghề của hộp "Đăng lại camp" (tab ④ Đang chạy) — ĐÚNG các mảnh hộp "Đăng camp" dùng (lựa chọn setup, khung đăng lẻ +
 * cổng chặn, tên theo khuôn của ngày, bằng chứng xếp fanpage, mã win) nhưng không đọc kết quả gen / hàng đợi như
 * `loadManualGenPanel`: tab Đang chạy không cần chúng.
 */
export async function loadRepublishCtx(db: Db, now: Date, productIds: readonly string[]) {
  const { config } = await readCurrentCreativeConfig(db);
  const ids = [...new Set(productIds.filter(Boolean))];
  const [setup, blockers, ctx, seq, pageName, fanpageEvidence, wins] = await Promise.all([
    loadCampaignSetupOptions(db, now, config),
    instantPublishBlockers(db, config, vnDay(now)),
    loadNamingContext(db, config),
    nextNameSeqOnDay(db, vnDay(now)),
    fanpageDisplayName(db, config.pageId),
    loadFanpageEvidence(db, ids),
    productWinCodes(db, ids),
  ]);
  const names = defaultNames(ctx, vnDay(now), seq);
  return {
    ctx: {
      pricing: { unitVnd: null, unitUsd: 0 },
      instant: {
        budgetVnd: config.budgetPerVariantVnd,
        testDays: Math.max(1, Math.min(config.testDays, CREATIVE_HARD_LIMITS.maxTestDays)),
        leadSeconds: INSTANT_PUBLISH.leadSeconds,
        minScheduleLeadMinutes: INSTANT_PUBLISH.minScheduleLeadMinutes,
        maxScheduleDays: INSTANT_PUBLISH.maxScheduleDays,
        blockers,
      },
      pageName,
      defaults: names,
      campDefaults: names,
      setup,
      fanpageEvidence,
    },
    winCodes: Object.fromEntries(wins) as Record<string, ProductWinCode>,
  };
}
