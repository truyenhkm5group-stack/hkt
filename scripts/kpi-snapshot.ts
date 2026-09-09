/**
 * ẢNH CHỤP KPI ĐỂ ĐỐI CHIẾU TRƯỚC / SAU MỖI LẦN DEPLOY.
 *
 * Vì sao cần: chính sách phát hành đòi "deploy không được tự làm đổi sự thật nghiệp vụ". Muốn khẳng
 * định điều đó thì phải có CÙNG MỘT phép đo chạy trước và sau, chứ không phải hai câu SQL gõ tay ở
 * hai thời điểm.
 *
 * NGUYÊN TẮC: script này KHÔNG tự định nghĩa công thức nào. Nó dùng lại `ORDER_OUTCOME` —
 * nguồn sự thật duy nhất của kết quả đơn (docs/business-rules/ORDER_OUTCOME.md). Viết lại điều kiện
 * ở đây là tạo ra một con số thứ hai cho cùng một chỉ số, đúng thứ mà đặc tả cấm.
 *
 * CHỈ ĐỌC. Không ghi bất cứ thứ gì.
 *
 * Dùng qua ops: Actions → "Vận hành ERP trên VPS" → kpi-snapshot
 */
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";

const o = schema.orders;
const s = schema.shipments;

async function main() {
  const db = await getDb();

  // ── Phân bố kết quả đơn: con số quan trọng nhất, và là con số dễ bị đổi ngầm nhất ──
  const [outcome] = await db
    .select({
      tong: sql<number>`count(distinct ${o.id})`,
      delivered: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'RETURNED')`,
      returnedByRule: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'RETURNED_BY_RULE')`,
      inTransit: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
      unknown: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'UNKNOWN')`,
      notShipped: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'NOT_SHIPPED')`,
      cancelled: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'CANCELLED')`,
    })
    .from(o)
    .leftJoin(s, sql`${s.orderId} = ${o.id}`);

  // ── Ba con số tiền, tách bạch theo đúng luật: lên đơn ≠ giao thành công ≠ thực nhận ──
  const [money] = await db
    .select({
      booked: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} <> 'CANCELLED'), 0)`,
      delivered: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      // Tiền CÓ CHỨNG TỪ, không phải COD khai báo.
      cash: sql<number>`coalesce(sum(coalesce(nullif(${s.codCollected}, 0), 0) + coalesce(${o.prepaid}, 0) + coalesce(${o.transferMoney}, 0)) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      codPending: sql<number>`coalesce(sum(coalesce(${s.codAmount}, 0)) filter (where ${ORDER_OUTCOME} = 'DELIVERED' and coalesce(${s.codCollected}, 0) = 0), 0)`,
    })
    .from(o)
    .leftJoin(s, sql`${s.orderId} = ${o.id}`);

  // ── Vài con số nền để phát hiện lệch dữ liệu, không phải lệch công thức ──
  const [scale] = await db
    .select({
      orders: sql<number>`(select count(*) from orders)`,
      shipments: sql<number>`(select count(*) from shipments)`,
      shipmentEvents: sql<number>`(select count(*) from shipment_events)`,
      openNotifications: sql<number>`(select count(*) from notifications where resolved_at is null)`,
      returnsPending: sql<number>`(select count(*) from shipments where stage::text = 'RETURNED' and return_received_at is null and order_id is not null)`,
    })
    .from(sql`(select 1) as x`);

  const delivered = Number(outcome?.delivered ?? 0);
  const returnedAll = Number(outcome?.returned ?? 0) + Number(outcome?.returnedByRule ?? 0);
  const settled = delivered + returnedAll;

  console.log(
    JSON.stringify(
      {
        chup_luc: new Date().toISOString(),
        ket_qua_don: {
          tong: Number(outcome?.tong ?? 0),
          giao_thanh_cong: delivered,
          hoan: Number(outcome?.returned ?? 0),
          hoan_theo_luat: Number(outcome?.returnedByRule ?? 0),
          dang_giao: Number(outcome?.inTransit ?? 0),
          chua_ro: Number(outcome?.unknown ?? 0),
          chua_gui: Number(outcome?.notShipped ?? 0),
          huy: Number(outcome?.cancelled ?? 0),
        },
        // Mẫu số là đơn ĐÃ KẾT THÚC — không phải tổng đơn.
        gtc_phan_tram: settled > 0 ? Math.round((delivered / settled) * 1000) / 10 : null,
        tien: {
          len_don: Number(money?.booked ?? 0),
          giao_thanh_cong: Number(money?.delivered ?? 0),
          thuc_nhan_co_chung_tu: Number(money?.cash ?? 0),
          cod_dang_cho: Number(money?.codPending ?? 0),
        },
        quy_mo: {
          don: Number(scale?.orders ?? 0),
          van_don: Number(scale?.shipments ?? 0),
          su_kien_van_don: Number(scale?.shipmentEvents ?? 0),
          viec_dang_mo: Number(scale?.openNotifications ?? 0),
          hoan_cho_kiem_dem: Number(scale?.returnsPending ?? 0),
        },
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
