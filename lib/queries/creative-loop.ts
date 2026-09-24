import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { chayKhongJit, schema, type Db } from "@/db";
import {
  CREATIVE_CONFIG_KEY,
  normalizeCreativeConfig,
  parseVariantRules,
  variantRuleSet,
  type BatchStatus,
  type ConfigProblem,
  type CreativeLoopConfig,
  type CreativeRule,
  type CreativeSourceKind,
  type CreativeVerdict,
  type SlotMode,
  type VariantRulesSnapshot,
  type VariantStatus,
} from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { judgeVariant, type JudgeResult, type VariantMetrics } from "@/lib/creative/judge";
import type { GeneStat } from "@/lib/creative/learn";
import { vnStartOfDay } from "@/lib/format";
import { CONFIRMED_ORDER } from "@/lib/queries/metrics";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { AD_MESSAGES } from "@/lib/queries/ads-roas";
import { RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";

/**
 * ═══════════ VÒNG MẪU QUẢNG CÁO — SỐ ĐO VÀ CÁC HÀM ĐỌC CHO MÀN HÌNH ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` (§2.6, §4). CHỈ ĐỌC — mọi phép ghi của vòng nằm ở `lib/creative/*`
 * (`tests/advisory-safety.test.ts` quét cả thư mục này).
 *
 * ─── HAI NGUỒN SỐ ĐO, KHÔNG NGUỒN THỨ BA ───
 *
 *  · TIỀN / HIỂN THỊ / NHẤP / TIN NHẮN: `ad_spends` hạt `AD` (`ad_id` = mẩu QC của mẫu), bỏ dòng
 *    `excluded`. Đã đo khớp 0 đồng với hạt chiến dịch (`docs/ads-measurement-audit-2026-09-22.md` §4).
 *    `spend` đã quy ra VND nguyên ở lượt đồng bộ (`lib/integrations/facebook/sync.ts`).
 *  · ĐƠN: đơn Pancake mang `orders.ad_id` = mẩu QC, kết quả qua `ORDER_OUTCOME_FAST`, nối vận đơn
 *    bằng `PRIMARY_ATTEMPT` (mỗi đơn một dòng) — đúng hình dạng của `lib/queries/ads-decision.ts`.
 *    Cấp mẩu CHỈ đi bằng `ad_id`, không qua `post_id` (`docs/ads-decision-contract.md` §6): một bài
 *    có thể do nhiều mẩu chạy, chọn bừa một mẩu là bịa quy kết.
 *
 * ─── POPULATION CỦA "ĐƠN CHỐT" ───
 *
 * Dùng `CONFIRMED_ORDER` — ĐÚNG population của bảng quyết định quảng cáo (`metricScope(…, "confirmed")`),
 * để cùng một mẩu QC mang cùng một số đơn trên màn vòng mẫu và trên `/ads`. Đơn `NEW` (khách nhắn
 * mà chưa chốt) chưa phải đơn; đếm nó là đẩy mẫu tới ngưỡng THẮNG bằng những đơn chưa tồn tại.
 * Trong population đó: `bookedOrders` = kết quả ≠ `CANCELLED`, `deliveredOrders` = `DELIVERED`,
 * `returnedOrders` = `RETURNED` + `RETURNED_BY_RULE` (luôn gộp — ORDER_OUTCOME.md mục 6).
 *
 * ─── CHƯA BIẾT KHÔNG PHẢI 0 (AGENTS.md mục 42) ───
 *
 * Mẩu chưa có dòng chi nào ⇒ `spendVnd / impressions / clicks / messages = null`. Có ít nhất một dòng
 * thì các cột kia là số thật (cột `NOT NULL DEFAULT 0` trong `ad_spends`), kể cả 0 thật.
 */

type VariantRow = typeof schema.creativeVariants.$inferSelect;
type BatchRow = typeof schema.creativeBatches.$inferSelect;

// ───────────────────────────── SỐ ĐO TỪNG MẪU ─────────────────────────────

export type VariantMetricsRow = VariantMetrics & {
  /** Số NGÀY có dòng chi cấp mẩu (sau mốc bắt đầu). 0 khi chưa có dòng nào. */
  spendDays: number;
  /** Ngày VN mới nhất có dòng chi (`YYYY-MM-DD`). `null` = chưa có dòng nào. */
  lastSpendDate: string | null;
};

export type VariantMetricsInput = { id: string; fbAdId: string | null; startAt: Date | null };

const UNKNOWN_METRICS: VariantMetricsRow = {
  spendVnd: null,
  impressions: null,
  clicks: null,
  messages: null,
  bookedOrders: 0,
  deliveredOrders: 0,
  returnedOrders: 0,
  spendDays: 0,
  lastSpendDate: null,
};

/**
 * Số đo của từng mẫu, khoá theo `variantId`. Mẫu không có `fbAdId` (chưa đăng) ⇒ số đo CHƯA BIẾT.
 *
 * Mốc chi: `spend_date` ≥ đầu NGÀY VIỆT NAM của `startAt` — dòng chi ghi theo ngày VN
 * (`vnStartOfDay`), nên so với 6:00 sáng sẽ loại mất chính ngày chạy. Mẩu QC do vòng tạo nên không
 * có chi trước ngày ấy; mốc chỉ là hàng rào cho id bị dùng lại.
 */
export async function variantMetrics(db: Db, variants: VariantMetricsInput[]): Promise<Map<string, VariantMetricsRow>> {
  const out = new Map<string, VariantMetricsRow>();
  for (const v of variants) out.set(v.id, { ...UNKNOWN_METRICS });

  const byAd = new Map<string, { id: string; floor: Date | null }>();
  for (const v of variants) {
    const ad = (v.fbAdId ?? "").trim();
    if (ad) byAd.set(ad, { id: v.id, floor: v.startAt ? vnStartOfDay(vnDay(v.startAt)) : null });
  }
  const adIds = [...byAd.keys()];
  if (adIds.length === 0) return out;

  const earliest = [...byAd.values()].reduce<Date | null>((m, x) => (x.floor === null ? m : m === null || x.floor < m ? x.floor : m), null);
  const allHaveFloor = [...byAd.values()].every((x) => x.floor !== null);
  const ads = schema.adSpends;
  const spendConds: SQL[] = [eq(ads.grain, "AD"), eq(ads.excluded, false), inArray(ads.adId, adIds)];
  if (allHaveFloor && earliest) spendConds.push(gte(ads.spendDate, earliest));

  // Gộp theo (mẩu × ngày) rồi lọc mốc từng mẫu ở TypeScript: mỗi mẫu có một mốc riêng.
  const spendRows = await db
    .select({
      adId: sql<string>`${ads.adId}`,
      spendDate: ads.spendDate,
      spend: sql<number>`coalesce(sum(${ads.spend}), 0)`,
      impressions: sql<number>`coalesce(sum(${ads.impressions}), 0)`,
      clicks: sql<number>`coalesce(sum(${ads.clicks}), 0)`,
      messages: sql<number>`coalesce(sum(${AD_MESSAGES}), 0)`,
    })
    .from(ads)
    .where(and(...spendConds))
    .groupBy(ads.adId, ads.spendDate);

  for (const r of spendRows) {
    const target = byAd.get(String(r.adId));
    if (!target) continue;
    const at = r.spendDate instanceof Date ? r.spendDate : new Date(r.spendDate);
    if (target.floor && at < target.floor) continue;
    const m = out.get(target.id) as VariantMetricsRow;
    m.spendVnd = (m.spendVnd ?? 0) + Number(r.spend ?? 0);
    m.impressions = (m.impressions ?? 0) + Number(r.impressions ?? 0);
    m.clicks = (m.clicks ?? 0) + Number(r.clicks ?? 0);
    m.messages = (m.messages ?? 0) + Number(r.messages ?? 0);
    m.spendDays += 1;
    const day = vnDay(at);
    if (m.lastSpendDate === null || day > m.lastSpendDate) m.lastSpendDate = day;
  }

  const o = schema.orders;
  const s = schema.shipments;
  // Mỗi đơn tính kết quả ĐÚNG MỘT LẦN (bảng dẫn xuất + rào `OUTCOME_FENCE`), như ads-decision.
  const facts = db
    .select({
      adId: sql<string>`${o.adId}`.as("cl_ad_id"),
      outcome: ORDER_OUTCOME_FAST.as("cl_outcome"),
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG (xem PRIMARY_ATTEMPT) — đơn gửi lại không được đếm hai lần.
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(and(CONFIRMED_ORDER, inArray(o.adId, adIds)))
    .offset(OUTCOME_FENCE)
    .as("creative_order_facts");

  const orderRows = await chayKhongJit(db, (tx) =>
    tx
      .select({
        adId: sql<string>`${facts.adId}`,
        booked: sql<number>`count(*) filter (where ${facts.outcome} <> 'CANCELLED')`,
        delivered: sql<number>`count(*) filter (where ${facts.outcome} = 'DELIVERED')`,
        returned: sql<number>`count(*) filter (where ${facts.outcome} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))`,
      })
      .from(facts)
      .groupBy(facts.adId),
  );
  for (const r of orderRows) {
    const target = byAd.get(String(r.adId));
    if (!target) continue;
    const m = out.get(target.id) as VariantMetricsRow;
    m.bookedOrders = Number(r.booked ?? 0);
    m.deliveredOrders = Number(r.delivered ?? 0);
    m.returnedOrders = Number(r.returned ?? 0);
  }
  return out;
}

// ───────────────────────────── CẤU HÌNH DÙNG ĐỂ CHẤM ─────────────────────────────

/**
 * Cấu hình HIỆN TẠI (`settings` khoá `creative.config`), đọc bằng chính `db` được truyền vào và
 * chuẩn hoá qua `normalizeCreativeConfig`. Không đọc được / JSON hỏng ⇒ mặc định (hai bộ luật RỖNG ⇒
 * máy không tự tắt, không tự kết luận) — nhánh lỗi rơi về phía HẸP HƠN.
 */
export async function readCurrentCreativeConfig(db: Db): Promise<{ config: CreativeLoopConfig; problems: ConfigProblem[] }> {
  let raw: unknown = {};
  try {
    const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY)).limit(1);
    raw = row ? (JSON.parse(row.value) as unknown) : {};
  } catch {
    raw = {};
  }
  return normalizeCreativeConfig(raw);
}

/**
 * Tên fanpage đứng tên bài quảng cáo — để khối "Sẵn sàng đăng" hiện đúng tên như Facebook sẽ hiện.
 * Tên người đặt (`alias`) trước tên API (`name`). Chưa khai fanpage, hoặc sổ fanpage chưa biết page ấy
 * ⇒ `null`; màn hình nói ra điều đó, không bịa một cái tên.
 */
export async function fanpageDisplayName(db: Db, pageId: string): Promise<string | null> {
  if (!pageId.trim()) return null;
  try {
    const [row] = await db.select({ name: schema.fanpages.name, alias: schema.fanpages.alias }).from(schema.fanpages).where(eq(schema.fanpages.externalPageId, pageId.trim())).limit(1);
    return row ? row.alias.trim() || row.name.trim() || null : null;
  } catch {
    return null;
  }
}

export type JudgeConfig =Pick<CreativeLoopConfig, "killRules" | "keepRules" | "winOrdersAbove" | "verdictSettleHours">;

/**
 * Bộ luật dùng để chấm MỘT mẫu — hai nguồn, cố ý:
 *
 *  · LUẬT TẮT lấy từ `config_snapshot` CỦA LÔ. Lượt duyệt lô đã cho phép trước đúng bộ luật ấy (phiếu
 *    duyệt khoá cả luật tắt). Luật tắt thêm SAU khi duyệt là thứ người duyệt chưa từng thấy — để nó
 *    tự tắt mẫu của lô cũ là để một dòng JSON gõ lúc nửa đêm quyết thay lượt duyệt.
 *  · Ô có LUẬT RIÊNG (`rules_snapshot`, ô mockup) ⇒ luật tắt VÀ luật giữ của chính ô.
 *  · LUẬT GIỮ, `winOrdersAbove`, `verdictSettleHours` lấy từ cấu hình HIỆN TẠI. Chúng chỉ quyết
 *    NHÃN (hứa hẹn / loại / thắng) và việc học, không chạm tiền: tiêu thêm vẫn phải người bấm. Chủ
 *    shop điền luật giữ sau khi lô đã chạy thì mẫu cũ vẫn được chấm — nếu đi theo snapshot, mọi lô
 *    dựng trước ngày điền luật mãi mãi là `UNJUDGED` và máy không học được gì từ chúng.
 */
export function effectiveJudgeConfig(snapshotRaw: unknown, current: CreativeLoopConfig, variantRulesRaw: unknown = null): JudgeConfig {
  const snap = normalizeCreativeConfig(snapshotRaw).config;
  // Ô có LUẬT RIÊNG (mockup của mã cũ, chủ shop 24/09/2026): cả luật tắt lẫn luật giữ là của ô — chụp lúc
  // lập lô và khoá trong phiếu duyệt. Không có ⇒ luật chung như trên.
  const own = variantRuleSet(variantRulesRaw, { killRules: snap.killRules, keepRules: current.keepRules });
  return {
    killRules: own.killRules,
    keepRules: own.keepRules,
    winOrdersAbove: current.winOrdersAbove,
    verdictSettleHours: current.verdictSettleHours,
  };
}

/** Hai luật cùng nội dung (bỏ qua nhãn thì không — nhãn là một phần của thứ người duyệt đã đọc). */
export function sameRule(a: CreativeRule, b: CreativeRule): boolean {
  return a.metric === b.metric && a.op === b.op && a.value === b.value && a.minSpendVnd === b.minSpendVnd && (a.label ?? "") === (b.label ?? "");
}

// ───────────────────────────── KIỂU TRẢ VỀ CHO MÀN HÌNH ─────────────────────────────
//
// Mọi mốc thời gian là CHUỖI ISO (hoặc `null`) — không lẫn `Date` với chuỗi khi đi qua ranh giới
// server → client. Không kiểu nào mang dữ liệu ảnh: chỉ `imageId` + `imageAvailable`.

export type BatchSummary = {
  id: string;
  batchDay: string;
  status: BatchStatus;
  slotCount: number;
  startAt: string;
  endAt: string;
  approvalDeadline: string;
  approvedAt: string | null;
  approvedByName: string;
  publishedAt: string | null;
  error: string;
  ruleVersion: number;
  createdAt: string;
  /** Số mẫu theo trạng thái MẪU (`VariantStatus`). */
  variantCounts: Partial<Record<VariantStatus, number>>;
};

export type VariantCard = {
  id: string;
  batchId: string;
  slot: number;
  mode: SlotMode;
  productId: string | null;
  productName: string | null;
  productPhotoSourceId: string | null;
  inspirationSourceId: string | null;
  parentVariantId: string | null;
  genes: Record<string, string>;
  genesVersion: number;
  mutatedGene: string;
  why: string;
  imagePrompt: string;
  primaryText: string;
  headline: string;
  writerModel: string;
  writerCostUsd: string;
  imageId: string | null;
  /** Điểm ảnh còn đọc được (chưa bị xoá sau hạn giữ). */
  imageAvailable: boolean;
  genModel: string;
  genCostUsd: string;
  genError: string;
  status: VariantStatus;
  rejectReason: string;
  fbAdsetId: string | null;
  fbAdId: string | null;
  committedBudgetVnd: number | null;
  publishedAt: string | null;
  pausedAt: string | null;
  pauseReason: string;
  libraryAt: string | null;
  libraryOrders: number | null;
  lostAt: string | null;
  createdAt: string;
  designConceptId: string | null;
  /** Luật riêng của ô (mockup của mã cũ). `null` = ô dùng luật chung của lô. */
  rules: VariantRulesSnapshot | null;
  /** Ô `DESIGN` ⇒ thiết kế mà mẩu quảng cáo. */
  design: DesignCard | null;
};

/** Thiết kế của một ô `DESIGN` — đủ để người duyệt thấy mã, DNA, mã cha, giá đề nghị. */
export type DesignCard = {
  id: string;
  code: string;
  status: string;
  dna: Record<string, string>;
  parentProductIds: string[];
  parentLabels: string[];
  /** Giá đề nghị; `null` = không suy được (câu chữ không ghi giá). */
  priceVnd: number | null;
};

export type JudgedVariant = VariantCard & {
  batchDay: string;
  startAt: string;
  endAt: string;
  metrics: VariantMetricsRow;
  verdict: CreativeVerdict;
  reasons: string[];
  firedKillRule: CreativeRule | null;
  keepChecks: JudgeResult["keepChecks"];
};

export type FbActionRow = {
  id: string;
  variantId: string | null;
  action: string;
  outcome: string;
  denial: string;
  detail: string;
  targetId: string;
  amountVnd: number | null;
  actorEmail: string;
  mode: string;
  createdAt: string;
};

export type PendingBatch = {
  batch: BatchSummary;
  variants: VariantCard[];
  /** Cấu hình CHỤP lúc lập lô (tiền, khung giờ, luật tắt) — thứ người duyệt đang cho phép. */
  config: CreativeLoopConfig;
  configProblems: ConfigProblem[];
  /** Tổng ngân sách sẽ cam kết nếu duyệt mọi mẫu chưa bị gạt (VND). */
  committedIfApprovedVnd: number;
};

export type BatchDetail = PendingBatch & {
  /** Số đo + phán quyết SỐNG của các mẫu đã đăng (LIVE/PAUSED/ENDED). */
  judged: JudgedVariant[];
  actions: FbActionRow[];
};

export type LibraryItem = VariantCard & {
  batchDay: string;
  /** Số đơn HIỆN TẠI — có thể khác `libraryOrders` (số lúc vào thư viện) vì đơn bị huỷ về sau. */
  bookedOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  spendVnd: number | null;
};

export type LearningPoint = { day: string; observations: number | null; relativeObservations: number | null };

export type LatestLearning = {
  learningDay: string;
  geneStats: GeneStat[];
  observations: number;
  relativeObservations: number;
  narrative: string;
  narrativeModel: string;
  ruleVersion: number;
  genesVersion: number;
  updatedAt: string;
  /** 14 ngày tính tới `learningDay`, cũ → mới. Ngày không có lượt học ⇒ `null` (không phải 0). */
  series: LearningPoint[];
};

export type SourceFilters = {
  kind?: CreativeSourceKind | null;
  productId?: string | null;
  /** Mặc định `true`: chỉ nguồn đang bật. */
  activeOnly?: boolean;
  q?: string | null;
  limit?: number;
};

export type SourceRow = {
  id: string;
  kind: CreativeSourceKind;
  productId: string | null;
  productName: string | null;
  title: string;
  note: string;
  sourceUrl: string;
  imageId: string | null;
  imageAvailable: boolean;
  genes: Record<string, string>;
  visionSummary: string;
  visionModel: string;
  visionAt: string | null;
  active: boolean;
  createdByName: string;
  createdAt: string;
  /** Số mẫu đã dùng nguồn này (làm ảnh sản phẩm gốc HOẶC làm cảm hứng). */
  usedCount: number;
  lastUsedAt: string | null;
};

// ───────────────────────────── ĐỔI DÒNG CSDL → KIỂU THUẦN ─────────────────────────────

function iso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isFinite(x.getTime()) ? x.toISOString() : null;
}

