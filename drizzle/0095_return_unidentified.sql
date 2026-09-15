-- ═══════ HÀNG HOÀN CHƯA XÁC ĐỊNH NGUỒN — KIỆN MẤT NHÃN VẬN ĐƠN ═══════
--
-- Ca có thật ở kho: một kiện nằm trong lô hàng hoàn, hàng còn nguyên, nhưng nhãn vận đơn đã rách
-- hoặc bong mất. Không có mã để bắn, nên không có `shipments.id` để trỏ tới — và
-- `return_inspections.shipment_id` là NOT NULL. Trước bản này ERP KHÔNG CÓ CHỖ NÀO ghi kiện ấy.
--
-- Kho khi đó chỉ còn hai đường, cả hai đều làm hỏng sổ:
--   · chọn đại một đơn "gần giống" ⇒ một khách vô can mang tiếng trả hàng, tỷ lệ hoàn của mã đó sai;
--   · lập phiếu nhập kho thường ⇒ hàng hoàn đội lốt hàng nhập mới, giá vốn lẫn tỷ lệ hoàn cùng sai.
--
-- Bảng này giữ LỚP 1 (kiện vật lý có thật) và LỚP 3 (đã đếm, đã kết luận) mà KHÔNG cần LỚP 2
-- (thuộc đơn nào). `stock_receipt_id` là cây cầu MỘT CHIỀU duy nhất sang tồn kho: `NULL` nghĩa là
-- hàng có thật trong kho nhưng KHÔNG nằm trong tồn bán được, và vì nó là cột duy nhất nói "đã
-- cộng" nên không món nào vào tồn được hai lần.
--
-- CHỈ CỘNG THÊM một bảng. Không đụng `shipments`, `return_inspections`, `stock_receipts` hay bất
-- kỳ dòng dữ liệu nào đang có.

