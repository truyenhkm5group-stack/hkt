import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT, SHIPMENT_LEFT_WAREHOUSE } from "@/lib/queries/return-rate";
import { ORDER_SOURCE, ORDER_SOURCE_LABEL, type OrderSourceKey } from "@/lib/queries/order-source";
import { ATTRIBUTION_FIELDS, LOW_COVERAGE_PCT, type AttributionField } from "@/lib/constants/sales-funnel";
import type { Period } from "@/lib/search-params";

/**
 * ───────────── PHỄU BÁN HÀNG ─────────────
 *
 * Đặc tả: docs/sales-funnel-contract.md — đọc trước khi sửa.
 *
 * NĂM bước, không phải bảy. "Đã liên hệ" và "Đủ điều kiện" KHÔNG có nguồn dữ liệu nào trong kho mã
 * này (ERP không đồng bộ hội thoại Pancake), nên chúng không tồn tại ở đây. Bịa ra bằng cách suy từ
 * đơn hàng là dựng số liệu.
 *
 * Phễu tính theo KỲ TẠO ĐƠN, không theo ngày xảy ra từng bước: nếu mỗi bước đếm theo ngày riêng thì
 * bước sau có thể lớn hơn bước trước — một phễu phình ra ở giữa, vô nghĩa.
 */

const o = schema.orders;
const s = schema.shipments;

export type FunnelStage = {
  key: "created" | "confirmed" | "shipped" | "delivered" | "repeat";
  label: string;
  count: number;
  /** Tỷ lệ so với bước ĐẦU (0–1). */
  ofStart: number;
  /** Tỷ lệ so với bước LIỀN TRƯỚC (0–1). Đây mới là "tỷ lệ chuyển đổi" của riêng bước này. */
  ofPrevious: number;
  /** Mẫu số của `ofPrevious` nói bằng lời — để người đọc biết đang so với cái gì. */
  previousLabel: string;
};

export type SalesFunnel = {
  stages: FunnelStage[];
  /** Đơn của kỳ còn đang chạy, chưa biết kết quả. KHÔNG được tính là thất bại. */
  unfinished: number;
  /** Đơn bị huỷ — rời phễu, không phải thất bại giao vận. */
  cancelled: number;
};

function periodWhere(period: Period) {
  const from = period.from ? sql`${o.insertedAt} >= ${period.from.toISOString()}::timestamptz` : sql`true`;
  const to = period.to ? sql`${o.insertedAt} <= ${period.to.toISOString()}::timestamptz` : sql`true`;
  return sql`${from} and ${to}`;
}

/**
 * Phễu theo kỳ tạo đơn.
 *
 * Bước "khách mua lại" đo trên KHÁCH, không trên đơn: nó trả lời "bao nhiêu khách đã nhận hàng của
 * kỳ này từng mua thành công nhiều hơn một lần". Vì grain khác, mẫu số của nó là SỐ KHÁCH đã nhận
 * hàng chứ không phải số đơn — `previousLabel` nói rõ điều đó thay vì để người đọc tự đoán.
 */
