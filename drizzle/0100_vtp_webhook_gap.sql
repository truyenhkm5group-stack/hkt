-- ═══════════ ĐO ĐỘ TIN CẬY CỦA WEBHOOK BẰNG CHÍNH TỆP ĐỐI CHIẾU ═══════════
--
-- VÌ SAO. Đo production 16/09/2026: 2.138/2.151 vận đơn là `WEBHOOK_ONLY` — tài khoản API không
-- đọc được chúng, nên webhook là NGUỒN TIN DUY NHẤT. Một nguồn duy nhất mà không ai biết nó rơi
-- bao nhiêu phần trăm thì không dùng để ra quyết định được.
--
-- ERP không thể tự phát hiện mình đang thiếu một gói tin CHƯA TỪNG TỚI. Chỗ hụt chỉ lộ ra khi một
-- nguồn ĐỘC LẬP nói lại cùng một sự việc — hôm nay là tệp "Danh sách vận đơn" tải từ
-- viettelpost.vn. Nên mỗi lần nhập tệp, ngoài việc vá dữ liệu, ERP ghi lại một PHÉP ĐO.
--
-- Ca thật đã quan sát được (16/09, một vận đơn có care): ĐVVC ghi "Chờ phát lại" lúc 12/09 07:23,
-- ERP chỉ biết lúc 13/09 03:50 — và biết QUA TỆP, không qua webhook. Đó là một khoảng hụt 20 giờ
-- mà trước bản này không có chỗ nào ghi lại.
--
-- CHỈ CỘNG THÊM: một bảng mới + ba cột có mặc định trên `vtp_import_batches`. KHÔNG backfill —
-- khoảng hụt trong quá khứ không dựng lại được từ dữ liệu hiện có, và bịa ra chúng là bịa ra một
-- phép đo chưa từng thực hiện. Sổ bắt đầu đếm từ lần nhập tệp kế tiếp.
-- Viết tay và idempotent như 0033–0099.

ALTER TABLE "vtp_import_batches" ADD COLUMN IF NOT EXISTS "checked" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vtp_import_batches" ADD COLUMN IF NOT EXISTS "webhook_ok" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vtp_import_batches" ADD COLUMN IF NOT EXISTS "webhook_gaps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vtp_webhook_gaps" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"tracking_code" text DEFAULT '' NOT NULL,
	"batch_id" text,
	"carrier_status_text" text DEFAULT '' NOT NULL,
	"carrier_stage" text,
	"carrier_event_at" timestamp with time zone NOT NULL,
	"erp_knew_at" timestamp with time zone,
	"erp_knew_source" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gap_minutes" integer NOT NULL,
	"severity" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "vtp_webhook_gaps" ADD CONSTRAINT "vtp_webhook_gaps_shipment_id_shipments_id_fk"
		FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "vtp_webhook_gaps" ADD CONSTRAINT "vtp_webhook_gaps_batch_id_vtp_import_batches_id_fk"
		FOREIGN KEY ("batch_id") REFERENCES "public"."vtp_import_batches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "vtp_webhook_gaps" DROP CONSTRAINT IF EXISTS "vtp_webhook_gaps_severity_check";--> statement-breakpoint
ALTER TABLE "vtp_webhook_gaps" ADD CONSTRAINT "vtp_webhook_gaps_severity_check" CHECK ("vtp_webhook_gaps"."severity" IN ('MINOR', 'MAJOR', 'CRITICAL'));--> statement-breakpoint

-- Cùng một sự việc phát hiện lại ở lần nhập sau KHÔNG được đếm thành hai lần rơi.
CREATE UNIQUE INDEX IF NOT EXISTS "vtp_webhook_gaps_uq" ON "vtp_webhook_gaps" ("shipment_id","carrier_event_at","carrier_status_text");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vtp_webhook_gaps_detected_idx" ON "vtp_webhook_gaps" ("detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vtp_webhook_gaps_shipment_idx" ON "vtp_webhook_gaps" ("shipment_id","carrier_event_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vtp_webhook_gaps_batch_idx" ON "vtp_webhook_gaps" ("batch_id");
