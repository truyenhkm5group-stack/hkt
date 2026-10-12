import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { INBOX_UNREAD_SWITCH_KEY, readInboxUnreadSwitch } from "@/lib/platform/inbox-unread-switch";
import { BOT_SENT_NOTE, PAGE_REPLY_NOTE, STAFF_OUT_ID_PREFIX } from "@/lib/sales-chatbot/response-ownership";
import { humanSeenAtSql, LEDGER_MEDIA_ONLY_NOTE, latestCustomerTurnUnhandledSql } from "@/lib/sales-chatbot/response-ownership-ledger";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ «TIN KHÁCH CHƯA ĐỌC» CỦA HỘP THƯ — CHỈ MÁY CHỦ (chủ shop 11/10/2026, OWNER CORRECTION · P0 inbox-unread-perf) ═══════════
 *
 * NGHĨA: LƯỢT KHÁCH MỚI NHẤT CHƯA ĐƯỢC XỬ LÝ — MỘT định nghĩa của response-ownership (#803): `latestCustomerTurnUnhandledSql()` (SQL) ≡
 * `latestTurnHandled` / `latestWebTurnHandled` (TS). Lượt khách đã xử lý khi SAU tin khách cuối có câu bot đã gửi, câu nhân viên hợp lệ,
 * câu phía page hợp lệ (không phải tin chào đầu phiên / tự động / chữ hệ thống), hoặc một NGƯỜI đã mở (con trỏ đọc của bất kỳ ai, mốc mở
 * cũ `staff_seen_at`). Tệp này KHÔNG có luật thứ hai.
 *
 * HIỆU NĂNG: định nghĩa là câu con nặng cho TỪNG hội thoại, và tất định theo dòng (không phụ thuộc «bây giờ») ⇒ trigger CSDL LƯU KẾT QUẢ
 * của chính nó vào `turn_unhandled` (drizzle/0245 — thân hàm CSDL dựng từ đúng hàm TS của #803, bài kiểm so từng ký tự). Hộp thư đọc
 * cột: một phép đọc trên dòng cho bộ đếm thẻ + khoá xếp của CẢ hộp thư. Cột NULL (chưa biết) ⇒ tính trực tiếp bằng hàm của #803.
 *
 * CÔNG TẮC LÙI (không cần deploy — lib/platform/inbox-unread-switch.ts): `settings` của CSDL NHÀ, khoá `inbox.unread.materialized`,
 * `{"enabled": false}` ⇒ MỌI tổ chức tính «chưa đọc» trực tiếp bằng `latestCustomerTurnUnhandledSql()` của #803 — không nhắc tới hai
 * cột lưu sẵn. CSDL chưa có hai cột (0245 chưa áp / áp hỏng) ⇒ cũng tự lùi, không bao giờ lỗi «column does not exist». Đọc ĐÚNG MỘT
 * chỗ (`inboxUnreadMaterialized`, đệm `memo` 60 giây theo tổ chức). Công tắc chỉ đổi ĐƯỜNG ĐỌC — trigger 0245 vẫn giữ cột đúng, nên
 * bật lại là dùng được ngay, không phải dẫn xuất lại.
 */

const col = (name: string) => sql.raw(`"sales_chat_conversations"."${name}"`);
const NEG_INF = sql`'-infinity'::timestamptz`;

/** CHƯA ĐỌC vận hành — kết quả lưu sẵn của định nghĩa #803; NULL ⇒ tính trực tiếp. */
export const INBOX_UNREAD_SQL: SQL<boolean> = sql<boolean>`coalesce(${col("turn_unhandled")}, ${latestCustomerTurnUnhandledSql()}, false)`;

/** Mốc «người đã mở» của CỬA HÀNG (con trỏ lớn nhất của mọi người · mốc mở cũ) — hàng mang nó để trình duyệt so với xác nhận đọc. */
export const INBOX_SEEN_AT_SQL = sql<Date | null>`greatest(${col("last_read_at")}, ${col("staff_seen_at")})`;

/**
 * «Tin khách» của MỘT dòng sổ tin thô — đúng vế `customer` của #803 (response-ownership-ledger.ts): không nhập lịch sử, ghi chú khác
 * BOT_SENT / PAGE_REPLY, và là tin MEDIA_ONLY (nhãn dán / ghi âm — người phải thấy) hoặc có chữ hoặc có ảnh.
 */
export function turnCustomerRowSql(a = "i"): SQL {
  const t = sql.raw(a);
  return sql`(${t}.imported_at is null and coalesce(${t}.note, '') not in (${BOT_SENT_NOTE}, ${PAGE_REPLY_NOTE})
    and (${t}.note = ${LEDGER_MEDIA_ONLY_NOTE} or ${t}.text ~ '[^[:space:]]' or (jsonb_typeof(${t}.image_urls) = 'array' and jsonb_array_length(${t}.image_urls) > 0)))`;
}

/**
 * HUY HIỆU — số tin khách CHƯA XỬ LÝ hiện tại (trần 100 — hàng in «99+»): tin khách mới hơn cả mốc «người đã mở» lẫn câu trả lời chắc
 * chắn hợp lệ gần nhất (kênh nhắn tin: bot · nhân viên ERP · người đã xác minh / AI phía page; chat web: dòng assistant có chữ). CHỈ có
 * nghĩa khi cờ nói «chưa đọc»; khi đó số ≥ 1 (cờ đã chứng minh có lượt khách chưa xử lý) ⇒ `chưa đọc ⇔ số ≥ 1`. Câu danh sách chỉ tính
 * nó cho các dòng của trang (Postgres hoãn biểu thức đắt tới sau LIMIT).
 */
export function inboxUnreadPendingCountSql(seenAt: SQL = INBOX_SEEN_AT_SQL): SQL<number> {
  const seen = sql`coalesce(${seenAt}, ${NEG_INF})`;
  const answer = sql`(o.imported_at is null and (o.note = ${BOT_SENT_NOTE} or (o.note = ${PAGE_REPLY_NOTE} and (o.message_id like ${`${STAFF_OUT_ID_PREFIX}%`}
    or o.sender_kind in ('VERIFIED_HUMAN', 'AI_AGENT')))))`;
  const lastAnswer = sql`(select max(o.created_at) from "sales_chat_inbound" o where o.page_id = ${col("page_id")} and o.thread_id = ${col("thread_id")} and ${answer})`;
  const TEXT = sql`'[{"type":"text"}]'::jsonb`;
  const lastWebAnswer = sql`(select max(a.seq) from "sales_chat_messages" a where a.conversation_id = ${col("id")} and a.role = 'assistant' and a.content @> ${TEXT})`;
  return sql<number>`greatest(1, (case when ${col("page_id")} is not null and ${col("thread_id")} is not null
    then (select count(*)::int from (select 1 from "sales_chat_inbound" i where i.page_id = ${col("page_id")} and i.thread_id = ${col("thread_id")} and ${turnCustomerRowSql("i")}
      and i.created_at > greatest(${seen}, coalesce(${lastAnswer}, ${NEG_INF})) limit 100) x)
    else (select count(*)::int from (select 1 from "sales_chat_messages" m where m.conversation_id = ${col("id")} and m.role = 'user' and m.content @> ${TEXT}
      and m.created_at > ${seen} and m.seq > coalesce(${lastWebAnswer}, -1) limit 100) y) end))`;
}

/** Số tin khách chưa xử lý KÈM cờ (một hội thoại — xác nhận đọc, audit): 0 khi đã xử lý. */
export const INBOX_UNREAD_COUNT_SQL = sql<number>`(case when ${INBOX_UNREAD_SQL} then ${inboxUnreadPendingCountSql()} else 0 end)`;

// ─────────────────────────── Công tắc lùi: lưu sẵn ⇄ tính trực tiếp ───────────────────────────

/** Khoá công tắc trong `settings` của CSDL NHÀ — `{"enabled": false}` ⇒ hộp thư mọi tổ chức tính trực tiếp bằng hàm #803. */
export { INBOX_UNREAD_SWITCH_KEY };

/** Bộ biểu thức «chưa đọc» của hộp thư cho MỘT lượt tải — cùng một nguồn cho bộ lọc, bộ đếm thẻ, khoá xếp, huy hiệu và xác nhận đọc. */
export type InboxUnreadSql = {
  /** `true` = đọc kết quả lưu sẵn 0245; `false` = tính trực tiếp bằng `latestCustomerTurnUnhandledSql()` của #803. */
  materialized: boolean;
  unread: SQL<boolean>;
  seenAt: SQL<Date | null>;
  pendingCount: SQL<number>;
  count: SQL<number>;
};

/** HÀM THUẦN: bộ biểu thức theo chế độ. Nhánh tính trực tiếp KHÔNG nhắc tới cột 0245 (CSDL chưa có cột vẫn chạy). */
export function inboxUnreadSqlFor(materialized: boolean): InboxUnreadSql {
  if (materialized) return { materialized, unread: INBOX_UNREAD_SQL, seenAt: INBOX_SEEN_AT_SQL, pendingCount: inboxUnreadPendingCountSql(), count: INBOX_UNREAD_COUNT_SQL };
  const unread = sql<boolean>`coalesce(${latestCustomerTurnUnhandledSql()}, false)`;
  const seenAt = sql<Date | null>`${humanSeenAtSql(col("id"), col("staff_seen_at"))}`;
  const pendingCount = inboxUnreadPendingCountSql(seenAt);
  return { materialized, unread, seenAt, pendingCount, count: sql<number>`(case when ${unread} then ${pendingCount} else 0 end)` };
}

/**
 * Công tắc đang ở đâu cho tổ chức hiện tại: `settings` NHÀ chưa tắt VÀ CSDL của tổ chức đã có hai cột 0245. Lỗi đọc ⇒ coi như tắt
 * (đường tính trực tiếp luôn đúng, chỉ chậm hơn — mọi nhánh lỗi rơi về phía KHÔNG phụ thuộc cột lưu sẵn).
 */
export async function inboxUnreadMaterialized(): Promise<boolean> {
  return memo("inbox-unread-switch", 60_000, async () => {
    if ((await readInboxUnreadSwitch()) !== true) return false;
    try {
      const db = await getDb();
      const [r] = rowsOf<{ n: number }>(
        await db.execute(sql`select count(*)::int as n from information_schema.columns where table_schema = current_schema() and table_name = 'sales_chat_conversations' and column_name in ('turn_unhandled', 'last_read_at')`),
      );
      return Number(r?.n) === 2;
    } catch {
      return false;
    }
  });
}

/** MỘT chỗ đọc công tắc: bộ biểu thức «chưa đọc» cho lượt tải hộp thư / xác nhận đọc. */
export async function loadInboxUnreadSql(): Promise<InboxUnreadSql> {
  return inboxUnreadSqlFor(await inboxUnreadMaterialized());
}
