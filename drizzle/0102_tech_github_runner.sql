-- ═══════════ PHASE 2A · ĐỌC DEPLOY TỪ GITHUB + CÂY LÀM VIỆC CỦA AGENT ═══════════
--
-- VÌ SAO. Phase 1 để `tech_deployments` phải GHI TAY, và đó là rủi ro số 1 đã nêu trong
-- `docs/ai-tech-department-phase1.md`: "Deploy hôm nay" chỉ đúng bằng mức người ta chịu ghi.
-- Bản này cho ERP ĐỌC LẠI lượt chạy workflow. GitHub Actions vẫn là bên CÓ THẨM QUYỀN — ERP không
-- kích hoạt, không dừng, không đổi được một lượt deploy nào.
--
-- BA CHIỀU KHÔNG GỘP. Một lượt deploy có ba câu hỏi khác nhau, và bản này cho mỗi câu một cột:
--   · GitHub nói gì            → `status` + `external_conclusion` (chữ nguyên văn)
--   · production đang chạy gì  → `production_commit`
--   · hai cái đó khớp không    → `verification`
-- Workflow xanh KHÔNG chứng minh máy chủ đang chạy bản đó; `deploy-vps.yml` đã phải thêm hẳn một
-- bước đối chiếu commit vì lý do ấy. Gộp ba thứ thành một cờ là xoá mất bài học đó.
--
-- `SUPERSEDED` tách khỏi `MISMATCH` có chủ đích: mọi lượt deploy cũ đều "không khớp" với bản đang
-- chạy, và tô đỏ tất cả là dạy người đọc bỏ qua màu đỏ. Chỉ lượt THÀNH CÔNG MỚI NHẤT mà lệch mới
-- là chuông báo.
--
-- CÂY LÀM VIỆC CỦA AGENT: AGENTS.md mục 9 — mỗi phiên một cây, một nhánh. Hai lượt chạy dùng chung
-- một thư mục là thứ đã làm `main` đỏ bốn lần trong một buổi chiều. `heartbeat_at` để một tiến
-- trình chết giữa chừng trở thành CŨ thay vì nằm mãi ở "đang chạy" và làm thẻ đếm nói dối.
--
-- CHỈ CỘNG THÊM: 10 cột có mặc định + 1 chỉ mục duy nhất CÓ ĐIỀU KIỆN + 2 ràng buộc CHECK.
-- KHÔNG sửa cột nào đang có, KHÔNG backfill một dòng nào. Dòng gõ tay của Phase 1 giữ nguyên
-- `provider = 'MANUAL'` và `verification = 'UNKNOWN'` — chúng CHƯA từng được đối chiếu, và khai
-- chúng là 'VERIFIED' sẽ là bịa ra một phép đo chưa ai thực hiện.
-- Viết tay và idempotent như 0033–0101.

ALTER TABLE "tech_deployments" ADD COLUMN IF NOT EXISTS "provider" text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_deployments" ADD COLUMN IF NOT EXISTS "workflow" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_deployments" ADD COLUMN IF NOT EXISTS "external_run_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_deployments" ADD COLUMN IF NOT EXISTS "external_run_attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_deployments" ADD COLUMN IF NOT EXISTS "external_conclusion" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_deployments" ADD COLUMN IF NOT EXISTS "production_commit" text;--> statement-breakpoint
ALTER TABLE "tech_deployments" ADD COLUMN IF NOT EXISTS "verification" text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_deployments" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "tech_agent_runs" ADD COLUMN IF NOT EXISTS "worktree" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_agent_runs" ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp with time zone;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "tech_deployments" ADD CONSTRAINT "tech_deployments_provider_check" CHECK ("tech_deployments"."provider" IN ('MANUAL','GITHUB_ACTIONS'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_deployments" ADD CONSTRAINT "tech_deployments_verification_check" CHECK ("tech_deployments"."verification" IN ('UNKNOWN','VERIFIED','MISMATCH','SUPERSEDED'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- MỘT LƯỢT CHẠY GITHUB = MỘT DÒNG. Điều kiện `<> ''` là bắt buộc: dòng gõ tay mang khoá rỗng và
-- phải được phép trùng nhau, nếu không người chỉ ghi tay được đúng một lần.
CREATE UNIQUE INDEX IF NOT EXISTS "tech_deployments_external_uq" ON "tech_deployments" USING btree ("provider","external_run_id","external_run_attempt") WHERE "external_run_id" <> '';