function isoReq(d: Date | string): string {
  return iso(d) ?? "";
}

function toBatchSummary(b: BatchRow, counts: Partial<Record<VariantStatus, number>>): BatchSummary {
  return {
    id: b.id,
    batchDay: b.batchDay,
    status: b.status as BatchStatus,
    slotCount: b.slotCount,
    startAt: isoReq(b.startAt),
    endAt: isoReq(b.endAt),
    approvalDeadline: isoReq(b.approvalDeadline),
    approvedAt: iso(b.approvedAt),
    approvedByName: b.approvedByName,
    publishedAt: iso(b.publishedAt),
    error: b.error,
    ruleVersion: b.ruleVersion,
    createdAt: isoReq(b.createdAt),
    variantCounts: counts,
  };
}

/** Cột của một mẫu + tên sản phẩm + ảnh còn không. KHÔNG chọn `creative_images.data`. */
const variantSelect = {
  v: schema.creativeVariants,
  productName: schema.products.name,
  imagePurgedAt: schema.creativeImages.purgedAt,
  imageRowId: schema.creativeImages.id,
};

type VariantJoined = { v: VariantRow; productName: string | null; imagePurgedAt: Date | null; imageRowId: string | null };

function variantQuery(db: Db) {
  return db
    .select(variantSelect)
    .from(schema.creativeVariants)
    .leftJoin(schema.products, eq(schema.products.id, schema.creativeVariants.productId))
    .leftJoin(schema.creativeImages, eq(schema.creativeImages.id, schema.creativeVariants.imageId));
}

