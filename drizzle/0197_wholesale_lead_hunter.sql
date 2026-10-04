-- 0197 · SĂN KHÁCH SỈ (module `wholesale_leads` — docs/verticals/wholesale-lead-hunter.md).
--
--  · HAI LOẠI DỮ LIỆU, HAI BẢNG. `wholesale_place_snapshots` giữ trường NGUỒN GOOGLE (tên, địa chỉ, SĐT, website, sao…)
--    và khoá khử trùng DẪN XUẤT từ chúng (SĐT chuẩn hoá, tên miền, tên + địa chỉ) kèm `expires_at` — hết hạn mà không làm mới thì job xoá trắng các trường nội dung, chỉ giữ Place ID (điều khoản
--    Google Maps Platform cho lưu Place ID lâu dài, nội dung thì không). `wholesale_leads` là dữ liệu CỦA HSLC: trạng
--    thái bán hàng, người phụ trách, ghi chú, điểm, cơ hội, khách đã chuyển đổi — và các trường liên hệ chỉ khi chúng
--    đến từ nguồn KHÔNG phải Google (nhân viên nhập / xác minh qua cuộc gọi, tệp nhập tay, website của chính doanh nghiệp).
--  · Khử trùng: `place_id` UNIQUE ở cả hai bảng (NULL của lead nhập tay khác nhau theo luật Postgres) ⇒ quét cùng một địa điểm 10 lần vẫn MỘT lead, kể cả khi hai lượt chạy song song.
--  · Bộ phủ: `wholesale_search_cells` (từ khoá × tỉnh × khu vực, toàn cục) + `wholesale_campaign_cells` (hàng đợi của
--    từng chiến dịch, có khoá thuê `locked_until` để lượt chạy chết giữa chừng không giữ ô mãi; tạm dừng / tiếp tục
--    không mất tiến độ vì tiến độ nằm ở từng dòng, kể cả `page_token` của trang kế).
--  · `wholesale_api_usage`: mỗi lượt gọi API một dòng — chi phí ước tính (micro-USD), thời gian, số kết quả. Trần ngân
--    sách đọc từ đây TRƯỚC mỗi lượt gọi.
--  · `wholesale_suppressions`: danh sách KHÔNG LIÊN HỆ — khoá theo SĐT chuẩn hoá / tên miền / Place ID; lead khớp không
--    bao giờ được đưa lại vào chiến dịch hay hàng đợi liên hệ.
--  · Module MỚI mặc định TẮT ở tổ chức nhà (như 0180 / 0190). CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "wholesale_campaigns" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "product_focus" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "pause_reason" text,
  "is_template" boolean DEFAULT false NOT NULL,
  "template_key" text,
  "provinces" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "keyword_groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "exclude_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
  "target_segments" text[] DEFAULT '{}'::text[] NOT NULL,
  "max_leads" integer DEFAULT 500 NOT NULL,
  "min_rating" double precision,
  "min_reviews" integer,
  "require_phone" boolean DEFAULT true NOT NULL,
  "require_website" boolean DEFAULT false NOT NULL,
  "search_mode" text DEFAULT 'TEXT' NOT NULL,
  "nearby_lat" double precision,
  "nearby_lng" double precision,
  "radius_m" integer,
  "discovery_tier" text DEFAULT 'PRO' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "started_at" timestamp with time zone,
  "paused_at" timestamp with time zone,
  "stopped_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "last_tick_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_campaigns_status_check" CHECK ("status" IN ('DRAFT','RUNNING','PAUSED','STOPPED','COMPLETED')),
  CONSTRAINT "wholesale_campaigns_mode_check" CHECK ("search_mode" IN ('TEXT','NEARBY')),
  CONSTRAINT "wholesale_campaigns_tier_check" CHECK ("discovery_tier" IN ('IDS_ONLY','PRO','ENTERPRISE')),
  CONSTRAINT "wholesale_campaigns_name_check" CHECK (length(btrim("name")) BETWEEN 2 AND 160),
  CONSTRAINT "wholesale_campaigns_max_check" CHECK ("max_leads" BETWEEN 1 AND 100000),
  CONSTRAINT "wholesale_campaigns_nearby_check" CHECK ("search_mode" <> 'NEARBY' OR ("nearby_lat" IS NOT NULL AND "nearby_lng" IS NOT NULL AND "radius_m" BETWEEN 100 AND 50000))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_campaigns_template_uq" ON "wholesale_campaigns" ("template_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_campaigns_status_idx" ON "wholesale_campaigns" ("status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wholesale_search_cells" (
  "id" text PRIMARY KEY NOT NULL,
  "cell_key" text NOT NULL,
  "keyword" text NOT NULL,
  "province_key" text NOT NULL,
  "province_label" text NOT NULL,
  "area_code" text NOT NULL,
  "area_name" text NOT NULL,
  "query_text" text NOT NULL,
  "search_mode" text DEFAULT 'TEXT' NOT NULL,
  "scan_count" integer DEFAULT 0 NOT NULL,
  "last_scanned_at" timestamp with time zone,
  "last_status" text,
  "last_campaign_id" text REFERENCES "wholesale_campaigns"("id") ON DELETE SET NULL,
  "results_found" integer DEFAULT 0 NOT NULL,
  "new_leads_found" integer DEFAULT 0 NOT NULL,
  "total_new_leads" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_search_cells_status_check" CHECK ("last_status" IS NULL OR "last_status" IN ('DONE','FAILED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_search_cells_key_uq" ON "wholesale_search_cells" ("cell_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_search_cells_province_idx" ON "wholesale_search_cells" ("province_key", "area_code");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wholesale_campaign_cells" (
  "id" text PRIMARY KEY NOT NULL,
  "campaign_id" text NOT NULL REFERENCES "wholesale_campaigns"("id") ON DELETE CASCADE,
  "cell_id" text NOT NULL REFERENCES "wholesale_search_cells"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "page_token" text,
  "pages_fetched" integer DEFAULT 0 NOT NULL,
  "results_found" integer DEFAULT 0 NOT NULL,
  "new_places" integer DEFAULT 0 NOT NULL,
  "new_leads" integer DEFAULT 0 NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "locked_until" timestamp with time zone,
  "last_error" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_campaign_cells_status_check" CHECK ("status" IN ('PENDING','RUNNING','DONE','SKIPPED_FRESH','FAILED','CANCELLED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_campaign_cells_uq" ON "wholesale_campaign_cells" ("campaign_id", "cell_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_campaign_cells_queue_idx" ON "wholesale_campaign_cells" ("campaign_id", "status", "priority");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wholesale_place_snapshots" (
  "place_id" text PRIMARY KEY NOT NULL,
  "display_name" text,
  "formatted_address" text,
  "national_phone" text,
  "international_phone" text,
  "website_uri" text,
  "google_maps_uri" text,
  "primary_type" text,
  "types" text[] DEFAULT '{}'::text[] NOT NULL,
  "rating" double precision,
  "user_rating_count" integer,
  "business_status" text,
  "lat" double precision,
  "lng" double precision,
  "normalized_phone" text,
  "phone_kind" text,
  "website_domain" text,
  "name_key" text,
  "fields_tier" text NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  "details_fetched_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "purged_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_place_snapshots_tier_check" CHECK ("fields_tier" IN ('IDS_ONLY','PRO','ENTERPRISE','DETAILS'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_place_snapshots_expires_idx" ON "wholesale_place_snapshots" ("expires_at") WHERE "purged_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_place_snapshots_phone_idx" ON "wholesale_place_snapshots" ("normalized_phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_place_snapshots_domain_idx" ON "wholesale_place_snapshots" ("website_domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_place_snapshots_name_idx" ON "wholesale_place_snapshots" ("name_key");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wholesale_leads" (
  "id" text PRIMARY KEY NOT NULL,
  "place_id" text,
  "source" text NOT NULL,
  "business_name" text,
  "address" text,
  "phone_raw" text,
  "normalized_phone" text,
  "phone_kind" text,
  "phone_country_code" text,
  "phone_source" text,
  "website" text,
  "website_domain" text,
  "email" text,
  "facebook_url" text,
  "zalo_url" text,
  "name_key" text,
  "province_key" text,
  "province_label" text,
  "area_code" text,
  "area_name" text,
  "segment" text DEFAULT 'UNCLASSIFIED' NOT NULL,
  "segment_evidence" text,
  "lead_score" integer,
  "lead_grade" text,
  "score_reasons" jsonb,
  "scored_at" timestamp with time zone,
  "source_query" text,
  "source_campaign_id" text REFERENCES "wholesale_campaigns"("id") ON DELETE SET NULL,
  "source_cell_id" text REFERENCES "wholesale_search_cells"("id") ON DELETE SET NULL,
  "enrichment_status" text DEFAULT 'READY' NOT NULL,
  "filter_reason" text,
  "duplicate_of_lead_id" text REFERENCES "wholesale_leads"("id") ON DELETE SET NULL,
  "details_attempts" integer DEFAULT 0 NOT NULL,
  "details_next_at" timestamp with time zone,
  "website_status" text DEFAULT 'NONE' NOT NULL,
  "website_checked_at" timestamp with time zone,
  "contact_status" text DEFAULT 'NEW' NOT NULL,
  "assigned_to_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "assigned_to_name" text,
  "assigned_at" timestamp with time zone,
  "first_contact_at" timestamp with time zone,
  "first_response_at" timestamp with time zone,
  "last_contact_at" timestamp with time zone,
  "next_followup_at" timestamp with time zone,
  "next_action" text,
  "contact_attempt_count" integer DEFAULT 0 NOT NULL,
  "response" text,
  "qualified_at" timestamp with time zone,
  "won_at" timestamp with time zone,
  "lost_at" timestamp with time zone,
  "lost_reason" text,
  "opportunity_value" bigint,
  "opportunity_note" text,
  "opportunity_at" timestamp with time zone,
  "customer_id" text REFERENCES "customers"("id") ON DELETE SET NULL,
  "converted_at" timestamp with time zone,
  "staff_edited_fields" text[] DEFAULT '{}'::text[] NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_refreshed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_leads_source_check" CHECK ("source" IN ('GOOGLE_PLACES','MANUAL_IMPORT','WEBSITE','STAFF')),
  CONSTRAINT "wholesale_leads_status_check" CHECK ("contact_status" IN ('NEW','QUALIFIED','READY_TO_CONTACT','CONTACTED','NO_ANSWER','INTERESTED','CATALOG_SENT','PRICE_SENT','SAMPLE_REQUESTED','NEGOTIATING','WON','LOST','DO_NOT_CONTACT')),
  CONSTRAINT "wholesale_leads_enrichment_check" CHECK ("enrichment_status" IN ('PENDING_DETAILS','READY','FILTERED','DUPLICATE','FAILED')),
  CONSTRAINT "wholesale_leads_website_check" CHECK ("website_status" IN ('NONE','PENDING','DONE','FAILED','BLOCKED')),
  CONSTRAINT "wholesale_leads_grade_check" CHECK ("lead_grade" IS NULL OR "lead_grade" IN ('A','B','C','D')),
  CONSTRAINT "wholesale_leads_score_check" CHECK ("lead_score" IS NULL OR "lead_score" BETWEEN 0 AND 100),
  CONSTRAINT "wholesale_leads_phone_kind_check" CHECK ("phone_kind" IS NULL OR "phone_kind" IN ('MOBILE','LANDLINE','SPECIAL','UNKNOWN')),
  CONSTRAINT "wholesale_leads_phone_source_check" CHECK ("phone_source" IS NULL OR "phone_source" IN ('STAFF','VERIFIED_CALL','IMPORT','WEBSITE')),
  CONSTRAINT "wholesale_leads_lost_check" CHECK ("contact_status" <> 'LOST' OR length(btrim(coalesce("lost_reason", ''))) >= 3),
  CONSTRAINT "wholesale_leads_identity_check" CHECK ("place_id" IS NOT NULL OR "business_name" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_leads_place_uq" ON "wholesale_leads" ("place_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_leads_phone_idx" ON "wholesale_leads" ("normalized_phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_leads_domain_idx" ON "wholesale_leads" ("website_domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_leads_name_idx" ON "wholesale_leads" ("name_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_leads_score_idx" ON "wholesale_leads" ("lead_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_leads_status_idx" ON "wholesale_leads" ("contact_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_leads_assignee_idx" ON "wholesale_leads" ("assigned_to_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_leads_enrichment_idx" ON "wholesale_leads" ("enrichment_status", "details_next_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_leads_campaign_idx" ON "wholesale_leads" ("source_campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_leads_customer_idx" ON "wholesale_leads" ("customer_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wholesale_place_hits" (
  "id" text PRIMARY KEY NOT NULL,
  "campaign_id" text NOT NULL REFERENCES "wholesale_campaigns"("id") ON DELETE CASCADE,
  "cell_id" text REFERENCES "wholesale_search_cells"("id") ON DELETE SET NULL,
  "place_id" text NOT NULL,
  "outcome" text NOT NULL,
  "reason" text,
  "lead_id" text REFERENCES "wholesale_leads"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_place_hits_outcome_check" CHECK ("outcome" IN ('NEW_LEAD','EXISTING_LEAD','FILTERED','SUPPRESSED','DUPLICATE'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_place_hits_uq" ON "wholesale_place_hits" ("campaign_id", "place_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wholesale_lead_campaigns" (
  "lead_id" text NOT NULL REFERENCES "wholesale_leads"("id") ON DELETE CASCADE,
  "campaign_id" text NOT NULL REFERENCES "wholesale_campaigns"("id") ON DELETE CASCADE,
  "added_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_lead_campaigns_pk" PRIMARY KEY ("lead_id", "campaign_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_lead_campaigns_campaign_idx" ON "wholesale_lead_campaigns" ("campaign_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wholesale_lead_activities" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL REFERENCES "wholesale_leads"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "channel" text,
  "outcome" text,
  "from_status" text,
  "to_status" text,
  "note" text DEFAULT '' NOT NULL,
  "meta" jsonb,
  "actor_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_lead_activities_kind_check" CHECK ("kind" IN ('DISCOVERED','IMPORTED','ENRICHED','SCORED','NOTE','CALL','STATUS','ASSIGN','OUTREACH','OPPORTUNITY','CONVERT','EDIT','CAMPAIGN'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_lead_activities_lead_idx" ON "wholesale_lead_activities" ("lead_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wholesale_lead_enrichments" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL REFERENCES "wholesale_leads"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "value" text NOT NULL,
  "source_url" text NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_lead_enrichments_kind_check" CHECK ("kind" IN ('EMAIL','PHONE','FACEBOOK','ZALO','CONTACT_PAGE','DESCRIPTION'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_lead_enrichments_uq" ON "wholesale_lead_enrichments" ("lead_id", "kind", "value");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wholesale_outreach_items" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL REFERENCES "wholesale_leads"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "message" text DEFAULT '' NOT NULL,
  "prepared_by" text NOT NULL,
  "ai_model" text,
  "approved_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "approved_at" timestamp with time zone,
  "sent_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "sent_at" timestamp with time zone,
  "result" text,
  "result_note" text,
  "result_at" timestamp with time zone,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_outreach_channel_check" CHECK ("channel" IN ('PHONE_CALL','ZALO','SMS','EMAIL','FACEBOOK','WHATSAPP')),
  CONSTRAINT "wholesale_outreach_status_check" CHECK ("status" IN ('DRAFT','APPROVED','SENT','DONE','CANCELLED')),
  CONSTRAINT "wholesale_outreach_prepared_check" CHECK ("prepared_by" IN ('AI','TEMPLATE','STAFF')),
  CONSTRAINT "wholesale_outreach_result_check" CHECK ("result" IS NULL OR "result" IN ('NO_ANSWER','INTERESTED','NOT_INTERESTED','CALLBACK','WRONG_NUMBER','REPLIED','DO_NOT_CONTACT'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_outreach_open_uq" ON "wholesale_outreach_items" ("lead_id", "channel") WHERE "status" IN ('DRAFT','APPROVED');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_outreach_status_idx" ON "wholesale_outreach_items" ("status", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wholesale_suppressions" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "value" text NOT NULL,
  "reason" text NOT NULL,
  "lead_id" text REFERENCES "wholesale_leads"("id") ON DELETE SET NULL,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_suppressions_kind_check" CHECK ("kind" IN ('PHONE','DOMAIN','PLACE')),
  CONSTRAINT "wholesale_suppressions_reason_check" CHECK (length(btrim("reason")) >= 3)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_suppressions_uq" ON "wholesale_suppressions" ("kind", "value");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wholesale_api_usage" (
  "id" text PRIMARY KEY NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "provider" text NOT NULL,
  "method" text NOT NULL,
  "sku" text,
  "campaign_id" text REFERENCES "wholesale_campaigns"("id") ON DELETE SET NULL,
  "cell_id" text REFERENCES "wholesale_search_cells"("id") ON DELETE SET NULL,
  "lead_id" text REFERENCES "wholesale_leads"("id") ON DELETE SET NULL,
  "query" text,
  "http_status" integer,
  "ok" boolean NOT NULL,
  "billable" boolean DEFAULT false NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL,
  "result_count" integer DEFAULT 0 NOT NULL,
  "new_count" integer DEFAULT 0 NOT NULL,
  "duplicate_count" integer DEFAULT 0 NOT NULL,
  "duration_ms" integer DEFAULT 0 NOT NULL,
  "cost_micros" bigint DEFAULT 0 NOT NULL,
  "error" text,
  CONSTRAINT "wholesale_api_usage_provider_check" CHECK ("provider" IN ('GOOGLE_PLACES','WEBSITE','AI')),
  CONSTRAINT "wholesale_api_usage_method_check" CHECK ("method" IN ('TEXT_SEARCH','NEARBY_SEARCH','PLACE_DETAILS','WEBSITE_FETCH','AI_OPENER'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_api_usage_at_idx" ON "wholesale_api_usage" ("at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_api_usage_campaign_idx" ON "wholesale_api_usage" ("campaign_id", "at");--> statement-breakpoint

INSERT INTO "platform_organization_modules" ("organization_id", "module_key", "enabled", "features", "config", "disabled_at", "updated_by")
SELECT "id", 'wholesale_leads', false, '{}'::jsonb, '{}'::jsonb, now(), 'system:0197'
FROM "platform_organizations" WHERE "is_home"
ON CONFLICT ("organization_id", "module_key") DO NOTHING;
