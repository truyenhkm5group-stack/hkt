-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
-- Sổ chi tiết bảng kê COD: giữ nguyên từng dòng của từng file bảng kê Viettel Post.
-- Trước đây tiền thực thu ghi thẳng lên shipments theo từng file nên file nhập sau đè mất file
-- nhập trước; số trên shipments nay chỉ là kết quả dựng lại từ sổ này.
CREATE TABLE IF NOT EXISTS "cod_statement_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "source_file" text NOT NULL,
  "batch_id" text,
  "tracking_code" text NOT NULL,
  "cod" integer DEFAULT 0 NOT NULL,
  "fee" integer DEFAULT 0 NOT NULL,
  "net" integer DEFAULT 0 NOT NULL,
  "cod_reported" boolean DEFAULT true NOT NULL,
  "paid_date" text,
  "statement_at" timestamp with time zone NOT NULL,
  "status_text" text DEFAULT '' NOT NULL,
  "shipment_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "cod_statement_lines" ADD CONSTRAINT "cod_statement_lines_batch_id_cod_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "cod_batches"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "cod_statement_lines" ADD CONSTRAINT "cod_statement_lines_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cod_statement_lines_file_code_uq" ON "cod_statement_lines" USING btree ("source_file","tracking_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cod_statement_lines_shipment_idx" ON "cod_statement_lines" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cod_statement_lines_batch_idx" ON "cod_statement_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cod_statement_lines_code_idx" ON "cod_statement_lines" USING btree ("tracking_code");