function toVariantCard(r: VariantJoined): VariantCard {
  const v = r.v;
  return {
    id: v.id,
    batchId: v.batchId,
    slot: v.slot,
    mode: v.mode === "EXPLOIT" || v.mode === "MANUAL" || v.mode === "DESIGN" ? v.mode : "EXPLORE",
    productId: v.productId,
    productName: r.productName ?? null,
    productPhotoSourceId: v.productPhotoSourceId,
    inspirationSourceId: v.inspirationSourceId,
    parentVariantId: v.parentVariantId,
    genes: { ...(v.genes ?? {}) },
    genesVersion: v.genesVersion,
    mutatedGene: v.mutatedGene,
    why: v.why,
    imagePrompt: v.imagePrompt,
    primaryText: v.primaryText,
    headline: v.headline,
    writerModel: v.writerModel,
    writerCostUsd: v.writerCostUsd,
    imageId: v.imageId,
    imageAvailable: v.imageId !== null && r.imageRowId !== null && r.imagePurgedAt === null,
    genModel: v.genModel,
    genCostUsd: v.genCostUsd,
    genError: v.genError,
    status: v.status as VariantStatus,
    rejectReason: v.rejectReason,
    fbAdsetId: v.fbAdsetId,
    fbAdId: v.fbAdId,
    committedBudgetVnd: v.committedBudgetVnd,
    publishedAt: iso(v.publishedAt),
    pausedAt: iso(v.pausedAt),
    pauseReason: v.pauseReason,
    libraryAt: iso(v.libraryAt),
    libraryOrders: v.libraryOrders,
    lostAt: iso(v.lostAt),
    createdAt: isoReq(v.createdAt),
    designConceptId: v.designConceptId,
    rules: parseVariantRules(v.rulesSnapshot),
    design: null,
  };
}

