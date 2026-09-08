/**
 * BỘ TRUY VẤN CHỈ-ĐỌC ĐỂ THẨM ĐỊNH PRODUCTION SAU DEPLOY.
 *
 * Vì sao tồn tại: các con số của "chạy thử dựng lại lịch sử" (job `canonical-backfill`) cần BẢN MỚI
 * mới chạy được. Bộ SQL dưới đây đo ĐÚNG những con số đó nhưng chỉ dùng các bảng đã có từ lâu, nên
 * chạy được cả trên bản đang chạy ở production — và TUYỆT ĐỐI không ghi gì.
 *
 * Dùng cục bộ:  DATABASE_URL="pglite://./data/pglite-test-xxxx" npx tsx scripts/prod-readonly-probe.ts
 * Trên production: chạy TỪNG câu qua ops `db-query` (một câu mỗi lần — CTE không tồn tại sang câu sau).
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

/** Vận đơn đã rời kho — cùng định nghĩa với SHIPMENT_LEFT_WAREHOUSE trong lib/queries/return-rate.ts. */
const LEFT_WAREHOUSE = `(s.picked_up_at is not null or s.stage::text in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED','DELIVERED','RETURNING','RETURNED'))`;

/** Tổng phiếu kho và số phiếu NHẬP theo mẫu mã. */
const RECEIPTS = `(
  select ri.variant_id, sum(ri.quantity) as received,
         count(distinct ri.receipt_id) filter (where r.kind = 'RECEIPT') as receipt_docs
  from stock_receipt_items ri join stock_receipts r on r.id = ri.receipt_id
  group by 1
)`;

/** Số đã xuất qua ĐVVC theo mẫu mã. */
const SHIPPED = `(
  select oi.variant_id, sum(oi.quantity) as shipped
  from order_items oi
  join orders o on o.id = oi.order_id
  join shipments s on s.order_id = o.id
  where ${LEFT_WAREHOUSE}
  group by 1
)`;

