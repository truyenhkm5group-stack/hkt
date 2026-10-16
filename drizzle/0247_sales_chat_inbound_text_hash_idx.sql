-- 0247 · CHỈ MỤC CHỮ CHUẨN HOÁ CỦA TIN PHÍA PAGE — gốc của sự cố «qa không áp được 0245» (15–16/10/2026).
--
-- VÌ SAO: định nghĩa #803 (thân hàm `sales_chat_turn_unhandled_thread` của 0245, và hàm trigger `sales_chat_turn_refresh_template`) có
-- vế «tin mẫu tự động đọc CHÉO luồng»: mỗi dòng PAGE_REPLY cũ (sender_kind NULL, chữ ≥ 40 ký tự) nằm sau lượt khách cuối dò MỌI dòng
-- PAGE_REPLY cùng page trong 168 giờ bằng `btrim(regexp_replace(text, '[[:space:]]+', ' ', 'g'))`. Không chỉ mục nào đỡ biểu thức đó ⇒
-- mỗi dòng ứng viên là một lượt quét cả cửa sổ của page, và khối CASE chứa vế ấy còn lặp HAI lần. Tổ chức `qa` (1 page · 13.241
-- PAGE_REPLY trong 7 ngày · 1.610 dòng ứng viên) vì thế chạy câu dẫn xuất của 0245 quá trần 600 s ở mọi lượt deploy từ 12/10.
-- Đo trên DỮ LIỆU TỔNG HỢP cùng hình dạng (Postgres 16, 959 hội thoại · 1.524 dòng ứng viên): câu dẫn xuất 175 s → 2,5 s với chỉ
-- mục này; kết quả 959/959 hội thoại giống hệt (chỉ mục không đổi nghĩa, chỉ đổi đường đi). Cùng ứng viên mà ops `migration-rehearsal`
-- đã khai (`MR_CHI_MUC_THU`, scripts/erp-migration-rehearsal.sh) — bài kiểm đối chiếu từng ký tự.
--
-- HASH, không btree: tra BẰNG NHAU trên chữ không giới hạn độ dài (btree từ chối khoá > ~2,7 KB). Biểu thức phải TRÙNG KÝ TỰ với vế
-- trong hàm, nếu không planner không dùng được.
--
-- THỨ TỰ VỚI 0245 (vì sao `qa` cần một lượt tạo TRƯỚC, ngoài migration): drizzle chạy MỌI migration còn thiếu theo thứ tự trong MỘT giao
-- dịch (db/migrate.ts::migrateOrganizationDb), nên ở `qa` (đang dừng ở 0244) 0245 luôn chạy TRƯỚC tệp này. Chủ shop duyệt 16/10/2026 một
-- ngoại lệ có giới hạn: ops `org-0245-index-preseed` tạo ĐÚNG chỉ mục này (CONCURRENTLY, chỉ `qa`) trước khi 0245 thử lại. Tệp này vẫn
-- là nguồn chuẩn cho MỌI tổ chức: `IF NOT EXISTS` theo tên ⇒ ở `qa` không làm gì; công cụ tạo trước bảo đảm chỉ mục hợp lệ (bỏ bản
-- INVALID) nên `IF NOT EXISTS` không bao giờ giữ lại một chỉ mục hỏng.
--
-- KHOÁ: trong giao dịch migration nên không dùng CONCURRENTLY — CREATE INDEX giữ khoá SHARE trên sales_chat_inbound (chặn GHI, không
-- chặn đọc) trong lúc dựng; bảng của mọi tổ chức hiện ở cỡ chục nghìn dòng (dựng ~0,2 s trên 15.800 dòng). lock_timeout 10 s: thà hỏng
-- nhanh và thử lại còn hơn xếp hàng sau một câu dài rồi chặn webhook. Idempotent.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_inbound_page_reply_text_hash_idx" ON "sales_chat_inbound" USING hash ((btrim(regexp_replace("text", '[[:space:]]+', ' ', 'g')))) WHERE "note" = 'PAGE_REPLY';
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
