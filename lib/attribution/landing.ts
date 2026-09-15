/**
 * ═══════════ ĐỌC BẰNG CHỨNG TRACKING CỦA ĐƠN LANDING VÀ KẾT LUẬN ═══════════
 *
 * Hợp đồng và lý lẽ ở `lib/constants/landing-attribution.ts`. Tệp này chỉ đi lấy dữ liệu và ghi.
 *
 * ─── ĐỌC Ô TRACKING TỪ ĐÂU ───
 *
 * `landing_orders.raw` là ảnh chụp NGUYÊN VĂN cả dòng sheet, khoá là tiêu đề cột. Shop đã đổi bố
 * cục form ba lần, nên cùng một thông tin nằm ở ba tên cột khác nhau (`utm_source` ở bố cục có
 * tiêu đề, `Cột 13` ở bố cục không tiêu đề…). Danh sách tên cột dưới đây là danh sách ĐÓNG, dựng
 * từ số đo thật trên production 15/09/2026 — không dò chữ, không đoán theo vị trí.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { productCodeFromText } from "@/lib/constants/landing";
import {
  LANDING_ATTRIBUTION_RULE_VERSION,
  resolveLandingAttribution,
  type AdRecord,
  type CampaignRecord,
  type LandingAttribution,
  type LandingTracking,
} from "@/lib/constants/landing-attribution";

const L = schema.landingOrders;
const LA = schema.landingAttributions;

/**
 * TÊN CỘT MANG TỪNG Ô TRACKING, xếp theo thứ tự ưu tiên đọc.
 *
 * Vì sao `utm_term` KHÔNG nằm trong danh sách `adId`: đo production, ô ấy chứa một TÊN chiến dịch
 * ("QA4_CĐ_08/09_Q003_ĐỎ_Hải An Luxury CS3_5"), không phải một id. Form đặt sai tên ô, và tin vào
 * cái tên ấy là tự dựng một bằng chứng không tồn tại.
 */
const COLS = {
  adId: ["ad_id", "Cột 17"],
  adsetId: ["adset_id", "Cột 16"],
  /** Ô mang TÊN CHIẾN DỊCH — khoá của bậc bằng chứng thứ ba. */
  campaignName: ["utm_source", "Cột 13"],
  /** Tên chiến dịch Meta ("Quảng cáo Lượt tương tác mới TXT") — chỉ để người đọc đối chiếu. */
  utmCampaign: ["utm_campaign", "Cột 15"],
  landingUrl: ["Link landing", "utm_content", "Cột 12", "Cột 14"],
} as const;

