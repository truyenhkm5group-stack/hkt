import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * ═══════ BẢN SQL CỦA KHOÁ BÀI VIẾT — SONG SINH VỚI BẢN TYPESCRIPT ═══════
 *
 * `lib/constants/ads-identity.ts` định nghĩa `normalizePostKey` / `isUsablePostKey` bằng TypeScript
 * cho đường nhập liệu. Truy vấn thì phải làm CÙNG một việc đó trong SQL.
 *
 * SỰ CỐ TÌM RA 10/09/2026: biểu thức này từng có **ba bản**. Một hằng số `POST_KEY_SQL` trong
 * `ads-identity.ts` mang chú thích "kiểm thử đối chiếu hai bản này để chúng không trôi khỏi nhau" —
 * và **không nơi nào dùng nó, bài kiểm đó chưa từng được viết**. Hai tệp truy vấn thì mỗi tệp tự chép
 * tay một bản `regexp_replace(..., '^.*_', '')` riêng.
 *
 * Ba bản không có gì buộc phải khớp nhau. Sửa `normalizePostKey` mà quên hai bản SQL kia thì độ phủ
 * quy kết quảng cáo đổi trong im lặng — và quy kết là thứ quyết định doanh thu được ghi cho marketer
 * nào, tức tiền hoa hồng của người thật.
 *
 * Nay ĐÚNG MỘT bản SQL, ở đây, và `tests/ads-identity.test.ts` chạy cả hai bản trên cùng bộ dữ liệu
 * để chứng minh chúng cho cùng kết quả — chứ không nhờ ai nhớ đồng bộ.
 */

/** Cắt tiền tố `<page_id>_`. Không có gạch dưới thì trả nguyên chuỗi — an toàn với cả hai định dạng. */
export function postKeySql(col: AnyPgColumn | SQL): SQL {
  return sql`regexp_replace(${col}, '^.*_', '')`;
}

/** Sau khi cắt tiền tố phải là chuỗi chữ số đủ dài. Khớp `isUsablePostKey` trong constants. */
export function usablePostKeySql(col: AnyPgColumn | SQL): SQL {
  return sql`(coalesce(${postKeySql(col)}, '') ~ '^[0-9]{5,}$')`;
}

/** Mã mẩu quảng cáo dùng được. Khớp `isUsableAdId`. */
export function usableAdIdSql(col: AnyPgColumn | SQL): SQL {
  return sql`(coalesce(${col}, '') ~ '^[0-9]{5,}$')`;
}
