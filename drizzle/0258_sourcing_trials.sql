-- 0258 · TÌM HÀNG NGUỒN — LƯU MẪU (TEST-) + YÊU CẦU MUA THỬ CÓ DUYỆT (SRC-5a, docs/tech/ai-sourcing.md §3.1, Tech Lead duyệt 24/10/2026).
--
-- Chỉ TẠO hai bảng mới ở CSDL của tổ chức, không đổi bảng nào mã đang đọc, không gieo dòng nào. Idempotent.
--  · sourcing_shortlist: một mẫu nguồn ↔ một mẫu TEST- ở sổ mẫu (product_models, productId NULL) — KHÔNG có dòng products / variants,
--    nên không tồn kho, không giá vốn, không báo cáo.
--  · sourcing_trial_requests: yêu cầu mua thử. `snapshot` là ẢNH CHỤP lúc xin (bậc giá, MOQ, cân nặng, tham số giá về, kết quả công
--    thức) — BẤT BIẾN, không tính lại khi tham số đổi. Lời duyệt ở approval_requests (nhóm SOURCING_TRIAL); ERP không đặt hàng,
--    không thanh toán, không liên hệ nhà cung cấp — «đã đặt» / «đã về» do NGƯỜI bấm, mang khoá tài khoản.
CREATE TABLE IF NOT EXISTS "sourcing_shortlist" (
  "id" text PRIMARY KEY NOT NULL,
  "offer_id" text NOT NULL,
  "model_id" text NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sourcing_shortlist_offer_uq" ON "sourcing_shortlist" USING btree ("offer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sourcing_shortlist_model_uq" ON "sourcing_shortlist" USING btree ("model_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_shortlist" ADD CONSTRAINT "sourcing_shortlist_offer_id_sourcing_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."sourcing_offers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_shortlist" ADD CONSTRAINT "sourcing_shortlist_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_shortlist" ADD CONSTRAINT "sourcing_shortlist_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sourcing_trial_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "shortlist_id" text NOT NULL,
  "quantities" jsonb NOT NULL,
  "total_qty" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "approval_request_id" text,
  "status" text DEFAULT 'REQUESTED' NOT NULL,
  "requested_by" text NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ordered_by" text,
  "ordered_at" timestamp with time zone,
  "order_note" text DEFAULT '' NOT NULL,
  "received_by" text,
  "received_at" timestamp with time zone,
  "receipt_id" text,
  "receive_note" text DEFAULT '' NOT NULL,
  "cancelled_by" text,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text DEFAULT '' NOT NULL,
  CONSTRAINT "sourcing_trial_requests_status_check" CHECK ("status" IN ('REQUESTED', 'ORDERED', 'RECEIVED', 'CANCELLED')),
  CONSTRAINT "sourcing_trial_requests_qty_check" CHECK ("total_qty" BETWEEN 1 AND 1000000),
  CONSTRAINT "sourcing_trial_requests_quantities_check" CHECK (jsonb_typeof("quantities") = 'array' AND jsonb_array_length("quantities") BETWEEN 1 AND 200),
  CONSTRAINT "sourcing_trial_requests_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object'),
  CONSTRAINT "sourcing_trial_requests_ordered_check" CHECK ("status" NOT IN ('ORDERED', 'RECEIVED') OR ("ordered_at" IS NOT NULL AND "ordered_by" IS NOT NULL)),
  CONSTRAINT "sourcing_trial_requests_received_check" CHECK ("status" <> 'RECEIVED' OR ("received_at" IS NOT NULL AND "received_by" IS NOT NULL)),
  CONSTRAINT "sourcing_trial_requests_cancelled_check" CHECK ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL AND length(trim("cancel_reason")) >= 3))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sourcing_trial_requests_shortlist_idx" ON "sourcing_trial_requests" USING btree ("shortlist_id", "requested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sourcing_trial_requests_status_idx" ON "sourcing_trial_requests" USING btree ("status");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_trial_requests" ADD CONSTRAINT "sourcing_trial_requests_shortlist_id_sourcing_shortlist_id_fk" FOREIGN KEY ("shortlist_id") REFERENCES "public"."sourcing_shortlist"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_trial_requests" ADD CONSTRAINT "sourcing_trial_requests_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_trial_requests" ADD CONSTRAINT "sourcing_trial_requests_receipt_id_stock_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."stock_receipts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_trial_requests" ADD CONSTRAINT "sourcing_trial_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_trial_requests" ADD CONSTRAINT "sourcing_trial_requests_ordered_by_users_id_fk" FOREIGN KEY ("ordered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_trial_requests" ADD CONSTRAINT "sourcing_trial_requests_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_trial_requests" ADD CONSTRAINT "sourcing_trial_requests_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
