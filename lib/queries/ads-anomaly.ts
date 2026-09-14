import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ADS_ANOMALY_RULES, PROFITABILITY_KINDS, type AdsAnomalyKind } from "@/lib/constants/ads-anomaly";
import { getAdsAttributionAudit } from "@/lib/queries/ads-attribution";
import { getAdsRoas } from "@/lib/queries/ads-roas";
import type { Period } from "@/lib/search-params";

/**
 * ───────────── PHÁT HIỆN QUẢNG CÁO BẤT THƯỜNG ─────────────
 *
 * Quy tắc, không phải mô hình. Mỗi cảnh báo phải nói được: so cái gì với cái gì, chênh bao nhiêu,
 * và vì sao đó là vấn đề — nếu không, người nhận sẽ bỏ qua nó ngay từ lần thứ hai.
 *
 * KHÔNG TỰ ĐỘNG ĐỔI NGÂN SÁCH, không tắt chiến dịch, không sửa gì trên Facebook. Chỉ tạo việc cho
 * người quyết định. Đây là ranh giới cứng: ERP đọc dữ liệu quảng cáo, không điều khiển quảng cáo.
 *
 * So sánh luôn là 7 ngày gần đây với 7 ngày liền TRƯỚC ĐÓ, không phải với trung bình dài hạn: shop
 * thời trang có mùa vụ mạnh, so với trung bình năm sẽ báo động suốt mùa cao điểm.
 */

const a = schema.adSpends;

export type AdsAnomaly = {
  kind: AdsAnomalyKind;
  /** Chiến dịch liên quan; rỗng = cảnh báo ở mức toàn bộ tài khoản. */
  campaignId: string;
  campaignName: string;
  severity: "warning" | "critical";
  /** Một câu nói rõ so cái gì với cái gì và chênh bao nhiêu. */
  detail: string;
  /** Tiền đang liên quan tới cảnh báo này (đồng). */
  amount: number;
  /** Đây là cảnh báo mức KINH DOANH hay mức VẬN HÀNH — quyết định nó vào loại việc nào. */
  profitability: boolean;
};

const pct = (value: number) => `${value >= 0 ? "+" : ""}${Math.round(value)}%`;
const vnd = (value: number) => `${Math.round(value).toLocaleString("vi-VN")}đ`;
const change = (now: number, before: number) => (before > 0 ? ((now - before) / before) * 100 : now > 0 ? 100 : 0);

function windowPeriod(days: number, offsetDays = 0): Period {
  const end = new Date(Date.now() - offsetDays * 86_400_000);
  const start = new Date(end.getTime() - days * 86_400_000);
  return { key: "custom", from: start, to: end, label: `${days} ngày`, fromKey: null, toKey: null };
}

