-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
-- Giữ nguyên tệp bảng kê Viettel Post nhận qua email để ERP tự phát lại được khi sửa cách đọc,
-- không phải vào Gmail gỡ nhãn "đã nhập" bằng tay.
CREATE TABLE IF NOT EXISTS "vtp_statement_files" (
  "id" text PRIMARY KEY NOT NULL,
  "filename" text NOT NULL,
  "content" text NOT NULL,
  "bytes" integer DEFAULT 0 NOT NULL,
  "kind" text DEFAULT '' NOT NULL,
  "actor" text DEFAULT '' NOT NULL,
  "rows" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_imported_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vtp_statement_files_name_uq" ON "vtp_statement_files" USING btree ("filename");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vtp_statement_files_received_idx" ON "vtp_statement_files" USING btree ("created_at");
