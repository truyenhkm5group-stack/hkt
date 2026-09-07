/**
 * Giải thích ERP kết luận kết quả một vận đơn như thế nào — bằng CHÍNH biểu thức ORDER_OUTCOME
 * đang chạy, không phải bằng truy vấn mô phỏng.
 *
 * Vì sao cần: đã có lần kiểm chứng bằng SQL viết lại theo trí nhớ nên bỏ sót một nhánh và kết luận
 * sai là "đã đúng". Công cụ này loại bỏ hẳn khoảng cách giữa thứ được kiểm và thứ đang chạy.
 *
 * Dùng: npx tsx scripts/order-outcome-explain.ts PKE1508909064 PKE1508909058
 */
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME, ORDER_OUTCOME_VERIFIED } from "@/lib/queries/return-rate";

async function main() {
  const codes = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((c) => c.trim().toUpperCase());
  if (!codes.length) {
    console.error("Cần ít nhất một mã vận đơn. Ví dụ: npx tsx scripts/order-outcome-explain.ts PKE1508909064");
    process.exit(1);
  }
  const db = await getDb();
  const s = schema.shipments;

  const rows = await db
    .select({
      ma: s.vtpOrderNumber,
      donHang: schema.orders.systemId,
      giaiDoan: s.stage,
      maSoVtp: s.vtpStatus,
      tenTrangThai: s.vtpStatusName,
      codKhaiBao: s.codAmount,
      thucThu: s.codCollected,
      trangThaiCod: s.codStatus,
      coMaBangKe: sql<boolean>`${s.codStatementRef} is not null`,
      traTruoc: sql<number>`coalesce(${schema.orders.prepaid}, 0) + coalesce(${schema.orders.transferMoney}, 0)`,
      vanDonChieuHoan: sql<number>`(select count(*) from shipments g where g.order_reference = ${s.vtpOrderNumber} and g.id <> ${s.id})`,
      suaDoanhThuSauGiao: sql<number>`(select count(*) from shipment_events e where e.shipment_id = ${s.id}
        and e.status_name like 'Nhập doanh thu%' and e.occurred_at >= coalesce(${s.deliveredAt}, ${s.vtpStatusDate}) - interval '2 minute')`,
      suKienChieuHoan: sql<number>`(select count(*) from shipment_events e where e.shipment_id = ${s.id} and e.leg_type = 'RETURN')`,
      chungTuVtp: sql<number>`(select count(*) from shipment_events e where e.shipment_id = ${s.id}
        and e.source in ('VTP_WEBHOOK','VTP_IMPORT','VTP_POLL','MANUAL') and e.normalized_stage is not null)`,
      ketQua: ORDER_OUTCOME,
      ketQuaDaXacMinh: ORDER_OUTCOME_VERIFIED,
    })
    .from(s)
    .leftJoin(schema.orders, eq(schema.orders.id, s.orderId))
    .where(inArray(sql`upper(${s.vtpOrderNumber})`, codes));

  const thieu = codes.filter((c) => !rows.some((r) => (r.ma ?? "").toUpperCase() === c));
  console.log(JSON.stringify({ tim: codes.length, thay: rows.length, khong_thay: thieu, van_don: rows }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
