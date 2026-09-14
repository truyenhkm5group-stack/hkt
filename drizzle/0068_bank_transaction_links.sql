-- ═══════ MỐI NỐI GIỮA TIỀN THẬT VÀ CHỨNG TỪ — NHIỀU–NHIỀU, CÓ SỐ TIỀN ═══════
--
-- CHỈ CỘNG THÊM. Một bảng mới, và một ràng buộc CŨ được NỚI (thêm hai giá trị hợp lệ). Không xoá
-- cột, không đổi kiểu, không viết lại dòng dữ liệu nào đã ghi.
--
-- Viết tay và idempotent (`IF NOT EXISTS`) như 0033–0067: ảnh chụp `drizzle/meta/*_snapshot.json`
-- đã cũ từ 0032 nên `drizzle-kit generate` sinh ra một bản dựng lại TOÀN BỘ lược đồ, chạy lên
-- production sẽ hỏng ngay câu lệnh đầu.
--
-- VÌ SAO CẦN BẢNG RIÊNG. `bank_transactions.linked_type/linked_id` chỉ chứa được MỘT mối nối và
-- KHÔNG mang số tiền. Ba tình huống thường ngày vì thế không diễn tả được: một khoản chi trả làm
-- nhiều lần, một chuyển khoản trả nhiều chứng từ, và trả một phần. Thiếu số tiền phân bổ thì câu
-- "khoản chi này đã trả bao nhiêu" không có câu trả lời — chỉ có đúng/sai, mà thực tế là một con số.
--
-- BẢNG NÀY KHÔNG TẠO RA TIỀN, CHI PHÍ HAY DOANH THU. Nối là ĐỐI CHIẾU. Mọi khoản đã được ghi nhận
-- ở sổ có thẩm quyền của nó (xem docs/finance-truth-contract.md); cộng số tiền ở đây vào báo cáo
-- nào là đếm đôi, đúng thứ bảng này sinh ra để chặn.

