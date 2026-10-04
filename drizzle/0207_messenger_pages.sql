-- 0207 · MESSENGER TRỰC TIẾP: PAGE ⇒ TỔ CHỨC (lib/sales-chatbot/messenger.ts · docs/platform/messenger.md).
--
--  · Webhook Messenger của Meta tới MỘT địa chỉ chung; mã page trong gói tin là chứng cứ duy nhất «tin này của ai».
--  · Một page thuộc ĐÚNG MỘT tổ chức (khoá chính). Chỉ mục — token page mã hoá ở CSDL của tổ chức.
--  · Bảng mặt phẳng điều khiển: chỉ bản ở CSDL nhà là thật. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "platform_messenger_pages" (
  "page_id" text PRIMARY KEY NOT NULL,
  "org_code" text NOT NULL,
  "page_name" text,
  "connected_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
