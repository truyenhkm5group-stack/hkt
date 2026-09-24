-- ═══════════ KẾT LUẬN NGỮ NGHĨA ĐÃ TRẢ TIỀN — MỘT CÂU HỎI Y HỆT KHÔNG HỎI MODEL LẦN HAI ═══════════
--
-- Job `cs-chat` quét lại mọi hội thoại trong 48 giờ gần nhất mỗi 15 phút, và trước bản này nó gọi
-- model cho MỌI hội thoại có dấu hiệu ở MỌI lượt — kể cả hội thoại không có một tin mới nào. Khoá là
-- dấu vân tay của toàn bộ đầu vào gửi model (xem `lib/cs/semantic-cache.ts`).
--
-- THUẦN BỔ SUNG: một bảng mới, không đụng bảng nào khác, không backfill. Bảng rỗng = mọi hội thoại
-- được hỏi model như cũ ở lượt đầu tiên. Xoá sạch bảng chỉ tốn một lượt hỏi lại, không mất dữ liệu
-- nghiệp vụ nào — kết luận của case vẫn nằm ở `cs_cases`.
CREATE TABLE IF NOT EXISTS "cs_semantic_verdicts" (
  "fingerprint" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL,
  "model" text NOT NULL,
  "verdict" jsonb NOT NULL,
  "hits" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cs_semantic_verdicts_last_used_idx" ON "cs_semantic_verdicts" ("last_used_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cs_semantic_verdicts_conversation_idx" ON "cs_semantic_verdicts" ("conversation_id");
