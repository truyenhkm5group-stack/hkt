-- 0245 · «TIN KHÁCH CHƯA ĐỌC» LƯU SẴN TRÊN HỘI THOẠI (P0 inbox-unread-perf, 11/10/2026).
--
-- NGHĨA không ở đây: «chưa đọc» = LƯỢT KHÁCH MỚI NHẤT CHƯA ĐƯỢC XỬ LÝ — MỘT định nghĩa của response-ownership (#803,
-- `latestCustomerTurnUnhandledFor` · `latestWebTurnUnhandledFor` ≡ `latestTurnHandled` · `latestWebTurnHandled`). Định nghĩa ấy là một câu
-- con nặng cho TỪNG hội thoại; hộp thư cần cờ cho CẢ hộp thư ở bộ đếm thẻ + khoá xếp. Đo PGlite 3.000 hội thoại: gọi thẳng làm SQL tải
-- hộp thư ~550 ms (trước #784: ~246 ms). Từ 27d9b2c7 định nghĩa TẤT ĐỊNH THEO DÒNG (không phụ thuộc «bây giờ»: tin mẫu cũ neo 168 giờ
-- trước mốc của chính dòng) ⇒ lưu được KẾT QUẢ của chính nó:
--  · turn_unhandled = kết quả của định nghĩa #803 cho hội thoại (kênh nhắn tin: sổ tin thô; chat web: lịch sử hội thoại), mốc «người đã
--    mở» = greatest(last_read_at, staff_seen_at) đúng như `humanSeenAtSql`;
--  · last_read_at = max(read_through_at) của MỌI con trỏ đọc.
-- Thân hai hàm `sales_chat_turn_unhandled_thread` / `sales_chat_turn_unhandled_web` là ĐÚNG câu SQL các hàm TS của #803 dựng ra (tham số gắn
-- thành hằng — lib/sales-chatbot/inbox-unread-render.ts); bài kiểm so từng ký tự, #803 đổi mà migration chưa theo thì đỏ.
--
-- AI GIỮ CỘT ĐÚNG: trigger, ở MỌI thứ định nghĩa đọc tới:
--  · sales_chat_inbound: thêm / sửa / xoá dòng ⇒ tính lại luồng của nó; dòng PAGE_REPLY chữ ≥ 40 ký tự ⇒ tính lại cả các luồng KHÁC có dòng
--    cũ cùng chữ trong 168 giờ SAU nó (vế tin mẫu cũ đọc chéo luồng);
--  · sales_chat_staff_messages: đổi trạng thái tin nhân viên (vế staff-out chỉ tính tin đã SENT) ⇒ tính lại hội thoại của nó;
--  · sales_chat_messages: thêm / sửa / xoá ⇒ tính lại hội thoại chat web của nó;
--  · sales_chat_reads: con trỏ tiến / lùi / xoá ⇒ last_read_at ⇒ tính lại;
--  · sales_chat_conversations: dựng / đổi page–luồng / đổi staff_seen_at / last_read_at ⇒ tính lại ngay trên dòng.
-- Không đường TypeScript nào ghi hai cột (bài kiểm quét mã). Mã đọc coi NULL là CHƯA BIẾT ⇒ tính trực tiếp bằng hàm #803.
--
-- GIÁ TRỊ CŨ: DẪN XUẤT TẤT ĐỊNH bằng chính hai hàm trên sổ đã có — chạy lại cho cùng kết quả, không đoán. MỘT câu UPDATE ghi cả hai cột.
-- Thứ tự trong CÙNG giao dịch: ALTER TABLE hội thoại (khoá ACCESS EXCLUSIVE tới lúc commit) → trigger của bốn bảng nguồn (CREATE TRIGGER
-- khoá ghi chúng tới lúc commit) → dẫn xuất → trigger của chính bảng hội thoại. Không phiên nào ghi được hội thoại / tin giữa các bước nên
-- không dòng nào lọt; trigger hội thoại dựng SAU dẫn xuất để câu dẫn xuất không bắt trigger tính lại lần hai mọi dòng có con trỏ đọc.
-- Chỉ mục (page, luồng) cho trigger. Idempotent.
--
-- AN TOÀN KHI CHẠY TRÊN PRODUCTION: drizzle chạy MỌI migration còn thiếu trong MỘT giao dịch (drizzle-orm pg-core/dialect.js `migrate` →
-- `session.transaction`), nên `SET LOCAL` có hiệu lực tới hết giao dịch và tự hết khi commit / rollback — không rò sang phiên của ứng
-- dụng. lock_timeout 10 giây: ALTER TABLE xin ACCESS EXCLUSIVE; đứng chờ vô hạn sau một câu đọc dài là chặn MỌI câu đọc hộp thư xếp hàng
-- sau nó — thà hỏng nhanh, rollback sạch (ensureMigrated thử lại ở lần gọi sau) còn hơn treo webhook. statement_timeout 600 giây đủ
-- cho câu dẫn xuất (đo bằng ops `inbox-unread-dryrun` trước khi gộp). Cuối tệp trả hai tham số về mặc định của phiên để các migration
-- đứng SAU trong cùng lượt không bị trần của tệp này.

SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
SET LOCAL statement_timeout = '600s';
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "turn_unhandled" boolean;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "last_read_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_conversations_thread_idx" ON "sales_chat_conversations" USING btree ("page_id","thread_id") WHERE "page_id" IS NOT NULL;
--> statement-breakpoint
-- Định nghĩa #803, kênh nhắn tin — thân dựng từ latestCustomerTurnUnhandledFor(p_page, p_thread, p_seen).
CREATE OR REPLACE FUNCTION "sales_chat_turn_unhandled_thread"(p_page text, p_thread text, p_seen timestamp with time zone) RETURNS boolean AS $$
SELECT coalesce((select (not exists (select 1 from "sales_chat_inbound" o where o.page_id = p_page and o.thread_id = p_thread and (date_trunc('milliseconds', coalesce(o."source_at", o."created_at")), date_trunc('milliseconds', o."created_at"), o."message_id") > (date_trunc('milliseconds', coalesce(lc."source_at", lc."created_at")), date_trunc('milliseconds', lc."created_at"), lc."message_id") and (
      (((o."imported_at" is null and o."note" = 'BOT_SENT') or ((o."imported_at" is null and o."note" = 'PAGE_REPLY' and o."message_id" not like 'staff-out:%'
    and o."text" <> '[Ảnh]' and o."text" ~ '[^[:space:]]') and o."sender_kind" = 'AI_AGENT')) and lc."status" <> 'PENDING' and date_trunc('milliseconds', o."created_at") > date_trunc('milliseconds', lc."created_at"))
      or (((o."imported_at" is null and o."note" = 'PAGE_REPLY' and o."message_id" like 'staff-out:%'
    and not exists (select 1 from "sales_chat_staff_messages" sm where sm.id = split_part(substr(o."message_id", 11), ':', 1) and sm.status <> 'SENT')) or ((o."imported_at" is null and o."note" = 'PAGE_REPLY' and o."message_id" not like 'staff-out:%'
    and o."text" <> '[Ảnh]' and o."text" ~ '[^[:space:]]') and o."sender_kind" = 'VERIFIED_HUMAN')) and (case when o."source_at" is null then date_trunc('milliseconds', o."created_at") > date_trunc('milliseconds', lc."created_at") else (case when o."source_at" is not null and lc."source_at" is not null then date_trunc('milliseconds', o."source_at") > date_trunc('milliseconds', lc."source_at")
    else date_trunc('milliseconds', o."created_at") - date_trunc('milliseconds', lc."created_at") >= interval '60 seconds' end) end))
      or ((o."imported_at" is null and o."note" = 'PAGE_REPLY' and o."message_id" not like 'staff-out:%'
    and o."text" <> '[Ảnh]' and o."text" ~ '[^[:space:]]') and (case when o."sender_kind" is not null then o."sender_kind"
    when o."text" ~* '(bạn đang phản hồi bình luận|you(''|’)?re replying to (a )?comment|replied to (a|your) comment|đã trả lời (về )?một (quảng cáo|bài viết)|nhãn tự động|đánh dấu trạng thái đơn|đặt giai đoạn của khách hàng)' then 'META_SYSTEM'
    when (char_length(btrim(regexp_replace(o."text", '[[:space:]]+', ' ', 'g'))) >= 40 and exists (select 1 from "sales_chat_inbound" p where p.page_id = o."page_id" and p.thread_id <> o."thread_id"
    and p.note = 'PAGE_REPLY' and date_trunc('milliseconds', p."created_at") < date_trunc('milliseconds', o."created_at") and date_trunc('milliseconds', p."created_at") >= date_trunc('milliseconds', o."created_at") - interval '168 hours' and btrim(regexp_replace(p."text", '[[:space:]]+', ' ', 'g')) = btrim(regexp_replace(o."text", '[[:space:]]+', ' ', 'g')))) then 'PANCAKE_AUTOMATION' else 'UNKNOWN' end) = 'OTHER_APP' and (case when o."source_at" is not null and lc."source_at" is not null then date_trunc('milliseconds', o."source_at") > date_trunc('milliseconds', lc."source_at")
    else date_trunc('milliseconds', o."created_at") - date_trunc('milliseconds', lc."created_at") >= interval '60 seconds' end))
      or ((o."imported_at" is null and o."note" = 'PAGE_REPLY' and o."message_id" not like 'staff-out:%'
    and o."text" <> '[Ảnh]' and o."text" ~ '[^[:space:]]') and (case when o."sender_kind" is not null then o."sender_kind"
    when o."text" ~* '(bạn đang phản hồi bình luận|you(''|’)?re replying to (a )?comment|replied to (a|your) comment|đã trả lời (về )?một (quảng cáo|bài viết)|nhãn tự động|đánh dấu trạng thái đơn|đặt giai đoạn của khách hàng)' then 'META_SYSTEM'
    when (char_length(btrim(regexp_replace(o."text", '[[:space:]]+', ' ', 'g'))) >= 40 and exists (select 1 from "sales_chat_inbound" p where p.page_id = o."page_id" and p.thread_id <> o."thread_id"
    and p.note = 'PAGE_REPLY' and date_trunc('milliseconds', p."created_at") < date_trunc('milliseconds', o."created_at") and date_trunc('milliseconds', p."created_at") >= date_trunc('milliseconds', o."created_at") - interval '168 hours' and btrim(regexp_replace(p."text", '[[:space:]]+', ' ', 'g')) = btrim(regexp_replace(o."text", '[[:space:]]+', ' ', 'g')))) then 'PANCAKE_AUTOMATION' else 'UNKNOWN' end) = 'UNKNOWN' and (case when o."source_at" is not null and lc."source_at" is not null then date_trunc('milliseconds', o."source_at") > date_trunc('milliseconds', lc."source_at")
    else date_trunc('milliseconds', o."created_at") - date_trunc('milliseconds', lc."created_at") >= interval '60 seconds' end) and not exists (select 1 from "sales_chat_inbound" s where s.page_id = p_page and s.thread_id = p_thread and (s."imported_at" is null and coalesce(s."note", '') not in ('BOT_SENT', 'PAGE_REPLY')
    and (s."note" = 'MEDIA_ONLY' or s."text" ~ '[^[:space:]]' or (jsonb_typeof(s."image_urls") = 'array' and jsonb_array_length(s."image_urls") > 0)))
    and date_trunc('milliseconds', coalesce(o."source_at", o."created_at")) between date_trunc('milliseconds', coalesce(s."source_at", s."created_at")) - interval '60 seconds' and date_trunc('milliseconds', coalesce(s."source_at", s."created_at")) + interval '60 seconds'
    and not exists (select 1 from "sales_chat_inbound" r where r.page_id = p_page and r.thread_id = p_thread and ((r."imported_at" is null and coalesce(r."note", '') not in ('BOT_SENT', 'PAGE_REPLY')
    and (r."note" = 'MEDIA_ONLY' or r."text" ~ '[^[:space:]]' or (jsonb_typeof(r."image_urls") = 'array' and jsonb_array_length(r."image_urls") > 0))) or (r."imported_at" is null and r."note" = 'BOT_SENT') or (r."imported_at" is null and r."note" = 'PAGE_REPLY' and r."message_id" like 'staff-out:%'
    and not exists (select 1 from "sales_chat_staff_messages" sm where sm.id = split_part(substr(r."message_id", 11), ':', 1) and sm.status <> 'SENT')) or ((r."imported_at" is null and r."note" = 'PAGE_REPLY' and r."message_id" not like 'staff-out:%'
    and r."text" <> '[Ảnh]' and r."text" ~ '[^[:space:]]') and r."sender_kind" in ('VERIFIED_HUMAN', 'AI_AGENT')))
      and (date_trunc('milliseconds', coalesce(r."source_at", r."created_at")), date_trunc('milliseconds', r."created_at"), r."message_id") < (date_trunc('milliseconds', coalesce(s."source_at", s."created_at")), date_trunc('milliseconds', s."created_at"), s."message_id") and date_trunc('milliseconds', coalesce(r."source_at", r."created_at")) > date_trunc('milliseconds', coalesce(s."source_at", s."created_at")) - interval '24 hours'))))) and not coalesce(date_trunc('milliseconds', lc."created_at") <= date_trunc('milliseconds', p_seen), false)) from (select * from "sales_chat_inbound" lc where lc.page_id = p_page and lc.thread_id = p_thread and (lc."imported_at" is null and coalesce(lc."note", '') not in ('BOT_SENT', 'PAGE_REPLY')
    and (lc."note" = 'MEDIA_ONLY' or lc."text" ~ '[^[:space:]]' or (jsonb_typeof(lc."image_urls") = 'array' and jsonb_array_length(lc."image_urls") > 0)))
    order by date_trunc('milliseconds', coalesce(lc."source_at", lc."created_at")) desc, date_trunc('milliseconds', lc."created_at") desc, lc.message_id desc limit 1) lc), false);
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
-- Định nghĩa #803, chat web — thân dựng từ latestWebTurnUnhandledFor(p_conv, p_seen).
CREATE OR REPLACE FUNCTION "sales_chat_turn_unhandled_web"(p_conv text, p_seen timestamp with time zone) RETURNS boolean AS $$
SELECT coalesce((select (not exists (select 1 from "sales_chat_messages" a where a.conversation_id = p_conv and a.role = 'assistant' and a.content @> '[{"type":"text"}]'::jsonb and a.seq > lu.seq)
      and not coalesce(date_trunc('milliseconds', lu.created_at) <= date_trunc('milliseconds', p_seen), false))
    from (select m.seq, m.created_at from "sales_chat_messages" m where m.conversation_id = p_conv and m.role = 'user' and m.content @> '[{"type":"text"}]'::jsonb order by m.seq desc limit 1) lu), false);
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
-- Kết quả cho MỘT dòng hội thoại (đúng phép chia của latestCustomerTurnUnhandledSql: có page + luồng ⇒ sổ tin thô, còn lại ⇒ chat web).
CREATE OR REPLACE FUNCTION "sales_chat_turn_unhandled_of"(p_id text, p_page text, p_thread text, p_seen timestamp with time zone) RETURNS boolean AS $$
SELECT CASE WHEN p_page IS NOT NULL AND p_thread IS NOT NULL THEN "sales_chat_turn_unhandled_thread"(p_page, p_thread, p_seen)
	ELSE "sales_chat_turn_unhandled_web"(p_id, p_seen) END;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales_chat_turn_refresh_thread"(p_page text, p_thread text) RETURNS void AS $$
