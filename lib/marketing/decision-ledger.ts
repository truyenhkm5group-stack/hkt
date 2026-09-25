import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { type AdsDimension } from "@/lib/constants/ads-decision";
import { DECISION_CLASS, DECISION_RULE_VERSION, decisionRuleSnapshot, ledgerPeriod } from "@/lib/constants/marketing-decision-ledger";
import { getAdsDecision, type AdsDecisionRow } from "@/lib/queries/ads-decision";

/**
 * ═══════════ GHI SỔ QUYẾT ĐỊNH QUẢNG CÁO — ĐƯỜNG GHI DUY NHẤT ═══════════
 *
 * Đặc tả: `docs/marketing-ai-department.md`. Ngưỡng: `lib/constants/marketing-decision-ledger.ts`.
 * Đường ĐỌC nằm ở `lib/queries/marketing-ledger.ts`.
 *
 * ─── VÌ SAO GHI VÀ ĐỌC Ở HAI TỆP ───
 *
 * `tests/advisory-safety.test.ts` quét mã nguồn và bắt lỗi nếu bất kỳ tệp nào trong `lib/queries`
 * chứa một phép ghi — ranh giới cứng của toàn bộ lớp tư vấn: ERP ĐỌC dữ liệu quảng cáo và chỉ ĐỀ
 * XUẤT. Bộ gác ấy đã bắt đúng bản đầu của tệp này, và nó đúng: một tệp trong `lib/queries` cần ghi
 * thì nó đang nằm sai thư mục.
 *
 * ─── VÀ TỆP NÀY VẪN KHÔNG PHẢI MỘT NGOẠI LỆ CỦA RANH GIỚI ẤY ───
 *
 * Nó ghi vào ĐÚNG MỘT bảng — `ads_decision_ledger`, sổ của chính nó — và không bảng nghiệp vụ nào
 * khác. Không đơn, không vận đơn, không tiền, không tồn kho, không ngân sách quảng cáo. Sổ là ẢNH
 * CHỤP một kết luận, nên nó không thể làm lệch một con số tài chính nào kể cả khi job hỏng hoàn
 * toàn: mọi báo cáo tiền vẫn đọc ở đường cũ.
 */

const ledger = schema.adsDecisionLedger;

/**
 * ───────────── CHIỀU NÀO ĐƯỢC GHI SỔ ─────────────
 *
 * Chỉ `campaign` và `product` — hai cấp DUY NHẤT có số chi (`ADS_DIMENSION_HAS_SPEND`). Ghi sổ cho
 * `adset`/`ad` sẽ là hàng nghìn dòng mỗi ngày mà mọi dòng đều mang `NO_SPEND_DATA`: không kết luận
 * nào, không hành động nào, chỉ có dung lượng.
 */
export const LEDGER_DIMENSIONS: AdsDimension[] = ["campaign", "product"];

export type LedgerWriteResult = {
  decisionDay: string;
  periodFrom: string;
  periodTo: string;
  ruleVersion: number;
  /** Số dòng đã ghi hoặc cập nhật, theo từng chiều. */
  written: { dimension: AdsDimension; rows: number; actionable: number }[];
};

export function ledgerRowValues(row: AdsDecisionRow, decisionDay: string, periodFrom: string, periodTo: string) {
  return {
    decisionDay,
    dimension: row.dimension,
    entityKey: row.key,
    entityName: row.name,
    action: row.action,
    actionClass: DECISION_CLASS[row.action],
    // Căn cứ đi vào sổ CÙNG kết luận: đọc lại hôm nay sẽ ra căn cứ khác, vì dữ liệu đã chín thêm.
    basis: row.basis,
    reason: row.reason,
    periodFrom,
    periodTo,
    ruleVersion: DECISION_RULE_VERSION,
    ruleSnapshot: decisionRuleSnapshot(),
    spendKnown: row.spendKnown,
    spend: Math.round(row.spend),
    bookedOrders: row.bookedOrders,
    deliveredOrders: row.deliveredOrders,
    returnedOrders: row.returnedOrders,
    openOrders: row.openOrders,
    deliveredRevenue: Math.round(row.deliveredRevenue),
    profitAfterAds: Math.round(row.profitAfterAds),
    /*
      BỐN TỶ SỐ ĐI THẲNG, KHÔNG `?? 0` (AGENTS.md mục 42).

      `successRate = null` nghĩa là chưa đơn nào ngã ngũ — khác hẳn 0%. Một dòng sổ ghi 0% ở đây sẽ
      làm mọi phép đọc lại về sau tin rằng chiến dịch ấy giao hỏng toàn bộ.
    */
    successRate: row.successRate,
    maturity: row.maturity,
    headroom: row.headroom,
    breakEvenBookedRoas: row.breakEvenBookedRoas,
    /*
      ẢNH CHỤP DỰ PHÓNG (Company OS · F, migration 0134) — chép từ CHÍNH dòng vừa kết luận, không
      tính lại. Ghi cho MỌI dòng, cả dòng căn cứ `ACTUAL`: khi ấy nó bằng số đo cộng phần treo nhỏ,
      và vẫn là con số cần có để đo sai số dự báo về sau. Không biết số chi ⇒ lợi nhuận sau QC là
      CHƯA BIẾT ⇒ `null`, không phải con số trước QC giả làm sau QC (mục 42).
    */
    projectedProfitAfterAds: row.spendKnown ? Math.round(row.projectedProfitAfterAds) : null,
    projectedHeadroom: row.projectedHeadroom,
    appliedDeliveryRate: row.appliedDeliveryRate,
    updatedAt: new Date(),
  };
}

