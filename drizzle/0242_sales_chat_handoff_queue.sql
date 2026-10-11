-- 0242 · HÀNG ĐỢI NGƯỜI KHI AI IM (P0 11/10/2026 — «AI chuyển người nhưng KHÔNG AI NHẬN», lib/sales-chatbot/handoff-routing.ts).
-- Trước bản này hội thoại AI chuyển người chỉ đổi `status = 'HANDOFF'`: không vào hàng đợi phòng nào, không có mốc để tính hạn, và
-- thông báo chống trùng bằng khoá VĨNH VIỄN theo hội thoại ⇒ lần chuyển người thứ hai của cùng hội thoại không báo ai. Hai cột mới:
--  · handoff_queued_at  — mốc VÀO hàng đợi người của đợt hiện tại; hạn xử lý tính LÚC ĐỌC theo `work.sla` (AGENTS luật 26);
--  · handoff_alerted_at — lần cuối ERP báo nhân viên / phòng trong đợt (tin khách mới không đẻ mỗi tin một thông báo).
-- Chỉ CỘNG THÊM, không backfill (luật 35 · 8.8): dòng cũ NULL = chưa vào hàng đợi; lượt quét `sales-health` đóng dấu hội thoại đang
-- chờ người. Chỉ mục một phần cho câu đếm «chuyển người không chủ». Idempotent.

ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "handoff_queued_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "handoff_alerted_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_conversations_handoff_queue_idx" ON "sales_chat_conversations" USING btree ("handoff_queued_at") WHERE "handoff_queued_at" is not null;