BEGIN
	IF p_page IS NULL OR p_thread IS NULL THEN RETURN; END IF;
	UPDATE "sales_chat_conversations" c SET "turn_unhandled" = x.v
	FROM (SELECT c2."id", "sales_chat_turn_unhandled_thread"(p_page, p_thread, greatest(c2."last_read_at", c2."staff_seen_at")) AS v
		FROM "sales_chat_conversations" c2 WHERE c2."page_id" = p_page AND c2."thread_id" = p_thread) x
	WHERE c."id" = x."id" AND c."turn_unhandled" IS DISTINCT FROM x.v;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales_chat_turn_refresh_conv"(p_id text) RETURNS void AS $$
BEGIN
	IF p_id IS NULL THEN RETURN; END IF;
	UPDATE "sales_chat_conversations" c SET "turn_unhandled" = "sales_chat_turn_unhandled_of"(c."id", c."page_id", c."thread_id", greatest(c."last_read_at", c."staff_seen_at"))
	WHERE c."id" = p_id AND c."turn_unhandled" IS DISTINCT FROM "sales_chat_turn_unhandled_of"(c."id", c."page_id", c."thread_id", greatest(c."last_read_at", c."staff_seen_at"));
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Vế tin mẫu cũ của #803 đọc CHÉO luồng: dòng PAGE_REPLY cùng chữ (gộp khoảng trắng, ≥ 40 ký tự) ở luồng khác trong 168 giờ TRƯỚC một dòng cũ
-- (chưa có sender_kind) làm dòng cũ ấy thành tin tự động. Dòng P đổi ⇒ tính lại các luồng có dòng cũ cùng chữ trong 168 giờ SAU P.
CREATE OR REPLACE FUNCTION "sales_chat_turn_refresh_template"(p_page text, p_thread text, p_text text, p_created timestamp with time zone) RETURNS void AS $$
DECLARE k text; r record;
BEGIN
	k := btrim(regexp_replace(coalesce(p_text, ''), '[[:space:]]+', ' ', 'g'));
	IF char_length(k) < 40 THEN RETURN; END IF;
	FOR r IN SELECT DISTINCT o."page_id", o."thread_id" FROM "sales_chat_inbound" o
		WHERE o."page_id" = p_page AND o."thread_id" <> p_thread AND o."note" = 'PAGE_REPLY' AND o."sender_kind" IS NULL
			AND date_trunc('milliseconds', o."created_at") > date_trunc('milliseconds', p_created)
			AND date_trunc('milliseconds', o."created_at") <= date_trunc('milliseconds', p_created) + interval '168 hours'
			AND btrim(regexp_replace(o."text", '[[:space:]]+', ' ', 'g')) = k
	LOOP
		PERFORM "sales_chat_turn_refresh_thread"(r."page_id", r."thread_id");
	END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales_chat_inbound_turn_trg"() RETURNS trigger AS $$
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		PERFORM "sales_chat_turn_refresh_thread"(OLD."page_id", OLD."thread_id");
		IF OLD."note" = 'PAGE_REPLY' THEN PERFORM "sales_chat_turn_refresh_template"(OLD."page_id", OLD."thread_id", OLD."text", OLD."created_at"); END IF;
	END IF;
	-- Dòng nhập lịch sử không vào định nghĩa ở chính luồng của nó (mọi vế đòi imported_at NULL) — chỉ vế tin mẫu chéo luồng đọc nó.
	IF (TG_OP = 'INSERT' AND NEW."imported_at" IS NULL) OR (TG_OP = 'UPDATE' AND (NEW."page_id", NEW."thread_id") IS DISTINCT FROM (OLD."page_id", OLD."thread_id")) THEN
		PERFORM "sales_chat_turn_refresh_thread"(NEW."page_id", NEW."thread_id");
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."note" = 'PAGE_REPLY' THEN
		PERFORM "sales_chat_turn_refresh_template"(NEW."page_id", NEW."thread_id", NEW."text", NEW."created_at");
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales_chat_staff_turn_trg"() RETURNS trigger AS $$
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM "sales_chat_turn_refresh_conv"(OLD."conversation_id"); END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM "sales_chat_turn_refresh_conv"(NEW."conversation_id"); END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales_chat_messages_turn_trg"() RETURNS trigger AS $$
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM "sales_chat_turn_refresh_conv"(OLD."conversation_id"); END IF;
	IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW."conversation_id" IS DISTINCT FROM OLD."conversation_id") THEN PERFORM "sales_chat_turn_refresh_conv"(NEW."conversation_id"); END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales_chat_reads_turn_trg"() RETURNS trigger AS $$
