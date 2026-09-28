-- 0167 · TRÌNH DỰNG TRANG KÉO-THẢ — chống ghi đè nháp (docs/platform/phase-5-contracts.md §2).
--
--  · CHỈ THÊM một cột vào `meta_pages` (CSDL tổ chức): `draft_revision` tăng 1 ở mỗi lượt lưu nháp. Trình soạn gửi
--    lại số nó đã đọc (`baseRevision`); lệch ⇒ `CONFLICT`, không ghi — người lưu sau không đè mất bản của người kia.
--  · Mặc định 0 cho mọi trang đã có: không dòng nào bị viết lại, trang đã xuất bản không đổi gì.
-- Viết tay và idempotent như các migration trước.

ALTER TABLE "meta_pages" ADD COLUMN IF NOT EXISTS "draft_revision" integer DEFAULT 0 NOT NULL;
