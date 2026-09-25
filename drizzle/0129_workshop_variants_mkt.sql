-- 0129 · SỔ ĐẶT XƯỞNG: chia số lượng theo từng mẫu (màu/size), giá báo MKT, phạt xưởng.
--
-- Vì sao: chủ shop cần hàng ĐÃ ĐẶT trừ vào số THIẾU của từng mẫu và Lark thôi nhắc khi đã đặt đủ.
-- Thiếu hàng tính theo MẪU (màu/size), nên lô phải chia được số đặt theo mẫu; đợt trả hàng cũng vậy.
--
-- CHỈ THÊM CỘT với mặc định trung tính. Không backfill (AGENTS.md mục 35): lô cũ không có bảng chia
-- mẫu thì `cells = {}` — nghĩa là "chưa chia", và phép trừ thiếu hàng KHÔNG đếm nó (không đoán chia hộ).
-- `marketer_price` NULL = chưa báo giá; `workshop_penalty` 0 = không phạt.
-- Viết tay và idempotent như 0033–0128.

ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "cells" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "workshop_penalty" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "penalty_note" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "marketer_price" integer;
--> statement-breakpoint
ALTER TABLE "production_deliveries" ADD COLUMN IF NOT EXISTS "cells" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
-- Ràng buộc giá mở rộng thêm hai cột mới: giá báo MKT không âm, tiền phạt không âm.
ALTER TABLE "production_batches" DROP CONSTRAINT IF EXISTS "production_batches_price_check";
--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_price_check" CHECK (("labor_unit_price" IS NULL OR "labor_unit_price" >= 0) AND ("marketer_price" IS NULL OR "marketer_price" >= 0) AND "workshop_penalty" >= 0);
