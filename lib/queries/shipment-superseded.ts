/**
 * ═══ VẬN ĐƠN BỊ THAY THẾ — ĐỌC RA LÚC XEM, DẪN XUẤT TỪ `PRIMARY_ATTEMPT` (vtp-direct-sync, 25/10/2026) ═══
 *
 * Shop tạo lại vận đơn trên web / app Viettel Post cho CHÍNH đơn đó (mẫu thật: PKE1555563080 huỷ → 155555577235 lấy hàng 16 phút sau).
 * Vận đơn cũ chưa từng được bàn giao, và Viettel Post KHÔNG gửi lệnh huỷ nó: nó đứng mãi ở «Giao cho bưu tá đi nhận». Đo production
 * 25/10/2026: 549 vận đơn như vậy chưa chốt, COD 320,6 triệu, 545 im lặng quá 96 giờ — và chúng nằm trong đếm «chờ lấy», «COD chưa thu»,
 * hàng đợi đối chiếu, tháp giao vận, hàng đợi tuổi chặng.
 *
 * Không có cột / cờ nào nói «bị thay thế» và không được thêm: kết luận là HÀM của các lần gửi hiện có, nên nó đúng tới từng lúc và tự
 * hết khi lần gửi chính đổi (lần mới bị huỷ ⇒ lần cũ lại là chính). Chứng từ ĐVVC và `cod_status` trong CSDL KHÔNG đổi.
 *
 * Định nghĩa (MỘT, cho cả SQL lẫn TS — `supersededBy` ở lib/constants/shipment-pick.ts, bài tương đương tests/shipment-superseded.test.ts):
 *   bị thay thế ⇔ có đơn ∧ KHÔNG phải lần gửi chính ∧ chưa từng bàn giao ∧ chưa giao ∧ lần gửi chính ĐÃ bàn giao và chưa huỷ.
 * «Lần gửi chính» = đúng thứ tự `PRIMARY_ATTEMPT_ORDER_BY`. Lần gửi chính chưa sống (cũng chờ lấy / đã huỷ) ⇒ KHÔNG ai bị thay thế:
 * đó là đơn chưa đi lần nào, và nó phải hiện ra ở «chờ lấy» chứ không được biến mất.
 */
import { carrierHandoffKnownSqlFor } from "@/lib/constants/carrier-handoff";
import { PRIMARY_ATTEMPT_ORDER_BY } from "@/lib/queries/return-rate";

const ALIAS = /^[a-z_][a-z0-9_]*$/;
// Bí danh nội bộ của câu con — nơi gọi không được trùng.
const RESERVED = new Set(["sh", "sp", "e"]);

function checkAlias(alias: string) {
  if (!ALIAS.test(alias) || RESERVED.has(alias)) throw new Error(`shipment-superseded: bí danh không hợp lệ «${alias}»`);
}

/** Câu con: id lần gửi chính của đơn `orderIdRef` (tham chiếu cột đã viết đủ bí danh). */
function primaryIdOf(orderIdRef: string): string {
  return `(select sh.id from shipments sh where sh.order_id = ${orderIdRef} order by ${PRIMARY_ATTEMPT_ORDER_BY} limit 1)`;
}

/** Mệnh đề SQL: dòng `shipments` bí danh `alias` BỊ THAY THẾ. */
export function supersededAttemptSql(alias: string): string {
  checkAlias(alias);
  return `(${alias}.order_id is not null and ${alias}.stage::text <> 'DELIVERED'
    and not ${carrierHandoffKnownSqlFor(`${alias}.id`, `${alias}.picked_up_at`)}
    and exists (select 1 from shipments sp where sp.id = ${primaryIdOf(`${alias}.order_id`)}
      and sp.id <> ${alias}.id and sp.stage::text <> 'CANCELLED' and ${carrierHandoffKnownSqlFor("sp.id", "sp.picked_up_at")}))`;
}

/** Mã của lần gửi chính đã thay dòng `alias` — chỉ đọc khi `supersededAttemptSql(alias)` đúng. */
export function supersedingCodeSql(alias: string): string {
  checkAlias(alias);
  return `(select coalesce(nullif(sp.vtp_order_number, ''), sp.tracking_code) from shipments sp where sp.id = ${primaryIdOf(`${alias}.order_id`)})`;
}