export const PROBES: { ten: string; sql: string }[] = [
  {
    ten: "1. Ảnh chụp vận đơn LỆCH trạng thái dựng từ lịch sử (= 'changed' của chạy thử backfill)",
    sql: `select s.stage::text as anh_chup, ev.normalized_stage::text as lich_su, count(*)::int as so_van_don
          from shipments s
          join lateral (
            select e.normalized_stage from shipment_events e
            where e.shipment_id = s.id
              and e.source in ('VTP_WEBHOOK','VTP_POLL','VTP_IMPORT','MANUAL')
              and e.normalized_stage is not null and e.normalized_stage::text <> 'UNKNOWN'
              and e.leg_type is distinct from 'RETURN'
            order by e.occurred_at desc limit 1
          ) ev on true
          where ev.normalized_stage <> s.stage
          group by 1, 2 order by 3 desc`,
  },
  {
    ten: "2. Tổng vận đơn · có chứng từ ĐVVC · KHÔNG có chứng từ nào",
    sql: `select count(*)::int as tong,
                 count(*) filter (where exists (select 1 from shipment_events e where e.shipment_id = s.id and e.normalized_stage is not null))::int as co_chung_tu,
                 count(*) filter (where not exists (select 1 from shipment_events e where e.shipment_id = s.id and e.normalized_stage is not null))::int as thieu_chung_tu
          from shipments s`,
  },
  {
    ten: "3. Ghi ĐÃ GIAO nhưng KHÔNG có sự kiện phát thành công nào của ĐVVC",
    sql: `select count(*)::int as so_van_don from shipments s
          where s.stage::text = 'DELIVERED'
            and not exists (select 1 from shipment_events e where e.shipment_id = s.id
              and e.source in ('VTP_WEBHOOK','VTP_POLL','VTP_IMPORT') and e.normalized_stage::text = 'DELIVERED')`,
  },
  {
    ten: "4. Tiền đã về / đã đối soát nhưng KHÔNG có chứng từ giao hàng (cấm suy DELIVERED từ tiền)",
    sql: `select count(*)::int as so_van_don from shipments s
          where s.cod_status::text in ('PAID_TO_BANK','RECONCILED')
            and not exists (select 1 from shipment_events e where e.shipment_id = s.id
              and e.source in ('VTP_WEBHOOK','VTP_POLL','VTP_IMPORT') and e.normalized_stage::text = 'DELIVERED')`,
  },
  {
    ten: "5. Mã 501 của CHIỀU HOÀN mà ảnh chụp vẫn là ĐÃ GIAO (tác động trực tiếp của F3)",
    sql: `select count(*)::int as so_van_don from shipments s
          where s.stage::text = 'DELIVERED'
            and exists (select 1 from shipment_events e where e.shipment_id = s.id
              and e.source in ('VTP_WEBHOOK','VTP_POLL','VTP_IMPORT')
              and e.status = '501' and e.leg_type = 'RETURN')`,
  },
  {
    ten: "6. Trạng thái ĐVVC mà ERP chưa hiểu",
    sql: `select e.status, count(*)::int as so_su_kien, max(e.occurred_at) as lan_cuoi
          from shipment_events e
          where e.source in ('VTP_WEBHOOK','VTP_POLL','VTP_IMPORT')
            and (e.normalized_stage is null or e.normalized_stage::text = 'UNKNOWN')
          group by 1 order by 2 desc limit 20`,
  },
  {
    ten: "7. Mốc thời gian đi ngược (giao / hoàn trước khi lấy hàng)",
    sql: `select count(*)::int as so_van_don from shipments s
          where s.picked_up_at is not null
            and ((s.delivered_at is not null and s.delivered_at < s.picked_up_at)
              or (s.returned_at is not null and s.returned_at < s.picked_up_at))`,
  },
  {
    ten: "8. SỔ KHO: mẫu mã có tồn ÂM (phiếu kho ít hơn số đã xuất)",
    sql: `select pv.sku, pv.color, pv.size,
                 coalesce(rc.received, 0)::int as tong_phieu_kho,
                 coalesce(sh.shipped, 0)::int as da_xuat_qua_dvvc,
                 (coalesce(rc.received, 0) - coalesce(sh.shipped, 0))::int as ton_thuc_te,
                 coalesce(rc.receipt_docs, 0)::int as so_phieu_nhap
          from product_variants pv
          left join ${RECEIPTS} rc on rc.variant_id = pv.id
          left join ${SHIPPED} sh on sh.variant_id = pv.id
          where coalesce(rc.received, 0) - coalesce(sh.shipped, 0) < 0
          order by 6 asc limit 50`,
  },
  {
    ten: "9. SỔ KHO: bao nhiêu mẫu mã tồn âm, trong đó bao nhiêu CHƯA CÓ phiếu nhập nào",
    sql: `select count(*)::int as mau_ma_ton_am,
                 count(*) filter (where so_phieu_nhap = 0)::int as trong_do_chua_co_phieu_nhap,
                 sum(ton_thuc_te)::int as tong_so_am
          from (
            select coalesce(rc.receipt_docs, 0) as so_phieu_nhap,
                   coalesce(rc.received, 0) - coalesce(sh.shipped, 0) as ton_thuc_te
            from product_variants pv
            left join ${RECEIPTS} rc on rc.variant_id = pv.id
            left join ${SHIPPED} sh on sh.variant_id = pv.id
          ) q
          where ton_thuc_te < 0`,
  },
  {
    ten: "10. Gói tin webhook: đã nhận / lỗi / chưa khớp được đơn",
    sql: `select source, status, count(*)::int as so_goi_tin, max(received_at) as gan_nhat
          from webhook_events group by 1, 2 order by 1, 3 desc`,
  },
  {
    ten: "11. Sự kiện ĐVVC mới nhất ERP nhận được (kiểm tra luồng còn chảy)",
    sql: `select max(e.occurred_at) as su_kien_moi_nhat, max(e.created_at) as ghi_vao_erp_luc,
                 count(*) filter (where e.created_at > now() - interval '24 hours')::int as su_kien_24h
          from shipment_events e where e.source in ('VTP_WEBHOOK','VTP_POLL','VTP_IMPORT')`,
  },
  {
    ten: "12. Đơn Pancake mới nhất ERP nhận được",
    sql: `select max(o.inserted_at) as don_moi_nhat, max(o.synced_at) as dong_bo_luc,
                 count(*) filter (where o.synced_at > now() - interval '24 hours')::int as don_dong_bo_24h
          from orders o`,
  },
];

async function main() {
  const db = await getDb();
  for (const q of PROBES) {
    console.log(`\n── ${q.ten}`);
    try {
      const res = await db.execute(sql.raw(q.sql));
      const rows = Array.isArray(res) ? res : ((res as { rows: unknown[] }).rows ?? []);
      console.log(JSON.stringify(rows, null, 2));
    } catch (error) {
      console.log(`LỖI: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
