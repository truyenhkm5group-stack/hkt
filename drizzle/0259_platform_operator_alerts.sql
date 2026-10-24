-- 0259 · VẾT GỬI TIN CHO NGƯỜI VẬN HÀNH NỀN TẢNG (P0 cạn credit AI, 24/10/2026).
--
--  · Đo 23/10/2026: job `sales-health` phát hiện hslc AI = CRITICAL · CREDIT lúc 19:52Z (2 phút sau lỗi đầu) nhưng chủ shop biết
--    qua đường thủ công ~40 phút sau — và KHÔNG truy được tin báo nhóm VNX có tới không: kết quả gửi bị bỏ. Bảng này giữ MỘT dòng
--    mỗi (tổ chức, khoá chống trùng của tin): kênh đã nhận · kết quả SENT / NO_CHANNEL / FAILED · số lần thử · câu lỗi đã che.
--  · Chỉ mã tổ chức + tiêu đề tin vận hành (số đếm, lớp lỗi) — không dữ liệu khách (luật ISO-05 của kênh vận hành).
--  · Chỉ CỘNG THÊM. Viết tay, idempotent. Không gieo dòng nào.

CREATE TABLE IF NOT EXISTS "platform_operator_alerts" (
	"org_code" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"result" text NOT NULL,
	"channel" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_operator_alerts_pkey" PRIMARY KEY ("org_code", "dedupe_key"),
	CONSTRAINT "platform_operator_alerts_result_check" CHECK ("platform_operator_alerts"."result" IN ('SENT', 'NO_CHANNEL', 'FAILED')),
	CONSTRAINT "platform_operator_alerts_channel_check" CHECK ("platform_operator_alerts"."channel" IS NULL OR "platform_operator_alerts"."channel" IN ('LARK_MANAGER', 'LARK', 'TELEGRAM')),
	CONSTRAINT "platform_operator_alerts_sent_check" CHECK (("platform_operator_alerts"."result" = 'SENT') = ("platform_operator_alerts"."channel" IS NOT NULL)),
	CONSTRAINT "platform_operator_alerts_attempts_check" CHECK ("platform_operator_alerts"."attempts" >= 1)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_operator_alerts_last_idx" ON "platform_operator_alerts" USING btree ("last_at");