/** Đọc ô tracking từ ảnh chụp dòng sheet. Ô trống ⇒ `null` (KHÔNG CÓ), không phải chuỗi rỗng. */
export function readTracking(raw: unknown, fallbackAdId?: string | null): LandingTracking {
  const row = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  const pick = (keys: readonly string[]): string | null => {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  const numeric = (keys: readonly string[]): string | null => {
    const v = pick(keys);
    return v && /^[0-9]{10,25}$/.test(v) ? v : null;
  };
  return {
    adId: numeric(COLS.adId) ?? (fallbackAdId && /^[0-9]{10,25}$/.test(fallbackAdId) ? fallbackAdId : null),
    adsetId: numeric(COLS.adsetId),
    campaignName: pick(COLS.campaignName),
    utmCampaign: pick(COLS.utmCampaign),
    landingUrl: pick(COLS.landingUrl),
  };
}

/** Sổ tra cứu nạp MỘT LẦN cho cả lượt đối soát — mỗi đơn tra trong bộ nhớ, không truy vấn lại. */
export type LandingLookups = {
  adById: Map<string, AdRecord>;
  adsByAdsetId: Map<string, AdRecord[]>;
  campaignByName: Map<string, CampaignRecord>;
  marketerOfCampaignId: Map<string, string>;
  knownPageIds: Set<string>;
};

export async function loadLandingLookups(db?: Db): Promise<LandingLookups> {
  const d = db ?? (await getDb());
  const ads = await d
    .select({ adId: schema.fbAds.id, adsetId: schema.fbAds.adsetId, campaignId: schema.fbAds.campaignId, accountId: schema.fbAds.accountId, storyId: schema.fbAds.storyId })
    .from(schema.fbAds);
  const adById = new Map<string, AdRecord>();
  const adsByAdsetId = new Map<string, AdRecord[]>();
  for (const a of ads) {
    const rec: AdRecord = { adId: a.adId, adsetId: a.adsetId, campaignId: a.campaignId, accountId: a.accountId, storyId: a.storyId };
    adById.set(a.adId, rec);
    if (a.adsetId) {
      const list = adsByAdsetId.get(a.adsetId);
      if (list) list.push(rec);
      else adsByAdsetId.set(a.adsetId, [rec]);
    }
  }

  /*
    GỘP THEO TÊN CHIẾN DỊCH. `array_agg(distinct …)` chính là phép đếm nhập nhằng: tên nào ra hai
    marketer thì mảng ấy có hai phần tử, và hàm thuần ở tầng hằng số sẽ từ chối kết luận. Lọc
    `excluded = false` vì chiến dịch của shop khác trong cùng Business Manager không phải tiền của
    shop này — cùng luật với mọi báo cáo quảng cáo khác.
  */
  const campaigns = await d
    .select({
      campaignName: schema.adSpends.campaign,
      campaignIds: sql<string[]>`array_remove(array_agg(distinct ${schema.adSpends.campaignId}), null)`,
      accountIds: sql<string[]>`array_remove(array_agg(distinct ${schema.adSpends.accountId}), null)`,
      marketerIds: sql<string[]>`array_remove(array_agg(distinct nullif(${schema.adSpends.marketerId}, '')), null)`,
    })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.excluded, false), sql`${schema.adSpends.campaign} <> ''`))
    .groupBy(schema.adSpends.campaign);
  const campaignByName = new Map<string, CampaignRecord>();
  const marketerOfCampaignId = new Map<string, string>();
  for (const c of campaigns) {
    campaignByName.set(c.campaignName, {
      campaignName: c.campaignName,
      campaignIds: c.campaignIds ?? [],
      accountIds: c.accountIds ?? [],
      marketerIds: c.marketerIds ?? [],
    });
  }

  // `campaign_id` → marketer, CHỈ chiến dịch có đúng một người khai. Cùng luật với
  // `CAMPAIGN_TO_MARKETER` của `lib/queries/order-marketer.ts` — không dựng định nghĩa thứ hai.
  const byCampaignId = await d
    .select({ campaignId: schema.adSpends.campaignId, marketerId: sql<string>`min(nullif(${schema.adSpends.marketerId}, ''))` })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.excluded, false), isNotNull(schema.adSpends.campaignId), sql`nullif(${schema.adSpends.marketerId}, '') is not null`))
    .groupBy(schema.adSpends.campaignId)
    .having(sql`count(distinct ${schema.adSpends.marketerId}) = 1`);
  for (const r of byCampaignId) if (r.campaignId && r.marketerId) marketerOfCampaignId.set(r.campaignId, r.marketerId);

  const pages = await d.select({ externalPageId: schema.fanpages.externalPageId }).from(schema.fanpages);
  return { adById, adsByAdsetId, campaignByName, marketerOfCampaignId, knownPageIds: new Set(pages.map((p) => p.externalPageId)) };
}

/** Một đơn landing kèm kết luận — đủ để ghi vào `landing_attributions` và để báo cáo đọc. */
export type LandingVerdict = {
  orderId: string;
  landingOrderId: string;
  tracking: LandingTracking;
  attribution: LandingAttribution;
  /** Mã hàng mà TÊN CHIẾN DỊCH nói tới (nếu đọc được). Không bao giờ ghi đè mã hàng của đơn. */
  campaignProductCode: string | null;
  /** Mã hàng THẬT trên dòng hàng của đơn. */
  orderProductCodes: string[];
  productMismatch: boolean;
};

