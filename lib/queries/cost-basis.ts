import { sql } from "drizzle-orm";
import type { CostBasis } from "@/lib/constants/inspection-truth";

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
 * ─── BẬC VÀ NHÃN ĐI CÙNG NHAU ───
 *
 * Trả về cả con số LẪN nguồn của nó. Một con số giá vốn không có xuất xứ thì sáu tháng sau không
 * ai kiểm chứng lại được, và cũng không ai biết nó đáng tin tới đâu.
 *
 * TUYỆT ĐỐI không có nhánh nào đọc giá BÁN, doanh thu POS hay biên lợi nhuận ước tính: đó là lấy
 * thứ khách trả làm thứ shop bỏ ra.
 */

/**
 * Giá vốn ĐÃ CÓ CHỨNG TỪ KHO của một mẫu mã: giá trên phiếu NHẬP HÀNG gần nhất.
 *
 * `NULL` khi mẫu mã chưa có phiếu nhập nào ghi đơn giá — và `NULL` đó phải đi tới tận báo cáo,
 * không được `coalesce` về 0 ở dọc đường.
 *
 * Tham số là BIỂU THỨC mẫu mã (thường là `stock_receipt_items.variant_id` hoặc `product_variants.id`)
 * để dùng được ở nhiều phép nối khác nhau mà không phải chép lại câu lệnh.
 */
export function receiptUnitCost(variantIdExpr: unknown) {
  return sql<number | null>`(
    select ri_c.unit_cost
    from stock_receipt_items ri_c
    join stock_receipts r_c on r_c.id = ri_c.receipt_id
    where ri_c.variant_id = ${variantIdExpr}
      and ri_c.unit_cost > 0
      and r_c.kind = 'RECEIPT'
    order by r_c.received_at desc, r_c.created_at desc
    limit 1
  )`;
}

/**
 * Nhãn xuất xứ đi kèm con số trên.
 *
 * Hôm nay chỉ có hai nhánh — `RECEIPT` hoặc `UNKNOWN` — vì đây là đường dùng cho hàng hoàn, nơi
 * mẫu mã luôn là mẫu mã shop đã từng nhập. Hai bậc giữa (`ORDER_SNAPSHOT`, `VARIANT_DEFAULT`) đã
 * khai ở `COST_BASES` và để dành cho đường lợi nhuận khi chủ shop duyệt đổi bậc cuối — khai trước
 * để hai nơi không đẻ ra hai bảng xuất xứ khác nhau.
 */
export function receiptCostBasis(variantIdExpr: unknown) {
  return sql<CostBasis>`case when ${receiptUnitCost(variantIdExpr)} is not null then 'RECEIPT' else 'UNKNOWN' end`;
}
