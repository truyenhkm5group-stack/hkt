ALTER TABLE "cod_batches" ADD COLUMN "cod_gross" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cod_batches" ADD COLUMN "fee_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cod_batches" ADD COLUMN "source" text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cod_batches_reference_uq" ON "cod_batches" USING btree ("reference");