/** Gắn thiết kế vào các thẻ ô `DESIGN` (một câu đọc cho cả lô). */
async function withDesigns(db: Db, cards: VariantCard[]): Promise<VariantCard[]> {
  const ids = [...new Set(cards.flatMap((c) => (c.mode === "DESIGN" && c.designConceptId ? [c.designConceptId] : [])))];
  if (ids.length === 0) return cards;
  const dc = schema.designConcepts;
  const rows = await db.select({ id: dc.id, code: dc.code, status: dc.status, dna: dc.dna, parentProductIds: dc.parentProductIds, priceVnd: dc.priceVnd }).from(dc).where(inArray(dc.id, ids));
  const parentIds = [...new Set(rows.flatMap((r) => r.parentProductIds))];
  const prods = parentIds.length ? await db.select({ id: schema.products.id, name: schema.products.name, customId: schema.products.customId }).from(schema.products).where(inArray(schema.products.id, parentIds)) : [];
  const labelOf = new Map(prods.map((p) => [p.id, p.customId || p.name]));
  const byId = new Map(rows.map((r) => [r.id, { id: r.id, code: r.code, status: r.status, dna: { ...(r.dna ?? {}) }, parentProductIds: r.parentProductIds, parentLabels: r.parentProductIds.map((x) => labelOf.get(x) ?? x), priceVnd: r.priceVnd }]));
  return cards.map((c) => (c.designConceptId && byId.has(c.designConceptId) ? { ...c, design: byId.get(c.designConceptId) ?? null } : c));
}

