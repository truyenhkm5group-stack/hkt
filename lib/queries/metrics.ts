import { and, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { schema } from "@/db";
import { CONFIRMED_STAGES } from "@/lib/constants/pancake";
import { ORDER_COGS } from "@/lib/queries/cogs";
import { ORDER_OUTCOME, REPORTABLE_ORDER } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

/**
 * ─────────────────────── LỚP CHÂN LÝ CHỈ SỐ ───────────────────────
 *
 * Mỗi chỉ số quản trị có ĐÚNG MỘT định nghĩa, ở đây. Hợp đồng đầy đủ (ý nghĩa · tử số · mẫu số ·
 * population · loại trừ · trường ngày · nguồn sự thật) nằm ở `docs/metrics-contract.md`.
 *
 * Vì sao cần: kết quả đơn đã tập trung vào `ORDER_OUTCOME` từ lâu, nhưng POPULATION thì chưa. Hai
 * phạm vi đơn cùng tồn tại — `REPORTABLE_ORDER` (mọi đơn đã chốt, kể cả huỷ) và `CONFIRMED_ORDER`
 * (đơn đã xác nhận trên Pancake) — và có màn hình dùng lẫn hai cái trong cùng một phép tính. Đo
 * được trên Tổng quan: doanh thu giao thành công lấy theo một tập đơn, giá vốn lấy theo tập khác,
 * nên lợi nhuận ước tính lệch (F4, docs/erp-data-truth-audit.md).
 *
 * KHÔNG có công thức kết quả đơn mới ở đây. `ORDER_OUTCOME` vẫn là bản duy nhất.
 * Mọi biểu thức dưới đây yêu cầu `FROM orders LEFT JOIN shipments`.
 */

const o = schema.orders;

/** Tên gọi của hai phạm vi đơn — dùng làm nhãn/tooltip để người đọc biết đang đếm tập nào. */
export type MetricPopulation = "confirmed" | "reportable";

export const POPULATION_LABEL: Record<MetricPopulation, string> = {
  confirmed: "Đơn đã xác nhận trên Pancake",
  reportable: "Mọi đơn đã chốt (gồm cả đơn huỷ)",
};

export const POPULATION_HINT: Record<MetricPopulation, string> = {
  confirmed: "Bỏ đơn Mới chưa chốt, đơn huỷ và đơn xoá. Dùng cho doanh thu, lợi nhuận, lương, quảng cáo.",
  reportable: "Chỉ bỏ đơn Mới chưa chốt; giữ đơn huỷ để còn đếm được số đơn huỷ. Dùng cho tỷ lệ giao thành công và bảng kết quả đơn.",
};

/** POPULATION 1 — đơn đã xác nhận trên Pancake. */
export const CONFIRMED_ORDER: SQL = inArray(o.stage, [...CONFIRMED_STAGES]);

/** POPULATION 2 — mọi đơn đã chốt, kể cả huỷ. */
export { REPORTABLE_ORDER };

export function populationFilter(population: MetricPopulation): SQL {
  return population === "confirmed" ? CONFIRMED_ORDER : (REPORTABLE_ORDER as SQL);
}

/** Kỳ báo cáo theo NGÀY LÊN ĐƠN — trường ngày mặc định của mọi chỉ số ở đây. */
export function bookedInPeriod(from: Date | null, to: Date | null): SQL | undefined {
  const conds: SQL[] = [];
  if (from) conds.push(gte(o.insertedAt, from));
  if (to) conds.push(lte(o.insertedAt, to));
  return conds.length ? and(...conds) : undefined;
}

/** Bộ lọc chuẩn của một chỉ số: population + kỳ. Mọi màn hình phải dùng chung hàm này. */
export function metricScope(period: Period, population: MetricPopulation = "confirmed"): SQL {
  const inPeriod = bookedInPeriod(period.from, period.to);
  return (inPeriod ? and(populationFilter(population), inPeriod) : populationFilter(population)) as SQL;
}

// ───────────────────────── Vị ngữ theo kết quả đơn ─────────────────────────
// Tất cả đều đi qua ORDER_OUTCOME; không nơi nào được viết lại điều kiện stage.

export const IS_DELIVERED = sql`${ORDER_OUTCOME} = 'DELIVERED'`;
/** `RETURNED` và `RETURNED_BY_RULE` LUÔN gộp làm một trong mọi tổng hợp (đặc tả mục 6). */
export const IS_RETURNED = sql`${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')`;
export const IS_CANCELLED = sql`${ORDER_OUTCOME} = 'CANCELLED'`;
export const IS_OPEN = sql`${ORDER_OUTCOME} in ('IN_TRANSIT','NOT_SHIPPED','UNKNOWN')`;
/** Đơn ĐÃ KẾT THÚC — mẫu số của tỷ lệ giao thành công. Đơn huỷ KHÔNG nằm trong mẫu số. */
export const IS_FINISHED = sql`${ORDER_OUTCOME} in ('DELIVERED','RETURNED','RETURNED_BY_RULE')`;

// ───────────────────────── Tiền ─────────────────────────

/**
 * DOANH THU LÊN ĐƠN (booked revenue) — giá trị đơn khách đã chốt, chưa nói gì về việc giao được
 * hay thu được tiền. Loại đơn huỷ.
 */
export const BOOKED_REVENUE = sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} <> 'CANCELLED'), 0)`;

/** DOANH THU GIAO THÀNH CÔNG (delivered revenue) — giá trị đơn ĐÃ tới tay khách. */
export const DELIVERED_REVENUE = sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${IS_DELIVERED}), 0)`;

/** GIÁ VỐN của đơn giao thành công — PHẢI cùng population với DELIVERED_REVENUE. */
export const DELIVERED_COGS = sql<number>`coalesce(sum(${ORDER_COGS}) filter (where ${IS_DELIVERED}), 0)`;

/** Giá vốn của mọi đơn không huỷ — dùng cho báo cáo danh nghĩa. */
export const BOOKED_COGS = sql<number>`coalesce(sum(${ORDER_COGS}) filter (where ${ORDER_OUTCOME} <> 'CANCELLED'), 0)`;

// ───────────────────────── Đếm ─────────────────────────

export const COUNT_BOOKED = sql<number>`count(*) filter (where ${ORDER_OUTCOME} <> 'CANCELLED')`;
export const COUNT_DELIVERED = sql<number>`count(*) filter (where ${IS_DELIVERED})`;
export const COUNT_RETURNED = sql<number>`count(*) filter (where ${IS_RETURNED})`;
export const COUNT_CANCELLED = sql<number>`count(*) filter (where ${IS_CANCELLED})`;
export const COUNT_OPEN = sql<number>`count(*) filter (where ${IS_OPEN})`;

/**
 * TỶ LỆ GIAO THÀNH CÔNG = giao thành công ÷ (giao thành công + hoàn), tính trên ĐƠN ĐÃ KẾT THÚC.
 * Chưa có đơn nào kết thúc thì trả `null` — hiển thị "—", KHÔNG phải 0%.
 * Đây là hàm dùng chung: mọi màn hình gọi nó, không tự chia.
 */
export function successRate(delivered: number, returned: number): number | null {
  const finished = delivered + returned;
  return finished ? Math.round((delivered / finished) * 1000) / 10 : null;
}

/** Giá trị đơn trung bình. Không có đơn nào thì 0 (đếm được là 0, không phải chưa biết). */
export function averageOrderValue(revenue: number, orders: number): number {
  return orders ? Math.round(revenue / orders) : 0;
}
