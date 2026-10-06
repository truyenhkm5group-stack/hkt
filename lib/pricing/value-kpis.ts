/**
 * ═══════════ KPI GIÁ TRỊ AI BÁN HÀNG — CHỈ SỐ GIÁ TRỊ, KHÔNG PHẢI TRẦN THU (docs/saas/PRICING_V1.md §7) ═══════════
 *
 * Đơn KHÔNG BAO GIỜ sinh phí — tám chỉ số dưới đây chỉ để khách và người vận hành thấy AI mang lại gì. KHÔNG một công thức mới:
 * mỗi chỉ số đọc lại đường đo đã có —
 *  · quy kết đơn (`lib/sales-chatbot/attribution.ts::loadOrderAttribution`: AI tự bán · AI góp công · người bán), DOANH THU theo
 *    `ORDER_OUTCOME` (lib/queries/return-rate.ts — chỉ đơn giao thành công + doanh thu đã ghi nhận), GMV = giá trị đơn LÚC TẠO
 *    (`orders.total_price_after_discount`, nhãn rõ: KHÔNG phải tiền đã thu);
 *  · phễu + upsell (`lib/sales-chatbot/performance.ts::loadAiSalesPerformance`), mẫu dưới 10 ⇒ `null`;
 *  · đơn AI tạo = câu đếm của sổ dùng theo ngày (`readOrgUsage.aiOrders`, 0204).
 * ERP chưa đo được ⇒ `UNAVAILABLE` + `missingWhat` cụ thể; mẫu số 0 ⇒ `null` (luật 42), không bao giờ 0%.
 */
import { getDb } from "@/db";
import { withOrganization } from "@/lib/platform/context";
import { readOrgUsage } from "@/lib/platform/saas-ledger";
import { loadOrderAttribution } from "@/lib/sales-chatbot/attribution";
import type { AttributionTable } from "@/lib/sales-chatbot/attribution-shared";
import { loadAiSalesPerformance } from "@/lib/sales-chatbot/performance";
import { rateOrNull, type FunnelRow } from "@/lib/sales-chatbot/performance-shared";

export const VALUE_KPI_KEYS = ["orders_assisted", "orders_created_by_ai", "orders_closed_by_ai", "revenue_attributed_to_ai", "gmv_attributed_to_ai", "conversion_rate", "upsell_rate", "cross_sell_rate"] as const;
export type ValueKpiKey = (typeof VALUE_KPI_KEYS)[number];

export type ValueKpiSpec = { label: string; unit: "đơn" | "VND" | "%"; source: string; availability: "MEASURED" | "UNAVAILABLE"; missingWhat: string | null };

export const VALUE_KPI_SPEC: Record<ValueKpiKey, ValueKpiSpec> = {
  orders_assisted: { label: "Đơn AI góp công", unit: "đơn", source: "quy kết đơn · AI_ASSISTED (sổ sự kiện hội thoại)", availability: "MEASURED", missingWhat: null },
  orders_created_by_ai: { label: "Đơn AI tạo", unit: "đơn", source: "orders nối sales_chat_conversations.order_id (câu đếm sổ dùng theo ngày 0204)", availability: "MEASURED", missingWhat: null },
  orders_closed_by_ai: { label: "Đơn AI tự chốt", unit: "đơn", source: "quy kết đơn · AI_ONLY (bot chốt, không người chạm)", availability: "MEASURED", missingWhat: null },
  revenue_attributed_to_ai: { label: "Doanh thu nhờ AI (giao thành công)", unit: "VND", source: "AI_ONLY + AI_ASSISTED · ORDER_OUTCOME = DELIVERED · doanh thu đã ghi nhận", availability: "MEASURED", missingWhat: null },
  gmv_attributed_to_ai: { label: "GMV nhờ AI (giá trị đơn lúc tạo)", unit: "VND", source: "AI_ONLY + AI_ASSISTED · orders.total_price_after_discount lúc tạo — chưa trừ hoàn / huỷ, KHÔNG phải tiền đã thu", availability: "MEASURED", missingWhat: null },
  conversion_rate: { label: "Tỷ lệ chốt", unit: "%", source: "hội thoại có tin khách trong kỳ → có order.confirmed (phễu Hiệu quả AI)", availability: "MEASURED", missingWhat: null },
  upsell_rate: { label: "Tỷ lệ nhận upsell", unit: "%", source: "upsell.accepted / upsell.offered (sổ sự kiện hội thoại)", availability: "MEASURED", missingWhat: null },
  cross_sell_rate: {
    label: "Tỷ lệ nhận cross-sell",
    unit: "%",
    source: "—",
    availability: "UNAVAILABLE",
    missingWhat: "Sổ sự kiện hội thoại (`sales_conversation_events`) chỉ có `upsell.offered/accepted/declined`; chưa có loại `cross_sell.offered` / `cross_sell.accepted` khi AI gợi ý MÓN ĐI KÈM — cần đường ghi sự kiện ở công cụ gợi ý sản phẩm của lib/sales-chatbot trước khi đo được.",
  },
};

export type ValueKpis = Record<ValueKpiKey, number | null>;

/** Ghép tám chỉ số từ các đường đo đã có — HÀM THUẦN. */
export function buildValueKpis(input: { attribution: AttributionTable | null; aiOrders: number | null; funnel: FunnelRow | null; upsell: { offered: number; accepted: number } | null }): ValueKpis {
  const a = input.attribution;
  return {
    orders_assisted: a ? a.AI_ASSISTED.orders : null,
    orders_created_by_ai: input.aiOrders,
    orders_closed_by_ai: a ? a.AI_ONLY.orders : null,
    revenue_attributed_to_ai: a ? a.AI_ONLY.deliveredRevenueVnd + a.AI_ASSISTED.deliveredRevenueVnd : null,
    gmv_attributed_to_ai: a ? a.AI_ONLY.valueVnd + a.AI_ASSISTED.valueVnd : null,
    conversion_rate: input.funnel ? rateOrNull(input.funnel.confirmed, input.funnel.conversations) : null,
    upsell_rate: input.upsell ? rateOrNull(input.upsell.accepted, input.upsell.offered) : null,
    cross_sell_rate: null,
  };
}

/** Tám chỉ số của MỘT tổ chức trong `days` ngày. Lỗi một nguồn ⇒ chỉ số của nguồn đó `null` + câu lỗi. */
export async function loadAiValueKpis(orgCode: string, opts: { days?: number; now?: Date } = {}): Promise<{ kpis: ValueKpis; errors: string[]; days: number }> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 30), 1), 180);
  const now = opts.now ?? new Date();
  const errors: string[] = [];
  const msg = (e: unknown) => (e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160));
  return withOrganization(orgCode, async () => {
    const [attribution, perf, aiOrders] = await Promise.all([
      loadOrderAttribution({ days, now }).catch((e) => {
        errors.push(`Quy kết đơn: ${msg(e)}`);
        return null;
      }),
      loadAiSalesPerformance(orgCode, { days, now, withMoney: false }).catch((e) => {
        errors.push(`Hiệu quả AI: ${msg(e)}`);
        return null;
      }),
      getDb()
        .then((db) => readOrgUsage(db, new Date(now.getTime() - days * 86_400_000), now))
        .then((u) => u.aiOrders)
        .catch((e) => {
          errors.push(`Đơn AI tạo: ${msg(e)}`);
          return null;
        }),
    ]);
    return { kpis: buildValueKpis({ attribution: attribution?.table ?? null, aiOrders, funnel: perf?.cohorts.total ?? null, upsell: perf ? { offered: perf.upsell.offered, accepted: perf.upsell.accepted } : null }), errors, days };
  });
}
