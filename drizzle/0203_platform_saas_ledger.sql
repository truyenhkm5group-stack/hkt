-- 0203 · SỔ KINH TẾ SAAS CỦA NỀN TẢNG (docs/productization/11_SAAS_METRICS_SPEC.md).
--
--  · `platform_saas_daily`: MỘT ảnh chụp mỗi (ngày giờ Việt Nam, tổ chức) — gói, tình trạng thu phí, MRR của ngày đó.
--    Gói và `paid_through` là trạng thái ĐỔI ĐƯỢC (`platform_organizations.plan`, `platform_subscriptions`), nên MRR của
--    tháng trước KHÔNG suy ngược được từ chúng: không có ảnh chụp thì New / Expansion / Churn / NRR là bịa. Dòng của
--    HÔM NAY còn được ghi lại trong ngày (ảnh chụp cuối ngày thắng); qua ngày là ĐÓNG BĂNG — mã không bao giờ ghi lại
--    ngày cũ. Không backfill: tháng chưa có ảnh chụp in "chưa đo", không in 0.
--    `mrr_vnd` NULL = CHƯA BIẾT (thu phí đang bật mà gói không khai giá) — khác 0 (không thu phí / đã khoá).
--  · `platform_org_milestones`: mốc kích hoạt của tổ chức (kết nối kênh · có sản phẩm · hội thoại đầu · lượt AI đầu ·
--    đơn AI đầu). GHI MỘT LẦN: mốc là thời điểm của chứng từ CÓ THẬT trong CSDL tổ chức (min created_at), không phải
--    lúc máy nhìn thấy — nên quét lần đầu sau deploy vẫn ra đúng mốc lịch sử mà không phải đoán.
--  · Mặt phẳng điều khiển: chỉ thật ở CSDL NHÀ; CSDL tổ chức có bảng (cùng bộ migration) nhưng bị xoá sạch mỗi lần mở
--    (db/migrate.ts). Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "platform_saas_daily" (
  "day" date NOT NULL,
  "org_code" text NOT NULL,
  "org_status" text NOT NULL,
  "is_home" boolean DEFAULT false NOT NULL,
  "plan_key" text NOT NULL,
  "billing_enabled" boolean DEFAULT false NOT NULL,
  "standing" text NOT NULL,
  "paying" boolean DEFAULT false NOT NULL,
  "mrr_vnd" integer,
  "mrr_note" text,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_saas_daily_pkey" PRIMARY KEY ("day", "org_code"),
  CONSTRAINT "platform_saas_daily_mrr_check" CHECK ("mrr_vnd" IS NULL OR "mrr_vnd" >= 0),
  CONSTRAINT "platform_saas_daily_paying_check" CHECK ("paying" = false OR "mrr_vnd" IS NULL OR "mrr_vnd" > 0),
  CONSTRAINT "platform_saas_daily_standing_check" CHECK ("standing" IN ('NOT_BILLED','ACTIVE','DUE_SOON','OVERDUE','LOCKED'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "platform_saas_daily_org_day_idx" ON "platform_saas_daily" ("org_code", "day");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "platform_org_milestones" (
  "org_code" text NOT NULL,
  "milestone" text NOT NULL,
  "reached_at" timestamp with time zone NOT NULL,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source" text NOT NULL,
  CONSTRAINT "platform_org_milestones_pkey" PRIMARY KEY ("org_code", "milestone"),
  CONSTRAINT "platform_org_milestones_key_check" CHECK ("milestone" ~ '^[A-Z][A-Z0-9_]{1,40}$')
);