CREATE TABLE IF NOT EXISTS "return_unidentified" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING_IDENTIFICATION',
  "source" text NOT NULL DEFAULT 'NO_TRACKING_LABEL',

  "received_at" timestamp with time zone NOT NULL,
  "received_by" text NOT NULL DEFAULT '',
  "received_by_user_id" text,
  "warehouse_note" text NOT NULL DEFAULT '',

  "variant_id" text,
  "sku" text NOT NULL DEFAULT '',
  "product_name" text NOT NULL DEFAULT '',
  "color" text NOT NULL DEFAULT '',
  "size" text NOT NULL DEFAULT '',
  "quantity" integer NOT NULL,
  "condition" text NOT NULL,
  "note" text NOT NULL DEFAULT '',

  "identification_method" text,
  "identified_at" timestamp with time zone,
  "identified_by" text NOT NULL DEFAULT '',
  "identified_by_user_id" text,
  "linked_order_id" text,
  "linked_shipment_id" text,
  "linked_tracking_number" text NOT NULL DEFAULT '',
  "unidentifiable_reason" text NOT NULL DEFAULT '',

  "stock_receipt_id" text,
  "restocked_at" timestamp with time zone,
  "restocked_by" text NOT NULL DEFAULT '',
  "restocked_by_user_id" text,
  "restock_authority" text,
  "restock_reason" text NOT NULL DEFAULT '',

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "return_unidentified_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_received_by_user_id_users_id_fk"
  FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_variant_id_product_variants_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_identified_by_user_id_users_id_fk"
  FOREIGN KEY ("identified_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_linked_order_id_orders_id_fk"
  FOREIGN KEY ("linked_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_linked_shipment_id_shipments_id_fk"
  FOREIGN KEY ("linked_shipment_id") REFERENCES "public"."shipments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- `restrict` chứ không phải `set null`: xoá một phiếu kho mà để lại dòng "đã vào tồn" trỏ vào
-- khoảng không là biến một món đã cộng tồn thành một món không ai truy được về chứng từ nào.
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_stock_receipt_id_stock_receipts_id_fk"
  FOREIGN KEY ("stock_receipt_id") REFERENCES "public"."stock_receipts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_restocked_by_user_id_users_id_fk"
  FOREIGN KEY ("restocked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_unidentified_status_idx" ON "return_unidentified" ("status","received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_unidentified_variant_idx" ON "return_unidentified" ("variant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_unidentified_shipment_idx" ON "return_unidentified" ("linked_shipment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_unidentified_holding_idx" ON "return_unidentified" ("stock_receipt_id","status");
--> statement-breakpoint
-- MỖI PHIẾU KHO CHỈ PHỤC VỤ MỘT MÓN GIỮ TẠM. Không có ràng buộc này thì một lỗi lập trình có thể
-- trỏ hai dòng vào cùng một phiếu, và "đã vào tồn" trở thành một lời nói dối có vẻ hợp lệ.
CREATE UNIQUE INDEX IF NOT EXISTS "return_unidentified_receipt_uk" ON "return_unidentified" ("stock_receipt_id");
--> statement-breakpoint
-- Ba danh sách dưới PHẢI khớp hằng số ở lib/constants/return-unidentified.ts (và `ITEM_CONDITIONS`
-- ở lib/constants/return-lifecycle.ts). Đã có tiền lệ lệch giữa hằng số TypeScript và ràng buộc
-- SQL (`WRONG_ITEM` của bảng kiểm cả kiện): người kho bấm một nút hợp lệ và nhận lỗi ràng buộc,
-- đúng lúc đang đứng đếm hàng.
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_status_check"
  CHECK ("status" IN ('PENDING_IDENTIFICATION', 'IDENTIFIED', 'UNIDENTIFIABLE'));
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_source_check"
  CHECK ("source" IN ('NO_TRACKING_LABEL', 'DAMAGED_LABEL', 'UNKNOWN_PARCEL'));
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_condition_check"
  CHECK ("condition" IN ('OK', 'SHORT', 'WRONG_ITEM', 'DAMAGED', 'DIRTY', 'UNSELLABLE', 'OTHER'));
--> statement-breakpoint
-- Không có hàng thì không có việc gì để ghi. Số 0 ở đây là một dòng rác vĩnh viễn.
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_qty_check"
  CHECK ("quantity" > 0);
--> statement-breakpoint
-- Đã nối đơn thì phải nói NỐI VỚI CÁI GÌ, AI nối, LÚC NÀO.
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_identified_check"
  CHECK ("status" <> 'IDENTIFIED' OR ("identification_method" IS NOT NULL AND "identified_at" IS NOT NULL
    AND length(trim("identified_by")) > 0 AND ("linked_shipment_id" IS NOT NULL OR "linked_order_id" IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_method_check"
  CHECK ("identification_method" IS NULL OR "identification_method" IN ('MANUAL_MATCH'));
--> statement-breakpoint
-- Kết luận "không thể xác định" phải có lý do: nếu không, nó chỉ là một cách bỏ việc lại cho người
-- sau mà trông như đã xử lý xong.
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_unidentifiable_check"
  CHECK ("status" <> 'UNIDENTIFIABLE' OR length(trim("unidentifiable_reason")) > 0);
--> statement-breakpoint
-- ĐÃ VÀO TỒN thì phải đủ: ai cộng, lúc nào, CĂN CỨ nào, và cộng vào MẪU MÃ nào.
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_restock_check"
  CHECK ("stock_receipt_id" IS NULL OR ("restocked_at" IS NOT NULL AND length(trim("restocked_by")) > 0
    AND "restock_authority" IS NOT NULL AND "variant_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_authority_check"
  CHECK ("restock_authority" IS NULL OR "restock_authority" IN ('IDENTIFIED', 'MANAGER_OVERRIDE'));
--> statement-breakpoint
-- Vào tồn mà KHÔNG có chứng từ đơn thì bắt buộc có lý do viết ra được — đây là toàn bộ khác biệt
-- giữa một quyết định của quản lý kho và một lượt cộng tồn không nguồn gốc.
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_override_reason_check"
  CHECK ("restock_authority" IS DISTINCT FROM 'MANAGER_OVERRIDE' OR length(trim("restock_reason")) > 0);
--> statement-breakpoint
-- Căn cứ `IDENTIFIED` chỉ đứng được khi thật sự đã nối đơn — nếu không, nó là `MANAGER_OVERRIDE`
-- đội lốt căn cứ mạnh hơn, và lượt tái nhập không chứng từ ấy biến mất khỏi mọi báo cáo.
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_authority_status_check"
  CHECK ("restock_authority" IS DISTINCT FROM 'IDENTIFIED' OR "status" = 'IDENTIFIED');