CREATE TABLE IF NOT EXISTS "bank_transaction_links" (
  "id" text PRIMARY KEY NOT NULL,
  "txn_id" text NOT NULL,

  -- Bốn loại đầu giữ đúng tên đã dùng ở `linked_type` nên dữ liệu cũ chuyển sang không phải đổi chữ.
  -- PAYROLL_PERIOD: bảng Lương là CẤU HÌNH chứ không phải bảng dữ liệu, không có id để nối — khoá
  -- tự nhiên của một kỳ lương là tháng của nó. BANK_TRANSACTION: chân kia của một lần chuyển nội bộ,
  -- không ghép được thì dòng tiền công ty cộng cả tiền ra lẫn tiền vào cho một đồng không rời shop.
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,

  -- Phần số tiền CỦA DÒNG TIỀN NÀY dành cho chứng từ kia. Luôn DƯƠNG: chiều tiền đã nằm ở dấu của
  -- `bank_transactions.amount`; lặp dấu ở đây chỉ tạo thêm một chỗ để cộng sai.
  "amount" integer NOT NULL,

  "confidence" text NOT NULL DEFAULT 'MANUAL',
  "method" text NOT NULL DEFAULT 'MANUAL',
  -- Mỗi dòng là một KHẲNG ĐỊNH có người chịu trách nhiệm. Máy tự nối ghi 'auto:exact', và CHỈ mức
  -- EXACT (nội dung chuyển khoản chứa mã chứng từ) mới được tự nối.
  "confirmed_by" text NOT NULL,
  "confirmed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "note" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "bank_txn_links_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "bank_txn_links_target_type_check" CHECK ("target_type" IN ('EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION')),
  -- Nhập nhằng KHÔNG được lưu: một mối nối đã ghi là một khẳng định, mà nhập nhằng theo định nghĩa
  -- không khẳng định được. AMBIGUOUS/UNMATCHED chỉ sống ở tầng gợi ý.
  CONSTRAINT "bank_txn_links_confidence_check" CHECK ("confidence" IN ('EXACT', 'HIGH_CONFIDENCE', 'MANUAL')),
  CONSTRAINT "bank_txn_links_method_check" CHECK ("method" IN ('IDENTIFIER_MATCH', 'AMOUNT_DATE_MATCH', 'MANUAL', 'TRANSFER_PAIR')),
  CONSTRAINT "bank_txn_links_actor_check" CHECK (length(trim("confirmed_by")) > 0),
  CONSTRAINT "bank_txn_links_payroll_period_check" CHECK ("target_type" <> 'PAYROLL_PERIOD' OR "target_id" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "bank_txn_links_self_check" CHECK ("target_type" <> 'BANK_TRANSACTION' OR "target_id" <> "txn_id")
);--> statement-breakpoint

-- Xoá dòng tiền thì mối nối của nó đi theo: một mối nối trỏ vào giao dịch không còn tồn tại là rác
-- làm sai mọi phép tổng hợp "đã trả bao nhiêu".
DO $$ BEGIN
  ALTER TABLE "bank_transaction_links"
    ADD CONSTRAINT "bank_txn_links_txn_fk"
    FOREIGN KEY ("txn_id") REFERENCES "bank_transactions"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Nối cùng một dòng tiền tới cùng một chứng từ HAI lần là đếm đôi ngay trong bảng chống đếm đôi.
CREATE UNIQUE INDEX IF NOT EXISTS "bank_txn_links_uq" ON "bank_transaction_links" USING btree ("txn_id", "target_type", "target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_txn_links_txn_idx" ON "bank_transaction_links" USING btree ("txn_id");--> statement-breakpoint
-- "Khoản chi này đã trả bao nhiêu" phải tra được từ phía CHỨNG TỪ, không chỉ từ phía dòng tiền.
CREATE INDEX IF NOT EXISTS "bank_txn_links_target_idx" ON "bank_transaction_links" USING btree ("target_type", "target_id");--> statement-breakpoint

-- ── NỚI ràng buộc cũ: `linked_type` nay là ẢNH CHỤP mối nối chính, nên nhận thêm hai loại mới ──
-- Nới chứ không siết: mọi giá trị đang có vẫn hợp lệ, không dòng nào bị từ chối.
DO $$ BEGIN
  ALTER TABLE "bank_transactions" DROP CONSTRAINT IF EXISTS "bank_txn_linked_check";
  ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_txn_linked_check"
    CHECK ("linked_type" IN ('', 'EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION'));
END $$;--> statement-breakpoint

-- ── CHUYỂN MỐI NỐI ĐÃ CÓ SANG BẢNG MỚI ──
--
-- Không mất mối nối nào người dùng đã bấm. Số tiền phân bổ lấy TRỌN trị tuyệt đối của dòng tiền —
-- đó đúng là ý nghĩa của mối nối 1–1 cũ ("đồng tiền này ứng với chứng từ kia"), và là cách đọc duy
-- nhất không bịa thêm thông tin. `confirmed_by` lấy người đã phân loại dòng đó; không có thì ghi
-- 'migration:0068' — thà nói thẳng "không biết ai" còn hơn gán bừa cho một người thật.
INSERT INTO "bank_transaction_links" ("id", "txn_id", "target_type", "target_id", "amount", "confidence", "method", "confirmed_by", "confirmed_at", "note")
SELECT md5("id" || ':' || "linked_type" || ':' || "linked_id"), "id", "linked_type", "linked_id", abs("amount"),
       'MANUAL', 'MANUAL',
       CASE WHEN length(trim(coalesce("classified_by", ''))) > 0 THEN "classified_by" ELSE 'migration:0068' END,
       coalesce("classified_at", "created_at"),
       'Chuyển từ linked_type/linked_id khi lên bảng nối nhiều–nhiều (0068)'
FROM "bank_transactions"
WHERE "linked_type" <> '' AND "linked_id" <> ''
ON CONFLICT DO NOTHING;