async function variantCountsByBatch(db: Db, batchIds: string[]): Promise<Map<string, Partial<Record<VariantStatus, number>>>> {
  const out = new Map<string, Partial<Record<VariantStatus, number>>>();
  if (batchIds.length === 0) return out;
  const rows = await db
    .select({ batchId: schema.creativeVariants.batchId, status: schema.creativeVariants.status, n: sql<number>`count(*)` })
    .from(schema.creativeVariants)
    .where(inArray(schema.creativeVariants.batchId, batchIds))
    .groupBy(schema.creativeVariants.batchId, schema.creativeVariants.status);
  for (const r of rows) {
    const m = out.get(r.batchId) ?? {};
    m[r.status as VariantStatus] = Number(r.n ?? 0);
    out.set(r.batchId, m);
  }
  return out;
}

const PUBLISHED_STATUSES: VariantStatus[] = ["LIVE", "PAUSED", "ENDED"];

/**
 * HẠN HIỆU LỰC của nhóm quảng cáo sau các lượt "cho tiêu thêm": `end_time` của lượt `EXTEND_ADSET`
 * ĐÃ ÁP gần nhất trong sổ (thứ đã thật sự gửi Facebook), không có thì không có mục trong kết quả.
 *
 * MỌI nơi hỏi "mẫu này hết khung chưa" phải đi qua đây. Đọc hạn gốc của lô là coi một mẫu đang tiêu
 * tiền theo hạn mới là đã dừng: lượt chấm chuyển nó sang ENDED và THÔI xét luật tắt — tiền chảy mà
 * không còn phanh.
 */
export async function extendedEndAtOf(db: Db, variantIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (variantIds.length === 0) return out;
  const fa = schema.creativeFbActions;
  const rows = await db
    .select({ variantId: sql<string>`${fa.variantId}`, endTime: sql<string | null>`${fa.request} ->> 'end_time'` })
    .from(fa)
    .where(and(inArray(fa.variantId, variantIds), eq(fa.action, "EXTEND_ADSET"), eq(fa.outcome, "APPLIED")));
  for (const r of rows) {
    const d = r.endTime ? new Date(r.endTime) : null;
    if (!d || !Number.isFinite(d.getTime())) continue;
    const prev = out.get(r.variantId);
    if (!prev || d > prev) out.set(r.variantId, d);
  }
  return out;
}

/** Hạn hiệu lực = muộn hơn giữa cuối khung test và hạn đã kéo. Không bao giờ SỚM hơn khung đã duyệt. */
export function effectiveEndAt(batchEndAt: Date, extended: Date | undefined): Date {
  return extended && extended > batchEndAt ? extended : batchEndAt;
}

/** Phán quyết SỐNG của một mẫu đã đăng — cùng bộ luật hai nguồn với lượt chấm (`evaluate.ts`). */
export function judgeLive(card: VariantCard, batch: Pick<BatchRow, "startAt" | "endAt" | "configSnapshot">, metrics: VariantMetricsRow, current: CreativeLoopConfig, now: Date): JudgeResult {
  return judgeVariant(
    {
      status: card.status,
      startAt: batch.startAt,
      endAt: batch.endAt,
      libraryAt: card.libraryAt ? new Date(card.libraryAt) : null,
      metrics,
    },
    effectiveJudgeConfig(batch.configSnapshot, current, card.rules),
    now,
  );
}

