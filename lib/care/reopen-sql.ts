import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

/**
 * ═══════════ "ĐỢT NÀY LÀ BẢN SAO DO LỖI MỞ CA CŨ" — BẢN SQL CỦA `classifyReopen` ═══════════
 *
 * Luật 62: chỉ `FALSE_REOPEN_LEGACY` bị loại khỏi mẫu số — mốc kích hoạt KHÔNG mới hơn lúc đóng đợt
 * liền trước, VÀ không có sự kiện ĐVVC nào xen giữa (đóng đợt trước → lúc dựng đợt này]. Có sự kiện
 * xen giữa là `REOPEN_UNVERIFIED` và VẪN đếm: loại một ca ra chỉ vì không chắc là giấu việc.
 *
 * Bản TypeScript (`classifyReopen` trong `lib/constants/care-reopen-class.ts`) phân loại cho trang
 * kiểm tra ca; bản này dùng ở nơi lọc NGAY TRONG SQL (bảng hiệu suất care). Hai bản đọc cùng ba dữ
 * kiện với cùng định nghĩa như `care-case-audit.ts`, và `tests/care-false-reopen-exclusion.test.ts`
 * chạy cả hai trên cùng dữ liệu rồi so từng đợt — trôi xa nhau là đỏ.
 *
 * Tham số là các CỘT của đợt đang xét (bảng không bí danh hoặc có bí danh đều được), để mệnh đề
 * gắn được vào `where` của bất kỳ truy vấn nào đọc `shipment_care`.
 */
export function laBanSaoCuSql(c: { shipmentId: AnyColumn | SQL; episodeNo: AnyColumn | SQL; openedAt: AnyColumn | SQL; createdAt: AnyColumn | SQL }): SQL {
  const truocDong = sql`(select coalesce(p.done_at, p.outcome_at) from shipment_care p
                           where p.shipment_id = ${c.shipmentId} and p.episode_no < ${c.episodeNo}
                           order by p.episode_no desc limit 1)`;
  return sql`(${c.episodeNo} > 1
    and ${truocDong} is not null
    and coalesce(${c.openedAt}, ${c.createdAt}) <= ${truocDong}
    and not exists (
      select 1 from shipment_events ev
       where ev.shipment_id = ${c.shipmentId}
         and ev.source in ('VTP_WEBHOOK', 'VTP_IMPORT', 'PANCAKE')
         and ev.occurred_at > ${truocDong}
         and ev.occurred_at <= ${c.createdAt}
    ))`;
}
