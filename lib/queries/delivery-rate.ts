import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { resolveDeliveryRate, type DeliveryRateSource, type ResolvedDeliveryRate } from "@/lib/constants/delivery-rate";
import { productReturnHistory, resolveAssumptions } from "@/lib/queries/profit-nominal";
import { getProjectedDeliveryMetrics } from "@/lib/queries/projected-delivery";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ TỶ LỆ GIAO THÀNH CÔNG ƯỚC TÍNH THEO MÃ — MỘT CỬA, MỌI BÁO CÁO ═══════════
 *
 * Thang bậc (ghi đè tay → số đo từng đơn → lịch sử của mã → tỷ lệ khai ở Giả định) là hàm THUẦN ở
 * `lib/constants/delivery-rate.ts`. Tệp này chỉ đi LẤY ba đầu vào của nó và gói lại thành một bản
 * đồ `productId → tỷ lệ`.
 *
 * ─── VÌ SAO MỐC CỦA COHORT LUÔN LÀ `ORDERED` ───
 *
 * Tỷ lệ giao thành công là THUỘC TÍNH CỦA MÃ HÀNG, không phải của trục thời gian người xem đang
 * chọn. Truyền `OUTCOME` vào đây khi người dùng bấm "theo ngày ghi nhận" sẽ làm tỷ lệ của Đầm Q002
 * đổi số chỉ vì màn hình đổi cách xếp dòng — và không ô nào trên màn hình giải thích được vì sao.
 * Cohort vẫn co giãn theo KỲ đang xem (đó là ý nghĩa của "trong kỳ này"), chỉ cái MỐC là cố định.
 */

export type ProductDeliveryRates = {
  /** `productId` → tỷ lệ đã kết luận. Mã không có mặt ở đây thì dùng `fallback`. */
  byProduct: Map<string, ResolvedDeliveryRate>;
  /** Bậc cuối: tỷ lệ khai ở Giả định. Dùng cho mã chưa có một quan sát nào. */
  fallback: ResolvedDeliveryRate;
  /** Hợp đồng dự báo có chạy được không — `null` = chạy được. Lỗi thì mọi mã lùi về lịch sử/giả định. */
  projectionError: string | null;
};

async function productDeliveryRatesUncached(period: Period): Promise<ProductDeliveryRates> {
  const assumptions = await resolveAssumptions();
  /*
    LỖI LÀ LỖI, KHÔNG HOÁ THÀNH "CHƯA ĐỦ DỮ LIỆU" — cùng cách Báo cáo lợi nhuận danh nghĩa xử lý.
    Hợp đồng hỏng thì bảng vẫn dựng được bằng bậc lịch sử / giả định, nhưng tên của lỗi đi lên tới
    màn hình thay vì biến mất.
  */
  const duBao = await getProjectedDeliveryMetrics({ from: period.from, to: period.to }, "ORDERED", "PRODUCT").then(
    (v) => ({ v, e: null as string | null }),
    (e: unknown) => ({ v: null, e: e instanceof Error ? e.message : String(e) }),
  );
  const history = await productReturnHistory(assumptions.returnRateWindowDays);

  const fallback = resolveDeliveryRate({
    projectedDeliveryRate: null,
    projectedFinished: 0,
    historyReturnRate: null,
    historyFinished: 0,
    minFinishedOrders: assumptions.minFinishedOrders,
    defaultReturnRate: assumptions.defaultReturnRate,
  });

  const byProduct = new Map<string, ResolvedDeliveryRate>();
  // Mọi mã có mặt ở BẤT KỲ nguồn nào đều phải có một dòng: mã chỉ có lịch sử mà không có cohort dự
  // báo (và ngược lại) vẫn là một mã đang bán, và bỏ nó ra là ngầm gán cho nó tỷ lệ giả định.
  const keys = new Set<string>([...history.keys(), ...(duBao.v?.rows ?? []).map((r) => r.key)]);
  const projected = new Map((duBao.v?.rows ?? []).map((r) => [r.key, r]));
  for (const key of keys) {
    const h = history.get(key);
    const p = projected.get(key);
    byProduct.set(
      key,
      resolveDeliveryRate({
        overrideReturnRate: assumptions.overrides[key],
        projectedDeliveryRate: p?.projectedRate ?? null,
        projectedFinished: p ? p.deliveredActual + p.failedActual : 0,
        historyReturnRate: h?.rate ?? null,
        historyFinished: h?.finished ?? 0,
        minFinishedOrders: assumptions.minFinishedOrders,
        defaultReturnRate: assumptions.defaultReturnRate,
      }),
    );
  }
  // Mã có ghi đè tay nhưng chưa có quan sát nào: ghi đè vẫn phải thắng, nên nó cũng cần một dòng.
  for (const key of Object.keys(assumptions.overrides)) {
    if (byProduct.has(key)) continue;
    byProduct.set(
      key,
      resolveDeliveryRate({
        overrideReturnRate: assumptions.overrides[key],
        projectedDeliveryRate: null,
        projectedFinished: 0,
        historyReturnRate: null,
        historyFinished: 0,
        minFinishedOrders: assumptions.minFinishedOrders,
        defaultReturnRate: assumptions.defaultReturnRate,
      }),
    );
  }
  return { byProduct, fallback, projectionError: duBao.e };
}

/** Đệm 90 giây — cùng nhịp với chính hợp đồng dự báo mà nó đọc, nên hai bên không lệch pha. */
export async function productDeliveryRates(period: Period): Promise<ProductDeliveryRates> {
  return memo(`productDeliveryRates:${periodKey(period)}`, 90_000, () => productDeliveryRatesUncached(period));
}

