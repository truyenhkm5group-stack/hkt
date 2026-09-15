-- HỒ SƠ BÁN HÀNG THEO FANPAGE — 5 bảng mới + 10 cột ảnh chụp trên hội thoại.
-- THUẦN BỔ SUNG, chỉ chạm bảng do nền tảng AI sở hữu. Không câu nào đụng đơn hàng, vận đơn,
-- tiền hay tồn kho.
--
-- VÌ SAO: bản trước đi ĐOÁN mẫu hàng từ từng tin nhắn và từng quảng cáo, đo được 17% trên dữ liệu
-- thật. Cách vận hành thật thì ngược lại — một fanpage tại một thời điểm bán MỘT mẫu thắng, nên
-- mẫu hàng là dữ kiện ĐÃ BIẾT theo page. Suy luận từ quảng cáo tụt xuống thành NGOẠI LỆ, và chỉ
-- ngoại lệ mới phải khai.
--
-- Mười cột trên `sales_conversations` là ẢNH CHỤP: chốt một lần rồi bất biến. Page đổi mẫu thắng
-- Q004 → Q017 thì hội thoại CŨ vẫn thuộc Q004 — đọc lại cấu hình hiện hành để diễn giải chuyện đã
-- xảy ra là viết lại quá khứ.

CREATE TABLE "sales_size_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"product_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"rules" jsonb,
	"fabric_stretch" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_product_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"test_code" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"pancake_page_id" text DEFAULT '' NOT NULL,
	"source_id" text DEFAULT '' NOT NULL,
	"images" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"material" text DEFAULT '' NOT NULL,
	"colors" text[] DEFAULT '{}'::text[] NOT NULL,
	"measurements" jsonb,
	"price" integer,
	"promotion" text DEFAULT '' NOT NULL,
	"shipping_policy" text DEFAULT '' NOT NULL,
	"size_profile_id" text,
	"approved_facts" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"owner_user_id" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"promoted_product_id" text,
	"ai_reply_enabled" boolean DEFAULT true NOT NULL,
	"allow_quote_price" boolean DEFAULT true NOT NULL,
	"allow_answer_material" boolean DEFAULT true NOT NULL,
	"allow_ask_size" boolean DEFAULT true NOT NULL,
	"allow_collect_preference" boolean DEFAULT true NOT NULL,
	"allow_collect_intent" boolean DEFAULT true NOT NULL,
	"allow_collect_phone" boolean DEFAULT true NOT NULL,
	"allow_collect_address" boolean DEFAULT true NOT NULL,
	"allow_offer_product" boolean DEFAULT true NOT NULL,
	"allow_auto_order_create" boolean DEFAULT false NOT NULL,
	"allow_confirm_order" boolean DEFAULT false NOT NULL,
	"allow_promotion" boolean DEFAULT false NOT NULL,
	"allow_upsell" boolean DEFAULT false NOT NULL,
	"allow_follow_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fanpage_sales_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"pancake_page_id" text NOT NULL,
	"facebook_page_id" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"ai_mode" text DEFAULT 'SHADOW' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"effective_from" timestamp with time zone,
	"active_product_id" text,
	"unit_price" integer,
	"shipping_fee" integer,
	"combo_pricing" jsonb,
	"free_ship_from" integer,
	"available_colors" text[] DEFAULT '{}'::text[] NOT NULL,
	"cod_policy" text DEFAULT '' NOT NULL,
	"inspection_policy" text DEFAULT '' NOT NULL,
	"delivery_estimate" text DEFAULT '' NOT NULL,
	"exchange_policy" text DEFAULT '' NOT NULL,
	"approved_facts" text[] DEFAULT '{}'::text[] NOT NULL,
	"size_profile_id" text,
	"note" text DEFAULT '' NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_source_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"pancake_page_id" text NOT NULL,
	"source_kind" text DEFAULT 'AD' NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text NOT NULL,
	"product_id" text,
	"test_product_id" text,
	"note" text DEFAULT '' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_market_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"test_product_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text,
	"customer_interest" boolean,
	"purchase_intent" boolean,
	"asked_price" boolean,
	"price_objection" boolean,
	"requested_color" text DEFAULT '' NOT NULL,
	"requested_size" text DEFAULT '' NOT NULL,
	"height_cm" integer,
	"weight_kg" integer,
	"bust_cm" integer,
	"waist_cm" integer,
	"hip_cm" integer,
	"material_question" boolean,
	"size_question" boolean,
	"shipping_question" boolean,
	"liked_design" boolean,
	"disliked_design" boolean,
	"ready_to_buy" boolean,
	"customer_feedback" text DEFAULT '' NOT NULL,
	"objection_category" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "sales_conversations" ADD COLUMN "source_type" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "source_kind" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "source_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "sales_profile_id" text;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "sales_profile_version" integer;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "active_product_id" text;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "test_product_id" text;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "classification_source" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "classification_confidence" double precision;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "classified_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "sales_size_profiles" ADD CONSTRAINT "sales_size_profiles_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD CONSTRAINT "test_product_profiles_size_profile_id_sales_size_profiles_id_fk" FOREIGN KEY ("size_profile_id") REFERENCES "public"."sales_size_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD CONSTRAINT "test_product_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD CONSTRAINT "test_product_profiles_promoted_product_id_products_id_fk" FOREIGN KEY ("promoted_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" ADD CONSTRAINT "fanpage_sales_profiles_active_product_id_products_id_fk" FOREIGN KEY ("active_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" ADD CONSTRAINT "fanpage_sales_profiles_size_profile_id_sales_size_profiles_id_fk" FOREIGN KEY ("size_profile_id") REFERENCES "public"."sales_size_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" ADD CONSTRAINT "fanpage_sales_profiles_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_source_rules" ADD CONSTRAINT "sales_source_rules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_source_rules" ADD CONSTRAINT "sales_source_rules_test_product_id_test_product_profiles_id_fk" FOREIGN KEY ("test_product_id") REFERENCES "public"."test_product_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_source_rules" ADD CONSTRAINT "sales_source_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_market_signals" ADD CONSTRAINT "test_market_signals_test_product_id_test_product_profiles_id_fk" FOREIGN KEY ("test_product_id") REFERENCES "public"."test_product_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_market_signals" ADD CONSTRAINT "test_market_signals_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_market_signals" ADD CONSTRAINT "test_market_signals_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_sales_profile_id_fanpage_sales_profiles_id_fk" FOREIGN KEY ("sales_profile_id") REFERENCES "public"."fanpage_sales_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_active_product_id_products_id_fk" FOREIGN KEY ("active_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_test_product_id_test_product_profiles_id_fk" FOREIGN KEY ("test_product_id") REFERENCES "public"."test_product_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "test_product_profiles_code_uq" ON "test_product_profiles" USING btree ("test_code");--> statement-breakpoint
CREATE UNIQUE INDEX "fanpage_sales_profiles_page_uq" ON "fanpage_sales_profiles" USING btree ("pancake_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_source_rules_uq" ON "sales_source_rules" USING btree ("pancake_page_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_market_signals_conv_uq" ON "test_market_signals" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "test_market_signals_test_idx" ON "test_market_signals" USING btree ("test_product_id");
