-- ═══════════ SỔ LƯỢT GHI NGÂN SÁCH QUẢNG CÁO — CÓ TRƯỚC LỜI GỌI ĐẦU TIÊN ═══════════
--
-- Hàng rào và mọi con số: `lib/constants/ads-write.ts`. Đặc tả: `docs/marketing-ai-department.md` mục 5.
-- Chủ shop duyệt 22/09/2026, ở nấc `COPILOT`: agent ĐỀ NGHỊ, người bấm xác nhận thì ERP mới gọi Facebook.
--
-- ─── VÌ SAO SỔ PHẢI CÓ TRƯỚC, KHÔNG PHẢI "THÊM SAU KHI CHẠY ỔN" ───
--
-- Mọi lớp sai của một cỗ máy tiêu tiền đều có cùng hình dạng: nó làm đúng thứ được bảo, rất nhanh,
-- rất nhiều lần. Sáng hôm sau không ai dựng lại được ngân sách cũ nếu không ai ghi lại nó. Cột
-- `budget_before` là thứ duy nhất cho phép quay lui, và nó chỉ tồn tại nếu bảng này có TRƯỚC.
--
-- ─── LƯỢT BỊ CHẶN CŨNG VÀO SỔ ───
--
-- "Máy đã ĐỊNH làm gì" là thông tin quý nhất khi đánh giá một cỗ máy tự chủ. Một sổ chỉ ghi lượt
-- thành công sẽ khiến một luật sai trông như một luật thận trọng: nó xin sai hai mươi lần mỗi ngày,
-- hàng rào chặn hết, và không ai biết để đi sửa luật.
--
-- ─── THUẦN BỔ SUNG, VÀ VÔ HẠI KHI ĐƯỜNG GHI CÒN TẮT ───
--
-- Không câu lệnh nào đụng bảng đang chạy. Đường ghi tắt mặc định (`ADS_WRITE_ENABLED` phải đúng
-- chuỗi "true"), nên tới khi chủ shop bật thì bảng này rỗng — và một bảng rỗng không làm gì cả.

CREATE TABLE IF NOT EXISTS "ads_budget_changes" (
  "id" text PRIMARY KEY NOT NULL,
  "change_day" text NOT NULL,
  "campaign_id" text NOT NULL,
  "campaign_name" text DEFAULT '' NOT NULL,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "denial" text DEFAULT '' NOT NULL,
  "detail" text DEFAULT '' NOT NULL,
  "decision" text NOT NULL,
  "ledger_id" text,
  "held_days" integer DEFAULT 0 NOT NULL,
  "budget_before" integer,
  "budget_after" integer,
  "profit_before" integer,
  "actor_user_id" text,
  "actor_email" text DEFAULT '' NOT NULL,
  "mode" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ads_budget_changes_outcome_check" CHECK ("outcome" IN ('APPLIED', 'DENIED', 'FAILED')),
  CONSTRAINT "ads_budget_changes_action_check" CHECK ("action" IN ('SET_DAILY_BUDGET', 'PAUSE_CAMPAIGN')),
  CONSTRAINT "ads_budget_changes_day_format_check" CHECK ("change_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  -- Một dòng vừa APPLIED vừa mang mã chặn là một dòng không ai đọc được, và nó làm mọi phép đếm nói sai.
  CONSTRAINT "ads_budget_changes_denial_check" CHECK ("outcome" <> 'APPLIED' OR "denial" = '')
);--> statement-breakpoint

-- Xoá dòng sổ quyết định KHÔNG được cuốn theo bằng chứng một lượt ghi đã xảy ra: lượt ghi ấy là
-- chuyện đã rồi, và mất nó là mất cả khả năng quay lui lẫn mẫu số của phanh.
DO $$ BEGIN
  ALTER TABLE "ads_budget_changes" ADD CONSTRAINT "ads_budget_changes_ledger_id_fk"
    FOREIGN KEY ("ledger_id") REFERENCES "ads_decision_ledger"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "ads_budget_changes" ADD CONSTRAINT "ads_budget_changes_actor_user_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ads_budget_changes_day_idx" ON "ads_budget_changes" ("change_day","outcome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_budget_changes_campaign_idx" ON "ads_budget_changes" ("campaign_id","change_day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_budget_changes_actor_idx" ON "ads_budget_changes" ("actor_user_id","created_at");
