-- ═══════ ẢNH CHỤP HIỆU SUẤT: SỐ LỊCH SỬ KHÔNG ĐỔI VÌ TRUY VẤN HÔM NAY ĐỔI ═══════
--
-- Đặc tả: chú thích đầu `performanceSnapshots` trong `db/schema.ts`.
--
-- CHỈ CỘNG THÊM. Một bảng mới, không cột nào bị xoá hay đổi kiểu, không dòng dữ liệu nào đang có
-- bị viết lại. Không bảng nghiệp vụ nào bị đụng tới.
--
-- Viết tay và idempotent (`IF NOT EXISTS`) như 0033–0070: ảnh chụp `drizzle/meta/*_snapshot.json`
-- đã cũ từ 0032 nên `drizzle-kit generate` sinh ra một bản dựng lại TOÀN BỘ lược đồ.
--
-- ─── VÌ SAO LÀ DÒNG, KHÔNG PHẢI MỘT KHỐI JSON MỖI KỲ ───
--
-- `review_cycles.snapshot` đã là khối JSON và nó đúng cho việc của nó: đóng băng TOÀN CẢNH một kỳ
-- họp. Nhưng câu hỏi của quản trị hiệu suất là "chỉ số này của người này đang lên hay xuống" —
-- một câu hỏi trải DỌC nhiều kỳ. Với JSON thì phải đọc hết mọi kỳ vào bộ nhớ rồi bóc từng khối;
-- với dòng thì một câu `order by period_start` là xong.
--
-- ─── BẤT BIẾN THẬT, KHÔNG PHẢI LỜI HỨA ───
--
-- Khoá duy nhất `(period, subject_type, subject_id, metric_key)`. Job chụp dùng
-- `ON CONFLICT DO NOTHING`: chạy lại bao nhiêu lần cũng không ghi đè được số đã chụp. KHÔNG đặt
-- khoá ngoại tới `users` — ảnh chụp phải sống sót cả khi tài khoản bị xoá, vì lịch sử hiệu suất
-- của một người đã nghỉ vẫn là lịch sử của shop.

CREATE TABLE IF NOT EXISTS "performance_snapshots" (
  "id"                 text PRIMARY KEY NOT NULL,
  "kind"               text NOT NULL,
  "period"             text NOT NULL,
  "period_start"       timestamp with time zone NOT NULL,
  "period_end"         timestamp with time zone NOT NULL,
  "subject_type"       text NOT NULL,
  "subject_id"         text NOT NULL,
  "subject_label"      text DEFAULT '' NOT NULL,
  "department_code"    text DEFAULT '' NOT NULL,
  "metric_key"         text NOT NULL,
  "metric_label"       text NOT NULL,
  "value"              double precision,
  "unit"               text NOT NULL,
  "sample"             integer DEFAULT 0 NOT NULL,
  "denominator_label"  text DEFAULT '' NOT NULL,
  "confidence"         text NOT NULL,
  "linkage"            text NOT NULL,
  "shared"             boolean DEFAULT false NOT NULL,
  "attribution"        text DEFAULT '' NOT NULL,
  "basis"              text DEFAULT '' NOT NULL,
  "calculated_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "definition_version" integer DEFAULT 1 NOT NULL,
  "created_at"         timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "performance_snapshots_uq" ON "performance_snapshots" ("period", "subject_type", "subject_id", "metric_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_snapshots_subject_idx" ON "performance_snapshots" ("subject_type", "subject_id", "metric_key", "period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_snapshots_period_idx" ON "performance_snapshots" ("kind", "period_start");--> statement-breakpoint

-- `value` để NULL được là cố ý: NULL = CHƯA ĐO ĐƯỢC trong kỳ đó, không phải đạt 0.
-- Ràng buộc dưới đây chặn đúng một lỗi dễ mắc: chụp một con số mà quên mẫu số.
DO $$ BEGIN
  ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_sample_check"
    CHECK ("value" IS NULL OR "sample" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_confidence_check"
    CHECK ("confidence" IN ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_subject_check"
    CHECK ("subject_type" IN ('PERSON', 'DEPARTMENT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