DECLARE v timestamp with time zone;
BEGIN
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		UPDATE "sales_chat_conversations" SET "last_read_at" = NEW."read_through_at"
		WHERE "id" = NEW."conversation_id" AND ("last_read_at" IS NULL OR "last_read_at" < NEW."read_through_at");
	END IF;
	IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (NEW."read_through_at" < OLD."read_through_at" OR NEW."conversation_id" IS DISTINCT FROM OLD."conversation_id")) THEN
		SELECT max(r."read_through_at") INTO v FROM "sales_chat_reads" r WHERE r."conversation_id" = OLD."conversation_id";
		UPDATE "sales_chat_conversations" SET "last_read_at" = v WHERE "id" = OLD."conversation_id" AND "last_read_at" IS DISTINCT FROM v;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Dòng hội thoại: dựng / đổi page–luồng / đổi mốc mở (staff_seen_at) / đổi mốc đọc ⇒ tính lại ngay. Giá trị ứng dụng gửi tới bị bỏ.
CREATE OR REPLACE FUNCTION "sales_chat_conversations_turn_trg"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN NEW."last_read_at" := NULL; END IF;
	NEW."turn_unhandled" := "sales_chat_turn_unhandled_of"(NEW."id", NEW."page_id", NEW."thread_id", greatest(NEW."last_read_at", NEW."staff_seen_at"));
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sales_chat_inbound_turn" ON "sales_chat_inbound";
--> statement-breakpoint
CREATE TRIGGER "sales_chat_inbound_turn" AFTER INSERT OR DELETE OR UPDATE OF "note", "imported_at", "text", "image_urls", "source_at", "created_at", "message_id", "status", "sender_kind", "page_id", "thread_id" ON "sales_chat_inbound" FOR EACH ROW
	EXECUTE FUNCTION "sales_chat_inbound_turn_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sales_chat_staff_messages_turn" ON "sales_chat_staff_messages";
