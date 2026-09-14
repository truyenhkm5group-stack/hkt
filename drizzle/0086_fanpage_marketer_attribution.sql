-- ═══════ FANPAGE → MARKETER → ĐƠN → DOANH THU XÁC NHẬN ═══════
--
-- CHỈ CỘNG THÊM BA BẢNG. Không đổi kiểu, không xoá cột, không đổi tên, không đụng một dòng dữ liệu
-- nào của `orders` / `shipments` / `ad_spends` / `settings`.
--
-- ĐÁNH SỐ LẠI 0084 → 0086 (14/09/2026): trong lúc nhánh này đang chạy, `main` đã lấy 0084 và 0085
-- cho hai migration khác và chúng đã chạy thật trên máy chủ. Số hiệu của một migration ĐÃ ÁP là
-- bất khả xâm phạm, nên thứ phải dời là cái CHƯA vào main — tức tệp này. Mốc cũng dời lên sau mọi
-- mốc đã có, nếu không drizzle bỏ qua nó trên máy đã chạy hai migration kia.
--
-- Tệp này TỪNG chạy trên production dưới số hiệu 0084 (bản phát hành lúc 15:26). Áp lại dưới số
-- hiệu mới là AN TOÀN và KHÔNG mất dữ liệu, đúng vì mọi câu lệnh ở đây đều idempotent — đó là lý do
-- kho mã này viết migration theo lối ấy.
--
-- Viết tay và idempotent (`IF NOT EXISTS`) như 0033–0085: ảnh chụp (`drizzle/meta/*_snapshot.json`)
-- của kho này đã cũ từ 0032, nên `drizzle-kit generate` sinh ra một bản dựng lại TOÀN BỘ lược đồ —
-- chạy bản đó lên production sẽ hỏng ngay ở câu lệnh đầu tiên.
--
-- ─── VÌ SAO BA BẢNG, KHÔNG PHẢI MỘT ───
--
-- Ba việc rời nhau, và trộn chúng lại là cách làm hỏng lịch sử báo cáo:
--   · `fanpages`                      — page nào tồn tại (khoá là Facebook Page ID, không phải tên);
--   · `fanpage_marketer_assignments`  — ai phụ trách, TỪ KHI NÀO ĐẾN KHI NÀO;
--   · `order_attributions`            — đơn nào đã tính cho ai, BẰNG DÒNG PHÂN CÔNG NÀO.
--
-- Nếu chỉ có một bảng "page → người đang phụ trách" thì ngày shop chuyển fanpage A từ An sang Bình,
-- toàn bộ doanh thu tháng trước của An lặng lẽ chạy sang Bình. Khoảng hiệu lực + ảnh chụp là hai
-- lớp cùng chặn đúng điều đó.
--
-- ─── BẢNG NÀY KHÔNG ĐỤNG TỚI TIỀN THẬT ───
--
-- Quy kết đo ở mốc CHỐT ĐƠN trên Pancake. Nó KHÔNG đọc COD, không đọc bảng kê Viettel Post, không
-- đọc `ORDER_OUTCOME`, và không có đường nào ghi ngược vào tồn kho hay doanh thu giao thành công.
-- Logistics và marketing là hai chiều riêng (AGENTS.md mục 3.1).

