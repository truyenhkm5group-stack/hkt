import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { intradayRateCheck, intradayScaleVerdict, type IntradayRate, type IntradayVerdict } from "@/lib/constants/ads-intraday";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import { getAdsDecision } from "@/lib/queries/ads-decision";
import { resolvePeriod } from "@/lib/search-params";

/**
 * ═══════════ LÀN NHANH — ĐỌC SỐ HÔM NAY ═══════════
 *
 * Số của hôm nay lấy từ ĐÚNG engine của bảng quyết định (`getAdsDecision` với kỳ "Hôm nay"): cùng
 * phép quy kết đơn → chiến dịch, cùng nguồn chi Facebook, cùng bộ loại trừ chiến dịch "không tính".
 * Không có phép cộng thứ hai — nếu có, bảng quyết định và làn nhanh sẽ nói hai con số khác nhau về
 * cùng một chiến dịch trong cùng một ngày. Luật ở `lib/constants/ads-intraday.ts`.
 */

export type IntradayRow = {
  campaignId: string;
  name: string;
  spend: number;
  spendKnown: boolean;
  bookedOrders: number;
  bookedRevenue: number;
  verdict: IntradayVerdict;
  /** Chỉ tính cho dòng đạt ngưỡng — dòng chưa đạt thì nhịp không có nghĩa. */
  rate: IntradayRate | null;
  appliedToday: number;
};

export type IntradayBoard = {
  rows: IntradayRow[];
  /** Dòng đạt ngưỡng HÔM NAY (chưa xét nhịp). */
  eligible: number;
  /** Dòng có chi hôm nay nhưng chưa đạt, theo từng lý do — để thấy làn đang chặn ở đâu. */
  blocked: { NO_SPEND_DATA: number; SMALL_SAMPLE: number; TOO_EXPENSIVE: number };
  measuredAt: Date;
};

const changes = schema.adsBudgetChanges;

/** Mốc các lượt ĐÃ ÁP hôm nay, mọi làn — nhịp trong ngày đếm trên đây. */
export async function appliedTodayByCampaign(campaignIds: string[], changeDay: string): Promise<Map<string, Date[]>> {
  const map = new Map<string, Date[]>();
  if (!campaignIds.length) return map;
  const db = await getDb();
  const rows = await db
    .select({ campaignId: changes.campaignId, at: changes.createdAt })
    .from(changes)
    .where(and(eq(changes.changeDay, changeDay), eq(changes.outcome, "APPLIED"), inArray(changes.campaignId, campaignIds)));
  for (const r of rows) map.set(r.campaignId, [...(map.get(r.campaignId) ?? []), new Date(r.at)]);
  return map;
}

export async function getIntradayBoard(now: Date = new Date()): Promise<IntradayBoard> {
  const d = await getAdsDecision(resolvePeriod({ period: "today" }, "today"), "campaign");
  const coSo = d.rows.filter((r) => r.spend > 0 || r.bookedOrders > 0 || !r.spendKnown);
  const dat = coSo.map((r) => ({ r, verdict: intradayScaleVerdict({ spendKnown: r.spendKnown, spend: r.spend, bookedOrders: r.bookedOrders, bookedRevenue: r.bookedRevenue }) }));
  const applied = await appliedTodayByCampaign(dat.filter((x) => x.verdict.eligible).map((x) => x.r.key), vnDay(now));

  const blocked = { NO_SPEND_DATA: 0, SMALL_SAMPLE: 0, TOO_EXPENSIVE: 0 };
  const rows: IntradayRow[] = dat.map(({ r, verdict }) => {
    if (verdict.blocker) blocked[verdict.blocker] += 1;
    const moc = applied.get(r.key) ?? [];
    return {
      campaignId: r.key,
      name: r.name,
      spend: r.spend,
      spendKnown: r.spendKnown,
      bookedOrders: r.bookedOrders,
      bookedRevenue: r.bookedRevenue,
      verdict,
      rate: verdict.eligible ? intradayRateCheck(moc, now) : null,
      appliedToday: moc.length,
    };
  });
  // Đạt ngưỡng trước, rồi %CPQC thấp trước (rẻ nhất trước), rồi chi nhiều trước.
  rows.sort(
    (a, b) =>
      Number(b.verdict.eligible) - Number(a.verdict.eligible) ||
      (a.verdict.cpqcPct ?? Number.POSITIVE_INFINITY) - (b.verdict.cpqcPct ?? Number.POSITIVE_INFINITY) ||
      b.spend - a.spend ||
      (a.campaignId < b.campaignId ? -1 : 1),
  );
  return { rows, eligible: rows.filter((r) => r.verdict.eligible).length, blocked, measuredAt: now };
}