--> statement-breakpoint
CREATE TRIGGER "sales_chat_staff_messages_turn" AFTER INSERT OR DELETE OR UPDATE OF "status", "conversation_id" ON "sales_chat_staff_messages" FOR EACH ROW
	EXECUTE FUNCTION "sales_chat_staff_turn_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sales_chat_messages_turn" ON "sales_chat_messages";
--> statement-breakpoint
CREATE TRIGGER "sales_chat_messages_turn" AFTER INSERT OR DELETE OR UPDATE OF "role", "content", "seq", "created_at", "conversation_id" ON "sales_chat_messages" FOR EACH ROW
	EXECUTE FUNCTION "sales_chat_messages_turn_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sales_chat_reads_turn" ON "sales_chat_reads";
--> statement-breakpoint
CREATE TRIGGER "sales_chat_reads_turn" AFTER INSERT OR DELETE OR UPDATE OF "read_through_at", "conversation_id" ON "sales_chat_reads" FOR EACH ROW
	EXECUTE FUNCTION "sales_chat_reads_turn_trg"();
--> statement-breakpoint
-- Dẫn xuất TẤT ĐỊNH giá trị cũ — MỘT câu: mốc đọc = max con trỏ, rồi kết quả định nghĩa #803 trên sổ đã có với đúng mốc đọc ấy.
UPDATE "sales_chat_conversations" c SET "last_read_at" = x."m",
	"turn_unhandled" = "sales_chat_turn_unhandled_of"(c."id", c."page_id", c."thread_id", greatest(x."m", c."staff_seen_at"))
