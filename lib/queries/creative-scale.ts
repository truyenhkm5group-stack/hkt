import { desc, eq, gte, ne, or } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_HARD_LIMITS, SCALE_KINDS, type CreativeVerdict, type ScaleDraftStatus, type ScaleKind, type VariantStatus } from "@/lib/constants/creative-loop";
import { judgeVariant } from "@/lib/creative/judge";
import { effectiveEndAt, effectiveJudgeConfig, extendedEndAtOf, readCurrentCreativeConfig, variantMetrics, type VariantMetricsRow } from "@/lib/queries/creative-loop";

/**
 * ═══════════ SCALE MẪU THẮNG — HÀM ĐỌC CHO MÀN HÌNH (CHỈ ĐỌC) ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §5f. Mọi phép ghi nằm ở `lib/creative/scale.ts`.
 *
 * Một hàng = một MẪU có ít nhất một dòng nháp; hai ô = hai loại scale. Số đo và phán quyết là SỐNG
 * (cùng đường với tab Đang chạy); số đo lúc đề nghị nằm ở `proposal_metrics` của từng dòng nháp.
 * Nháp đã BỎ QUA quá `DISMISSED_VISIBLE_DAYS` ngày thì không hiện nữa.
 */

export const DISMISSED_VISIBLE_DAYS = 7;

export type ScaleDraftCell = {
  id: string;
  kind: ScaleKind;
  status: ScaleDraftStatus;
  fbCampaignId: string | null;
  fbAdsetId: string | null;
  fbAdId: string | null;
  fbCreativeId: string | null;
  budgetLevel: string;
  dailyBudgetVnd: number | null;
  error: string;
  draftedByName: string;
  draftedAt: string | null;
  approvedByName: string;
  approvedAt: string | null;
  /** Đã từng thử sao chép — nháp hỏng loại này không dựng lại được (có thể có bản sao mồ côi). */
  copyAttempted: boolean;
};

export type ScaleRow = {
  variantId: string;
  batchDay: string;
  slot: number;
  headline: string;
  productName: string | null;
  productId: string | null;
  imageId: string | null;
  imageAvailable: boolean;
  verdict: CreativeVerdict;
  metrics: VariantMetricsRow | null;
  cells: Partial<Record<ScaleKind, ScaleDraftCell>>;
  /** Mốc mới nhất trong các dòng nháp — để xếp hàng. */
  touchedAt: string;
};

export type ScaleOverview = {
  rows: ScaleRow[];
  adAccountId: string;
  templates: Record<ScaleKind, string>;
  dailyBudgetVnd: number;
  activeTotalVnd: number;
  activeCapVnd: number;
  perCampaignCapVnd: number;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function scaleOverview(db: Db, now: Date): Promise<ScaleOverview> {
  const { config } = await readCurrentCreativeConfig(db);
  const D = schema.creativeScaleDrafts;
  const since = new Date(now.getTime() - DISMISSED_VISIBLE_DAYS * 86_400_000);
  const rows = await db
    .select({ d: D, v: schema.creativeVariants, b: schema.creativeBatches, productName: schema.products.name, imagePurgedAt: schema.creativeImages.purgedAt, imageRowId: schema.creativeImages.id })
    .from(D)
    .innerJoin(schema.creativeVariants, eq(schema.creativeVariants.id, D.variantId))
    .innerJoin(schema.creativeBatches, eq(schema.creativeBatches.id, schema.creativeVariants.batchId))
    .leftJoin(schema.products, eq(schema.products.id, schema.creativeVariants.productId))
    .leftJoin(schema.creativeImages, eq(schema.creativeImages.id, schema.creativeVariants.imageId))
    .where(or(ne(D.status, "DISMISSED"), gte(D.updatedAt, since)))
    .orderBy(desc(D.updatedAt))
    .limit(200);

  const variantIds = [...new Set(rows.map((r) => r.v.id))];
  const firstOf = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!firstOf.has(r.v.id)) firstOf.set(r.v.id, r);
  const [metrics, extended] = await Promise.all([
    variantMetrics(
      db,
      [...firstOf.values()].map((r) => ({ id: r.v.id, fbAdId: r.v.fbAdId, startAt: r.b.startAt })),
    ),
    extendedEndAtOf(db, variantIds),
  ]);

  const out = new Map<string, ScaleRow>();
  for (const r of rows) {
    let row = out.get(r.v.id);
    if (!row) {
      const m = metrics.get(r.v.id) ?? null;
      const verdict: CreativeVerdict = m
        ? judgeVariant(
            { status: r.v.status as VariantStatus, startAt: r.b.startAt, endAt: effectiveEndAt(r.b.endAt, extended.get(r.v.id)), libraryAt: r.v.libraryAt, metrics: m },
            effectiveJudgeConfig(r.b.configSnapshot, config),
            now,
          ).verdict
        : "PENDING";
      row = {
        variantId: r.v.id,
        batchDay: r.b.batchDay,
        slot: r.v.slot,
        headline: r.v.headline,
        productName: r.productName ?? null,
        productId: r.v.productId,
        imageId: r.v.imageId,
        imageAvailable: !!r.imageRowId && r.imagePurgedAt === null,
        verdict,
        metrics: m,
        cells: {},
        touchedAt: r.d.updatedAt.toISOString(),
      };
      out.set(r.v.id, row);
    }
    const kind = r.d.kind as ScaleKind;
    row.cells[kind] = {
      id: r.d.id,
      kind,
      status: r.d.status as ScaleDraftStatus,
      fbCampaignId: r.d.fbCampaignId,
      fbAdsetId: r.d.fbAdsetId,
      fbAdId: r.d.fbAdId,
      fbCreativeId: r.d.fbCreativeId,
      budgetLevel: r.d.budgetLevel,
      dailyBudgetVnd: r.d.dailyBudgetVnd,
      error: r.d.error,
      draftedByName: r.d.draftedByName,
      draftedAt: iso(r.d.draftedAt),
      approvedByName: r.d.approvedByName,
      approvedAt: iso(r.d.approvedAt),
      copyAttempted: r.d.copyAttemptedAt !== null || r.d.fbCampaignId !== null,
    };
  }

  const active = await db.select({ b: D.dailyBudgetVnd }).from(D).where(eq(D.status, "ACTIVE"));
  const activeTotalVnd = active.reduce((s, a) => s + (a.b ?? 0), 0);

  return {
    rows: [...out.values()],
    adAccountId: config.adAccountId,
    templates: Object.fromEntries(SCALE_KINDS.map((k) => [k, k === "LEADS" ? config.scaleTemplates.leadsCampaignId : config.scaleTemplates.purchaseMessagingCampaignId])) as Record<ScaleKind, string>,
    dailyBudgetVnd: config.scaleDailyBudgetVnd,
    activeTotalVnd,
    activeCapVnd: CREATIVE_HARD_LIMITS.maxScaleActiveDailyTotalVnd,
    perCampaignCapVnd: CREATIVE_HARD_LIMITS.maxScaleDailyBudgetVnd,
  };
}

/** Link Ads Manager tới đúng chiến dịch — để người mở bản nháp, sửa tay hoặc xoá. */
export function adsManagerCampaignUrl(adAccountId: string, campaignId: string): string {
  const act = adAccountId.replace(/^act_/, "");
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(act)}&selected_campaign_ids=${encodeURIComponent(campaignId)}`;
}
