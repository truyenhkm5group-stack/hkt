-- ═══════════ GHI CHÚ VẬN HÀNH CHO SẢN PHẨM / MẪU MÃ ═══════════
--
-- Cột `products.note` đã có từ trước, nhưng nó là ô ghi chú ĐỒNG BỘ TỪ PANCAKE: trang sản phẩm
-- hiện nó ra và KHÔNG có đường nào để người trong shop viết vào. Viết đè lên cột đó là hai cái
-- sai cùng lúc — lần đồng bộ sau ghi đè mất, và không ai biết ai viết lúc nào.
--
-- Bảng riêng, CHỈ THÊM, mỗi dòng mang khoá tài khoản người viết (AGENTS.md mục 34). Cột chữ
-- `actor_name` là ẢNH CHỤP TÊN để người đọc; tên do MÁY CHỦ đọc từ `users`, không nhận từ client.
--
-- `variant_id` cho phép ghi chú ở mức MẪU MÃ ("size L hay bị chật") chứ không chỉ mức sản phẩm.
-- `NULL` = ghi chú cho cả sản phẩm.

CREATE TABLE IF NOT EXISTS "product_notes" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL REFERENCES "products"("id") ON DELETE cascade,
  "variant_id" text REFERENCES "product_variants"("id") ON DELETE set null,
  "category" text DEFAULT 'OTHER' NOT NULL,
  "body" text NOT NULL,
  "actor_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "actor_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Đọc theo sản phẩm, mới nhất trước — đúng thứ tự màn hình cần.
CREATE INDEX IF NOT EXISTS "product_notes_product_idx" ON "product_notes" ("product_id", "created_at" DESC);
--> statement-breakpoint

-- Danh sách ĐÓNG. Ô gõ tự do sẽ sinh ra "chatluong", "Chất lượng", "CL" là ba nhóm khác nhau, và
-- bộ lọc theo nhóm thành vô dụng ngay trong tuần đầu.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_notes_category_check') THEN
    ALTER TABLE "product_notes" ADD CONSTRAINT "product_notes_category_check"
      CHECK ("category" IN ('QUALITY', 'SIZING', 'SUPPLIER', 'PRICING', 'PACKAGING', 'OTHER'));
  END IF;
END $$;
--> statement-breakpoint

-- Ghi chú rỗng là một dòng nhiễu vĩnh viễn: nó chiếm chỗ "ghi chú mới nhất" trên màn hình danh
-- sách và đẩy ghi chú thật xuống dưới.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_notes_body_check') THEN
    ALTER TABLE "product_notes" ADD CONSTRAINT "product_notes_body_check" CHECK (length(btrim("body")) > 0);
  END IF;
END $$;
