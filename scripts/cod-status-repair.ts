/**
 * SỬA TRẠNG THÁI COD BỊ GẮN SAI "KHÔNG THU HỘ".
 *
 * "Không thu hộ" (NOT_APPLICABLE) là thuộc tính của vận đơn: COD khai báo = 0. Nó KHÔNG có nghĩa
 * "sẽ không thu được tiền". Hai luồng cũ đã dùng sai nó:
 *   1. đồng bộ Viettel Post hạ đơn hoàn / huỷ về "không thu hộ";
 *   2. nhập bảng kê: dòng báo 0đ bị hiểu là "vận đơn này không thu hộ".
 * Hậu quả: Viettel Post ghi "Thu hộ 849.000đ · Đã nhận COD" mà ERP hiện "Không thu hộ".
 *
 * Script này chỉ SỬA LỜI KHẲNG ĐỊNH SAI, không bịa thêm tiền:
 *   · vận đơn có COD khai báo > 0 mà đang "không thu hộ" → đưa về đúng chiều tiền:
 *       - ĐVVC đã báo giao tới khách  ⇒ COLLECTED ("ĐVVC đã thu, chưa có chứng từ tiền về")
 *       - còn lại                      ⇒ PENDING   ("có thu hộ, ERP chưa có chứng từ")
 *   · vận đơn nào bị lần nhập bảng kê hỏng gán chứng từ nhưng tiền = 0 thì XOÁ dấu vết chứng từ đó
 *     (mã bảng kê / mốc chứng từ / đợt tiền), vì dòng chứng từ tương ứng đã không còn: để lại thì
 *     ERP tưởng đã xác minh trong khi không có gì để xác minh. Nhập lại bảng kê sẽ gắn lại đúng.
 *
 * KHÔNG đụng tới `cod_collected`: tiền thực thu chỉ đến từ sổ chi tiết bảng kê.
 *
 * Dùng:
 *   npx tsx scripts/cod-status-repair.ts            # chạy thử, chỉ báo cáo
 *   npx tsx scripts/cod-status-repair.ts --apply    # ghi thật
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Vận đơn nói "không thu hộ" trong khi vẫn có tiền thu hộ khai báo. */
const SAI = sql`cod_status = 'NOT_APPLICABLE' and cod_amount > 0`;

/** Chứng từ bảng kê còn ghi tên file nhưng không có dòng nào trong sổ và tiền = 0 ⇒ chứng từ rỗng. */
const CHUNG_TU_RONG = sql`cod_statement_ref is not null and coalesce(cod_collected, 0) = 0 and cod_amount > 0
  and not exists (select 1 from cod_statement_lines l where l.shipment_id = shipments.id)`;

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDb();

  const truoc = rowsOf(await db.execute(sql`
    select stage::text stage, count(*) so_van_don, sum(cod_amount) cod_khai_bao
    from shipments where ${SAI} group by stage order by 2 desc
  `));
  const [rong] = rowsOf(await db.execute(sql`
    select count(*) so_van_don from shipments where ${CHUNG_TU_RONG}
  `));

  console.log(JSON.stringify({
    che_do: apply ? "GHI THAT" : "CHAY THU",
    gan_sai_khong_thu_ho: truoc,
    tong_van_don_sai: truoc.reduce((t, r) => t + Number(r.so_van_don ?? 0), 0),
    chung_tu_rong_se_go: Number(rong?.so_van_don ?? 0),
  }, null, 2));

  if (!apply) {
    console.log("\nChưa ghi gì. Thêm --apply để sửa thật.");
    return;
  }

  const sua = await db.execute(sql`
    update shipments set
      cod_status = case when stage = 'DELIVERED' then 'COLLECTED'::cod_status else 'PENDING'::cod_status end,
      updated_at = now()
    where ${SAI}
  `);
  const goChungTu = await db.execute(sql`
    update shipments set
      cod_statement_ref = null,
      cod_statement_at = null,
      cod_batch_id = null,
      cod_paid_to_bank_at = null,
      updated_at = now()
    where ${CHUNG_TU_RONG}
  `);
  const sau = rowsOf(await db.execute(sql`
    select cod_status::text trang_thai, count(*) so_van_don, sum(cod_amount) cod_khai_bao
    from shipments group by cod_status order by 2 desc
  `));
  console.log(JSON.stringify({
    da_sua_trang_thai: Number((sua as unknown as { rowCount?: number }).rowCount ?? 0),
    da_go_chung_tu_rong: Number((goChungTu as unknown as { rowCount?: number }).rowCount ?? 0),
    sau_khi_sua: sau,
  }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