/**
 * Ghi (hoặc cập nhật trong CÙNG ngày) các dòng sổ. Tách ra khỏi `recordDecisionLedger` để kiểm thử
 * được đường ghi thật mà không cần dựng cả bộ quyết định. Khoá xung đột là `(ngày, chiều, mục)`:
 * dòng của NGÀY KHÁC không bao giờ bị chạm — sổ là ảnh chụp, không phải khung nhìn (mục 21).
 */
export async function upsertLedgerValues(values: ReturnType<typeof ledgerRowValues>[]): Promise<void> {
  if (!values.length) return;
  const db = await getDb();
  await db
    .insert(ledger)
    .values(values)
    .onConflictDoUpdate({
      target: [ledger.decisionDay, ledger.dimension, ledger.entityKey],
      set: {
        entityName: sql`excluded.entity_name`,
        action: sql`excluded.action`,
        actionClass: sql`excluded.action_class`,
        basis: sql`excluded.basis`,
        reason: sql`excluded.reason`,
        periodFrom: sql`excluded.period_from`,
        periodTo: sql`excluded.period_to`,
        ruleVersion: sql`excluded.rule_version`,
        ruleSnapshot: sql`excluded.rule_snapshot`,
        spendKnown: sql`excluded.spend_known`,
        spend: sql`excluded.spend`,
        bookedOrders: sql`excluded.booked_orders`,
        deliveredOrders: sql`excluded.delivered_orders`,
        returnedOrders: sql`excluded.returned_orders`,
        openOrders: sql`excluded.open_orders`,
        deliveredRevenue: sql`excluded.delivered_revenue`,
        profitAfterAds: sql`excluded.profit_after_ads`,
        successRate: sql`excluded.success_rate`,
        maturity: sql`excluded.maturity`,
        headroom: sql`excluded.headroom`,
        breakEvenBookedRoas: sql`excluded.break_even_booked_roas`,
        projectedProfitAfterAds: sql`excluded.projected_profit_after_ads`,
        projectedHeadroom: sql`excluded.projected_headroom`,
        appliedDeliveryRate: sql`excluded.applied_delivery_rate`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Chạy bộ quyết định trên KỲ CHUẨN rồi chép kết luận vào sổ của NGÀY HÔM NAY.
 *
 * Idempotent theo thiết kế: khoá duy nhất `(decision_day, dimension, entity_key)` biến lượt chạy
 * thứ hai trong cùng ngày thành CẬP NHẬT. Nên job chạy dày để không bỏ lỡ ngày nào là an toàn.
 *
 * KHÔNG ghi gì cho ngày quá khứ. Dựng lại quá khứ là bất khả: kết luận của hôm ấy phải tính trên dữ
 * liệu NHƯ NÓ CÓ hôm ấy, mà đơn hôm ấy còn treo nay đã ngã ngũ (mục 8.8).
 */
export async function recordDecisionLedger(options: { now?: Date; log?: (m: string) => void } = {}): Promise<LedgerWriteResult> {
  const now = options.now ?? new Date();
  const { decisionDay, period } = ledgerPeriod(now);
  const periodFrom = period.fromKey ?? "";
  const periodTo = period.toKey ?? "";
  const written: LedgerWriteResult["written"] = [];

  for (const dimension of LEDGER_DIMENSIONS) {
    const decision = await getAdsDecision(period, dimension);
    const values = decision.rows.map((r) => ledgerRowValues(r, decisionDay, periodFrom, periodTo));
    await upsertLedgerValues(values);
    const actionable = values.filter((v) => v.actionClass === "ACTIONABLE").length;
    written.push({ dimension, rows: values.length, actionable });
    options.log?.(`${dimension}: ${values.length} dòng · ${actionable} cần làm`);
  }

  return { decisionDay, periodFrom, periodTo, ruleVersion: DECISION_RULE_VERSION, written };
}
