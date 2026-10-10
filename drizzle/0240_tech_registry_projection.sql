-- 0240 · PHÉP CHIẾU SỔ TECH ROOM VÀO /tech (sứ mệnh tech-mission-control).
--
--  · Sổ điều phối kỹ thuật vẫn là nhánh git `ai-control/registry` (CLI `scripts/ai-tech.ts`). Hai bảng dưới đây là ẢNH
--    CHỤP CHỈ ĐỌC để `/tech/missions` và «Cần chủ shop» hiện được sổ — không phải sổ thứ hai (AGENTS.md luật 19). Job
--    `tech-registry-sync` là đường ghi duy nhất; ERP không ghi ngược vào sổ.
--  · `tech_registry_missions`: mỗi `mission.<id>.json` một dòng (khoá `registry_id`); biến khỏi sổ ⇒ `in_registry = false`
--    + `removed_at`, không xoá. `control_state` + `state_since` chỉ để nhận ra một lần CHUYỂN trạng thái (báo Lark đúng một
--    lần — `notified_key`); màn hình tính lại trạng thái lúc đọc.
--  · `tech_registry_events`: `events.ndjson`, chỉ thêm; khoá dòng = băm nội dung ⇒ đọc lại không nhân đôi.
--  · KHÔNG gieo dòng nào. Chỉ CỘNG THÊM. Viết tay, idempotent (ảnh chụp drizzle cũ từ 0032 — không dùng `db:generate`).

CREATE TABLE IF NOT EXISTS "tech_registry_missions" (
	"id" text PRIMARY KEY NOT NULL,
	"registry_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"control_state" text NOT NULL,
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"priority" text DEFAULT 'P2' NOT NULL,
	"risk" text DEFAULT 'MEDIUM' NOT NULL,
	"owner" text DEFAULT '' NOT NULL,
	"branch" text DEFAULT '' NOT NULL,
	"entry" jsonb NOT NULL,
	"blob_sha" text DEFAULT '' NOT NULL,
	"src_updated_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"deploy_check" text DEFAULT '' NOT NULL,
	"deploy_checked_commit" text DEFAULT '' NOT NULL,
	"deploy_checked_at" timestamp with time zone,
	"notified_key" text DEFAULT '' NOT NULL,
	"notified_at" timestamp with time zone,
	"in_registry" boolean DEFAULT true NOT NULL,
	"removed_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_registry_missions_state_check" CHECK ("tech_registry_missions"."control_state" IN ('QUEUED','RUNNING','BLOCKED','WAITING_APPROVAL','COMPLETED','DONE_UNVERIFIED','FAILED','CANCELLED','UNKNOWN')),
	CONSTRAINT "tech_registry_missions_deploy_check" CHECK ("tech_registry_missions"."deploy_check" IN ('','CONTAINED','NOT_CONTAINED')),
	CONSTRAINT "tech_registry_missions_removed_check" CHECK ("tech_registry_missions"."in_registry" = ("tech_registry_missions"."removed_at" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_registry_missions_registry_uq" ON "tech_registry_missions" USING btree ("registry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_registry_missions_state_idx" ON "tech_registry_missions" USING btree ("control_state");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tech_registry_events" (
	"id" text PRIMARY KEY NOT NULL,
	"line_key" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"actor" text DEFAULT '' NOT NULL,
	"mission_id" text DEFAULT '' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_registry_events_line_uq" ON "tech_registry_events" USING btree ("line_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_registry_events_mission_idx" ON "tech_registry_events" USING btree ("mission_id","at");
