import { sql } from "drizzle-orm";

/**
 * ═══════════ GIÁ VỐN CÓ XUẤT XỨ, VÀ BẬC CUỐI LÀ **CHƯA BIẾT** ═══════════
 *
 * `lib/queries/cogs.ts::LINE_UNIT_COST` là công thức giá vốn của toàn bộ báo cáo lợi nhuận, và nó
 * kết thúc bằng `0`:
 *
 *     coalesce(giá phiếu nhập gần nhất, giá vốn trên đơn, giá nhập mẫu mã, **0**)
 *
 * Với lợi nhuận, `0` và "chưa biết" dẫn tới hai kết luận trái ngược: một món không biết giá vốn sẽ
 * hiện ra như một món LÃI TRỌN — sai đúng theo hướng dễ chịu. ERP đã tự biết lỗ hổng này: ops
 * `cogs-drift` in `BASIS_NONE 12 ← đã giao mà CHƯA BIẾT giá vốn (NULL, báo cáo đang tính 0)`.
 *
 * ─── VÌ SAO KHÔNG SỬA THẲNG `LINE_UNIT_COST` Ở BẢN NÀY ───
 *
 * Đổi bậc cuối của nó từ `0` thành `NULL` là đổi **chân lý tài chính** của mọi báo cáo đang chạy
 * (lợi nhuận, hiệu quả mẫu mã, kế hoạch sản xuất, đối soát). AGENTS.md mục 7 nói rõ: việc làm đổi
 * số lợi nhuận phải hỏi chủ shop trước. Nên bản này thêm một đường ĐỌC RIÊNG, có xuất xứ, dùng cho
 * phần giá trị hàng hoàn — và để lại khuyến nghị cho một bản phát hành có chủ shop duyệt.
 *
 * TUYỆT ĐỐI không có nhánh nào đọc giá BÁN, doanh thu POS hay biên lợi nhuận ước tính: đó là lấy
 * thứ khách trả làm thứ shop bỏ ra.
 */

/**
 * Giá vốn ĐÃ CÓ CHỨNG TỪ KHO của từng mẫu mã: đơn giá trên phiếu NHẬP HÀNG gần nhất.
 *
 * Dùng làm CTE rồi `left join` vào bảng cần đọc:
 *
 *     with gia as ${LAST_RECEIPT_COST_BY_VARIANT}
 *     select ... from stock_receipt_items ri left join gia on gia.variant_id = ri.variant_id
 *
 * Mẫu mã chưa có phiếu nhập nào ghi đơn giá thì phép nối trái để lại `NULL` — và `NULL` đó phải đi
 * tới tận báo cáo, không được `coalesce` về 0 ở dọc đường. `unit_cost > 0` là cố ý: số 0 trên phiếu
 * là CHƯA KHAI giá, không phải hàng cho không.
 *
 * ─── VÌ SAO CHỈ CÓ BẢN THEO TẬP, KHÔNG CÓ BẢN THEO DÒNG ───
 *
 * Bản cũ là một truy vấn con TƯƠNG QUAN nhận biểu thức mẫu mã: nó chạy LẠI cho mỗi dòng đọc nó, và
 * bộ tối ưu chọn quét từ phía bảng phiếu nên chi phí tăng theo TÍCH của (số dòng × số phiếu).
 * `lib/queries/stock.ts` đã ghi lại đúng cái bẫy này bằng số đo thật: ở cấp dòng đơn hàng, truy vấn
 * con ấy chạy 4.260 lần, ngốn 99,3% toàn bộ chi phí.
 *
 * Và ở Node — một luồng — một truy vấn nặng trên đường dựng trang không chỉ làm chậm trang gọi nó:
 * nó chặn mọi yêu cầu khác đang chờ trên cùng tiến trình. Đo được đúng điều đó ở lượt triển khai
 * 14/09/2026: giá vốn hàng hoàn gọi truy vấn con ba lần trên mỗi dòng ⇒ `/ads` trả lỗi máy chủ,
 * `/reports/returns` quá 60 giây, `/expenses` lên 10,6 giây — trong khi chính trang hàng hoàn vẫn
 * xanh 98 ms và trông vô can.
 *
 * Bản dưới đây quét bảng phiếu ĐÚNG MỘT LẦN. Nó ra cùng con số với cùng bộ lọc và cùng thứ tự sắp
 * xếp, chỉ khác số lần tính — nên không có lý do nào để dựng lại bản theo dòng.
 */
export const LAST_RECEIPT_COST_BY_VARIANT = sql`(
  select distinct on (ri_g.variant_id) ri_g.variant_id as variant_id, ri_g.unit_cost as unit_cost
  from stock_receipt_items ri_g
  join stock_receipts r_g on r_g.id = ri_g.receipt_id
  where ri_g.unit_cost > 0 and r_g.kind = 'RECEIPT'
  order by ri_g.variant_id, r_g.received_at desc, r_g.created_at desc
)`;
