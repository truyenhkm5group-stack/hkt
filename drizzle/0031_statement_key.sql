-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
-- Khoá chống trùng bảng kê theo DANH TÍNH thay vì theo tên file: cùng một bảng kê tải tay và nhận
-- qua email có tên khác nhau, khoá theo tên file thì tiền bị cộng hai lần.
ALTER TABLE "cod_statement_lines" ADD COLUMN IF NOT EXISTS "statement_key" text;--> statement-breakpoint
UPDATE "cod_statement_lines" SET "statement_key" = "source_file" WHERE "statement_key" IS NULL;--> statement-breakpoint
ALTER TABLE "cod_statement_lines" ALTER COLUMN "statement_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vtp_statement_files" ADD COLUMN IF NOT EXISTS "statement_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "cod_statement_lines_file_code_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cod_statement_lines_key_code_uq" ON "cod_statement_lines" USING btree ("statement_key","tracking_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cod_statement_lines_file_idx" ON "cod_statement_lines" USING btree ("source_file");
