-- 0242 · VẾT QUYẾT ĐỊNH CỦA FOLLOW-UP (mission P0 `followup-lifecycle` · lib/sales-chatbot/followup.ts · lifecycle.ts).
--
--  · Sự cố KimThu Le (11/10/2026): đơn đã «Đã xác nhận» mà job follow-up vẫn nhắn «em xác nhận để gửi đi luôn nhé ạ?» rồi «có
--    muốn tiếp tục chốt đơn» — và KHÔNG một dòng nào nói vì sao job quyết gửi. Mỗi lượt follow-up nay ghi MỘT sự kiện
--    `followup.decided` (gửi / chặn · mã lý do · ảnh chụp vòng đời · kết quả kiểm mới nhất · mã đơn · model / phiên bản lời nhắc)
--    vào sổ sự kiện hội thoại SẴN CÓ. Dòng GỬI được chèn TRƯỚC khi gọi Pancake với `dedupe_key` duy nhất (hội thoại · đợt im lặng ·
--    lần nhắc) ⇒ nó CHÍNH LÀ khoá chống trùng: hai lượt job / lượt chạy lại chèn thua thì không gửi.
--  · Chỉ NỚI danh sách loại của CHECK (thêm `followup.decided`), không đổi cột, không gieo, không backfill (AGENTS 35 · 8.8).
--    Dòng cũ không đổi. CSDL mọi tổ chức. Viết tay, idempotent (ảnh chụp drizzle cũ từ 0032 — không dùng `db:generate`).

ALTER TABLE "sales_conversation_events" DROP CONSTRAINT IF EXISTS "sales_conversation_events_type_check";
--> statement-breakpoint
ALTER TABLE "sales_conversation_events" ADD CONSTRAINT "sales_conversation_events_type_check" CHECK ("type" IN ('conversation.opened','message.received','ai.replied','stage.changed','quote.given','customer.identified','upsell.offered','upsell.accepted','upsell.declined','order.drafted','order.confirmed','appointment.booked','handoff.requested','human.took_over','human.replied','ai.resumed','followup.sent','conversation.declined','followup.decided'));
