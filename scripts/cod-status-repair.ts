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
 *   · xoá lời khẳng định sai "tiền đã về tài khoản ngày X" ở những vận đơn chưa có đồng nào;
 *   · xoá TIỀN THỰC THU KHÔNG CÓ CHỨNG TỪ NÀO — số do đoạn code cũ tự ghi khi ĐVVC báo đã giao
 *     (tiền thực thu = COD khai báo). Chỉ xoá khi vận đơn không có dòng nào trong sổ VÀ không có
 *     tên file bảng kê: vận đơn nhập tay từ file bảng kê cũ vẫn có chứng từ thật, không đụng tới.
 *     Xoá xong đơn đó quay về "tạm tính theo COD khai báo" — doanh thu không đổi, chỉ được gắn
 *     đúng nhãn là chưa xác minh thay vì giả vờ đã có chứng từ.
 *
 * KHÔNG xoá `cod_statement_ref`: cái tên file là dấu vết truy nguyên, giữ lại để còn lần theo. Nó
 * không còn được coi là bằng chứng tiền nữa — bằng chứng là DÒNG trong sổ `cod_statement_lines`.
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

/** Tiền thực thu tự bịa: có số nhưng không dòng chứng từ nào, cũng không file bảng kê nào. */
const TIEN_KHONG_CHUNG_TU = sql`cod_collected > 0 and cod_statement_ref is null
  and not exists (select 1 from cod_statement_lines l where l.shipment_id = shipments.id)`;

/** Ghi "tiền về tài khoản ngày X" trong khi chưa nhận được đồng nào — lời khẳng định sai. */
const VE_TK_MA_KHONG_CO_TIEN = sql`cod_paid_to_bank_at is not null and coalesce(cod_collected, 0) = 0`;

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDb();

  const truoc = rowsOf(await db.execute(sql`
    select stage::text stage, count(*) so_van_don, sum(cod_amount) cod_khai_bao
    from shipments where ${SAI} group by stage order by 2 desc
  `));
  const [rong] = rowsOf(await db.execute(sql`
    select count(*) so_van_don from shipments where ${VE_TK_MA_KHONG_CO_TIEN}
  `));
  const [bia] = rowsOf(await db.execute(sql`
    select count(*) so_van_don, coalesce(sum(cod_collected), 0) tien from shipments where ${TIEN_KHONG_CHUNG_TU}
  `));

  console.log(JSON.stringify({
    che_do: apply ? "GHI THAT" : "CHAY THU",
    gan_sai_khong_thu_ho: truoc,
    tong_van_don_sai: truoc.reduce((t, r) => t + Number(r.so_van_don ?? 0), 0),
    ghi_ve_tk_ma_khong_co_tien: Number(rong?.so_van_don ?? 0),
    tien_khong_chung_tu: { so_van_don: Number(bia?.so_van_don ?? 0), tien: Number(bia?.tien ?? 0) },
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
    update shipments set cod_paid_to_bank_at = null, updated_at = now()
    where ${VE_TK_MA_KHONG_CO_TIEN}
  `);
  const goTien = await db.execute(sql`
    update shipments set
      cod_collected = 0,
      cod_status = case when stage = 'DELIVERED' then 'COLLECTED'::cod_status else 'PENDING'::cod_status end,
      cod_paid_to_bank_at = null,
      updated_at = now()
    where ${TIEN_KHONG_CHUNG_TU}
  `);
  const sau = rowsOf(await db.execute(sql`
    select cod_status::text trang_thai, count(*) so_van_don, sum(cod_amount) cod_khai_bao
    from shipments group by cod_status order by 2 desc
  `));
  console.log(JSON.stringify({
    da_sua_trang_thai: Number((sua as unknown as { rowCount?: number }).rowCount ?? 0),
    da_go_ghi_ve_tk_sai: Number((goChungTu as unknown as { rowCount?: number }).rowCount ?? 0),
    da_go_tien_khong_chung_tu: Number((goTien as unknown as { rowCount?: number }).rowCount ?? 0),
    sau_khi_sua: sau,
  }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