async function judgeCards(db: Db, rows: { card: VariantCard; batch: BatchRow }[], now: Date): Promise<JudgedVariant[]> {
  if (rows.length === 0) return [];
  const { config: current } = await readCurrentCreativeConfig(db);
  const [metrics, extended] = await Promise.all([
    variantMetrics(
      db,
      rows.map((r) => ({ id: r.card.id, fbAdId: r.card.fbAdId, startAt: r.batch.startAt })),
    ),
    extendedEndAtOf(
      db,
      rows.map((r) => r.card.id),
    ),
  ]);
  return rows.map(({ card, batch: b0 }) => {
    const batch = { ...b0, endAt: effectiveEndAt(b0.endAt, extended.get(card.id)) };
    const m = metrics.get(card.id) ?? { ...UNKNOWN_METRICS };
    const j = judgeLive(card, batch, m, current, now);
    return {
      ...card,
      batchDay: batch.batchDay,
      startAt: isoReq(batch.startAt),
      endAt: isoReq(batch.endAt),
      metrics: m,
      verdict: j.verdict,
      reasons: j.reasons,
      firedKillRule: j.firedKillRule,
      keepChecks: j.keepChecks,
    };
  });
}

function committedIfApproved(cards: VariantCard[], cfg: CreativeLoopConfig): number {
  const eligible = cards.filter((c) => c.status === "GENERATED").length;
  return Math.min(eligible, cfg.batchSize) * cfg.budgetPerVariantVnd;
}

// ───────────────────────────── HÀM ĐỌC CHO MÀN HÌNH ─────────────────────────────

/** Lô mới nhất đang `PENDING_APPROVAL` / `PLANNED` + các mẫu của nó. Không có ⇒ `null`. */
export async function getPendingBatch(db: Db): Promise<PendingBatch | null> {
  const [b] = await db
    .select()
    .from(schema.creativeBatches)
    .where(inArray(schema.creativeBatches.status, ["PENDING_APPROVAL", "PLANNED"]))
    .orderBy(desc(schema.creativeBatches.batchDay))
    .limit(1);
  if (!b) return null;
  return pendingOf(db, b);
}

async function pendingOf(db: Db, b: BatchRow): Promise<PendingBatch> {
  const rows = await variantQuery(db).where(eq(schema.creativeVariants.batchId, b.id)).orderBy(schema.creativeVariants.slot);
  const variants = await withDesigns(db, rows.map(toVariantCard));
  const counts: Partial<Record<VariantStatus, number>> = {};
  for (const v of variants) counts[v.status] = (counts[v.status] ?? 0) + 1;
  const { config, problems } = normalizeCreativeConfig(b.configSnapshot);
  return { batch: toBatchSummary(b, counts), variants, config, configProblems: problems, committedIfApprovedVnd: committedIfApproved(variants, config) };
}

/** Một lô bất kỳ: mẫu, cấu hình chụp, số đo + phán quyết sống của mẫu đã đăng, sổ ghi Facebook. */
export async function getBatchDetail(db: Db, batchId: string, now: Date = new Date()): Promise<BatchDetail | null> {
  const [b] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.id, batchId)).limit(1);
  if (!b) return null;
  const base = await pendingOf(db, b);
  const judged = await judgeCards(
    db,
    base.variants.filter((v) => PUBLISHED_STATUSES.includes(v.status)).map((card) => ({ card, batch: b })),
    now,
  );
  const fa = schema.creativeFbActions;
  const actionRows = await db
    .select({
      id: fa.id,
      variantId: fa.variantId,
      action: fa.action,
      outcome: fa.outcome,
      denial: fa.denial,
      detail: fa.detail,
      targetId: fa.targetId,
      amountVnd: fa.amountVnd,
      actorEmail: fa.actorEmail,
      mode: fa.mode,
      createdAt: fa.createdAt,
    })
    .from(fa)
    .where(eq(fa.batchId, batchId))
    .orderBy(desc(fa.createdAt))
    .limit(200);
  const actions: FbActionRow[] = actionRows.map((r) => ({ ...r, createdAt: isoReq(r.createdAt) }));
  return { ...base, judged, actions };
}

