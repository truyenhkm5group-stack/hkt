-- 0206 · GỢI Ý COPILOT CỦA BOT BÁN HÀNG (lib/sales-chatbot/operating-mode.ts · docs/productization/19_HSLC_PILOT.md).
--
--  · Một dòng = một câu bot SOẠN ở hội thoại bóng (kênh thử, KHÔNG gửi) cho một lượt tin khách, khi tổ chức chạy chế độ
--    COPILOT. Khi câu thật của page tới, máy ghi câu đó + độ giống + phán quyết (gần như nguyên văn · sửa · khác hẳn ·
--    không ai trả lời) — đó là số đo "người dùng lại gợi ý tới đâu", không phải đoán.
--  · Ở CSDL của CHÍNH tổ chức (SILO). Thuần THÊM. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "sales_copilot_suggestions" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL,
  "page_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "customer_text" text NOT NULL,
  "suggestion" text,
  "ai_status" text,
  "tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" text,
  "human_reply" text,
  "human_reply_at" timestamp with time zone,
  "similarity" double precision,
  "verdict" text,
  "scored_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_copilot_suggestions_verdict_check" CHECK ("verdict" IS NULL OR "verdict" IN ('SAME','EDITED','DIFFERENT','NO_REPLY')),
  CONSTRAINT "sales_copilot_suggestions_similarity_check" CHECK ("similarity" IS NULL OR ("similarity" >= 0 AND "similarity" <= 1))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sales_copilot_suggestions_thread_idx" ON "sales_copilot_suggestions" ("page_id", "thread_id", "created_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sales_copilot_suggestions_unscored_idx" ON "sales_copilot_suggestions" ("created_at") WHERE "scored_at" IS NULL;
