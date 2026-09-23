-- ═══════════ THỨ TỰ HIỂN THỊ PHÒNG BAN: VÁ ĐÚNG TRẠNG THÁI ĐO ĐƯỢC TRÊN PRODUCTION ═══════════
--
-- ─── VÌ SAO CẦN BẢN NÀY, TRONG KHI 0113 ĐÃ CÓ CÁC LỆNH UPDATE ───
--
-- 0113 đổi `sort_order` bằng các lệnh có hàng rào `WHERE sort_order = <giá trị 0069 gieo>`, để không
-- đè lên thứ tự do người đặt tay. Hàng rào ấy chạy ĐÚNG — nhưng nó không khớp dòng nào trên
-- production, và đo ngày 23/09/2026 (ops db-query, lượt chạy 35829607289) cho biết vì sao:
--
--     PRODUCTION | Sản xuất          |  50    ← lệnh INSERT của 0113
--     FINANCE    | Kế toán           | 100
--     HR         | Nhân sự           | 100
--     WAREHOUSE  | Kho               | 100
--     LOGISTICS  | Giao vận          | 100
--     SALES      | Kinh doanh & CSKH | 100
--     MANAGEMENT | Ban điều hành     | 100
--     MARKETING  | Marketing         | 100
--
-- **100 là giá trị MẶC ĐỊNH CỦA CỘT, không phải giá trị 0069 gieo** (0069 gieo 10·20·30·40·50·60·70).
-- Nên bảy dòng ấy không do 0069 tạo ra: chúng đã có trước — 0069 dùng `ON CONFLICT DO NOTHING` nên
-- bỏ qua — hoặc được tạo qua màn hình Công việc → Cấu hình → Nhân sự và phòng ban, đường ghi
-- `lib/work/service.ts` không truyền `sort_order` nên rơi về mặc định.
--
-- Hậu quả có thật: 50 < 100, nên phòng Sản xuất — phòng CHƯA CÓ AI — nhảy lên đầu mọi danh sách đọc
-- `sort_order` từ CSDL (`listDepartments`, bộ chọn phòng của hàng đợi công việc). Thanh menu và trang
-- Bản đồ phòng ban không bị ảnh hưởng vì chúng đọc hằng số `DEPARTMENT_ORDER` trong mã nguồn.
--
-- ─── HÀNG RÀO: CHỈ SẮP LẠI KHI CHƯA AI ĐẶT THỨ TỰ ───
--
-- Không thể chỉ "sửa cho đúng": một shop đã tự sắp thứ tự phòng ban thì thứ tự đó là quyết định của
-- họ, và ghi đè nó là đoán ý người dùng (cùng lý lẽ với luật ngưỡng độ tươi ở AGENTS.md mục 54).
--
-- Bằng chứng "chưa ai đặt" là một mệnh đề ĐO ĐƯỢC chứ không phải một niềm tin: **mọi phòng ngoài
-- phòng vừa gieo đều mang CÙNG MỘT giá trị, và giá trị đó đúng bằng mặc định của cột (100)**. Một
-- danh sách toàn giá trị bằng nhau không phải một thứ tự — nó là sự vắng mặt của thứ tự.
--
-- Vì thế:
--   · Production hôm nay (bảy dòng cùng 100)      ⇒ CHẠY, và thứ tự thành đúng như mã nguồn khai.
--   · CSDL dựng mới (0069 → 0113 cho 10…80 khác nhau) ⇒ KHÔNG chạy, vì đã đúng rồi.
--   · Shop đã tự sắp (các giá trị khác nhau)       ⇒ KHÔNG chạy, lựa chọn của họ còn nguyên.
--   · Chạy lại migration                           ⇒ KHÔNG chạy lần hai (các giá trị đã khác nhau).
--
-- ─── DANH SÁCH DƯỚI ĐÂY PHẢI KHỚP `DEPARTMENT_ORDER` ───
--
-- SQL không đọc được TypeScript, nên bảng này là bản sao duy nhất được phép tồn tại của thứ tự ấy.
-- `tests/migration-upgrade-path.test.ts` so thứ tự trong CSDL với chính `DEPARTMENT_ORDER` sau khi
-- áp migration, và bài kiểm đó dựng sẵn đúng tình trạng production (đặt cả bảng về 100 trước khi
-- áp) — nên hai bên trôi xa nhau là ĐỎ, không phải là một chỗ lệch im lặng.

UPDATE "departments" AS d
   SET "sort_order" = v.so
  FROM (VALUES
          ('SALES', 10),
          ('MARKETING', 20),
          ('LOGISTICS', 30),
          ('WAREHOUSE', 40),
          ('PRODUCTION', 50),
          ('FINANCE', 60),
          ('MANAGEMENT', 70),
          ('HR', 80)
       ) AS v(code, so)
 WHERE d."code" = v.code
   AND (SELECT count(DISTINCT "sort_order") FROM "departments" WHERE "code" <> 'PRODUCTION') = 1
   AND (SELECT min("sort_order") FROM "departments" WHERE "code" <> 'PRODUCTION') = 100;
