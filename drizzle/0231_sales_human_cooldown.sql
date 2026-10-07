-- 0231 · AI NHƯỜNG NGƯỜI CÓ MỐC HẾT HẠN TƯỜNG MINH (sứ mệnh sales-human-takeover · lib/sales-chatbot/ai-hold-shared.ts).
--
--  · Sự cố (chủ shop 07/10/2026): nhân viên gửi một câu tay ⇒ AI nhường 30 phút, nhưng đồng hồ nhường là `updated_at` — cột mà
--    MỌI lượt ghi vào hội thoại đều đẩy về «bây giờ» (`$onUpdate` của drizzle: ghi mốc tin khách, nhật ký ghi đơn, level khách…).
--    Đường Pancake ghi mốc tin khách NGAY TRƯỚC khi hỏi «hết nhường chưa» ⇒ mỗi tin khách lại đặt đồng hồ về 0.
--  · `human_cooldown_until`: mốc AI được trả lời lại sau khi NHÂN VIÊN gửi tay (ghi ở đường nhận tin nhân viên — hộp thư ERP,
--    Pancake, Messenger, Zalo — và xoá khi «Cho AI tiếp tục ngay» / «Trả lại cho AI» / hết hạn). Trạng thái AI_ACTIVE ·
--    HUMAN_COOLDOWN · HUMAN_TAKEOVER SUY RA từ cột này + `status` + `handoff_reason` + `state.control` bằng MỘT hàm thuần
--    (`aiHoldOf`), không lưu thành cột thứ hai.
--  · Chỉ THÊM cột; dòng cũ giữ NULL — KHÔNG backfill: hội thoại đang nhường từ trước bản này vẫn đọc mốc cũ (`updated_at` + 30
--    phút) như hôm nay. CSDL mọi tổ chức. Viết tay, idempotent.

ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "human_cooldown_until" timestamp with time zone;
--> statement-breakpoint
-- Hộp thư bán hàng đọc sổ AI THEO HỘI THOẠI (dấu vết từng tin — lib/ai-usage/conversation-evidence.ts): chỉ mục cũ chỉ có
-- (org_code, at) nên lọc `ref` quét mọi dòng của tổ chức. Bảng có ở mọi CSDL (0176 tạo không điều kiện, lược đồ chung).
CREATE INDEX IF NOT EXISTS "platform_ai_usage_org_ref_at_idx" ON "platform_ai_usage" USING btree ("org_code","ref","at") WHERE "ref" IS NOT NULL;
