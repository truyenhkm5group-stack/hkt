-- ═══════════ CA CHĂM SÓC TRỞ THÀNH MỘT ĐỢT, KHÔNG CÒN LÀ MỘT DÒNG VĨNH VIỄN ═══════════
--
-- TRƯỚC: `shipment_care.shipment_id` mang ràng buộc UNIQUE (migration 0060) — một vận đơn đúng
-- MỘT dòng care, mãi mãi. Kiện hỏng lần hai, đội xử lý lần hai, thì lần đó ghi đè lên lần trước:
-- thời gian phản hồi, người phụ trách và kết quả của đợt đầu biến mất khỏi sổ.
--
-- SAU: nhiều ĐỢT theo thời gian, nhưng **tối đa một đợt ĐANG MỞ** cho mỗi vận đơn — ràng buộc đó
-- do một CHỈ MỤC DUY NHẤT TỪNG PHẦN giữ, không do mã nguồn tự canh. Nhờ nó, webhook phát lại
-- không thể sinh ra đợt thứ hai: lệnh chèn thứ hai bị CSDL từ chối, chứ không phải bị một câu
-- `if` nào đó bỏ sót.
--
-- KHÔNG BACKFILL KẾT QUẢ LOGISTICS. Mọi cột kết cục mới để NULL cho dòng cũ: NULL là CHƯA BIẾT.
-- Suy ngược kết quả cho 70 ca lịch sử sẽ biến một lỗ hổng dữ liệu thành một lời khẳng định sai về
-- việc ai đã cứu được đơn nào — và sau đó không ai phân biệt được nữa.
ALTER TABLE "shipment_care" DROP CONSTRAINT IF EXISTS "shipment_care_shipment_id_key";--> statement-breakpoint
ALTER TABLE "shipment_care" DROP CONSTRAINT IF EXISTS "shipment_care_shipment_id_unique";--> statement-breakpoint

ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "episode_no" integer NOT NULL DEFAULT 1;--> statement-breakpoint
-- Đợt ĐANG MỞ. Dòng cũ đều là đợt đang mở của kiện đó nên mặc định `true` là đúng với 100% dữ liệu.
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "active" boolean NOT NULL DEFAULT true;--> statement-breakpoint

-- Bối cảnh LÚC MỞ ĐỢT, cố ý không tính lại về sau: "đợt này bắt đầu vì ĐVVC báo gì".
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "entry_carrier_state" text;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "source_trigger" text;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "order_id" text REFERENCES "orders"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "tracking_number" text;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "priority" text;--> statement-breakpoint

-- Mốc thời gian: mỗi báo cáo hỏi một câu khác nhau nên phải có đủ mốc, không dùng chung một cột.
--   khối lượng việc → `opened_at`   ·  hiệu suất người → `outcome_at`  ·  số thao tác → mốc của action
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "first_action_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "last_action_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "outcome_at" timestamp with time zone;--> statement-breakpoint

-- Kết cục. `resolution` là QUYẾT ĐỊNH của shop; `final_*` là CHỨNG TỪ của ĐVVC. Hai thứ khác nhau
-- và cố ý nằm ở hai cột: "duyệt hoàn" không phải "đã hoàn".
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "resolution" text;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "final_carrier_state" text;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "final_logistics_outcome" text;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "care_outcome" text;--> statement-breakpoint

-- Người CHỊU TRÁCH NHIỆM lúc chốt kết quả. Khác `owner_id` (người đang cầm): A nhận rồi chuyển B
-- thì hiệu suất thuộc về người đứng ở khâu chốt, và lịch sử chuyển giao không bị viết lại.
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "owner_at_resolution" text REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "initial_owner_id" text REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Đơn đổi nối với ca này. Không có nó thì "cứu bằng đơn đổi" không đo được, chỉ đoán được.
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "replacement_order_id" text REFERENCES "orders"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD COLUMN IF NOT EXISTS "replacement_shipment_id" text REFERENCES "shipments"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Dòng cũ: mốc mở đợt lấy đúng lúc dòng được tạo. Đây KHÔNG phải suy đoán kết quả — chỉ là chép
-- một mốc đã có sẵn sang đúng cột của nó.
UPDATE "shipment_care" SET "opened_at" = "created_at" WHERE "opened_at" IS NULL;--> statement-breakpoint

-- TỐI ĐA MỘT ĐỢT ĐANG MỞ CHO MỖI VẬN ĐƠN — do CSDL giữ, không do mã nguồn.
CREATE UNIQUE INDEX IF NOT EXISTS "shipment_care_active_uidx" ON "shipment_care" ("shipment_id") WHERE "active";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_care_outcome_idx" ON "shipment_care" ("care_outcome", "outcome_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_care_resolution_owner_idx" ON "shipment_care" ("owner_at_resolution", "outcome_at");--> statement-breakpoint

ALTER TABLE "shipment_care" DROP CONSTRAINT IF EXISTS "shipment_care_outcome_check";--> statement-breakpoint
ALTER TABLE "shipment_care" ADD CONSTRAINT "shipment_care_outcome_check"
  CHECK ("care_outcome" IS NULL OR "care_outcome" IN ('RESCUED_DIRECT', 'RESCUED_EXCHANGE', 'RESCUE_FAILED', 'PENDING', 'UNATTRIBUTED'));--> statement-breakpoint

-- ═══════════ THAO TÁC NGHIỆP VỤ: GHI THÊM, KHÔNG BAO GIỜ GHI ĐÈ ═══════════
--
-- `care_actions` đang có ghi "việc chăm sóc đã làm" ở mức thô (gọi / nhắn). Bảng này ghi bốn QUYẾT
-- ĐỊNH nghiệp vụ kèm đủ bối cảnh để trả lời: ai, lúc nào, trên kiện nào, làm gì, trạng thái xử lý
-- trước/sau, gửi lệnh gì sang ĐVVC, ĐVVC trả lời ra sao.
CREATE TABLE IF NOT EXISTS "care_business_actions" (
  "id" text PRIMARY KEY NOT NULL,
  "care_case_id" text NOT NULL REFERENCES "shipment_care"("id") ON DELETE CASCADE,
  "shipment_id" text NOT NULL REFERENCES "shipments"("id") ON DELETE CASCADE,
  "actor_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_email" text NOT NULL DEFAULT '',
  -- Người ĐANG CẦM ca lúc thao tác — ảnh chụp, không tính lại theo owner hôm nay.
  "owner_id_at_action" text REFERENCES "users"("id") ON DELETE SET NULL,
  "action_type" text NOT NULL,
  "reason_code" text,
  "reason_note" text NOT NULL DEFAULT '',
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- Nối sang sổ lệnh ĐVVC. NULL với hai hành động không gửi lệnh (Đổi, Theo dõi tiếp).
  "carrier_command_id" text REFERENCES "carrier_action_requests"("id") ON DELETE SET NULL,
  "carrier_result" text,
  "previous_care_status" text,
  "next_care_status" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "care_business_actions_type_check"
    CHECK ("action_type" IN ('APPROVE_RETURN', 'REQUEST_REDELIVERY', 'EXCHANGE', 'CONTINUE_MONITORING'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_business_actions_case_idx" ON "care_business_actions" ("care_case_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_business_actions_actor_idx" ON "care_business_actions" ("actor_user_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_business_actions_shipment_idx" ON "care_business_actions" ("shipment_id", "created_at");
