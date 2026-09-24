-- Vòng mẫu: NGƯỜI tải mẫu tự làm vào lô (docs/creative-loop.md — "Mẫu tự làm").
--
-- Thuần bổ sung: nới ràng buộc chế độ ô thêm 'MANUAL' và thêm cột quy kết người tải (AGENTS.md mục
-- 34). Không đụng dòng nào đã có; không backfill — mẫu cũ đều do máy lập nên NULL là đúng sự thật.
ALTER TABLE "creative_variants" DROP CONSTRAINT IF EXISTS "creative_variants_mode_check";
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_mode_check" CHECK ("creative_variants"."mode" IN ('EXPLOIT', 'EXPLORE', 'MANUAL'));
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "created_by_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