export async function detectAdsAnomalies(): Promise<AdsAnomaly[]> {
  const db = await getDb();
  const days = ADS_ANOMALY_RULES.windowDays;
  const now = windowPeriod(days);
  const before = windowPeriod(days, days);
  const out: AdsAnomaly[] = [];

  const [current, previous, audit] = await Promise.all([getAdsRoas(now, "campaign"), getAdsRoas(before, "campaign"), getAdsAttributionAudit(now)]);
  const prevByKey = new Map(previous.rows.map((r) => [r.key, r]));

  /**
   * CÓ DÁM KẾT LUẬN VỀ LỢI NHUẬN CHIẾN DỊCH HAY KHÔNG.
   *
   * Chi tiêu đếm đủ 100%; doanh thu chỉ quy được cho đơn CÓ mã quảng cáo. Độ phủ thấp thì hiệu
   * "doanh thu − chi tiêu" âm ở gần như mọi chiến dịch, và cảnh báo "đang lỗ" trở thành tiếng kêu
   * suốt ngày — người nhận sẽ tắt hết, kể cả cảnh báo đúng.
   *
   * So sánh KỲ NÀY với KỲ TRƯỚC thì vẫn dùng được, vì cả hai kỳ cùng thiếu như nhau.
   */
  const ceilingRow = audit.rows.find((r) => r.key === "order.ad");
  const attributionPct = ceilingRow && ceilingRow.total > 0 ? ceilingRow.coverage * 100 : 0;
  const canJudgeProfit = attributionPct >= ADS_ANOMALY_RULES.minAttributionToJudgeProfit;

  for (const row of current.rows) {
    if (row.spend < ADS_ANOMALY_RULES.minSpendToJudge) continue;
    const prev = prevByKey.get(row.key);

    // ── 1. Chi tăng mạnh mà doanh thu giao thành công không tăng theo ──
    // Bất thường đắt nhất: tiền chảy ra đều đặn còn hàng thì không tới tay khách.
    if (prev && prev.spend > 0) {
      const spendChange = change(row.spend, prev.spend);
      const revenueChange = change(row.deliveredRevenue, prev.deliveredRevenue);
      if (spendChange >= ADS_ANOMALY_RULES.spendSurgePct && revenueChange < ADS_ANOMALY_RULES.revenueLagPct) {
        out.push({
          kind: "SPEND_SURGE_NO_REVENUE",
          campaignId: row.key,
          campaignName: row.name,
          severity: "critical",
          detail: `Chi ${pct(spendChange)} (${vnd(prev.spend)} → ${vnd(row.spend)}) nhưng doanh thu giao thành công chỉ ${pct(revenueChange)} (${vnd(prev.deliveredRevenue)} → ${vnd(row.deliveredRevenue)}), so ${days} ngày trước.`,
          amount: row.spend - prev.spend,
          profitability: false,
        });
      }
    }

    // ── 2. Tỷ lệ giao thành công tụt ──
    // Không phải vấn đề của mẩu quảng cáo mà của chất lượng đơn nó mang về: sai đối tượng, sai giá,
    // hoặc chốt ẩu. Vẫn phải báo ở đây vì chỉ nhìn từ phía quảng cáo mới thấy.
    if (prev && prev.successRate !== null && row.successRate !== null) {
      const drop = prev.successRate - row.successRate;
      if (drop >= ADS_ANOMALY_RULES.successDropPoints) {
        out.push({
          kind: "SUCCESS_RATE_DROP",
          campaignId: row.key,
          campaignName: row.name,
          severity: "warning",
          detail: `Tỷ lệ giao thành công tụt ${Math.round(drop)} điểm (${prev.successRate}% → ${row.successRate}%) so ${days} ngày trước. Đơn vẫn về nhưng không tới được tay khách.`,
          amount: row.spend,
          profitability: false,
        });
      }
    }

    // ── 3. ROAS giao thành công dưới ngưỡng ──
    if (canJudgeProfit && row.spendKnown && row.deliveredRoas !== null && row.deliveredRoas < ADS_ANOMALY_RULES.minDeliveredRoas) {
      out.push({
        kind: "LOW_DELIVERED_ROAS",
        campaignId: row.key,
        campaignName: row.name,
        severity: "warning",
        detail: `ROAS giao thành công ${row.deliveredRoas} — chi ${vnd(row.spend)} thu về ${vnd(row.deliveredRevenue)} hàng đã tới tay khách. Dưới ${ADS_ANOMALY_RULES.minDeliveredRoas} là chưa hoàn được vốn quảng cáo.`,
        amount: row.spend,
        profitability: true,
      });
    }

    // ── 4. Càng chạy càng lỗ ──
    // Lợi nhuận góp đã trừ giá vốn, cước và chính tiền quảng cáo. Âm nghĩa là mỗi đồng chi thêm là
    // mất thêm — khác hẳn "ROAS thấp", vốn vẫn có thể đang lãi mỏng.
    if (canJudgeProfit && row.spendKnown && row.contribution < 0) {
      out.push({
        kind: "CAMPAIGN_LOSING_MONEY",
        campaignId: row.key,
        campaignName: row.name,
        severity: "critical",
        detail: `Lợi nhuận góp ${vnd(row.contribution)} sau khi trừ giá vốn, cước và tiền quảng cáo. Mỗi đồng chi thêm là mất thêm.`,
        amount: Math.abs(row.contribution),
        profitability: true,
      });
    }
  }

  // ── 5. Mất dấu quy kết ──
  // Tiền vẫn tiêu nhưng ERP không còn nối được đơn nào vào quảng cáo: thường là Pancake ngừng ghi
  // ad_id. Không phải lỗi hiệu quả, là lỗi ĐO LƯỜNG — nhưng nếu không báo thì mọi báo cáo quảng cáo
  // bên trên đều lặng lẽ sai.
  if (current.totals.spend >= ADS_ANOMALY_RULES.minSpendToJudge && ceilingRow && ceilingRow.total > 0 && !canJudgeProfit) {
    const nghiemTrong = attributionPct < ADS_ANOMALY_RULES.minAttributionPct;
    out.push({
      kind: "ATTRIBUTION_LOST",
      campaignId: "",
      campaignName: "Toàn bộ tài khoản",
      severity: nghiemTrong ? "critical" : "warning",
      detail:
        `Chỉ ${attributionPct.toFixed(1)}% đơn ${days} ngày qua có mã quảng cáo, trong khi chi tiêu ${vnd(current.totals.spend)} được đếm đủ. ` +
        `Vì thế ERP KHÔNG kết luận chiến dịch nào lỗ hay lãi — hiệu "doanh thu trừ chi tiêu" ở đây so hai vế không cùng gốc. ` +
        `Gắn mã quảng cáo cho đơn (hoặc ghép chiến dịch → mã hàng) tới trên ${ADS_ANOMALY_RULES.minAttributionToJudgeProfit}% thì cảnh báo lợi nhuận mới bật lại.`,
      amount: current.totals.spend,
      profitability: false,
    });
  }

  // ── 6. Đồng bộ chi tiêu đứng im ──
  const [{ lastAt }] = await db.select({ lastAt: sql<Date | null>`max(${a.spendDate})` }).from(a).where(sql`${a.externalKey} is not null`);
  if (lastAt) {
    const staleDays = (Date.now() - new Date(lastAt).getTime()) / 86_400_000;
    if (staleDays > ADS_ANOMALY_RULES.staleSpendDays) {
      out.push({
        kind: "SPEND_SYNC_STALE",
        campaignId: "",
        campaignName: "Đồng bộ Facebook",
        severity: "warning",
        detail: `Dòng chi tiêu tự động mới nhất là ${new Date(lastAt).toLocaleDateString("vi-VN")} — đã ${Math.floor(staleDays)} ngày không có dữ liệu mới. Chi phí quảng cáo trong báo cáo đang thiếu.`,
        amount: 0,
        profitability: false,
      });
    }
  }

  // Việc đắt nhất lên trước.
  return out.sort((x, y) => Number(y.severity === "critical") - Number(x.severity === "critical") || y.amount - x.amount);
}

export function isProfitabilityAnomaly(kind: AdsAnomalyKind): boolean {
  return PROFITABILITY_KINDS.includes(kind);
}
