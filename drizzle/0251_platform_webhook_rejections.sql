-- 0251 · SỔ GÓI WEBHOOK BỊ TỪ CHỐI (M4 mục 4 · messenger-webhook-reliability, 21/10/2026).
--
--  · `platform_webhook_rejections`: MỘT dòng mỗi (nguồn, lý do, phút) — chữ ký sai / thân không phải JSON / quá trần / không tra
--    được page / page lạ của webhook Messenger. Trước bản này chỉ ra stdout ⇒ /platform không đọc được «chữ ký sai hàng loạt».
--    Gói dồn dập cộng vào `count` (chống bão); 24 giờ / 7 ngày tính lúc đọc; giữ 30 ngày (lượt ghi tự xoá xô quá hạn).
--  · KHÔNG mã page, KHÔNG PSID, KHÔNG nội dung. KHÔNG gieo dòng nào.
--  · Chỉ CỘNG THÊM. Viết tay, idempotent (ảnh chụp drizzle cũ từ 0032 — không dùng `db:generate`).

CREATE TABLE IF NOT EXISTS "platform_webhook_rejections" (
	"provider" text NOT NULL,
	"reason" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_webhook_rejections_pkey" PRIMARY KEY ("provider", "reason", "bucket"),
	CONSTRAINT "platform_webhook_rejections_provider_check" CHECK ("platform_webhook_rejections"."provider" IN ('MESSENGER')),
	CONSTRAINT "platform_webhook_rejections_reason_check" CHECK ("platform_webhook_rejections"."reason" ~ '^[A-Z][A-Z0-9_]{1,40}$'),
	CONSTRAINT "platform_webhook_rejections_count_check" CHECK ("platform_webhook_rejections"."count" >= 1)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_webhook_rejections_bucket_idx" ON "platform_webhook_rejections" USING btree ("bucket");
