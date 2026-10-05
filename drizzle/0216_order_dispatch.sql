-- 0216 · ĐIỀU PHỐI GIAO CỦA ĐƠN TẠO TAY (docs/verticals/pos-tu-chu.md P7 · lib/shipping/routing.ts).
--
--  · Tuyến của đơn (tự giao / hãng / giữ lại) KHÔNG lưu: hàm thuần của đơn + cấu hình `shipping.routing`, đọc lúc xem.
--  · Bảng chỉ giữ NGƯỜI GIAO (khoá users.id — AGENTS 34) và LƯỢT MÁY TỰ TẠO VẬN ĐƠN gần nhất (để không dội hãng mỗi lượt).
--  · Bảng của CSDL tổ chức. Viết tay, idempotent. Không backfill.

CREATE TABLE IF NOT EXISTS "order_dispatch" (
  "order_id" text PRIMARY KEY NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
  "courier_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "courier_name" text DEFAULT '' NOT NULL,
  "assigned_at" timestamp with time zone,
  "assigned_by_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "auto_attempts" integer DEFAULT 0 NOT NULL,
  "auto_last_at" timestamp with time zone,
  "auto_last_result" text,
  "auto_last_carrier" text,
  "auto_last_message" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "order_dispatch_manual_check" CHECK ("order_id" LIKE 'erp-%'),
  CONSTRAINT "order_dispatch_auto_result_check" CHECK ("auto_last_result" IS NULL OR "auto_last_result" IN ('CREATED', 'FAILED'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_dispatch_courier_idx" ON "order_dispatch" ("courier_user_id");
