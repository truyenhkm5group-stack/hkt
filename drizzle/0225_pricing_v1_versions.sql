-- 0225 · BẢNG GIÁ CÓ PHIÊN BẢN + GIÁ V1 CHỐT ĐƠN TỰ ĐỘNG (docs/saas/PRICING_V1.md) — MỞ RỘNG 0187 · 0192 · 0194 · 0223 · 0224.
--
--  · `platform_price_versions`: một PHIÊN BẢN bảng giá. `LEGACY_SNAPSHOT` = ảnh chụp giá ĐANG THU lúc migration này chạy (chỉ
--    tới được bằng ghim, không bao giờ là "giá hiện hành"); `CATALOG` = bảng giá niêm yết, hiệu lực từ `effective_from`. Giá
--    tương lai đổi = THÊM phiên bản mới — không sửa dòng cũ (lịch sử tái lập được).
--  · `platform_plan_prices`: giá của MỘT gói trong MỘT phiên bản — giá tháng, giá NĂM TƯỜNG MINH (NULL = theo
--    `yearly_free_months` như 0194), "từ …" của gói hợp đồng, hạn mức gồm (khách AI · fanpage · người dùng · fair-use hội
--    thoại / trả lời AI · đơn), đơn giá vượt theo khối khách AI, đơn giá fanpage / người dùng thêm, tính năng, giá mua thêm
--    cũ (0192). Dòng LEGACY chép NGUYÊN `platform_plans` (giá, tặng tháng, mua thêm, limits, commercial) — số tiền khách
--    đang trả không đổi sau deploy.
--  · `platform_price_pins`: tổ chức đang ở phiên bản nào. MỌI tổ chức có từ trước migration này ⇒ ghim `legacy`. Tổ chức
--    không có ghim (tạo sau) ⇒ theo phiên bản CATALOG đang hiệu lực, và được ghim khi hoá đơn đầu tiên được trả.
--  · `platform_invoices.price_version_key`: hoá đơn tính theo phiên bản nào (NULL = trước 0225 = legacy).
--  · Gói MỚI trong `platform_plans`: `inbox` (KHÔNG có AI bán hàng) và `scale` — chỉ là DANH TÍNH gói + hạn mức kỹ thuật
--    (`checkEntitlement`); giá của chúng nằm ở phiên bản. Credit AI nền tảng của hai gói mới = 0 (credit là quyết định của chủ
--    nền tảng, 0194 — chưa khai cho gói mới ⇒ AI chạy bằng khoá của tổ chức). Gói cũ (basic · pro · standard · internal…) GIỮ NGUYÊN.
--  · Mốc đồng hồ khách AI bắt đầu ghi = `created_at` của phiên bản CATALOG đầu tiên (dòng V1 do chính migration này ghi,
--    cùng lần deploy với mã ghi đồng hồ) — kỳ bắt đầu trước mốc này là kỳ đo CHƯA TRỌN (cận dưới, không tính phần vượt).
--    Không gieo dòng `platform_settings` nào (ghi đè tay vẫn được ở `platform.pricing.ai-customer-meter-live-at`).
--  · Không bật trần cứng nào, không đổi `grandfathered`, không gán gói cho tổ chức nhà (việc của người vận hành — đường chạy
--    thử `scripts/ops/pricing-internal-fit.ts`). Thuế: `tax_mode = 'UNDECLARED'` — không giả định VAT.
--  · Mặt phẳng điều khiển: chỉ thật ở CSDL NHÀ (xoá ở CSDL tổ chức — db/migrate.ts). Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "platform_price_versions" (
  "key" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "kind" text NOT NULL,
  "effective_from" timestamp with time zone,
  "tax_mode" text DEFAULT 'UNDECLARED' NOT NULL,
  "tax_note" text,
  "alert_thresholds" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "note" text,
  "created_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_price_versions_key_check" CHECK ("key" ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  CONSTRAINT "platform_price_versions_kind_check" CHECK ("kind" IN ('LEGACY_SNAPSHOT','CATALOG')),
  CONSTRAINT "platform_price_versions_effective_check" CHECK (("kind" = 'CATALOG') = ("effective_from" IS NOT NULL)),
  CONSTRAINT "platform_price_versions_tax_check" CHECK ("tax_mode" IN ('UNDECLARED','EXCLUSIVE','INCLUSIVE'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_plan_prices" (
  "version_key" text NOT NULL REFERENCES "platform_price_versions"("key"),
  "plan_key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "position" integer DEFAULT 0 NOT NULL,
  "listed" boolean DEFAULT false NOT NULL,
  "highlight" boolean DEFAULT false NOT NULL,
  "contact_sales" boolean DEFAULT false NOT NULL,
  "monthly_vnd" bigint,
  "yearly_vnd" bigint,
  "yearly_free_months" integer DEFAULT 0 NOT NULL,
  "price_from_vnd" bigint,
  "trial_days" integer,
  "included" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "overage" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "features" jsonb,
  "addon_prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "commercial" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "platform_plan_prices_pk" PRIMARY KEY ("version_key", "plan_key"),
  CONSTRAINT "platform_plan_prices_amount_check" CHECK (("monthly_vnd" IS NULL OR "monthly_vnd" > 0) AND ("yearly_vnd" IS NULL OR "yearly_vnd" > 0) AND ("price_from_vnd" IS NULL OR "price_from_vnd" > 0)),
  CONSTRAINT "platform_plan_prices_free_months_check" CHECK ("yearly_free_months" BETWEEN 0 AND 6),
  CONSTRAINT "platform_plan_prices_trial_check" CHECK ("trial_days" IS NULL OR "trial_days" BETWEEN 1 AND 90)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_price_pins" (
  "org_code" text PRIMARY KEY NOT NULL,
  "version_key" text NOT NULL REFERENCES "platform_price_versions"("key"),
  "source" text NOT NULL,
  "reason" text,
  "pinned_by_email" text,
  "pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_price_pins_source_check" CHECK ("source" IN ('MIGRATION_0225','INVOICE_PAID','OPERATOR','TEST'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_price_pins_version_idx" ON "platform_price_pins" ("version_key");--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD COLUMN IF NOT EXISTS "price_version_key" text;--> statement-breakpoint

-- ── Phiên bản LEGACY: chụp ĐÚNG giá đang thu hôm nay từ `platform_plans` (mọi gói, kể cả gói không bán). ──
INSERT INTO "platform_price_versions" ("key", "label", "kind", "effective_from", "tax_mode", "note")
VALUES ('legacy', 'Giá cũ (trước V1 · chụp lúc 0225)', 'LEGACY_SNAPSHOT', NULL, 'UNDECLARED', '0225: ảnh chụp platform_plans lúc migration — thuê bao có từ trước giữ nguyên số tiền đang trả')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_plan_prices" ("version_key", "plan_key", "name", "description", "position", "listed", "highlight", "contact_sales", "monthly_vnd", "yearly_vnd", "yearly_free_months", "price_from_vnd", "trial_days", "included", "overage", "features", "addon_prices", "limits", "commercial")
SELECT 'legacy', p."key", p."name", p."description", p."position", false,
       coalesce(p."commercial" ->> 'highlight', 'false') = 'true',
       coalesce(p."commercial" ->> 'contactSales', 'false') = 'true',
       CASE WHEN p."price_vnd" > 0 THEN p."price_vnd" ELSE NULL END,
       NULL,
       least(greatest(coalesce(p."yearly_free_months", 0), 0), 6),
       NULL, NULL,
       (CASE WHEN p."limits" ? 'users' THEN jsonb_build_object('users', p."limits" -> 'users') ELSE '{}'::jsonb END)
         || (CASE WHEN (p."commercial" -> 'quotas') ? 'fanpages' THEN jsonb_build_object('fanpages', p."commercial" -> 'quotas' -> 'fanpages') ELSE '{}'::jsonb END)
         || (CASE WHEN (p."commercial" -> 'quotas') ? 'aiConversations' THEN jsonb_build_object('aiConversations', p."commercial" -> 'quotas' -> 'aiConversations') ELSE '{}'::jsonb END)
         || (CASE WHEN (p."commercial" -> 'quotas') ? 'aiMessages' THEN jsonb_build_object('aiReplies', p."commercial" -> 'quotas' -> 'aiMessages') ELSE '{}'::jsonb END)
         || (CASE WHEN (p."commercial" -> 'quotas') ? 'orders' THEN jsonb_build_object('orders', p."commercial" -> 'quotas' -> 'orders') ELSE '{}'::jsonb END),
       '{"mode":"NONE"}'::jsonb,
       p."commercial" -> 'features',
       p."addon_prices", p."limits", p."commercial"
FROM "platform_plans" p
ON CONFLICT ("version_key", "plan_key") DO NOTHING;--> statement-breakpoint

-- ── Gói mới: danh tính + hạn mức KỸ THUẬT (checkEntitlement đọc platform_plans). Giá của chúng chỉ ở phiên bản. ──
INSERT INTO "platform_plans" ("key", "name", "description", "limits", "position", "price_vnd", "yearly_free_months", "commercial") VALUES
  ('inbox', 'Inbox', 'Hộp thư hợp nhất cho fanpage — nhân viên trả lời tay, chưa có AI bán hàng.', '{"users":3,"pages":5,"objects":2,"records":2000,"workflows":5,"aiDraftsPerDay":10,"storageMb":512,"ai":{"requestsPerDay":20,"requestsPerMonth":300,"costUsdPerMonth":{"soft":15,"hard":30},"platformCreditUsdPerMonth":0}}'::jsonb, 11, NULL, 2,
   '{"publicListed":false,"contactSales":false,"quotas":{"fanpages":3,"aiConversations":0,"aiMessages":0,"orders":null},"features":["multi_page_inbox","human_handoff","analytics","multi_user"],"overage":{"policy":"SOFT_ONLY","unitPricesVnd":{},"graceAllowancePct":0},"limitModes":{}}'::jsonb),
  ('scale', 'Scale', 'Chuỗi / nhiều fanpage: 30 fanpage, 7.500 khách AI mỗi tháng.', '{"users":25,"pages":100,"objects":40,"records":150000,"workflows":100,"aiDraftsPerDay":150,"storageMb":20480,"ai":{"requestsPerDay":300,"requestsPerMonth":6000,"costUsdPerMonth":{"soft":300,"hard":600},"platformCreditUsdPerMonth":0}}'::jsonb, 36, NULL, 2,
   '{"publicListed":false,"contactSales":false,"quotas":{"fanpages":30,"aiConversations":30000,"aiMessages":200000,"orders":null},"features":["ai_sales","multi_page_inbox","ai_order_creation","upsell","cross_sell","follow_up","human_handoff","analytics","advanced_analytics","custom_ai_training","api","webhook","multi_user"],"overage":{"policy":"SOFT_ONLY","unitPricesVnd":{},"graceAllowancePct":0},"limitModes":{}}'::jsonb)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

-- ── Phiên bản V1 (chủ shop chốt 07/10/2026 — docs/saas/PRICING_V1.md). Ngưỡng cảnh báo 80 · 100 · 120 · 150. ──
INSERT INTO "platform_price_versions" ("key", "label", "kind", "effective_from", "tax_mode", "tax_note", "alert_thresholds", "note")
VALUES ('v1-2026-10', 'Chốt Đơn Tự Động V1 (07/10/2026)', 'CATALOG', '2026-10-06T17:00:00Z', 'UNDECLARED', 'Giá chưa áp thuế — không giả định VAT cho tới khi cấu hình thuế được khai.', '{"notifyPct":80,"overagePct":100,"strongPct":120,"reviewPct":150}'::jsonb, 'Quyết định kinh doanh chính thức của chủ shop 07/10/2026')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_plan_prices" ("version_key", "plan_key", "name", "description", "position", "listed", "highlight", "contact_sales", "monthly_vnd", "yearly_vnd", "yearly_free_months", "price_from_vnd", "trial_days", "included", "overage", "features", "addon_prices", "limits", "commercial") VALUES
  ('v1-2026-10', 'trial', 'Dùng thử', 'Dùng thử 7 ngày, miễn phí: một fanpage, 100 khách AI.', 10, true, false, false, NULL, NULL, 0, NULL, 7,
   '{"aiCustomers":100,"fanpages":1,"users":2,"aiConversations":300,"aiReplies":2000,"orders":null}'::jsonb, '{"mode":"NONE"}'::jsonb,
   '["ai_sales","ai_order_creation","follow_up","human_handoff","analytics","multi_user"]'::jsonb, '{}'::jsonb, '{"users":2}'::jsonb,
   '{"publicListed":true,"contactSales":false,"quotas":{"fanpages":1,"aiConversations":300,"aiMessages":2000,"orders":null},"features":["ai_sales","ai_order_creation","follow_up","human_handoff","analytics","multi_user"],"overage":{"policy":"SOFT_ONLY","unitPricesVnd":{},"graceAllowancePct":0},"limitModes":{}}'::jsonb),
  ('v1-2026-10', 'inbox', 'Inbox', 'Hộp thư hợp nhất cho fanpage — nhân viên trả lời tay, chưa có AI bán hàng.', 11, true, false, false, 299000, 2990000, 2, NULL, NULL,
   '{"aiCustomers":0,"fanpages":3,"users":3,"aiConversations":0,"aiReplies":0,"orders":null}'::jsonb, '{"mode":"BILLED","extraFanpageVnd":99000,"extraUserVnd":49000}'::jsonb,
   '["multi_page_inbox","human_handoff","analytics","multi_user"]'::jsonb, '{}'::jsonb, '{"users":3}'::jsonb,
   '{"publicListed":true,"contactSales":false,"quotas":{"fanpages":3,"aiConversations":0,"aiMessages":0,"orders":null},"features":["multi_page_inbox","human_handoff","analytics","multi_user"],"overage":{"policy":"SOFT_ONLY","unitPricesVnd":{},"graceAllowancePct":0},"limitModes":{}}'::jsonb),
  ('v1-2026-10', 'starter', 'Starter', 'Shop đang bán đều trên vài fanpage: 1.500 khách AI mỗi tháng.', 20, true, false, false, 790000, 7900000, 2, NULL, NULL,
   '{"aiCustomers":1500,"fanpages":3,"users":5,"aiConversations":4500,"aiReplies":30000,"orders":null}'::jsonb, '{"mode":"BILLED","aiCustomerBlockSize":100,"aiCustomerBlockVnd":59000,"extraFanpageVnd":99000,"extraUserVnd":49000}'::jsonb,
   '["ai_sales","multi_page_inbox","ai_order_creation","upsell","follow_up","human_handoff","analytics","multi_user"]'::jsonb, '{}'::jsonb, '{"users":5}'::jsonb,
   '{"publicListed":true,"contactSales":false,"quotas":{"fanpages":3,"aiConversations":4500,"aiMessages":30000,"orders":null},"features":["ai_sales","multi_page_inbox","ai_order_creation","upsell","follow_up","human_handoff","analytics","multi_user"],"overage":{"policy":"SOFT_ONLY","unitPricesVnd":{},"graceAllowancePct":0},"limitModes":{}}'::jsonb),
  ('v1-2026-10', 'growth', 'Growth', 'Phổ biến nhất: 10 fanpage, 3.000 khách AI mỗi tháng.', 30, true, true, false, 1490000, 14900000, 2, NULL, NULL,
   '{"aiCustomers":3000,"fanpages":10,"users":10,"aiConversations":10000,"aiReplies":75000,"orders":null}'::jsonb, '{"mode":"BILLED","aiCustomerBlockSize":100,"aiCustomerBlockVnd":49000,"extraFanpageVnd":99000,"extraUserVnd":49000}'::jsonb,
   '["ai_sales","multi_page_inbox","ai_order_creation","upsell","cross_sell","follow_up","human_handoff","analytics","advanced_analytics","custom_ai_training","webhook","multi_user"]'::jsonb, '{}'::jsonb, '{"users":10}'::jsonb,
   '{"publicListed":true,"contactSales":false,"highlight":true,"quotas":{"fanpages":10,"aiConversations":10000,"aiMessages":75000,"orders":null},"features":["ai_sales","multi_page_inbox","ai_order_creation","upsell","cross_sell","follow_up","human_handoff","analytics","advanced_analytics","custom_ai_training","webhook","multi_user"],"overage":{"policy":"SOFT_ONLY","unitPricesVnd":{},"graceAllowancePct":0},"limitModes":{}}'::jsonb),
  ('v1-2026-10', 'scale', 'Scale', 'Chuỗi / nhiều fanpage: 30 fanpage, 7.500 khách AI mỗi tháng.', 36, true, false, false, 2990000, 29900000, 2, NULL, NULL,
   '{"aiCustomers":7500,"fanpages":30,"users":25,"aiConversations":30000,"aiReplies":200000,"orders":null}'::jsonb, '{"mode":"BILLED","aiCustomerBlockSize":100,"aiCustomerBlockVnd":39000,"extraFanpageVnd":99000,"extraUserVnd":49000}'::jsonb,
   '["ai_sales","multi_page_inbox","ai_order_creation","upsell","cross_sell","follow_up","human_handoff","analytics","advanced_analytics","custom_ai_training","api","webhook","multi_user"]'::jsonb, '{}'::jsonb, '{"users":25}'::jsonb,
   '{"publicListed":true,"contactSales":false,"quotas":{"fanpages":30,"aiConversations":30000,"aiMessages":200000,"orders":null},"features":["ai_sales","multi_page_inbox","ai_order_creation","upsell","cross_sell","follow_up","human_handoff","analytics","advanced_analytics","custom_ai_training","api","webhook","multi_user"],"overage":{"policy":"SOFT_ONLY","unitPricesVnd":{},"graceAllowancePct":0},"limitModes":{}}'::jsonb),
  ('v1-2026-10', 'enterprise', 'Enterprise', 'Hợp đồng riêng: 20.000–30.000+ khách AI, fanpage / người dùng / fair-use tuỳ chỉnh.', 40, true, false, true, NULL, NULL, 0, 5990000, NULL,
   '{"aiCustomers":null,"fanpages":null,"users":null,"aiConversations":null,"aiReplies":null,"orders":null}'::jsonb, '{"mode":"CONTRACT"}'::jsonb,
   '["ai_sales","multi_page_inbox","ai_order_creation","upsell","cross_sell","follow_up","human_handoff","analytics","advanced_analytics","custom_ai_training","api","webhook","multi_user"]'::jsonb, '{}'::jsonb, '{"users":null}'::jsonb,
   '{"publicListed":true,"contactSales":true,"quotas":{"fanpages":null,"aiConversations":null,"aiMessages":null,"orders":null},"features":["ai_sales","multi_page_inbox","ai_order_creation","upsell","cross_sell","follow_up","human_handoff","analytics","advanced_analytics","custom_ai_training","api","webhook","multi_user"],"overage":{"policy":"SOFT_ONLY","unitPricesVnd":{},"graceAllowancePct":0},"limitModes":{}}'::jsonb)
ON CONFLICT ("version_key", "plan_key") DO NOTHING;--> statement-breakpoint

-- ── Ghim MỌI tổ chức có từ trước vào `legacy` (kể cả nhà — gán nhà vào gói thường là việc tay, có chạy thử). ──
INSERT INTO "platform_price_pins" ("org_code", "version_key", "source", "reason")
SELECT o."code", 'legacy', 'MIGRATION_0225', '0225: tổ chức có từ trước bảng giá V1 — giữ nguyên giá đang thu'
FROM "platform_organizations" o
ON CONFLICT ("org_code") DO NOTHING;
