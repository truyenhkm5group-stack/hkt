ALTER TABLE "ad_spends" ADD COLUMN "marketer_id" text;--> statement-breakpoint
CREATE INDEX "ad_spends_marketer_idx" ON "ad_spends" USING btree ("marketer_id");