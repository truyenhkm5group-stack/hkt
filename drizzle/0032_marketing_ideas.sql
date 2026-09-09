-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
-- Bảng ý tưởng marketing: marketer đăng ý tưởng kèm ảnh, quản lý nhận xét và chốt trạng thái.
DO $$ BEGIN CREATE TYPE "idea_status" AS ENUM('NEW', 'REVIEWING', 'CHANGES', 'APPROVED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketing_ideas" (
  "id" text PRIMARY KEY NOT NULL,
  "marketer_id" text,
  "marketer_name" text DEFAULT '' NOT NULL,
  "idea_date" text NOT NULL,
  "content" text DEFAULT '' NOT NULL,
  "status" "idea_status" DEFAULT 'NEW' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "reviewed_at" timestamp with time zone,
  "reviewed_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketing_idea_images" (
  "id" text PRIMARY KEY NOT NULL,
  "idea_id" text NOT NULL,
  "content_type" text DEFAULT 'image/jpeg' NOT NULL,
  "bytes" integer DEFAULT 0 NOT NULL,
  "data" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketing_idea_comments" (
  "id" text PRIMARY KEY NOT NULL,
  "idea_id" text NOT NULL,
  "author_email" text DEFAULT '' NOT NULL,
  "author_name" text DEFAULT '' NOT NULL,
  "body" text NOT NULL,
  "status_set" "idea_status",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "marketing_idea_images" ADD CONSTRAINT "marketing_idea_images_idea_id_marketing_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "marketing_ideas"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "marketing_idea_comments" ADD CONSTRAINT "marketing_idea_comments_idea_id_marketing_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "marketing_ideas"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_ideas_date_idx" ON "marketing_ideas" USING btree ("idea_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_ideas_status_idx" ON "marketing_ideas" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_ideas_marketer_idx" ON "marketing_ideas" USING btree ("marketer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_idea_images_idea_idx" ON "marketing_idea_images" USING btree ("idea_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_idea_comments_idea_idx" ON "marketing_idea_comments" USING btree ("idea_id","created_at");
