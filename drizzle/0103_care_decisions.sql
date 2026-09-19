-- ═══════════ KẾT QUẢ XỬ LÝ CASE TÁCH KHỎI LỆNH GỬI ĐVVC ═══════════
--
-- VÌ SAO (chủ shop chốt 19/09/2026). Ba lựa chọn người trực vận đơn dùng cả ngày — Đã hoàn ·
-- Phát tiếp · Xử lý sau — trước bản này được ghi vào `care_business_actions`, bảng GẮN LIỀN với
-- một lệnh gửi Viettel Post (`carrier_command_id`, `carrier_result`). Hệ quả: đường ghi từ chối
-- hành động khi ĐVVC không nhận lệnh, nên NĂNG LỰC API CỦA ERP quyết định xem NHÂN VIÊN có ghi
-- nhận được việc mình vừa làm hay không. Thiếu `VIETTELPOST_API_KEY`, API lỗi, kiện chưa có mã,
-- kiện đã kết thúc, kiện đi hãng khác — tất cả đều khoá mất một phép đo về CON NGƯỜI.
--
-- Bảng này là chiều thứ ba, đứng riêng và KHÔNG BAO GIỜ gọi ĐVVC:
--   `shipments.stage`            — gói hàng ở đâu (chỉ ĐVVC đổi được)
--   `shipment_care.care_status`  — đội đang ở đâu
--   `care_decisions`             — đội đã QUYẾT gì
--
-- `CARE_RETURN` KHÔNG có nghĩa hàng đã về shop. Tiền tố `CARE_` cố ý, để không lập trình viên nào
-- đọc nhầm thành trạng thái ĐVVC — bài học từ chính `APPROVE_RETURN` / `REQUEST_REDELIVERY`.
--
-- CHỈ CỘNG THÊM: một bảng mới, KHÔNG sửa cột nào đang có, KHÔNG backfill một dòng nào (luật 8.8 /
-- mục 35). Dữ liệu `care_business_actions` cũ giữ nguyên nghĩa cũ của nó và vẫn tra được ở nhật ký
-- vận đơn. Viết tay và idempotent như 0033–0102.

CREATE TABLE IF NOT EXISTS "care_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"care_case_id" text NOT NULL,
	"shipment_id" text NOT NULL,
	"decision" text NOT NULL,
	"reason_code" text,
	"note" text DEFAULT '' NOT NULL,
	"follow_up_at" timestamp with time zone,
	"actor_user_id" text,
	"actor_email" text DEFAULT '' NOT NULL,
	"owner_id_at_decision" text,
	"previous_decision" text,
	"previous_care_status" text,
	"next_care_status" text,
	"carrier_stage_at_decision" text DEFAULT '' NOT NULL,
	"carrier_substate_at_decision" text DEFAULT '' NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "care_decisions" ADD CONSTRAINT "care_decisions_case_fk" FOREIGN KEY ("care_case_id") REFERENCES "public"."shipment_care"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "care_decisions" ADD CONSTRAINT "care_decisions_shipment_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "care_decisions" ADD CONSTRAINT "care_decisions_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "care_decisions" ADD CONSTRAINT "care_decisions_owner_fk" FOREIGN KEY ("owner_id_at_decision") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- BA GIÁ TRỊ, ĐÓNG. Ô gõ tự do ở đây là mở đường cho một chuỗi lạ mà mọi báo cáo phải đoán nghĩa.
DO $$ BEGIN
	ALTER TABLE "care_decisions" ADD CONSTRAINT "care_decisions_kind_check" CHECK ("care_decisions"."decision" IN ('CARE_RETURN','CARE_CONTINUE_DELIVERY','CARE_FOLLOW_UP'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- "Xử lý sau" mà không có giờ thì ca chìm khỏi hàng đợi và không ai quay lại. CSDL chặn việc đó,
-- không để mã nguồn tự canh — đã có tiền lệ 13/09/2026: 16 ca chờ với `follow_up_at` NULL biến mất
-- khỏi "Cần care" vĩnh viễn.
DO $$ BEGIN
	ALTER TABLE "care_decisions" ADD CONSTRAINT "care_decisions_follow_up_check" CHECK ("care_decisions"."decision" <> 'CARE_FOLLOW_UP' OR "care_decisions"."follow_up_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "care_decisions_case_idx" ON "care_decisions" USING btree ("care_case_id","decided_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_decisions_shipment_idx" ON "care_decisions" USING btree ("shipment_id","decided_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_decisions_actor_idx" ON "care_decisions" USING btree ("actor_user_id","decided_at");