/**
 * KẾT LUẬN CHO MỌI ĐƠN LANDING ĐÃ NỐI ĐƯỢC SANG PANCAKE.
 *
 * Chỉ xét dòng landing có `order_id`: dòng chưa lên đơn thì chưa có doanh thu nào để quy kết.
 */
export async function judgeLandingOrders(db?: Db): Promise<LandingVerdict[]> {
  const d = db ?? (await getDb());
  const lookups = await loadLandingLookups(d);
  const rows = await d
    .select({ id: L.id, orderId: L.orderId, adId: L.adId, raw: L.raw })
    .from(L)
    .where(isNotNull(L.orderId));

  /*
    ═══ KẾT LUẬN ĐÃ CHỤP THÌ ĐỨNG YÊN ═══

    `ad_spends.marketer_id` là SỔ KHAI HIỆN HÀNH: chủ shop đổi người phụ trách một chiến dịch hôm
    nay là ô ấy đổi ngay. Tính lại từ đầu mỗi lượt đối soát thì đơn của tháng trước đổi chủ theo —
    đúng lớp lỗi mà ảnh chụp fanpage sinh ra để chặn (`lib/constants/payroll.ts`).
    
    Nên đơn NÀO ĐÃ CÓ kết luận ở CÙNG phiên bản luật thì giữ nguyên kết luận ấy; chỉ đơn chưa quy
    kết được mới hỏi lại sổ. Đổi LUẬT (tăng `LANDING_ATTRIBUTION_RULE_VERSION`) là lời tuyên bố
    tường minh rằng phải tính lại tất cả — và lúc ấy dòng cũ vẫn tìm ra được bằng `rule_version`.
  */
  const frozen = new Map(
    (
      await d
        .select({ orderId: LA.orderId, tier: LA.tier, marketerId: LA.marketerId, adAccountId: LA.adAccountId, campaignId: LA.campaignId, adsetId: LA.adsetId, adId: LA.adId, pageId: LA.pageId, evidence: LA.evidence, ruleVersion: LA.ruleVersion })
        .from(LA)
    )
      .filter((r) => r.marketerId && r.ruleVersion === LANDING_ATTRIBUTION_RULE_VERSION)
      .map((r) => [
        r.orderId,
        {
          resolved: true,
          tier: r.tier as LandingAttribution["tier"],
          gap: null,
          marketerId: r.marketerId,
          adAccountId: r.adAccountId,
          campaignId: r.campaignId,
          adsetId: r.adsetId,
          adId: r.adId,
          pageId: r.pageId,
          evidence: r.evidence,
        } satisfies LandingAttribution,
      ]),
  );

  const orderIds = rows.map((r) => r.orderId).filter((x): x is string => Boolean(x));
  const codeByOrder = new Map<string, string[]>();
  if (orderIds.length) {
    /*
      MÃ HÀNG ĐỌC TỪ DÒNG HÀNG THẬT CỦA ĐƠN (`products.custom_id`), không từ chiến dịch. Landing
      chạy Q003 mà khách đặt Q004 thì đơn vẫn là Q004 — chênh lệch ấy được ĐÁNH DẤU, không được sửa.
    */
    const items = await d
      .select({
        orderId: schema.orderItems.orderId,
        code: sql<string | null>`coalesce(${schema.products.customId}, '')`,
        sku: sql<string | null>`coalesce(${schema.orderItems.sku}, '')`,
      })
      .from(schema.orderItems)
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderItems.variantId))
      .leftJoin(schema.products, eq(schema.products.id, sql`coalesce(${schema.productVariants.productId}, ${schema.orderItems.productId})`))
      .where(sql`${schema.orderItems.orderId} in (${sql.join(orderIds.map((x) => sql`${x}`), sql`, `)})`);
    for (const it of items) {
      /*
        HAI NGUỒN CHO MÃ HÀNG CỦA MỘT DÒNG, và cả hai đều đọc từ CHÍNH ĐƠN:
          · `products.custom_id` — mã đã khai trong sổ sản phẩm (chính xác nhất);
          · mã nằm trong `sku` — đơn chưa ghép được mẫu mã thì đây là thứ duy nhất còn lại.
        Không có nguồn nào thì mảng rỗng, và mảng rỗng KHÔNG bao giờ sinh ra một kết luận "lệch
        mã": chưa biết mã của đơn thì chưa so được với gì.
      */
      const add = (raw: string) => {
        const code = raw.trim().toUpperCase();
        if (!code) return;
        const list = codeByOrder.get(it.orderId);
        if (list) {
          if (!list.includes(code)) list.push(code);
        } else codeByOrder.set(it.orderId, [code]);
      };
      add(it.code ?? "");
      add(productCodeFromText(it.sku ?? ""));
    }
  }

  /*
    ═══ MỘT ĐƠN CÓ THỂ CÓ HAI DÒNG LANDING ═══

    Khách gửi form hai lần thì hai dòng sheet cùng trỏ vào một đơn Pancake. `order-source.ts` đã
    ghi lại đúng cái bẫy này (nó dùng `exists` thay vì `join` vì lý do ấy). Ở đây hệ quả nặng hơn
    một con số bị nhân đôi: hai dòng cùng `order_id` làm lượt ghi `on conflict` hỏng giữa chừng.

    Nên mỗi đơn chỉ giữ MỘT kết luận, và phép chọn phải ỔN ĐỊNH — chạy hai lần ra cùng một kết
    quả: có bằng chứng thắng không có, bằng chứng MẠNH thắng bằng chứng yếu, hoà thì lấy dòng
    landing có id nhỏ nhất.
  */
  const TIER_RANK: Record<string, number> = { AD_ID: 3, ADSET_ID: 2, CAMPAIGN_NAME: 1 };
  const best = new Map<string, LandingVerdict>();
  const out: LandingVerdict[] = [];
  for (const r of rows) {
    if (!r.orderId) continue;
    const tracking = readTracking(r.raw, r.adId);
    const attribution = frozen.get(r.orderId) ?? resolveLandingAttribution({ tracking, ...lookups });
    const campaignProductCode = productCodeFromText(tracking.campaignName ?? "") || productCodeFromText(tracking.landingUrl ?? "") || null;
    const orderProductCodes = codeByOrder.get(r.orderId) ?? [];
    const verdict: LandingVerdict = {
      orderId: r.orderId,
      landingOrderId: r.id,
      tracking,
      attribution,
      campaignProductCode: campaignProductCode || null,
      orderProductCodes,
      productMismatch: Boolean(campaignProductCode && orderProductCodes.length > 0 && !orderProductCodes.includes(campaignProductCode)),
    };
    const current = best.get(r.orderId);
    if (!current || betterVerdict(verdict, current, TIER_RANK)) best.set(r.orderId, verdict);
  }
  out.push(...best.values());
  return out;
}

