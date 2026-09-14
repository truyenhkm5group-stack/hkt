-- ═══════ SỔ NGÂN HÀNG: NHẬN GIAO DỊCH REALTIME TỪ SEPAY ═══════
--
-- CHỈ CỘNG THÊM. Không đổi kiểu, không xoá cột, không đổi tên. `bank_ref` UNIQUE giữ nguyên — đó
-- chính là chỗ webhook hội tụ với sao kê đã nhập bằng file, nên không được đụng tới.
--
-- Viết tay và idempotent (`IF NOT EXISTS`) như các migration 0033–0062 của kho này: ảnh chụp
-- (`drizzle/meta/*_snapshot.json`) đã cũ từ 0032, nên `drizzle-kit generate` sinh ra một bản dựng
-- lại TOÀN BỘ lược đồ — chạy lên production sẽ hỏng ngay ở `CREATE TABLE` đầu tiên.

-- ── Tài khoản ngân hàng ──
-- Trước đây `bank_transactions.account` là ô chữ tự do và luôn rỗng: sao kê tải tay không nói tài
-- khoản nào, người nhập tự biết. Realtime thì không — một gói tin SePay có thể tới từ bất kỳ tài
-- khoản nào đã nối, nên phải có thực thể tài khoản mới trả lời được "đồng tiền này ở tài khoản nào".
CREATE TABLE IF NOT EXISTS "bank_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL DEFAULT '',
  "gateway" text NOT NULL DEFAULT '',
  "account_number" text NOT NULL,
  "sub_account" text NOT NULL DEFAULT '',
  "label" text NOT NULL DEFAULT '',
  "currency" text NOT NULL DEFAULT 'VND',
  "status" text NOT NULL DEFAULT 'UNCONFIRMED',
  "note" text NOT NULL DEFAULT '',
  "last_seen_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bank_accounts_status_check" CHECK ("status" IN ('ACTIVE', 'UNCONFIRMED', 'DISABLED'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "bank_accounts_natural_uq" ON "bank_accounts" USING btree ("provider", "gateway", "account_number", "sub_account");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_accounts_status_idx" ON "bank_accounts" USING btree ("status");--> statement-breakpoint

-- ── Provenance trên từng giao dịch ──
-- Đường vào là NGUỒN GỐC, không phải danh tính: cùng một giao dịch ngân hàng có thể được webhook
-- báo trước rồi sao kê xác nhận sau, nhưng vẫn chỉ MỘT dòng.
ALTER TABLE "bank_transactions" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN IF NOT EXISTS "provider_txn_id" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN IF NOT EXISTS "bank_account_id" text;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN IF NOT EXISTS "last_seen_source" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN IF NOT EXISTS "seen_sources" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
-- NULL = CHƯA BIẾT số dư, không phải 0. Cố ý cho phép NULL.
ALTER TABLE "bank_transactions" ADD COLUMN IF NOT EXISTS "balance_after" integer;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN IF NOT EXISTS "match_key" text NOT NULL DEFAULT '';--> statement-breakpoint

-- Dòng đã có (nhập bằng file) giữ nguyên mọi thứ, chỉ điền provenance suy ra từ chính `source`.
UPDATE "bank_transactions"
   SET "last_seen_source" = "source",
       "seen_sources" = jsonb_build_array(jsonb_build_object('source', "source", 'provider', '', 'at', to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'ref', ''))
 WHERE "last_seen_source" = '';--> statement-breakpoint

-- Hai đường vào mới. WEBHOOK = SePay đẩy realtime, API = truy vấn đối chiếu.
ALTER TABLE "bank_transactions" DROP CONSTRAINT IF EXISTS "bank_txn_source_check";--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_txn_source_check" CHECK ("source" IN ('IMPORT', 'MANUAL', 'WEBHOOK', 'API'));--> statement-breakpoint

-- CHỐNG TRÙNG Ở TẦNG CSDL, không phải ở tầng ứng dụng.
-- SePay gửi lại tối đa 7 lần trong 5 giờ. Hai gói tin cùng `id` tới CÙNG LÚC vẫn không thể đẻ hai
-- dòng: một cái thắng, cái kia va vào chỉ mục này. Tự kiểm tra "đã có chưa" rồi mới ghi thì luôn
-- thua điều kiện tranh chấp.
CREATE UNIQUE INDEX IF NOT EXISTS "bank_txn_provider_uq" ON "bank_transactions" USING btree ("provider", "provider_txn_id") WHERE "provider_txn_id" <> '';--> statement-breakpoint

-- Lưới an toàn phải phủ CẢ dòng đã nhập từ file, nếu không nó chỉ canh được webhook-với-webhook
-- và đúng cặp nguy hiểm nhất (file ↔ realtime) lại lọt. Khoá = số tiền | số phút kể từ epoch;
-- CỐ Ý không có số tài khoản vì sao kê tải tay không nói tài khoản nào.
UPDATE "bank_transactions"
   SET "match_key" = "amount" || '|' || floor(extract(epoch from "txn_at") / 60)::bigint
 WHERE "match_key" = '';--> statement-breakpoint

-- Lưới an toàn phát hiện nghi trùng — CỐ Ý không unique.
CREATE INDEX IF NOT EXISTS "bank_txn_match_idx" ON "bank_transactions" USING btree ("match_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_txn_account_idx" ON "bank_transactions" USING btree ("bank_account_id", "txn_at");
