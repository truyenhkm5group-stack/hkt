ALTER TABLE "ad_spends" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN "account_name" text;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN "campaign_id" text;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN "product_id" text;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN "impressions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN "clicks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN "messages" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD CONSTRAINT "ad_spends_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_spends_external_key_uq" ON "ad_spends" USING btree ("external_key");--> statement-breakpoint
CREATE INDEX "ad_spends_product_idx" ON "ad_spends" USING btree ("product_id");