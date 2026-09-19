ALTER TABLE "sales_review_labels" ADD COLUMN IF NOT EXISTS "expected_behavior" text DEFAULT '' NOT NULL;
