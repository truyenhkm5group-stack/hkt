-- 0260 · TÌM HÀNG NGUỒN — LƯU MẪU TỪ TRANG CHI TIẾT 1688 (SRC-6, chủ shop chốt 25/10/2026 · docs/tech/ai-sourcing.md §2.1c).
--
-- CSDL của tổ chức. Idempotent. Không thêm / đổi / xoá cột của bảng nào mã đang đọc; không gieo dòng nào.
--  · Bốn CHECK nguồn số liệu (mẫu · ảnh chụp giá · cân nặng · nhà cung cấp) nhận thêm 'EXTENSION' — chỉ NỚI, mọi dòng cũ vẫn hợp lệ.
--  · sourcing_capture_tokens: token của tiện ích Chrome, MỘT người một máy, chỉ lưu BĂM, phạm vi duy nhất sourcing:capture, thu hồi
--    bằng revoked_at (không xoá).
--  · sourcing_offer_captures: mỗi lần người bấm «Lưu mẫu vào ERP» là MỘT dòng mới (chỉ thêm) — kết quả bộ đọc + nhánh dữ liệu gốc.
ALTER TABLE "sourcing_offers" DROP CONSTRAINT IF EXISTS "sourcing_offers_data_status_check";
--> statement-breakpoint
ALTER TABLE "sourcing_offers" ADD CONSTRAINT "sourcing_offers_data_status_check" CHECK ("data_status" IN ('MANUAL', 'API', 'EXTENSION', 'UNKNOWN'));
--> statement-breakpoint
ALTER TABLE "sourcing_offer_snapshots" DROP CONSTRAINT IF EXISTS "sourcing_offer_snapshots_source_check";
--> statement-breakpoint
ALTER TABLE "sourcing_offer_snapshots" ADD CONSTRAINT "sourcing_offer_snapshots_source_check" CHECK ("source" IN ('MANUAL', 'API', 'EXTENSION', 'UNKNOWN'));
--> statement-breakpoint
ALTER TABLE "sourcing_offer_weights" DROP CONSTRAINT IF EXISTS "sourcing_offer_weights_source_check";
--> statement-breakpoint
ALTER TABLE "sourcing_offer_weights" ADD CONSTRAINT "sourcing_offer_weights_source_check" CHECK ("source" IN ('MANUAL', 'API', 'EXTENSION', 'UNKNOWN'));
--> statement-breakpoint
ALTER TABLE "sourcing_suppliers" DROP CONSTRAINT IF EXISTS "sourcing_suppliers_facts_source_check";
--> statement-breakpoint
ALTER TABLE "sourcing_suppliers" ADD CONSTRAINT "sourcing_suppliers_facts_source_check" CHECK ("facts_source" IN ('MANUAL', 'API', 'EXTENSION', 'UNKNOWN'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sourcing_capture_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "label" text DEFAULT '' NOT NULL,
  "token_hash" text NOT NULL,
  "token_hint" text NOT NULL,
  "scope" text DEFAULT 'sourcing:capture' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  CONSTRAINT "sourcing_capture_tokens_scope_check" CHECK ("scope" = 'sourcing:capture')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sourcing_capture_tokens_hash_uq" ON "sourcing_capture_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sourcing_capture_tokens_user_idx" ON "sourcing_capture_tokens" USING btree ("user_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_capture_tokens" ADD CONSTRAINT "sourcing_capture_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_capture_tokens" ADD CONSTRAINT "sourcing_capture_tokens_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sourcing_offer_captures" (
  "id" text PRIMARY KEY NOT NULL,
  "offer_id" text NOT NULL,
  "snapshot_id" text,
  "source" text NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  "captured_by" text,
  "token_id" text,
  "page_url" text NOT NULL,
  "parser_version" integer NOT NULL,
  "facts" jsonb NOT NULL,
  "raw" jsonb,
  "flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  CONSTRAINT "sourcing_offer_captures_source_check" CHECK ("source" IN ('EXTENSION', 'API')),
  CONSTRAINT "sourcing_offer_captures_flags_check" CHECK (jsonb_typeof("flags") = 'array')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sourcing_offer_captures_offer_idx" ON "sourcing_offer_captures" USING btree ("offer_id", "captured_at");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_offer_captures" ADD CONSTRAINT "sourcing_offer_captures_offer_id_sourcing_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."sourcing_offers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_offer_captures" ADD CONSTRAINT "sourcing_offer_captures_snapshot_id_sourcing_offer_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."sourcing_offer_snapshots"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_offer_captures" ADD CONSTRAINT "sourcing_offer_captures_captured_by_users_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_offer_captures" ADD CONSTRAINT "sourcing_offer_captures_token_id_sourcing_capture_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."sourcing_capture_tokens"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
