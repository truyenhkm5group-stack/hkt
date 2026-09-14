-- ═══════ BẢNG TÍNH HÀNG HOÀN ĐƯA VÀO BẰNG CHÍNH ERP ═══════
--
-- CHỈ CỘNG THÊM MỘT BẢNG. Không đổi kiểu, không xoá cột, không đổi tên, không đụng
-- `hmt_return_reconciliation` / `return_inspections` / `shipments` / `stock_receipts`.
--
-- Viết tay và idempotent (`IF NOT EXISTS`) như 0033–0081: ảnh chụp (`drizzle/meta/*_snapshot.json`)
-- của kho này đã cũ từ 0032, nên `drizzle-kit generate` sinh ra một bản dựng lại TOÀN BỘ lược đồ —
-- chạy bản đó lên production sẽ hỏng ngay ở câu lệnh đầu tiên.
--
-- VÌ SAO CẦN BẢNG RIÊNG. Sổ hàng hoàn là một tệp Excel trên máy chủ shop; để đối soát được, tệp
-- phải tới nơi có CSDL production. `scp` cần khoá SSH mà máy ấy không có; đường dẫn tải công khai
-- là dữ liệu khách hàng nằm trên Internet; đưa vào kho mã thì kho mã này PUBLIC. Đường đúng đã có
-- sẵn cho bảng kê Viettel Post (`vtp_statement_files`): người đã đăng nhập kéo tệp vào màn hình
-- của chính họ, đi qua HTTPS bằng phiên của họ.
--
-- KHOÁ TỰ NHIÊN LÀ NỘI DUNG, KHÔNG PHẢI TÊN TỆP. Cùng một tệp tải lên mười lần vẫn là MỘT dòng, kể
-- cả khi người dùng đổi tên ("Bản sao của…", "… (1).xlsx") — mà họ luôn đổi. Băm do MÁY CHỦ tính
-- lại từ chính các byte đã nhận, không nhận từ client.
--
-- BẢNG NÀY KHÔNG ĐỤNG TỒN KHO. Tồn vẫn chỉ đổi qua `stock_receipts` / `stock_receipt_items`, và
-- chỉ khi người kho đếm thật (AGENTS.md mục 10).

CREATE TABLE IF NOT EXISTS "hmt_workbooks" (
  "id" text PRIMARY KEY NOT NULL,
  "filename" text NOT NULL,
  "sha256" text NOT NULL,
  "bytes" integer NOT NULL DEFAULT 0,
  "content" text NOT NULL,
  "uploaded_by_user_id" text,
  "uploaded_by" text NOT NULL DEFAULT '',
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Người tải lên nghỉ việc / tài khoản bị xoá ⇒ khoá về NULL, DÒNG Ở LẠI. Xoá dòng theo người là
-- xoá bằng chứng của một lượt đối soát đã ghi vào kho.
DO $$ BEGIN
  ALTER TABLE "hmt_workbooks"
    ADD CONSTRAINT "hmt_workbooks_uploader_fk"
    FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "hmt_workbooks_sha_uq" ON "hmt_workbooks" ("sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hmt_workbooks_created_idx" ON "hmt_workbooks" ("created_at");