-- ───────── 1 · SỔ FANPAGE ─────────
-- Khoá tự nhiên là `external_page_id`. Tên page đổi được bất cứ lúc nào nên nó chỉ là ảnh chụp để
-- người đọc nhận ra, không tham gia phép so khớp nào.
CREATE TABLE IF NOT EXISTS "fanpages" (
  "id" text PRIMARY KEY NOT NULL,
  "external_page_id" text NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "platform" text NOT NULL DEFAULT 'facebook',
  "active" boolean NOT NULL DEFAULT true,
  "first_order_at" timestamp with time zone,
  "last_order_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fanpages_external_uq" ON "fanpages" ("external_page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fanpages_active_idx" ON "fanpages" ("active");--> statement-breakpoint

-- ───────── 2 · SỔ PHÂN CÔNG, CÓ KHOẢNG HIỆU LỰC ─────────
-- `marketer_id` là id nhân sự trong `settings["payroll.employees"]` — CÙNG không gian khoá với
-- `ad_spends.marketer_id`. Không đặt khoá ngoại vì sổ nhân sự nằm trong `settings`, không phải bảng;
-- đặt một khoá ngoại giả sẽ chặn đúng những lượt ghi hợp lệ.
CREATE TABLE IF NOT EXISTS "fanpage_marketer_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "fanpage_id" text NOT NULL,
  "marketer_id" text NOT NULL,
  "effective_from" timestamp with time zone NOT NULL,
  "effective_to" timestamp with time zone,
  "active" boolean NOT NULL DEFAULT true,
  "note" text NOT NULL DEFAULT '',
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "fanpage_marketer_assignments" ADD CONSTRAINT "fanpage_assign_page_fk"
    FOREIGN KEY ("fanpage_id") REFERENCES "fanpages"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Người BẤM NÚT lưu bằng `users.id` (AGENTS.md mục 34). Tài khoản bị xoá ⇒ khoá về NULL, DÒNG PHÂN
-- CÔNG Ở LẠI: xoá nó đi là làm mồ côi mọi đơn đã quy kết bằng nó.
DO $$ BEGIN
  ALTER TABLE "fanpage_marketer_assignments" ADD CONSTRAINT "fanpage_assign_creator_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Khoảng phải có chiều xuôi. Một dòng `to <= from` không mô tả được khoảng thời gian nào cả, nhưng
-- nó vẫn lọt qua mọi phép đọc và âm thầm làm đơn trong khoảng đó mất người phụ trách.
DO $$ BEGIN
  ALTER TABLE "fanpage_marketer_assignments" ADD CONSTRAINT "fanpage_assign_period_check"
    CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "fanpage_marketer_assignments" ADD CONSTRAINT "fanpage_assign_marketer_check"
    CHECK ("marketer_id" <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fanpage_assign_page_idx" ON "fanpage_marketer_assignments" ("fanpage_id", "effective_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fanpage_assign_marketer_idx" ON "fanpage_marketer_assignments" ("marketer_id");--> statement-breakpoint

-- MỘT FANPAGE CHỈ CÓ MỘT DÒNG ĐANG MỞ. Chồng lấn giữa hai khoảng đã đóng được chặn ở tầng ứng dụng
-- (`lib/attribution/fanpage.ts`), nhưng khoảng MỞ là ca duy nhất mà hai lượt ghi chạy song song có
-- thể cùng đọc "chưa có ai" rồi cùng ghi. Chặn ở CSDL là chỗ duy nhất chặn được ca đó.
CREATE UNIQUE INDEX IF NOT EXISTS "fanpage_assign_open_uq"
  ON "fanpage_marketer_assignments" ("fanpage_id")
  WHERE "effective_to" IS NULL AND "active";--> statement-breakpoint

-- ───────── 3 · ẢNH CHỤP QUY KẾT, MỖI ĐƠN ĐÚNG MỘT DÒNG ─────────
-- Bảng riêng chứ không phải cột trên `orders`: `orders` là bảng ĐỒNG BỘ, mỗi lượt
-- `pancake-reconcile` ghi đè cả dòng. Kết quả TÍNH RA không nằm chung chỗ với dữ liệu CHÉP VỀ —
-- cùng lý do và cùng hình dạng với `canonical_order_outcome`.
CREATE TABLE IF NOT EXISTS "order_attributions" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL,
  "source_page_id" text,
  "fanpage_id" text,
  "marketer_id" text,
  "assignment_id" text,
  "status" text NOT NULL,
  "source_order_at" timestamp with time zone NOT NULL,
  "dedupe_key" text,
  "duplicate_of_order_id" text,
  "duplicate_score" integer,
  "duplicate_reason" text,
  "rule_version" integer NOT NULL DEFAULT 1,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_order_fk"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_fanpage_fk"
    FOREIGN KEY ("fanpage_id") REFERENCES "fanpages"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_assignment_fk"
    FOREIGN KEY ("assignment_id") REFERENCES "fanpage_marketer_assignments"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_duplicate_fk"
    FOREIGN KEY ("duplicate_of_order_id") REFERENCES "orders"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Danh sách ĐÓNG, khớp `ATTRIBUTION_STATUSES` ở lib/constants/fanpage-attribution.ts. Ô gõ tự do ở
-- đây là chỗ một chuỗi lạ buộc mã nguồn phải chọn giữa "bỏ đơn khỏi báo cáo" và "tính cho nhầm người".
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_status_check"
    CHECK ("status" IN ('ATTRIBUTED', 'NO_PAGE', 'NO_ASSIGNMENT', 'DUPLICATE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- CHỈ MỘT TÌNH TRẠNG ĐƯỢC MANG TÊN MỘT NGƯỜI. Không có ràng buộc này thì một lỗi lập trình có thể
-- ghi `marketer_id` lên một dòng `DUPLICATE` và doanh thu bị đếm hai lần mà báo cáo trông vẫn bình thường.
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_marketer_check"
    CHECK (("status" = 'ATTRIBUTED') = ("marketer_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Ngược lại: chỉ dòng `DUPLICATE` mới được trỏ về một đơn khác, và nó BẮT BUỘC phải trỏ. Một dòng
-- "trùng đơn" không nói được trùng với đơn nào là một kết luận không kiểm chứng được.
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_duplicate_check"
    CHECK (("status" = 'DUPLICATE') = ("duplicate_of_order_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- CĂN CỨ ĐI CÙNG KẾT LUẬN. Một dòng "trùng đơn" đang lấy doanh thu khỏi tên một người thật; không
-- lưu điểm chứng cứ thì sáu tháng sau không ai kiểm chứng được, và người bị mất đơn không có gì để cãi.
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_evidence_check"
    CHECK (("status" = 'DUPLICATE') = ("duplicate_score" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Đơn không được trùng với chính nó — một chuỗi trùng đơn tự trỏ vào mình là một vòng lặp vô tận
-- cho mọi phép truy ngược.
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_self_check"
    CHECK ("duplicate_of_order_id" IS NULL OR "duplicate_of_order_id" <> "order_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- KHOÁ DUY NHẤT TRÊN `order_id` LÀ THỨ LÀM PHÉP ĐỐI SOÁT IDEMPOTENT: chạy lại bao nhiêu lần cũng
-- chỉ có một dòng cho mỗi đơn, nên không có đường nào để doanh thu bị cộng hai lần.
CREATE UNIQUE INDEX IF NOT EXISTS "order_attribution_order_uq" ON "order_attributions" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_attribution_marketer_idx" ON "order_attributions" ("marketer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_attribution_page_idx" ON "order_attributions" ("source_page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_attribution_status_idx" ON "order_attributions" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_attribution_dedupe_idx" ON "order_attributions" ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_attribution_version_idx" ON "order_attributions" ("rule_version");
