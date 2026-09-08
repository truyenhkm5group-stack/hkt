import { sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { LOW_COVERAGE_PCT, UNASSIGNED_LABEL, type AttributionField } from "@/lib/constants/sales-funnel";
import type { Period } from "@/lib/search-params";

/**
 * ───────────── HIỆU SUẤT NHÂN SỰ ─────────────
 *
 * Đặc tả: docs/sales-funnel-contract.md.
 *
 * BA ĐIỀU QUYẾT ĐỊNH CÁCH LÀM Ở ĐÂY:
 *
 * 1. KHÔNG đánh giá ai bằng SỐ LƯỢNG đơn. Một người lên 100 đơn mà 70 đơn hoàn thì kém hơn người
 *    lên 50 đơn giao trót lọt cả 50. Nên mọi dòng đều có doanh thu GIAO THÀNH CÔNG và tỷ lệ hoàn
 *    đứng cạnh số đơn, và bảng xếp theo doanh thu giao thành công chứ không theo số đơn.
 *
 * 2. Đơn KHÔNG GÁN ĐƯỢC vào một dòng "Chưa gán" hiện tường minh, KHÔNG chia đều cho nhân viên.
 *    Chia đều là bịa: nó làm tổng khớp trong khi từng người đều sai.
 *
 * 3. Đơn CHƯA KẾT THÚC đếm riêng. Người mới nhận đơn hôm qua không được tính là đã thất bại.
 *
 * Doanh thu ở đây là doanh thu GIAO THÀNH CÔNG theo `ORDER_OUTCOME`, không phải số lên đơn —
 * dùng lại đúng một công thức của toàn ERP, không viết lại điều kiện.
 */

const o = schema.orders;
const s = schema.shipments;

/** Cột chứa tên người, theo vai được chọn. Một chỗ duy nhất ánh xạ vai → cột. */
function columnFor(field: AttributionField): SQL {
  switch (field) {
    case "sellerName":
      return sql`${o.sellerName}`;
    case "careName":
      return sql`${o.careName}`;
    case "marketerName":
      return sql`${o.marketerName}`;
    case "creatorName":
      return sql`${o.creatorName}`;
    case "editorName":
      // Người ĐẦU TIÊN đổi trạng thái đơn — tức người xác nhận. Nguồn duy nhất có mốc thời gian.
      return sql`coalesce((select h.editor_name from order_status_history h where h.order_id = ${o.id} and h.editor_name <> '' order by h.updated_at limit 1), '')`;
  }
}

export type StaffRow = {
  name: string;
  /** Dòng gộp các đơn không gán được cho ai. */
  unassigned: boolean;
  orders: number;
  confirmed: number;
  delivered: number;
  returned: number;
  /** Đơn còn đang chạy — KHÔNG tính vào tỷ lệ thành công/hoàn. */
  unfinished: number;
  /** Doanh thu đơn đã chốt (số "lên đơn"). */
  bookedRevenue: number;
  /** Doanh thu của đơn ĐÃ GIAO THÀNH CÔNG. Đây mới là tiền thật đã bán được. */
  deliveredRevenue: number;
  /** Giá vốn của phần đã giao thành công; `null` khi chưa đủ dữ liệu giá vốn. */
  cogs: number | null;
  /** Doanh thu giao thành công − giá vốn. `null` khi thiếu giá vốn — KHÔNG coi thiếu là 0. */
  contribution: number | null;
  /** Tỷ lệ giao thành công trên các đơn ĐÃ KẾT THÚC (0–1); `null` khi chưa đơn nào kết thúc. */
  gtc: number | null;
  returnRate: number | null;
  /** Giá trị trung bình một đơn giao thành công; `null` khi chưa có đơn nào. */
  aov: number | null;
};

export type StaffPerformance = {
  field: AttributionField;
  rows: StaffRow[];
  /** Tỷ lệ đơn trong kỳ CÓ gán vai này (0–1). */
  coverage: number;
  lowCoverage: boolean;
  /** Bao nhiêu phần trăm đơn giao thành công tra được giá vốn — dưới 100% thì đóng góp là ước tính. */
  cogsCoverage: number;
  totalOrders: number;
};

/**
 * Hiệu suất theo một vai. Kỳ tính theo NGÀY TẠO ĐƠN, thống nhất với phễu bán hàng — nếu doanh thu
 * đếm theo ngày giao mà số đơn đếm theo ngày tạo thì hai cột trong cùng một hàng nói về hai tập đơn
 * khác nhau.
 */
export async function getStaffPerformance(period: Period, field: AttributionField): Promise<StaffPerformance> {
  const db = await getDb();
  const who = columnFor(field);
  const from = period.from ? sql`${o.insertedAt} >= ${period.from.toISOString()}::timestamptz` : sql`true`;
  const to = period.to ? sql`${o.insertedAt} <= ${period.to.toISOString()}::timestamptz` : sql`true`;
  const finished = sql`${ORDER_OUTCOME} in ('DELIVERED','RETURNED','RETURNED_BY_RULE')`;
  const isDelivered = sql`${ORDER_OUTCOME} = 'DELIVERED'`;
  const isReturned = sql`${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')`;

  const rows = await db
    .select({
      name: sql<string>`${who}`,
      orders: sql<number>`count(distinct ${o.id})`,
      confirmed: sql<number>`count(distinct ${o.id}) filter (where ${o.stage} not in ('NEW','WAITING'))`,
      delivered: sql<number>`count(distinct ${o.id}) filter (where ${isDelivered})`,
      returned: sql<number>`count(distinct ${o.id}) filter (where ${isReturned})`,
      unfinished: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} in ('IN_TRANSIT','UNKNOWN','NOT_SHIPPED'))`,
      bookedRevenue: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${o.stage} not in ('NEW','WAITING')), 0)`,
      deliveredRevenue: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${isDelivered}), 0)`,
      cogs: sql<number>`coalesce(sum(${o.cogs}) filter (where ${isDelivered} and ${o.cogs} is not null), 0)`,
      // Đếm riêng phần giao thành công TRA ĐƯỢC giá vốn: thiếu giá vốn phải hiện thành thiếu,
      // không được lặng lẽ tính bằng 0 rồi thổi phồng đóng góp.
      cogsKnown: sql<number>`count(distinct ${o.id}) filter (where ${isDelivered} and ${o.cogs} is not null)`,
    })
    .from(o)
    .leftJoin(s, sql`${s.orderId} = ${o.id}`)
    .where(sql`${from} and ${to}`)
    .groupBy(sql`${who}`);

  let totalOrders = 0;
  let assignedOrders = 0;
  let deliveredAll = 0;
  let cogsKnownAll = 0;

  const mapped: StaffRow[] = rows.map((r) => {
    const name = (r.name ?? "").trim();
    const orders = Number(r.orders ?? 0);
    const delivered = Number(r.delivered ?? 0);
    const returned = Number(r.returned ?? 0);
    const settled = delivered + returned;
    const deliveredRevenue = Number(r.deliveredRevenue ?? 0);
    const cogsKnown = Number(r.cogsKnown ?? 0);
    const cogs = cogsKnown > 0 ? Number(r.cogs ?? 0) : null;

    totalOrders += orders;
    if (name) assignedOrders += orders;
    deliveredAll += delivered;
    cogsKnownAll += cogsKnown;

    return {
      name: name || UNASSIGNED_LABEL,
      unassigned: !name,
      orders,
      confirmed: Number(r.confirmed ?? 0),
      delivered,
      returned,
      unfinished: Number(r.unfinished ?? 0),
      bookedRevenue: Number(r.bookedRevenue ?? 0),
      deliveredRevenue,
      cogs,
      contribution: cogs === null ? null : deliveredRevenue - cogs,
      // Mẫu số là đơn ĐÃ KẾT THÚC. Chia cho tổng đơn sẽ trừng phạt người vừa nhận đơn hôm qua.
      gtc: settled > 0 ? delivered / settled : null,
      returnRate: settled > 0 ? returned / settled : null,
      aov: delivered > 0 ? deliveredRevenue / delivered : null,
    };
  });

  // Xếp theo TIỀN THẬT ĐÃ BÁN ĐƯỢC, không theo số đơn — người lên nhiều đơn mà hoàn hết không
  // được đứng đầu bảng.
  mapped.sort((a, b) => Number(a.unassigned) - Number(b.unassigned) || b.deliveredRevenue - a.deliveredRevenue || b.delivered - a.delivered);

  const coverage = totalOrders > 0 ? assignedOrders / totalOrders : 0;
  return {
    field,
    rows: mapped,
    coverage,
    lowCoverage: totalOrders > 0 && coverage * 100 < LOW_COVERAGE_PCT,
    cogsCoverage: deliveredAll > 0 ? cogsKnownAll / deliveredAll : 0,
    totalOrders,
  };
}