/** Các lô gần nhất (mới → cũ) kèm số mẫu theo trạng thái. */
export async function listRecentBatches(db: Db, limit = 14): Promise<BatchSummary[]> {
  const n = Math.max(1, Math.min(200, Math.round(limit)));
  const rows = await db.select().from(schema.creativeBatches).orderBy(desc(schema.creativeBatches.batchDay)).limit(n);
  const counts = await variantCountsByBatch(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((b) => toBatchSummary(b, counts.get(b.id) ?? {}));
}

/** Cửa sổ của màn "Đang chạy". */
export const LIVE_WINDOW_DAYS = 14;

/**
 * Mẫu đã đăng (LIVE / PAUSED / ENDED) của các lô chạy trong 14 ngày gần nhất, kèm số đo và phán quyết
 * SỐNG (`judgeVariant`, luật tắt của lô + luật giữ hiện tại — xem `effectiveJudgeConfig`).
 */
export async function listLiveVariants(db: Db, now: Date): Promise<JudgedVariant[]> {
  const from = new Date(now.getTime() - LIVE_WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({ ...variantSelect, batch: schema.creativeBatches })
    .from(schema.creativeVariants)
    .innerJoin(schema.creativeBatches, eq(schema.creativeBatches.id, schema.creativeVariants.batchId))
    .leftJoin(schema.products, eq(schema.products.id, schema.creativeVariants.productId))
    .leftJoin(schema.creativeImages, eq(schema.creativeImages.id, schema.creativeVariants.imageId))
    .where(and(inArray(schema.creativeVariants.status, PUBLISHED_STATUSES), gte(schema.creativeBatches.startAt, from), lte(schema.creativeBatches.startAt, now)))
    .orderBy(desc(schema.creativeBatches.startAt), schema.creativeVariants.slot);
  return judgeCards(
    db,
    rows.map((r) => ({ card: toVariantCard(r), batch: r.batch })),
    now,
  );
}

/** Thư viện: mẫu đã THẮNG (`library_at`), mới → cũ, kèm số đơn HIỆN TẠI. */
export async function listLibrary(db: Db): Promise<LibraryItem[]> {
  const rows = await db
    .select({ ...variantSelect, batch: schema.creativeBatches })
    .from(schema.creativeVariants)
    .innerJoin(schema.creativeBatches, eq(schema.creativeBatches.id, schema.creativeVariants.batchId))
    .leftJoin(schema.products, eq(schema.products.id, schema.creativeVariants.productId))
    .leftJoin(schema.creativeImages, eq(schema.creativeImages.id, schema.creativeVariants.imageId))
    .where(isNotNull(schema.creativeVariants.libraryAt))
    .orderBy(desc(schema.creativeVariants.libraryAt));
  const cards = rows.map((r) => ({ card: toVariantCard(r), batch: r.batch }));
  const metrics = await variantMetrics(
    db,
    cards.map((c) => ({ id: c.card.id, fbAdId: c.card.fbAdId, startAt: c.batch.startAt })),
  );
  return cards.map(({ card, batch }) => {
    const m = metrics.get(card.id) ?? { ...UNKNOWN_METRICS };
    return { ...card, batchDay: batch.batchDay, bookedOrders: m.bookedOrders, deliveredOrders: m.deliveredOrders, returnedOrders: m.returnedOrders, spendVnd: m.spendVnd };
  });
}

function parseGeneStats(raw: unknown): GeneStat[] {
  if (!Array.isArray(raw)) return [];
  const out: GeneStat[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    if (typeof r.key !== "string" || typeof r.value !== "string") continue;
    const n = (k: string) => (typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : 0);
    out.push({
      key: r.key as GeneStat["key"],
      value: r.value,
      tests: n("tests"),
      successes: n("successes"),
      wins: n("wins"),
      spendVnd: n("spendVnd"),
      bookedOrders: n("bookedOrders"),
      posteriorMean: typeof r.posteriorMean === "number" && Number.isFinite(r.posteriorMean) ? r.posteriorMean : 0.5,
      relativeCount: n("relativeCount"),
    });
  }
  return out;
}

/** Dòng sổ học mới nhất + chuỗi 14 ngày số quan sát. Chưa có lượt học nào ⇒ `null`. */
export async function getLatestLearning(db: Db): Promise<LatestLearning | null> {
  const lrn = schema.creativeLearnings;
  const [row] = await db.select().from(lrn).orderBy(desc(lrn.learningDay)).limit(1);
  if (!row) return null;
  const fromDay = shiftDay(row.learningDay, -13);
  const hist = await db
    .select({ day: lrn.learningDay, observations: lrn.observations, relative: lrn.relativeObservations })
    .from(lrn)
    .where(and(gte(lrn.learningDay, fromDay), lte(lrn.learningDay, row.learningDay)));
  const byDay = new Map(hist.map((h) => [h.day, h]));
  const series: LearningPoint[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const day = shiftDay(row.learningDay, -i);
    const h = byDay.get(day);
    series.push({ day, observations: h ? h.observations : null, relativeObservations: h ? h.relative : null });
  }
  return {
    learningDay: row.learningDay,
    geneStats: parseGeneStats(row.geneStats),
    observations: row.observations,
    relativeObservations: row.relativeObservations,
    narrative: row.narrative,
    narrativeModel: row.narrativeModel,
    ruleVersion: row.ruleVersion,
    genesVersion: row.genesVersion,
    updatedAt: isoReq(row.updatedAt),
    series,
  };
}

/** Nguồn ảnh đầu vào + số lần đã dùng. Không kèm điểm ảnh. */
export async function listSources(db: Db, filters: SourceFilters = {}): Promise<SourceRow[]> {
  const src = schema.creativeSources;
  const conds: SQL[] = [];
  if (filters.activeOnly !== false) conds.push(eq(src.active, true));
  if (filters.kind) conds.push(eq(src.kind, filters.kind));
  if (filters.productId) conds.push(eq(src.productId, filters.productId));
  const q = (filters.q ?? "").trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const text = or(sql`${src.title} ilike ${like}`, sql`${src.note} ilike ${like}`, sql`${src.visionSummary} ilike ${like}`, sql`${schema.products.name} ilike ${like}`);
    if (text) conds.push(text);
  }
  const limit = Math.max(1, Math.min(500, Math.round(filters.limit ?? 200)));
  const used = sql<number>`(select count(*) from creative_variants cv where cv.product_photo_source_id = ${src.id} or cv.inspiration_source_id = ${src.id})`;
  const lastUsed = sql<Date | string | null>`(select max(cv.created_at) from creative_variants cv where cv.product_photo_source_id = ${src.id} or cv.inspiration_source_id = ${src.id})`;
  const rows = await db
    .select({
      s: src,
      productName: schema.products.name,
      imageRowId: schema.creativeImages.id,
      imagePurgedAt: schema.creativeImages.purgedAt,
      usedCount: used,
      lastUsedAt: lastUsed,
    })
    .from(src)
    .leftJoin(schema.products, eq(schema.products.id, src.productId))
    .leftJoin(schema.creativeImages, eq(schema.creativeImages.id, src.imageId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(src.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.s.id,
    kind: r.s.kind as CreativeSourceKind,
    productId: r.s.productId,
    productName: r.productName ?? null,
    title: r.s.title,
    note: r.s.note,
    sourceUrl: r.s.sourceUrl,
    imageId: r.s.imageId,
    imageAvailable: r.s.imageId !== null && r.imageRowId !== null && r.imagePurgedAt === null,
    genes: { ...(r.s.genes ?? {}) },
    visionSummary: r.s.visionSummary,
    visionModel: r.s.visionModel,
    visionAt: iso(r.s.visionAt),
    active: r.s.active,
    createdByName: r.s.createdByName,
    createdAt: isoReq(r.s.createdAt),
    usedCount: Number(r.usedCount ?? 0),
    lastUsedAt: iso(r.lastUsedAt),
  }));
}

// ───────────────────────────── ĐẦU VÀO CỦA LƯỢT CHẤM ─────────────────────────────

/** Cửa sổ của lượt chấm: mẫu đăng trong bấy nhiêu ngày (cộng mọi mẫu đã vào thư viện). */
export const EVALUATE_WINDOW_DAYS = 45;

export type EvaluateCandidate = {
  variant: VariantRow;
  batch: Pick<BatchRow, "id" | "batchDay" | "startAt" | "endAt" | "configSnapshot">;
};

/**
 * Mẫu mà lượt chấm phải xét: LIVE / PAUSED / ENDED đăng trong 45 ngày (theo `published_at`, thiếu thì
 * theo giờ chạy của lô) + MỌI mẫu đã vào thư viện. Dùng chung cho `evaluateCreatives` để hàm ghi
 * không tự dựng câu chọn thứ hai.
 */
export async function evaluationCandidates(db: Db, now: Date): Promise<EvaluateCandidate[]> {
  const v = schema.creativeVariants;
  const b = schema.creativeBatches;
  const from = new Date(now.getTime() - EVALUATE_WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({ variant: v, batch: { id: b.id, batchDay: b.batchDay, startAt: b.startAt, endAt: b.endAt, configSnapshot: b.configSnapshot } })
    .from(v)
    .innerJoin(b, eq(b.id, v.batchId))
    .where(or(and(inArray(v.status, PUBLISHED_STATUSES), sql`coalesce(${v.publishedAt}, ${b.startAt}) >= ${from.toISOString()}::timestamptz`), isNotNull(v.libraryAt)))
    .orderBy(b.batchDay, v.slot);
  // Khung của TỪNG mẫu là khung hiệu lực (đã tính lượt tiêu thêm) — xem `extendedEndAtOf`.
  const extended = await extendedEndAtOf(
    db,
    rows.map((r) => r.variant.id),
  );
  return rows.map((r) => ({ ...r, batch: { ...r.batch, endAt: effectiveEndAt(r.batch.endAt, extended.get(r.variant.id)) } }));
}

/**
 * Mẫu THUA mà điểm ảnh đã quá hạn giữ và KHÔNG còn ai cần tới — ứng viên xoá điểm ảnh.
 *
 * Giữ lại (không trả về) khi BẤT KỲ điều nào sau đây đúng:
 *  · mẫu đã vào thư viện;
 *  · là CHA của một mẫu đang LIVE, đang chờ sinh/duyệt (PLANNED / GENERATED), hoặc đã vào thư viện —
 *    ảnh cha là điểm ảnh gốc của ô KHAI THÁC. Đặc tả chỉ nói "LIVE / thư viện"; hai trạng thái chờ
 *    được thêm vì xoá ảnh cha giữa lúc lập lô và lúc sinh ảnh là làm hỏng chính ô ấy;
 *  · ảnh là ảnh của một nguồn `PRODUCT_PHOTO` (không bao giờ xoá ảnh sản phẩm thật);
 *  · ảnh còn được một mẫu KHÁC dùng mà mẫu ấy chưa phải "thua quá hạn".
 */
export async function purgeCandidates(db: Db, now: Date, retentionDays: number): Promise<{ variantId: string; imageId: string }[]> {
  const v = schema.creativeVariants;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const rows = await db
    .select({ variantId: v.id, imageId: sql<string>`${v.imageId}` })
    .from(v)
    .innerJoin(schema.creativeImages, eq(schema.creativeImages.id, v.imageId))
    .where(
      and(
        isNotNull(v.lostAt),
        sql`${v.lostAt} < ${cutoff.toISOString()}::timestamptz`,
        isNull(v.libraryAt),
        isNull(schema.creativeImages.purgedAt),
        sql`not exists (select 1 from creative_variants ch where ch.parent_variant_id = ${v.id}
              and (ch.status in ('LIVE','PLANNED','GENERATED') or ch.library_at is not null))`,
        sql`not exists (select 1 from creative_sources cs where cs.image_id = ${v.imageId} and cs.kind = 'PRODUCT_PHOTO')`,
        sql`not exists (select 1 from creative_variants ov where ov.image_id = ${v.imageId} and ov.id <> ${v.id}
              and (ov.library_at is not null or ov.lost_at is null or ov.lost_at >= ${cutoff.toISOString()}::timestamptz))`,
      ),
    );
  return rows;
}