export async function getSalesFunnel(period: Period): Promise<SalesFunnel> {
  const db = await getDb();
  const where = periodWhere(period);
  const [row] = await db
    .select({
      created: sql<number>`count(distinct ${o.id})`,
      confirmed: sql<number>`count(distinct ${o.id}) filter (where ${o.stage} not in ('NEW','WAITING'))`,
      shipped: sql<number>`count(distinct ${o.id}) filter (where ${SHIPMENT_LEFT_WAREHOUSE})`,
      delivered: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      cancelled: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'CANCELLED')`,
      unfinished: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} in ('IN_TRANSIT','UNKNOWN','NOT_SHIPPED'))`,
      deliveredCustomers: sql<number>`count(distinct ${o.customerId}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      repeatCustomers: sql<number>`count(distinct ${o.customerId}) filter (where ${ORDER_OUTCOME} = 'DELIVERED' and coalesce(${schema.customers.succeedOrderCount}, 0) > 1)`,
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG: đơn nhiều lần gửi không được cộng tiền nhiều lần (xem PRIMARY_ATTEMPT).
    .leftJoin(s, sql`${s.orderId} = ${o.id} and ${PRIMARY_ATTEMPT}`)
    .leftJoin(schema.customers, sql`${schema.customers.id} = ${o.customerId}`)
    .where(where);

  const created = Number(row?.created ?? 0);
  const confirmed = Number(row?.confirmed ?? 0);
  const shipped = Number(row?.shipped ?? 0);
  const delivered = Number(row?.delivered ?? 0);
  const deliveredCustomers = Number(row?.deliveredCustomers ?? 0);
  const repeat = Number(row?.repeatCustomers ?? 0);

  const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
  const stages: FunnelStage[] = [
    { key: "created", label: "Đơn được tạo", count: created, ofStart: created > 0 ? 1 : 0, ofPrevious: created > 0 ? 1 : 0, previousLabel: "chính nó" },
    { key: "confirmed", label: "Đã xác nhận", count: confirmed, ofStart: ratio(confirmed, created), ofPrevious: ratio(confirmed, created), previousLabel: "đơn được tạo" },
    { key: "shipped", label: "Đã rời kho", count: shipped, ofStart: ratio(shipped, created), ofPrevious: ratio(shipped, confirmed), previousLabel: "đơn đã xác nhận" },
    { key: "delivered", label: "Giao thành công", count: delivered, ofStart: ratio(delivered, created), ofPrevious: ratio(delivered, shipped), previousLabel: "đơn đã rời kho" },
    { key: "repeat", label: "Khách mua lại", count: repeat, ofStart: ratio(repeat, deliveredCustomers), ofPrevious: ratio(repeat, deliveredCustomers), previousLabel: "khách đã nhận hàng" },
  ];

  return { stages, unfinished: Number(row?.unfinished ?? 0), cancelled: Number(row?.cancelled ?? 0) };
}

export type AttributionCoverage = {
  field: AttributionField;
  label: string;
  /** Số đơn CÓ giá trị ở trường này. */
  filled: number;
  total: number;
  /** 0–1. */
  coverage: number;
  /** Số người khác nhau xuất hiện ở trường này. */
  distinct: number;
  /** Độ phủ dưới ngưỡng ⇒ mọi chỉ số chia theo trường này phải kèm cảnh báo. */
  lowCoverage: boolean;
};

/**
 * ĐỘ PHỦ GÁN NGƯỜI. Không có nó thì một người xử lý 10 đơn trong tổng 100 đơn có gán trông y hệt
 * người xử lý 10 đơn trong tổng 1.000 đơn.
 *
 * Đo cả năm trường vì chúng KHÔNG thay thế được cho nhau: người chốt đơn, người chăm sóc, người chạy
 * quảng cáo và người tạo đơn là bốn vai khác nhau, và chỉ `editor_name` mới có mốc thời gian.
 */
export async function getAttributionCoverage(period: Period): Promise<AttributionCoverage[]> {
  const db = await getDb();
  const where = periodWhere(period);
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      sellerFilled: sql<number>`count(*) filter (where ${o.sellerName} <> '')`,
      sellerDistinct: sql<number>`count(distinct nullif(${o.sellerName}, ''))`,
      careFilled: sql<number>`count(*) filter (where ${o.careName} <> '')`,
      careDistinct: sql<number>`count(distinct nullif(${o.careName}, ''))`,
      marketerFilled: sql<number>`count(*) filter (where ${o.marketerName} <> '')`,
      marketerDistinct: sql<number>`count(distinct nullif(${o.marketerName}, ''))`,
      creatorFilled: sql<number>`count(*) filter (where ${o.creatorName} <> '')`,
      creatorDistinct: sql<number>`count(distinct nullif(${o.creatorName}, ''))`,
      editorFilled: sql<number>`count(*) filter (where exists (select 1 from order_status_history h where h.order_id = ${o.id} and h.editor_name <> ''))`,
      editorDistinct: sql<number>`count(distinct (select h.editor_name from order_status_history h where h.order_id = ${o.id} and h.editor_name <> '' order by h.updated_at limit 1))`,
    })
    .from(o)
    .where(where);

  const total = Number(row?.total ?? 0);
  const pick: Record<AttributionField, { filled: number; distinct: number }> = {
    sellerName: { filled: Number(row?.sellerFilled ?? 0), distinct: Number(row?.sellerDistinct ?? 0) },
    careName: { filled: Number(row?.careFilled ?? 0), distinct: Number(row?.careDistinct ?? 0) },
    marketerName: { filled: Number(row?.marketerFilled ?? 0), distinct: Number(row?.marketerDistinct ?? 0) },
    creatorName: { filled: Number(row?.creatorFilled ?? 0), distinct: Number(row?.creatorDistinct ?? 0) },
    editorName: { filled: Number(row?.editorFilled ?? 0), distinct: Number(row?.editorDistinct ?? 0) },
  };

  return ATTRIBUTION_FIELDS.map((f) => {
    const v = pick[f.field];
    const coverage = total > 0 ? v.filled / total : 0;
    return { field: f.field, label: f.label, filled: v.filled, total, coverage, distinct: v.distinct, lowCoverage: total > 0 && coverage * 100 < LOW_COVERAGE_PCT };
  });
}

export type FunnelBySource = {
  source: OrderSourceKey;
  label: string;
  created: number;
  confirmed: number;
  shipped: number;
  delivered: number;
  unfinished: number;
  deliveredRevenue: number;
  /** Giao thành công / đã rời kho (0–1); `null` khi chưa gửi đơn nào. */
  deliveryRate: number | null;
  /** Xác nhận / được tạo (0–1); `null` khi chưa có đơn nào. */
  confirmRate: number | null;
};

/**
 * Phễu tách theo KÊNH ĐẶT HÀNG. Dùng lại `ORDER_SOURCE` — kênh của một đơn được quyết định ở một
 * chỗ duy nhất trong ERP, không định nghĩa lại ở đây.
 *
 * Vì sao cần tách: tỷ lệ giao thành công của đơn landing và đơn chat Facebook khác nhau rất xa; gộp
 * chung thành một con số trung bình thì con số đó không mô tả đúng kênh nào cả.
 */
export async function getFunnelBySource(period: Period): Promise<FunnelBySource[]> {
  const db = await getDb();
  const rows = await db
    .select({
      source: sql<OrderSourceKey>`${ORDER_SOURCE}`,
      created: sql<number>`count(distinct ${o.id})`,
      confirmed: sql<number>`count(distinct ${o.id}) filter (where ${o.stage} not in ('NEW','WAITING'))`,
      shipped: sql<number>`count(distinct ${o.id}) filter (where ${SHIPMENT_LEFT_WAREHOUSE})`,
      delivered: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      unfinished: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} in ('IN_TRANSIT','UNKNOWN','NOT_SHIPPED'))`,
      deliveredRevenue: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG: đơn nhiều lần gửi không được cộng tiền nhiều lần (xem PRIMARY_ATTEMPT).
    .leftJoin(s, sql`${s.orderId} = ${o.id} and ${PRIMARY_ATTEMPT}`)
    .where(periodWhere(period))
    .groupBy(sql`${ORDER_SOURCE}`);

  return rows
    .map((r) => {
      const created = Number(r.created ?? 0);
      const shipped = Number(r.shipped ?? 0);
      const delivered = Number(r.delivered ?? 0);
      const confirmed = Number(r.confirmed ?? 0);
      return {
        source: r.source,
        label: ORDER_SOURCE_LABEL[r.source] ?? r.source,
        created,
        confirmed,
        shipped,
        delivered,
        unfinished: Number(r.unfinished ?? 0),
        deliveredRevenue: Number(r.deliveredRevenue ?? 0),
        // Mẫu số là đơn ĐÃ RỜI KHO: kênh nào cũng không chịu trách nhiệm cho đơn chưa từng gửi đi.
        deliveryRate: shipped > 0 ? delivered / shipped : null,
        confirmRate: created > 0 ? confirmed / created : null,
      };
    })
    .sort((a, b) => b.deliveredRevenue - a.deliveredRevenue || b.created - a.created);
}
