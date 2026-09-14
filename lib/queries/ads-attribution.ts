import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AMBIGUOUS_BY_POST, LINKED_BY_POST } from "@/lib/queries/ads-attribution-link";
import { metricScope } from "@/lib/queries/metrics";
import type { Period } from "@/lib/search-params";

/**
 * ───────────── ĐỘ PHỦ QUY KẾT QUẢNG CÁO ─────────────
 *
 * Đặc tả: docs/ads-attribution-audit.md.
 *
 * Câu hỏi duy nhất mà file này trả lời: **bao nhiêu phần trăm tiền quảng cáo và bao nhiêu phần trăm
 * đơn hàng thật sự nối được với nhau** — và phần không nối được nằm ở đâu.
 *
 * Vì sao phải đo trước khi tin bất kỳ chỉ số ROAS nào: nếu chỉ 30% đơn có `ad_id` thì "ROAS 4.2"
 * là ROAS của 30% đó, không phải của shop. Con số vẫn đúng, nhưng đọc nó như thể nó nói về toàn
 * shop là tự lừa mình.
 *
 * KHÔNG BỊA QUY KẾT: phần không nối được luôn hiện thành số riêng, không bao giờ chia đều cho các
 * chiến dịch.
 */

const o = schema.orders;
const a = schema.adSpends;

export type AdsCoverageRow = {
  key: string;
  label: string;
  /** Cái được đo: dòng chi tiêu hay đơn hàng. */
  unit: "spend" | "order";
  matched: number;
  total: number;
  coverage: number;
  /** Ghi chú: vì sao phần còn lại không nối được. */
  note: string;
};

export type AdsAttributionAudit = {
  rows: AdsCoverageRow[];
  /** Tiền quảng cáo trong kỳ (đã bỏ chiến dịch đánh dấu loại trừ). */
  totalSpend: number;
  /** Tiền quảng cáo của các dòng KHÔNG gắn được chiến dịch nào có đơn. */
  spendUnattributed: number;
  /** Số mẩu quảng cáo đã bị Facebook xoá hoặc ERP không có quyền đọc. */
  adsMissing: number;
  /** Cấp phân tích KHÔNG có dữ liệu — nêu tên để không ai đi tìm. */
  unavailableLevels: { level: string; reason: string }[];
};

function spendWhere(period: Period) {
  const conds = [eq(a.excluded, false)];
  if (period.from) conds.push(gte(a.spendDate, period.from));
  if (period.to) conds.push(lte(a.spendDate, period.to));
  return and(...conds);
}

