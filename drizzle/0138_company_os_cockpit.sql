-- 0138 · COMPANY OS · AGENT H — SỔ PHẢN ỨNG VỚI ĐỀ XUẤT CỦA BUỒNG LÁI CHỦ SHOP ("Cần anh quyết").
--
-- Hàng đợi "Cần anh quyết" là PHÉP CHIẾU lên các nguồn đang chạy (luật 19) — không bảng nào lưu đề xuất.
-- Bảng này chỉ lưu PHẢN ỨNG của người đọc: ACCEPTED (vẫn hiện tới khi nguồn hết điều kiện) · DISMISSED
-- (bắt buộc lý do; ẩn tới khi khoá nguồn đổi) · SNOOZED (ẩn tới `snooze_until`), kèm ảnh chụp đề xuất
-- lúc quyết để đo sau. APPEND-ONLY. Người quyết là MỘT tài khoản (luật 34): `decided_by_user_id` NOT NULL.
--
-- Bảng mới, rỗng: không backfill, không đoán phản ứng cho quá khứ (mục 8.8, 35).
-- Viết tay và idempotent như 0033–0137.

CREATE TABLE IF NOT EXISTS "recommendation_decisions" (
  "id" text PRIMARY KEY NOT NULL,
  "source_key" text NOT NULL,
  "kind" text NOT NULL,
  "decision" text NOT NULL,
  "reason" text DEFAULT '' NOT NULL,
  "snooze_until" timestamp with time zone,
  "decided_by_user_id" text NOT NULL,
  "decided_by" text DEFAULT '' NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  "snapshot" jsonb NOT NULL,
  CONSTRAINT "recommendation_decisions_source_key_check" CHECK (length(btrim("source_key")) > 0),
  CONSTRAINT "recommendation_decisions_decision_check" CHECK ("decision" IN ('ACCEPTED', 'DISMISSED', 'SNOOZED')),
  CONSTRAINT "recommendation_decisions_kind_check" CHECK ("kind" IN ('APPROVAL', 'SAMPLE_REVIEW', 'TOPIC_DECISION', 'ADS_CUT', 'INVENTORY_STOCKOUT', 'PRODUCTION_LATE', 'INVENTORY_REORDER', 'MODEL_SCALE', 'INVENTORY_CLEARANCE')),
  CONSTRAINT "recommendation_decisions_reason_check" CHECK ("decision" <> 'DISMISSED' OR length(btrim("reason")) > 0),
  CONSTRAINT "recommendation_decisions_snooze_check" CHECK (("decision" = 'SNOOZED') = ("snooze_until" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "recommendation_decisions" ADD CONSTRAINT "recommendation_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recommendation_decisions_key_idx" ON "recommendation_decisions" ("source_key", "decided_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recommendation_decisions_at_idx" ON "recommendation_decisions" ("decided_at");
