-- 0205 · PHÁT LẠI HỘI THOẠI CŨ (HISTORICAL REPLAY — lib/sales-chatbot/replay.ts · docs/productization/22_HISTORICAL_REPLAY.md).
--
--  · `sales_replay_runs`: một lượt do NGƯỜI bấm (ai_sales:manage) — số điểm, khoảng ngày, trạng thái, tóm tắt. Tóm tắt là
--    ẢNH CHỤP lúc chạy xong (cấu hình / lời nhắc của bot đổi sau đó không đổi số của lượt cũ).
--  · `sales_replay_points`: mỗi điểm = MỘT tin khách thật + câu AI sẽ nói ở đúng chỗ đó (chạy ở kênh THỬ — công cụ chỉ mô
--    phỏng, không khách / đơn / tin nhóm thật) + câu thật đã được nói + cờ chấm bằng luật tất định. Ở CSDL của CHÍNH tổ
--    chức (SILO) — cùng chỗ với hội thoại gốc.
--  · Thuần THÊM, không backfill. CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "sales_replay_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'RUNNING' NOT NULL,
  "target_points" integer NOT NULL,
  "days" integer NOT NULL,
  "summary" jsonb,
  "error" text,
  "created_by_user_id" text,
  "created_by_email" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "sales_replay_runs_status_check" CHECK ("status" IN ('RUNNING','DONE','FAILED')),
  CONSTRAINT "sales_replay_runs_points_check" CHECK ("target_points" BETWEEN 1 AND 50)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sales_replay_runs_started_idx" ON "sales_replay_runs" ("started_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sales_replay_points" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL REFERENCES "sales_replay_runs"("id") ON DELETE CASCADE,
  "source_conversation_id" text NOT NULL,
  "source_channel" text NOT NULL,
  "source_seq" integer NOT NULL,
  "customer_text" text NOT NULL,
  "history_messages" integer DEFAULT 0 NOT NULL,
  "historical_reply" text,
  "historical_speaker" text NOT NULL,
  "ai_reply" text,
  "ai_status" text,
  "tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "flags" text[] DEFAULT '{}'::text[] NOT NULL,
  "ungrounded_amounts" integer[] DEFAULT '{}'::integer[] NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_replay_points_speaker_check" CHECK ("historical_speaker" IN ('BOT','SHOP','NONE'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sales_replay_points_run_idx" ON "sales_replay_points" ("run_id");