/** Bao nhiêu phần của bản đồ là SỐ ĐO thật, bao nhiêu là giả định — in cạnh mọi con số ước tính. */
export function rateCoverage(rates: ProductDeliveryRates): Record<DeliveryRateSource, number> {
  const out: Record<DeliveryRateSource, number> = { override: 0, projected: 0, history: 0, default: 0 };
  for (const r of rates.byProduct.values()) out[r.source] += 1;
  return out;
}

/**
 * ═══════════ TỶ LỆ CỦA MỘT ĐƠN = TRUNG BÌNH CÓ TRỌNG SỐ THEO TIỀN HÀNG CỦA CÁC MÃ TRONG ĐƠN ═══════════
 *
 * Một đơn hai mã thì nó KHÔNG thuộc trọn về mã nào cả. Căn cứ phân bổ khai rõ trước khi nhân
 * (AGENTS.md mục 14): **tỷ trọng `line_total` của từng dòng trong đơn** — đúng căn cứ mà
 * `productDayRows` và `lib/queries/ads-decision.ts` đã dùng, nên ba chỗ không nói ba con số.
 *
 * Đơn không có dòng hàng nào, hoặc mọi dòng đều 0đ ⇒ `nullif` cho `null` ⇒ rơi về tỷ lệ giả định.
 * Đó là bậc cuối của thang bậc, không phải một giá trị đặc biệt của riêng chỗ này.
 *
 * Trả về BIỂU THỨC SQL dựng sẵn bản đồ tỷ lệ thành một bảng `values` — một lượt tra băm cho mỗi
 * dòng hàng, thay vì một truy vấn con cho mỗi mã.
 */
export function orderDeliveryRateSql(rates: ProductDeliveryRates): SQL<number> {
  const fb = sql`${rates.fallback.deliveryRate / 100}::numeric`;
  if (!rates.byProduct.size) return sql<number>`${fb}`;
  /*
    ═══════════ `CASE` CHỨ KHÔNG PHẢI MỘT PHÉP NỐI `VALUES` — ĐO ĐƯỢC 22/09/2026 ═══════════

    Bản đầu tra tỷ lệ bằng `left join (values …)`. Nó đọc đẹp, và nó SAI VỀ GIÁ: biểu thức này nằm
    trong danh sách chọn của một bảng dẫn xuất, nên nó chạy MỘT LẦN CHO MỖI ĐƠN — và mỗi lần ấy
    Postgres phải dựng lại quan hệ `values` rồi băm nó để nối. Với ~1.150 đơn của một kỳ 30 ngày,
    nhân tiếp 13 lượt `buildDays` của bảng bóc tách, đó là ~15.000 lần dựng một bảng bảy dòng.

        bóc tách theo MKTer      74ms → 248ms   (perf-probe production, trạng thái ấm)
        bóc tách theo chiến dịch 1.195ms → 1.505ms

    Bản đồ tỷ lệ chỉ có đúng NGẦN ẤY MÃ HÀNG mà shop đang bán (đo cùng ngày: 7 mã). Bảy nhánh
    `CASE` là một phép so chuỗi tuyến tính trên một giá trị đã có sẵn trong dòng — không quan hệ
    nào để dựng, không phép nối nào để lập kế hoạch.

    Ngưỡng an toàn: danh sách mã ở đây là số mã CÓ LỊCH SỬ BÁN
    hoặc có cohort dự báo. Nếu shop lên tới hàng nghìn mã thì `CASE` mới đáng ngờ — và lúc đó phải
    ĐO LẠI chứ không đoán, đúng bài học ở `getMarketingBreakdown`.
  */
  const theoMa = deliveryRateCaseSql(rates, sql<string>`coalesce(mdr_pv.product_id, mdr_i.product_id)`);
  return sql<number>`coalesce((
    select sum(coalesce(mdr_i.line_total, 0) * ${theoMa})
           / nullif(sum(coalesce(mdr_i.line_total, 0)), 0)
      from order_items mdr_i
      left join product_variants mdr_pv on mdr_pv.id = mdr_i.variant_id
     where mdr_i.order_id = ${schema.orders.id}
  ), ${fb})`;
}

/**
 * ═══════════ TRA TỶ LỆ CHO MỘT KHOÁ MÃ HÀNG ĐÃ CÓ SẴN TRONG DÒNG ═══════════
 *
 * Vế `case` bên trong `orderDeliveryRateSql`, tách ra để dùng lại ở nơi khoá mã hàng **đã là một
 * cột của dòng** — bảng quyết định quảng cáo cấp MÃ HÀNG là ví dụ: ở đó mỗi dòng đã mang đúng một
 * mã, nên đi vòng qua trung bình có trọng số theo đơn là tính lại một thứ đã biết.
 *
 * Tách chứ không chép: hai nơi dựng hai vế `case` riêng là hai nguồn cho cùng một tỷ lệ, và chúng
 * sẽ trôi xa nhau đúng lần đầu có người sửa một bên (AGENTS.md mục 15).
 *
 * Lý do chọn `case` thay vì `join (values …)` nằm ở chú thích của hàm trên — đã đo, không đoán.
 */
export function deliveryRateCaseSql(rates: ProductDeliveryRates, productKeyExpr: SQL<string>): SQL<number> {
  const fb = sql`${rates.fallback.deliveryRate / 100}::numeric`;
  const entries = [...rates.byProduct.entries()];
  if (!entries.length) return sql<number>`${fb}`;
  const whens = sql.join(
    entries.map(([id, r]) => sql`when ${id} then ${r.deliveryRate / 100}::numeric`),
    sql` `,
  );
  return sql<number>`(case ${productKeyExpr} ${whens} else ${fb} end)`;
}
