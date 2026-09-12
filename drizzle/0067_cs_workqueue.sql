-- ═══════ HÀNG ĐỢI CSKH: HẸN QUAY LẠI + LỊCH SỬ CASE ═══════
--
-- CHỈ CỘNG THÊM. Một cột nullable trên `cs_cases` và một bảng mới. Không đổi kiểu, không xoá cột,
-- không đổi tên, không viết lại dòng dữ liệu nào đang có.
--
-- Viết tay và idempotent (`IF NOT EXISTS`) như 0033–0066 của kho này: ảnh chụp
-- `drizzle/meta/*_snapshot.json` đã cũ từ 0032, nên `drizzle-kit generate` sinh ra một bản dựng
-- lại TOÀN BỘ lược đồ và chạy lên production sẽ hỏng ngay câu lệnh đầu tiên.
--
-- ─── VÌ SAO KHÔNG THÊM CỘT `domain` ───
--
-- Miền của case (CSKH hay giao vận) SUY ĐƯỢC từ dữ liệu đã có: loại case + có vận đơn chưa kết
-- thúc hay không (`lib/constants/cs-domain.ts`). Thêm một cột nữa nghĩa là có hai nguồn sự thật
-- phải giữ đồng bộ, và cột đó sẽ sai ngay lần đầu vận đơn đổi trạng thái mà không ai chạy job cập
-- nhật. Cột chỉ tồn tại cho thứ KHÔNG suy được: cái hẹn và cái lịch sử ở dưới.

ALTER TABLE "cs_cases" ADD COLUMN IF NOT EXISTS "follow_up_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cs_cases_follow_up_idx" ON "cs_cases" ("follow_up_at");--> statement-breakpoint

-- Lịch sử nghiệp vụ của case: ai làm gì, lúc nào, khách nói gì. `audit_logs` là nhật ký an ninh và
-- không hiện được trên dòng; `resolution` là một ô bị ghi đè nên lần liên hệ trước biến mất.
CREATE TABLE IF NOT EXISTS "cs_case_events" (
  "id" text PRIMARY KEY NOT NULL,
  "case_id" text NOT NULL,
  "actor_id" text,
  "actor_email" text NOT NULL DEFAULT '',
  -- Ảnh chụp tên lúc xảy ra: người dùng đổi tên hoặc nghỉ việc thì lịch sử vẫn đọc được.
  "actor_name" text NOT NULL DEFAULT '',
  "source" text NOT NULL DEFAULT 'UI',
  "action" text NOT NULL,
  "note" text NOT NULL DEFAULT '',
  "previous_status" text,
  "next_status" text,
  "previous_assignee" text,
  "next_assignee" text,
  "follow_up_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "cs_case_events" ADD CONSTRAINT "cs_case_events_case_id_cs_cases_id_fk"
    FOREIGN KEY ("case_id") REFERENCES "public"."cs_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "cs_case_events" ADD CONSTRAINT "cs_case_events_actor_id_users_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "cs_case_events_case_idx" ON "cs_case_events" ("case_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cs_case_events_actor_idx" ON "cs_case_events" ("actor_email", "created_at");