/** `a` có đáng giữ hơn `b` không. Thứ tự phải TOÀN PHẦN, nếu không hai lượt chạy ra hai kết quả. */
function betterVerdict(a: LandingVerdict, b: LandingVerdict, rank: Record<string, number>): boolean {
  if (a.attribution.resolved !== b.attribution.resolved) return a.attribution.resolved;
  const ra = rank[a.attribution.tier ?? ""] ?? 0;
  const rb = rank[b.attribution.tier ?? ""] ?? 0;
  if (ra !== rb) return ra > rb;
  return a.landingOrderId < b.landingOrderId;
}

export type LandingRebuild = {
  scanned: number;
  resolved: number;
  byTier: Record<string, number>;
  byGap: Record<string, number>;
  productMismatch: number;
  changed: number;
  ruleVersion: number;
};

/**
 * GHI ẢNH CHỤP BẰNG CHỨNG LANDING. Idempotent theo `order_id`; `dryRun` chỉ đếm, không ghi.
 *
 * KHÔNG đụng `order_attributions` ở đây: kết luận cuối cùng do `rebuildFanpageAttribution` ghi,
 * để một đơn không bao giờ có hai nơi cùng ghi trạng thái của nó.
 */
export async function rebuildLandingAttribution(options?: { dryRun?: boolean; db?: Db; verdicts?: LandingVerdict[] }): Promise<LandingRebuild> {
  const d = options?.db ?? (await getDb());
  const dryRun = options?.dryRun === true;
  const verdicts = options?.verdicts ?? (await judgeLandingOrders(d));

  const byTier: Record<string, number> = {};
  const byGap: Record<string, number> = {};
  let resolved = 0;
  let productMismatch = 0;
  for (const v of verdicts) {
    if (v.attribution.resolved) resolved++;
    if (v.attribution.tier) byTier[v.attribution.tier] = (byTier[v.attribution.tier] ?? 0) + 1;
    if (v.attribution.gap) byGap[v.attribution.gap] = (byGap[v.attribution.gap] ?? 0) + 1;
    if (v.productMismatch) productMismatch++;
  }

  const prior = await d.select({ orderId: LA.orderId, marketerId: LA.marketerId, tier: LA.tier, gap: LA.gap, ruleVersion: LA.ruleVersion }).from(LA);
  const priorByOrder = new Map(prior.map((p) => [p.orderId, p]));
  let changed = 0;
  const rows: (typeof LA.$inferInsert)[] = verdicts.map((v) => {
    const before = priorByOrder.get(v.orderId);
    if (!before || before.marketerId !== v.attribution.marketerId || before.tier !== v.attribution.tier || before.gap !== v.attribution.gap || before.ruleVersion !== LANDING_ATTRIBUTION_RULE_VERSION) changed++;
    return {
      orderId: v.orderId,
      landingOrderId: v.landingOrderId,
      tier: v.attribution.tier,
      gap: v.attribution.gap,
      marketerId: v.attribution.marketerId,
      adAccountId: v.attribution.adAccountId,
      campaignId: v.attribution.campaignId,
      adsetId: v.attribution.adsetId,
      adId: v.attribution.adId,
      pageId: v.attribution.pageId,
      utm: v.tracking,
      landingUrl: v.tracking.landingUrl,
      campaignProductCode: v.campaignProductCode,
      productMismatch: v.productMismatch,
      evidence: v.attribution.evidence,
      ruleVersion: LANDING_ATTRIBUTION_RULE_VERSION,
      computedAt: new Date(),
    };
  });

  if (!dryRun) {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      if (!chunk.length) continue;
      await d
        .insert(LA)
        .values(chunk)
        .onConflictDoUpdate({
          target: LA.orderId,
          set: {
            landingOrderId: sql`excluded.landing_order_id`,
            tier: sql`excluded.tier`,
            gap: sql`excluded.gap`,
            marketerId: sql`excluded.marketer_id`,
            adAccountId: sql`excluded.ad_account_id`,
            campaignId: sql`excluded.campaign_id`,
            adsetId: sql`excluded.adset_id`,
            adId: sql`excluded.ad_id`,
            pageId: sql`excluded.page_id`,
            utm: sql`excluded.utm`,
            landingUrl: sql`excluded.landing_url`,
            campaignProductCode: sql`excluded.campaign_product_code`,
            productMismatch: sql`excluded.product_mismatch`,
            evidence: sql`excluded.evidence`,
            ruleVersion: sql`excluded.rule_version`,
            computedAt: sql`excluded.computed_at`,
          },
        });
    }
  }

  return { scanned: verdicts.length, resolved, byTier, byGap, productMismatch, changed, ruleVersion: LANDING_ATTRIBUTION_RULE_VERSION };
}
