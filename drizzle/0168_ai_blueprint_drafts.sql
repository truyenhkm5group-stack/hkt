-- 0168 · AI ERP BUILDER — BẢN NHÁP DO AI SOẠN (docs/platform/phase-8-contracts.md mục 3).
--
--  · CHỈ THÊM một bảng trong CSDL tổ chức: `ai_blueprint_drafts` — mỗi lượt AI soạn một blueprint (dựng mới) hoặc một
--    blueprint MẢNH (sửa lặp): câu mô tả của người, gói AI trả, kết quả bộ kiểm, mục người bỏ chọn, băm kế hoạch lúc
--    áp dụng, token / chi phí ước tính. AI KHÔNG ghi gì khác: áp dụng đi qua bộ cài Phase 7 (`installBlueprint`).
--  · Vòng đời DRAFT → APPLIED | DISCARDED. `APPLIED` bắt buộc có `install_id` (lượt cài trong `blueprint_installs`).
--  · `blueprint` NULL = AI không trả qua công cụ / trả JSON hỏng — nháp giữ lại để người thấy lỗi và chi phí, không
--    áp dụng được. Chi phí NULL = CHƯA BIẾT (model không có trong bảng giá), không phải 0.
--  · Không dòng nào được chèn. Không bảng cũ nào bị đổi.
-- Viết tay và idempotent như các migration trước.

CREATE TABLE IF NOT EXISTS "ai_blueprint_drafts" (
  "id" text PRIMARY KEY NOT NULL,
  "mode" text NOT NULL,
  "prompt" text NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "blueprint" jsonb,
  "context_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "valid" boolean DEFAULT false NOT NULL,
  "validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "excluded_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "plan_hash" text,
  "install_id" text,
  "ai_source" text,
  "provider" text,
  "model" text,
  "ai_calls" integer DEFAULT 0 NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cost_usd" double precision,
  "created_by" text,
  "created_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_at" timestamp with time zone,
  "applied_by" text,
  "discarded_at" timestamp with time zone,
  "discarded_by" text,
  CONSTRAINT "ai_blueprint_drafts_mode_check" CHECK ("mode" in ('new','edit')),
  CONSTRAINT "ai_blueprint_drafts_status_check" CHECK ("status" in ('DRAFT','APPLIED','DISCARDED')),
  CONSTRAINT "ai_blueprint_drafts_applied_check" CHECK ("status" <> 'APPLIED' or "install_id" is not null),
  CONSTRAINT "ai_blueprint_drafts_source_check" CHECK ("ai_source" is null or "ai_source" in ('ORG_CONNECTION','HOME'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_blueprint_drafts_created_idx" ON "ai_blueprint_drafts" ("created_at");
