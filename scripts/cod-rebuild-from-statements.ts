/**
 * Dựng lại tiền COD của vận đơn TỪ SỔ CHI TIẾT BẢNG KÊ (`cod_statement_lines`).
 *
 * Vì sao cần: trước đây mỗi file bảng kê ghi thẳng lên vận đơn, không có thứ tự nào bảo vệ, nên
 * file nhập sau đè mất số của file nhập trước. Nay chứng từ nằm ở sổ, còn số trên vận đơn chỉ là
 * kết quả dựng lại — chạy script này bất cứ lúc nào cũng ra đúng một kết quả.
 *
 * Vận đơn KHÔNG có dòng nào trong sổ thì không bị đụng tới.
 *
 * Dùng:
 *   npx tsx scripts/cod-rebuild-from-statements.ts            # chạy thử, chỉ báo cáo
 *   npx tsx scripts/cod-rebuild-from-statements.ts --apply    # ghi thật
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { materializeCodFromStatementLines } from "@/lib/integrations/viettelpost/statement-db";

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDb();

  const [truoc] = rowsOf(await db.execute(sql`
    select count(*) filter (where s.cod_collected > 0) van_don_co_tien,
           coalesce(sum(s.cod_collected), 0) tong_thuc_thu,
           (select count(*) from cod_statement_lines) dong_so,
           (select count(*) from cod_statement_lines where shipment_id is not null) dong_ghep_duoc,
           (select coalesce(sum(cod), 0) from cod_statement_lines where shipment_id is not null) cod_ghep_duoc
    from shipments s
  `));

  // Vận đơn mà số hiện tại KHÁC với số dựng lại từ sổ — đây chính là phần đã bị ghi đè.
  const lech = rowsOf(await db.execute(sql`
    with chon as (
      select distinct on (l.shipment_id) l.shipment_id, l.cod, l.source_file
      from cod_statement_lines l
      where l.shipment_id is not null and l.cod_reported
      order by l.shipment_id, (l.cod > 0) desc, l.statement_at desc, l.created_at desc
    )
    select s.vtp_order_number ma, s.cod_collected dang_ghi, c.cod theo_chung_tu, c.source_file file
    from chon c join shipments s on s.id = c.shipment_id
    where s.cod_collected is distinct from c.cod
    order by abs(c.cod - s.cod_collected) desc
    limit 20
  `));

  const [dem] = rowsOf(await db.execute(sql`
    with chon as (
      select distinct on (l.shipment_id) l.shipment_id, l.cod
      from cod_statement_lines l
      where l.shipment_id is not null and l.cod_reported
      order by l.shipment_id, (l.cod > 0) desc, l.statement_at desc, l.created_at desc
    )
    select count(*) so_van_don, coalesce(sum(c.cod - s.cod_collected), 0) chenh_lech
    from chon c join shipments s on s.id = c.shipment_id
    where s.cod_collected is distinct from c.cod
  `));

  console.log(JSON.stringify({ che_do: apply ? "GHI THAT" : "CHAY THU", truoc_khi_dung: truoc, se_sua: dem, vi_du: lech }, null, 2));

  if (!apply) {
    console.log("\nChưa ghi gì. Thêm --apply để dựng lại thật.");
    return;
  }
  const r = await materializeCodFromStatementLines();
  const [sau] = rowsOf(await db.execute(sql`
    select count(*) filter (where cod_collected > 0) van_don_co_tien, coalesce(sum(cod_collected), 0) tong_thuc_thu from shipments
  `));
  console.log(JSON.stringify({ da_sua: r.updated, sau_khi_dung: sau }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
