import { sql, type SQL } from "drizzle-orm";

/**
 * ═══════════ MỘT SỰ CỐ CŨ KHÔNG ĐƯỢC SINH RA MỘT CA MỚI ═══════════
 *
 * ─── LỖI THẬT, ĐO ĐƯỢC TRÊN PRODUCTION 18/09/2026 ───
 *
 * Nhân viên xử lý xong một ca, ghi note, bấm hoàn tất. Ca biến khỏi "Cần care". Tải lại trang:
 * **ca quay về, trạng thái về "Chưa xử lý", note biến mất.** Nhân viên phải làm lại từ đầu.
 *
 * Đếm trên toàn bộ dữ liệu care:
 *
 *   18 cặp đợt liên tiếp trên cùng một kiện
 *   16 cặp có mốc kích hoạt CŨ HƠN HOẶC BẰNG mốc đóng của đợt trước  ⇒ ca bị dựng lại vô cớ
 *    9 trong số đó mang ĐÚNG cùng một nguyên nhân (`entry_carrier_state`)
 *   12 trong số đó làm "mất" một note đã ghi
 *   16 do BỘ ĐỐI CHIẾU ĐỊNH KỲ tạo ra (`source_trigger = 'RECONCILE'`)
 *    2 cặp là hợp lệ — có sự kiện ĐVVC MỚI sau khi đóng
 *
 * ─── NGUYÊN NHÂN GỐC ───
 *
 * Cả hai đường mở ca đều hỏi cùng một câu SAI: *"kiện này có đợt nào ĐANG MỞ không?"*
 *
 *   · `reconcileCareCoverage` (chạy 10 phút/lần): `not exists (… where c.shipment_id = s.id and c.active)`
 *   · `applyCarrierEventToCare` (webhook): `findFirst(… active = true)`
 *
 * Người vừa đóng ca ⇒ `active = false` ⇒ cả hai câu hỏi trả lời "không có đợt nào" ⇒ mở đợt MỚI
 * cho ĐÚNG tình trạng ĐVVC cũ, chưa đổi một chữ. Chậm nhất 10 phút sau là ca quay lại.
 *
 * Note KHÔNG hề mất khỏi CSDL: nó nằm ở `care_actions` và ở cột `last_note` của đợt CŨ. Màn hình
 * đọc đợt ĐANG MỞ, và đợt đang mở bây giờ là đợt MỚI — trắng trơn. Người dùng thấy "mất note", còn
 * dữ liệu thì vẫn nguyên. Đây là lý do phải sửa ĐƯỜNG MỞ CA chứ không phải đường ghi note.
 *
 * ─── LUẬT THAY THẾ ───
 *
 * **Chỉ mở đợt mới khi MỐC KÍCH HOẠT MỚI HƠN mốc đóng của đợt gần nhất.** Không chứng minh được là
 * mới thì KHÔNG mở.
 *
 * Mốc kích hoạt là mốc của ĐVVC (`shipments.vtp_status_date` / `occurredAt` của sự kiện), không
 * phải lúc job chạy — nếu lấy lúc job chạy thì mốc nào cũng "mới hơn" và luật này vô nghĩa.
 *
 * Luật KHÔNG cần cột mới: vân tay của một lần kích hoạt đã nằm sẵn trong `(shipment_id,
 * entry_carrier_state, opened_at)`, và `opened_at` xưa nay vẫn được ghi bằng mốc ĐVVC.
 *
 * ─── VÌ SAO KHÔNG CHẶN THEO `entry_carrier_state` ───
 *
 * Cám dỗ là "chỉ chặn khi cùng nguyên nhân". Nhưng 7 trong 16 lần dựng lại mang nguyên nhân KHÁC
 * mà mốc vẫn cũ hơn lúc đóng — tức trạng thái con đã đổi TRƯỚC khi người bấm hoàn tất, nên người
 * đã nhìn thấy nó rồi. Chặn theo nguyên nhân sẽ để lọt đúng 7 ca đó. Mốc thời gian là điều kiện
 * mạnh hơn và đủ một mình.
 *
 * ─── VÀ VÌ SAO KHÔNG CHẶN VĨNH VIỄN THEO VẬN ĐƠN ───
 *
 * Một kiện hoàn toàn có thể gặp sự cố THẬT lần thứ hai. Chặn theo mã vận đơn là bịt luôn lần đó.
 * Luật gắn với MỐC, nên sự cố mới (mốc ĐVVC mới hơn lúc đóng) vẫn mở được đợt mới — đúng như hai
 * cặp hợp lệ đã quan sát được.
 */

export type ReopenCheck = {
  /** Mốc ĐVVC của tình trạng đang xét. `null` = ĐVVC chưa cho mốc nào. */
  triggerAt: Date | null;
  /** Mốc đóng của đợt gần nhất đã đóng. `null` = kiện chưa từng có đợt nào đóng. */
  lastClosedAt: Date | null;
};

export type ReopenVerdict = { open: true } | { open: false; reason: string };

/**
 * Có được mở một đợt MỚI không. Hàm THUẦN — chạy hai lần ra cùng kết quả, kiểm thử được mà không
 * cần CSDL, và là lời khai DUY NHẤT của luật này (bản SQL bên dưới phải nói đúng điều đó).
 */
export function canOpenNewEpisode(c: ReopenCheck): ReopenVerdict {
  // Chưa từng có đợt nào đóng ⇒ đây là lần đầu, mở bình thường.
  if (!c.lastClosedAt) return { open: true };
  /*
    ĐVVC KHÔNG CHO MỐC ⇒ KHÔNG MỞ.

    Nếu ở đây lùi về "lấy giờ hiện tại" thì mốc kích hoạt luôn mới hơn mốc đóng, và bộ đối chiếu sẽ
    dựng lại một đợt MỖI MƯỜI PHÚT, mãi mãi. Không chứng minh được là mới thì không mở — đây là
    nhánh lỗi, và nhánh lỗi phải rơi về phía HẸP HƠN.
  */
  if (!c.triggerAt) return { open: false, reason: "ĐVVC chưa cho mốc nào nên không chứng minh được đây là sự cố mới" };
  if (c.triggerAt.getTime() > c.lastClosedAt.getTime()) return { open: true };
  return { open: false, reason: "tình trạng ĐVVC này đã có người xử lý xong — mốc kích hoạt không mới hơn lúc đóng" };
}

/**
 * Cùng một luật, viết cho SQL, để bộ đối chiếu lọc ngay trong câu truy vấn thay vì nạp về rồi loại.
 *
 * `trigger` là biểu thức mốc ĐVVC của kiện; `shipmentId` là cột id trong câu gọi. Hai bản (TS và
 * SQL) phải nói đúng cùng một điều — `tests/care-reopen.test.ts` chạy cả hai trên cùng dữ liệu và
 * so từng kiện, nên chúng không lặng lẽ trôi xa nhau được.
 */
export function chuaAiXuLyXongSql(shipmentId: SQL | unknown, trigger: SQL | unknown): SQL {
  return sql`not exists (
    select 1 from shipment_care c_guard
    where c_guard.shipment_id = ${shipmentId}
      and c_guard.active = false
      and (
        ${trigger} is null
        or coalesce(c_guard.done_at, c_guard.outcome_at, c_guard.updated_at) >= ${trigger}
      )
  )`;
}
