-- ═══════════ HẠ HẠT CHI TIÊU QUẢNG CÁO XUỐNG CẤP MẨU ═══════════
--
-- Đặc tả: `docs/ads-measurement-audit-2026-09-22.md` mục 4.
--
-- ─── VÌ SAO ───
--
-- Đo production 22/09/2026: `fb_ads` có 185 dòng trong khi 30 ngày có 1.096 chiến dịch tiêu tiền,
-- và chi tiêu chỉ tồn tại ở cấp CHIẾN DỊCH. Hệ quả: hai tab "Nhóm quảng cáo" và "Mẩu quảng cáo"
-- trên /ads là hai bảng tra cứu, không phải bảng điều khiển — không tiền thì không ROAS, không
-- %CPQC, không lợi nhuận.
--
-- Đọc insights ở `level=ad` sửa cả hai chuyện cùng lúc: có tiền ở cả ba cấp, VÀ có cây
-- ad → adset → campaign cho mọi mẩu đã tiêu tiền (bộ tra danh mục cũ đi từ ĐƠN ra nên không bao
-- giờ biết một mẩu chưa đẻ ra đơn nào).
--
-- ─── ĐIỀU NGUY HIỂM NHẤT, VÀ CÁCH NÓ ĐƯỢC CHẶN ───
--
-- `ad_spends` là nguồn thẩm quyền của tiền quảng cáo trong mọi báo cáo lợi nhuận, lương và
-- marketer (AGENTS.md mục 15). THÊM dòng cấp mẩu mà QUÊN bỏ dòng cấp chiến dịch là nhân đôi toàn
-- bộ chi phí quảng cáo.
--
-- Cột `grain` làm điều đó KIỂM CHỨNG ĐƯỢC thay vì phải tin: mỗi (tài khoản × ngày) chỉ được mang
-- MỘT hạt, và đường ghi bảo đảm bằng XOÁ-RỒI-GHI trong một giao dịch. Hai hạt cùng tồn tại trong
-- BẢNG là bình thường (ngày cũ ngoài cửa sổ đồng bộ mãi mãi ở hạt CAMPAIGN); hai hạt cùng tồn tại
-- trong MỘT NGÀY thì không.
--
-- ─── THUẦN BỔ SUNG ───
--
-- Mọi dòng đang có nhận `grain = 'CAMPAIGN'` — đúng sự thật về chúng, không phải một phép đoán.
-- Dòng nhập tay (`external_key IS NULL`) nhận `MANUAL`: chúng không đến từ Facebook và đường ghi
-- KHÔNG BAO GIỜ được xoá chúng.
--
-- Không câu lệnh nào đụng tới `spend`, nên không một con số tiền nào đổi khi migration này chạy.

ALTER TABLE "ad_spends" ADD COLUMN IF NOT EXISTS "grain" text DEFAULT 'CAMPAIGN' NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN IF NOT EXISTS "adset_id" text;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN IF NOT EXISTS "adset_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN IF NOT EXISTS "ad_id" text;--> statement-breakpoint
ALTER TABLE "ad_spends" ADD COLUMN IF NOT EXISTS "ad_name" text DEFAULT '' NOT NULL;--> statement-breakpoint

-- Dòng GÕ TAY khai đúng nguồn của nó. Đây KHÔNG phải backfill một điều chưa biết: `external_key`
-- rỗng nghĩa là không lượt đồng bộ nào tạo ra nó, và đó là định nghĩa của dòng nhập tay.
UPDATE "ad_spends" SET "grain" = 'MANUAL' WHERE "external_key" IS NULL AND "grain" = 'CAMPAIGN';--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "ad_spends" ADD CONSTRAINT "ad_spends_grain_check" CHECK ("grain" IN ('CAMPAIGN', 'AD', 'MANUAL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Hạt AD mà không có mã mẩu là dòng tự mâu thuẫn: rơi khỏi mọi phép gộp cấp mẩu trong khi vẫn được
-- cộng vào tổng — mất dấu tiền ở đúng cấp vừa dựng ra để nhìn thấy nó.
DO $$ BEGIN
  ALTER TABLE "ad_spends" ADD CONSTRAINT "ad_spends_ad_grain_check" CHECK ("grain" <> 'AD' OR "ad_id" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ad_spends_adset_idx" ON "ad_spends" ("adset_id","spend_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_spends_ad_idx" ON "ad_spends" ("ad_id","spend_date");
