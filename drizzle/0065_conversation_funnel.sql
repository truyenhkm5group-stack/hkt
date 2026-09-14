-- ═══════ PHỄU HỘI THOẠI: GIỮ LẠI BẰNG CHỨNG JOB cs-chat ĐANG NÉM ĐI ═══════
--
-- `docs/sales-funnel-contract.md` kết luận hai bước đầu của phễu không đo được vì "ERP không đồng
-- bộ hội thoại Pancake". `lib/constants/operating-funnel.ts` nói ở khâu LEAD: "Không có mốc phản
-- hồi đầu tiên cho từng lead, nên tỷ lệ và thời gian phản hồi CHƯA đo được."
--
-- Nhưng job `cs-chat` vẫn đọc hội thoại + tới 50 tin nhắn mỗi hội thoại mỗi 15 phút, và tính ra
-- được lúc khách cho SĐT / địa chỉ — rồi ném đi tất cả trừ ca sinh case CSKH. Đo trên chính lượt
-- quét 11/09/2026: 157 khách đủ thông tin, 136 đã có đơn nên KHÔNG sinh case ⇒ 87% bằng chứng mất
-- ngay tại chỗ, và mẫu số của mọi tỷ lệ chuyển đổi mất theo.
--
-- Bảng này KHÔNG thêm suy diễn nào; nó chỉ ghi lại thứ đã đọc được, kèm CĂN CỨ của từng mốc.
--
-- NULL = CHƯA QUAN SÁT ĐƯỢC TRONG CỬA SỔ QUÉT, không phải "không xảy ra": `scan_window_from` lưu
-- mốc sớm nhất thật sự đọc được để phân biệt hai thứ đó.

CREATE TABLE IF NOT EXISTS "conversation_funnel" (
  "id" text PRIMARY KEY NOT NULL,
  "page_id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "pancake_customer_id" text NOT NULL DEFAULT '',
  "customer_name" text NOT NULL DEFAULT '',
  "phone" text,
  "first_customer_message_at" timestamp with time zone,
  "first_shop_reply_at" timestamp with time zone,
  "last_customer_message_at" timestamp with time zone,
  "last_shop_message_at" timestamp with time zone,
  "customer_message_count" integer NOT NULL DEFAULT 0,
  "shop_message_count" integer NOT NULL DEFAULT 0,
  "phone_at" timestamp with time zone,
  "address_at" timestamp with time zone,
  "address_text" text NOT NULL DEFAULT '',
  "info_complete_at" timestamp with time zone,
  "tags" text[] NOT NULL DEFAULT '{}'::text[],
  "owner_name" text NOT NULL DEFAULT '',
  "matched_order_id" text REFERENCES "orders"("id") ON DELETE SET NULL,
  "match_basis" text NOT NULL DEFAULT 'NONE',
  "match_candidates" integer NOT NULL DEFAULT 0,
  "matched_order_at" timestamp with time zone,
  "truncated" boolean NOT NULL DEFAULT false,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_scan_at" timestamp with time zone NOT NULL DEFAULT now(),
  "scan_window_from" timestamp with time zone,
  "evidence" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "conversation_funnel_match_basis_check" CHECK ("match_basis" IN ('BY_CONVERSATION','BY_PHONE_UNIQUE','AMBIGUOUS','NONE'))
);--> statement-breakpoint
-- Khoá tự nhiên: quét lại cùng hội thoại phải CẬP NHẬT, không được nhân dòng.
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_funnel_uq" ON "conversation_funnel" USING btree ("page_id", "conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_funnel_first_msg_idx" ON "conversation_funnel" USING btree ("first_customer_message_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_funnel_info_idx" ON "conversation_funnel" USING btree ("info_complete_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_funnel_order_idx" ON "conversation_funnel" USING btree ("matched_order_id");--> statement-breakpoint
-- "Khách nhắn mà chưa ai trả lời" là truy vấn nóng nhất của hàng đợi rò rỉ.
CREATE INDEX IF NOT EXISTS "conversation_funnel_unanswered_idx" ON "conversation_funnel" USING btree ("first_shop_reply_at", "last_customer_message_at");--> statement-breakpoint
-- Chấm rủi ro theo tỉnh phải quét theo tỉnh; hôm nay `orders` không có chỉ mục nào trên cột này.
CREATE INDEX IF NOT EXISTS "orders_ship_province_idx" ON "orders" USING btree ("ship_province") WHERE "ship_province" <> '';