export async function getAdsAttributionAudit(period: Period): Promise<AdsAttributionAudit> {
  const db = await getDb();
  const scope = metricScope(period, "confirmed");
  const HAS_AD = sql`${o.adId} is not null and ${o.adId} <> ''`;

  const [spendRow] = await db
    .select({
      rows: sql<number>`count(*)`,
      spend: sql<number>`coalesce(sum(${a.spend}), 0)`,
      withAccount: sql<number>`count(*) filter (where ${a.accountId} is not null and ${a.accountId} <> '')`,
      withCampaignId: sql<number>`count(*) filter (where ${a.campaignId} is not null and ${a.campaignId} <> '')`,
      withProduct: sql<number>`count(*) filter (where ${a.productId} is not null)`,
      withMarketer: sql<number>`count(*) filter (where ${a.marketerId} is not null and ${a.marketerId} <> '')`,
      // Tiền của chiến dịch KHÔNG có đơn nào gắn vào: đây là tiền đã tiêu mà không truy được kết quả.
      spendNoOrders: sql<number>`coalesce(sum(${a.spend}) filter (where not exists (
        select 1 from orders oo join fb_ads fa on fa.id = oo.ad_id
        where fa.campaign_id is not distinct from ${a.campaignId}
      )), 0)`,
    })
    .from(a)
    .where(spendWhere(period));

  const [orderRow] = await db
    .select({
      total: sql<number>`count(*)`,
      withAd: sql<number>`count(*) filter (where ${HAS_AD})`,
      adKnown: sql<number>`count(*) filter (where ${HAS_AD} and exists (select 1 from fb_ads fa where fa.id = ${o.adId}))`,
      adAlive: sql<number>`count(*) filter (where ${HAS_AD} and exists (select 1 from fb_ads fa where fa.id = ${o.adId} and fa.missing = false))`,
      campaignKnown: sql<number>`count(*) filter (where ${HAS_AD} and exists (select 1 from fb_ads fa where fa.id = ${o.adId} and fa.campaign_id is not null))`,
      adsetKnown: sql<number>`count(*) filter (where ${HAS_AD} and exists (select 1 from fb_ads fa where fa.id = ${o.adId} and fa.adset_id is not null))`,
      withPage: sql<number>`count(*) filter (where ${o.pageId} is not null and ${o.pageId} <> '')`,
      linkedByPost: sql<number>`count(*) filter (where ${LINKED_BY_POST})`,
      ambiguousByPost: sql<number>`count(*) filter (where ${AMBIGUOUS_BY_POST})`,
    })
    .from(o)
    .where(scope);

  const [{ missing }] = await db.select({ missing: sql<number>`count(*) filter (where ${schema.fbAds.missing})` }).from(schema.fbAds);

  const spendRows = Number(spendRow?.rows ?? 0);
  const orders = Number(orderRow?.total ?? 0);
  const withAd = Number(orderRow?.withAd ?? 0);
  const cov = (matched: number, total: number) => (total > 0 ? matched / total : 0);

  const rows: AdsCoverageRow[] = [
    {
      key: "spend.account",
      label: "Chi tiêu có mã tài khoản",
      unit: "spend",
      matched: Number(spendRow?.withAccount ?? 0),
      total: spendRows,
      coverage: cov(Number(spendRow?.withAccount ?? 0), spendRows),
      note: "Dòng nhập tay không có mã tài khoản — vẫn tính vào tổng chi, chỉ không tách được theo tài khoản.",
    },
    {
      key: "spend.campaign",
      label: "Chi tiêu có mã chiến dịch",
      unit: "spend",
      matched: Number(spendRow?.withCampaignId ?? 0),
      total: spendRows,
      coverage: cov(Number(spendRow?.withCampaignId ?? 0), spendRows),
      note: "Không có mã chiến dịch thì ghép với đơn phải dựa vào TÊN chiến dịch — kém tin cậy hơn hẳn.",
    },
    {
      key: "spend.product",
      label: "Chi tiêu ghép được mã hàng",
      unit: "spend",
      matched: Number(spendRow?.withProduct ?? 0),
      total: spendRows,
      coverage: cov(Number(spendRow?.withProduct ?? 0), spendRows),
      note: "Ghép từ tên chiến dịch. Không ghép được thì không tính được lợi nhuận theo mã hàng.",
    },
    {
      key: "spend.marketer",
      label: "Chi tiêu có người phụ trách",
      unit: "spend",
      matched: Number(spendRow?.withMarketer ?? 0),
      total: spendRows,
      coverage: cov(Number(spendRow?.withMarketer ?? 0), spendRows),
      note: "Thiếu thì phần chi đó nằm ở nhóm 'Chưa gán marketer', KHÔNG chia đều cho các marketer.",
    },
    {
      key: "order.ad",
      label: "Đơn có mã quảng cáo",
      unit: "order",
      matched: withAd,
      total: orders,
      coverage: cov(withAd, orders),
      note: "ĐÂY LÀ TRẦN của mọi chỉ số ROAS: đơn không có mã quảng cáo thì không thuộc về chiến dịch nào.",
    },
    {
      key: "order.adKnown",
      label: "Mã quảng cáo tra được trên Facebook",
      unit: "order",
      matched: Number(orderRow?.adKnown ?? 0),
      total: withAd,
      coverage: cov(Number(orderRow?.adKnown ?? 0), withAd),
      note: "Tra không ra thì biết đơn từ quảng cáo nhưng không biết chiến dịch nào.",
    },
    {
      key: "order.adAlive",
      label: "Mẩu quảng cáo còn đọc được",
      unit: "order",
      matched: Number(orderRow?.adAlive ?? 0),
      total: withAd,
      coverage: cov(Number(orderRow?.adAlive ?? 0), withAd),
      note: "Phần còn lại là quảng cáo đã xoá hoặc ERP không còn quyền đọc — dữ liệu cũ vẫn giữ, không xoá.",
    },
    {
      key: "order.campaign",
      label: "Truy được tới chiến dịch",
      unit: "order",
      matched: Number(orderRow?.campaignKnown ?? 0),
      total: withAd,
      coverage: cov(Number(orderRow?.campaignKnown ?? 0), withAd),
      note: "Đây là cấp sâu nhất mà cả TIỀN lẫn ĐƠN cùng có dữ liệu.",
    },
    {
      key: "order.postLink",
      label: "Nối thêm được nhờ bài viết",
      unit: "order",
      matched: Number(orderRow?.linkedByPost ?? 0),
      total: orders,
      coverage: cov(Number(orderRow?.linkedByPost ?? 0), orders),
      note: "Pancake không gửi mã quảng cáo nhưng có mã bài viết, và bài đó chỉ thuộc MỘT chiến dịch — nối bằng dữ kiện của Facebook, không phải suy đoán.",
    },
    {
      key: "order.postAmbiguous",
      label: "Có bài viết nhưng nhiều chiến dịch cùng chạy",
      unit: "order",
      matched: Number(orderRow?.ambiguousByPost ?? 0),
      total: orders,
      coverage: cov(Number(orderRow?.ambiguousByPost ?? 0), orders),
      note: "CỐ Ý không nối: chọn bừa một chiến dịch sẽ gán doanh thu sai chỗ mà con số vẫn trông hợp lý.",
    },
    {
      key: "order.adset",
      label: "Truy được tới nhóm quảng cáo",
      unit: "order",
      matched: Number(orderRow?.adsetKnown ?? 0),
      total: withAd,
      coverage: cov(Number(orderRow?.adsetKnown ?? 0), withAd),
      note: "Có mã nhóm nhưng KHÔNG có tên và KHÔNG có chi tiêu ở cấp này — không tính được ROAS theo nhóm.",
    },
    {
      key: "order.page",
      label: "Đơn có mã trang",
      unit: "order",
      matched: Number(orderRow?.withPage ?? 0),
      total: orders,
      coverage: cov(Number(orderRow?.withPage ?? 0), orders),
      note: "Dùng để tách doanh số theo trang trong báo cáo marketer.",
    },
  ];

  return {
    rows,
    totalSpend: Number(spendRow?.spend ?? 0),
    spendUnattributed: Number(spendRow?.spendNoOrders ?? 0),
    adsMissing: Number(missing ?? 0),
    // Nêu tên những cấp KHÔNG có dữ liệu, để không ai mất công đi tìm rồi tự dựng số thay thế.
    unavailableLevels: [
      { level: "Nội dung quảng cáo (creative)", reason: "Không có bảng nào trong ERP lưu creative. Đồng bộ Facebook hiện chỉ lấy tới cấp mẩu quảng cáo." },
      { level: "Chi tiêu theo nhóm quảng cáo (adset)", reason: "Facebook Insights được đồng bộ ở cấp CHIẾN DỊCH/ngày. Không có chi tiêu cấp nhóm nên không có ROAS cấp nhóm." },
      { level: "Chi tiêu theo từng mẩu quảng cáo", reason: "Cùng lý do trên. Bảng ROAS theo mẩu quảng cáo chỉ có ĐƠN, phần tiền lấy theo chiến dịch mẹ." },
    ],
  };
}
