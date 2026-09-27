-- 0162 · LƯỢT CHẠY LUẬT TỰ ĐỘNG CÓ HẠN GIỮ (lib/workflow/engine.ts · Phase 3.1).
--
--  · CHỈ THÊM ba cột vào workflow_runs. Không bảng nào đổi ràng buộc, không dòng nào bị ghi:
--      attempt            — số lần một tiến trình đã CHIẾM lượt chạy (0 = chưa ai chiếm: DRY_RUN, chờ duyệt…)
--      lease_until        — hạn giữ của tiến trình đang chạy; quá hạn mà vẫn PENDING ⇒ tiến trình đã chết giữa
--                           chừng, lượt sau được chiếm lại
--      last_heartbeat_at  — lần cuối tiến trình đang chạy báo còn sống (ghi cùng lúc với mỗi bước xong)
--  · KHÔNG backfill (mục 8.8): dòng cũ mang attempt 0 và hai mốc NULL. Dòng PENDING cũ không có hạn giữ được
--    bộ máy coi là hết hạn theo updated_at + hạn giữ — đúng nghĩa của nó: một tiến trình đã chết từ trước khi
--    có hạn giữ.
-- Viết tay và idempotent như 0033–0161.

ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "attempt" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "lease_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone;
