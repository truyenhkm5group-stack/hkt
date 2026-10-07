-- 0232 · ĐƯỜNG NHẬN TIN CANONICAL CỦA MỖI PAGE + KHỬ TRÙNG HAI NGUỒN (sứ mệnh saas-l3-inbox · lib/sales-chatbot/channel-ownership.ts).
--
--  · Một page có thể nối qua Pancake VÀ qua Meta trực tiếp (Messenger / Instagram). Trước bản này «đường nào kích AI» là luật cứng
--    trong mã: Pancake luôn thắng. Chủ shop 07/10/2026: mỗi page có MỘT `connection_mode` canonical LƯU ĐƯỢC
--    (`META_DIRECT` | `PANCAKE_WEBHOOK`); page mới ưu tiên Meta trực tiếp; chuyển đường là thao tác tường minh của người.
--  · `channel_page_modes`: mỗi page một dòng (UNIQUE page_id), kèm NGUỒN và LÝ DO. CSDL mọi tổ chức (mỗi tổ chức một CSDL — không
--    cột tổ chức nào để lọc sai).
--  · BACKFILL KHÔNG ĐOÁN — chép ĐÚNG đường đang chạy hôm nay (`transportOwnerOf` trước bản này):
--      1. page đang khai ở kết nối «Fanpage qua Pancake» đang bật ⇒ PANCAKE_WEBHOOK (Pancake thắng như cũ, kể cả khi page đó cũng
--         nối Messenger — chèn TRƯỚC nên dòng Messenger cùng page rơi vào ON CONFLICT DO NOTHING);
--      2. page / Instagram đang bật dưới kết nối Messenger trực tiếp (`org_channel_pages` ACTIVE) ⇒ META_DIRECT;
--      3. page của hàng kết nối Messenger đơn CŨ (trước 0220, chưa có hàng riêng) đang bật ⇒ META_DIRECT.
--    Page không đường nào đang bật ⇒ KHÔNG dòng nào (chưa có gì để giữ). Mã đọc: page chưa có dòng ⇒ luật cũ.
--  · `sales_chat_inbound.transport` + `sender_id`: đường đã ghi dòng tin khách + PSID chuẩn — khử trùng một tin khách tới qua cả
--    hai webhook. Chỉ THÊM cột; dòng cũ giữ NULL (không backfill).
--  Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "channel_page_modes" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"mode" text NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"set_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_page_modes_mode_check" CHECK ("channel_page_modes"."mode" in ('META_DIRECT','PANCAKE_WEBHOOK')),
	CONSTRAINT "channel_page_modes_source_check" CHECK ("channel_page_modes"."source" in ('BACKFILL','CONNECT','MANUAL'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_page_modes_page_uq" ON "channel_page_modes" USING btree ("page_id");
--> statement-breakpoint
INSERT INTO "channel_page_modes" ("id", "page_id", "mode", "source", "reason")
SELECT gen_random_uuid()::text, btrim("settings"->>'pageId'), 'PANCAKE_WEBHOOK', 'BACKFILL',
  '0232: page đang nhận tin qua Pancake lúc nâng cấp — giữ nguyên đường đang chạy (Pancake thắng như trước)'
FROM "org_connections"
WHERE "connector_key" = 'pancake-fanpage' AND "status" = 'ACTIVE' AND coalesce(btrim("settings"->>'pageId'), '') <> ''
ON CONFLICT ("page_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "channel_page_modes" ("id", "page_id", "mode", "source", "reason")
SELECT gen_random_uuid()::text, "page_id", 'META_DIRECT', 'BACKFILL',
  '0232: page chỉ nhận tin qua Meta trực tiếp lúc nâng cấp — giữ nguyên đường đang chạy'
FROM "org_channel_pages"
WHERE "connector_key" = 'facebook-messenger' AND "status" = 'ACTIVE' AND btrim("page_id") <> ''
ON CONFLICT ("page_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "channel_page_modes" ("id", "page_id", "mode", "source", "reason")
SELECT gen_random_uuid()::text, x.id, 'META_DIRECT', 'BACKFILL',
  '0232: page của kết nối Messenger đơn cũ (trước 0220) lúc nâng cấp — giữ nguyên đường đang chạy'
FROM "org_connections" oc
CROSS JOIN LATERAL (VALUES (btrim(coalesce(oc."settings"->>'pageId', ''))), (btrim(coalesce(oc."settings"->>'igAccountId', '')))) AS x(id)
WHERE oc."connector_key" = 'facebook-messenger' AND oc."status" = 'ACTIVE' AND x.id <> ''
  AND NOT EXISTS (SELECT 1 FROM "org_channel_pages" p WHERE p."connector_key" = 'facebook-messenger' AND p."page_id" = x.id)
ON CONFLICT ("page_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "transport" text;
--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "sender_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sales_chat_inbound" ADD CONSTRAINT "sales_chat_inbound_transport_check" CHECK ("sales_chat_inbound"."transport" IS NULL OR "sales_chat_inbound"."transport" IN ('PANCAKE','MESSENGER'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_inbound_sender_idx" ON "sales_chat_inbound" USING btree ("page_id","sender_id","created_at") WHERE "sales_chat_inbound"."sender_id" is not null;
