-- ═══════════ LÝ DO HOÀN: NHÓM LỚN, NGUỒN VÀ ĐỘ TIN CẬY TÁCH BẠCH ═══════════
--
-- Ba cột thêm vào, tất cả CÓ MẶC ĐỊNH vì bảng này đang rỗng trên production (0 dòng, đo
-- 13/09/2026). Mặc định KHÔNG phải là một phép đoán về dữ liệu cũ — không có dữ liệu cũ nào.

ALTER TABLE "shipment_return_reasons" ADD COLUMN IF NOT EXISTS "reason_group" text DEFAULT 'UNKNOWN' NOT NULL;
--> statement-breakpoint
ALTER TABLE "shipment_return_reasons" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'MANUAL' NOT NULL;
--> statement-breakpoint
ALTER TABLE "shipment_return_reasons" ADD COLUMN IF NOT EXISTS "confidence" text DEFAULT 'CONFIRMED' NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipment_return_reasons_source_check') THEN
    ALTER TABLE "shipment_return_reasons" ADD CONSTRAINT "shipment_return_reasons_source_check"
      CHECK ("source" IN ('MANUAL', 'AUTO', 'IMPORT'));
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shipment_return_reasons_group_idx" ON "shipment_return_reasons" ("reason_group");
