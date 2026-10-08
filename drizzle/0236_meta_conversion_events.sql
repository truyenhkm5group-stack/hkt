-- 0236 · SỔ SỰ KIỆN CHUYỂN ĐỔI GỬI META (lib/marketing/meta-capi.ts · chủ shop HSLC 08/10/2026: «gửi sự kiện khi chốt đơn»).
--
--  · Một dòng cho một đơn (`order_id` UNIQUE) — lượt chạy lại không bao giờ gửi `Purchase` lần hai cho cùng đơn.
--  · `SKIPPED` bắt buộc có lý do (CHECK) — đơn không gửi được vẫn đếm được, không biến mất.
--  · Chỉ CỘNG THÊM; không backfill, không đụng dòng cũ. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "meta_conversion_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"event_name" text DEFAULT 'Purchase' NOT NULL,
	"event_id" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"skip_reason" text,
	"page_id" text,
	"psid" text,
	"value_vnd" integer,
	"event_time" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"fbtrace_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_conversion_events_status_check" CHECK ("meta_conversion_events"."status" IN ('PENDING','SENT','SKIPPED','FAILED')),
	CONSTRAINT "meta_conversion_events_skip_check" CHECK (("meta_conversion_events"."status" = 'SKIPPED') = ("meta_conversion_events"."skip_reason" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meta_conversion_events_order_uq" ON "meta_conversion_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meta_conversion_events_due_idx" ON "meta_conversion_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meta_conversion_events_time_idx" ON "meta_conversion_events" USING btree ("event_time");