FROM (SELECT c2."id", (SELECT max(r."read_through_at") FROM "sales_chat_reads" r WHERE r."conversation_id" = c2."id") AS "m" FROM "sales_chat_conversations" c2) x
WHERE c."id" = x."id";
--> statement-breakpoint
-- Trigger của chính bảng hội thoại — SAU dẫn xuất (xem đầu tệp). Dựng / đổi page–luồng / đổi mốc mở / đổi mốc đọc ⇒ tính lại ngay.
DROP TRIGGER IF EXISTS "sales_chat_conversations_turn_ins" ON "sales_chat_conversations";
--> statement-breakpoint
CREATE TRIGGER "sales_chat_conversations_turn_ins" BEFORE INSERT ON "sales_chat_conversations" FOR EACH ROW
	EXECUTE FUNCTION "sales_chat_conversations_turn_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sales_chat_conversations_turn_upd" ON "sales_chat_conversations";
--> statement-breakpoint
CREATE TRIGGER "sales_chat_conversations_turn_upd" BEFORE UPDATE OF "page_id", "thread_id", "staff_seen_at", "last_read_at" ON "sales_chat_conversations" FOR EACH ROW
	WHEN (OLD."page_id" IS DISTINCT FROM NEW."page_id" OR OLD."thread_id" IS DISTINCT FROM NEW."thread_id" OR OLD."staff_seen_at" IS DISTINCT FROM NEW."staff_seen_at" OR OLD."last_read_at" IS DISTINCT FROM NEW."last_read_at")
	EXECUTE FUNCTION "sales_chat_conversations_turn_trg"();
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
