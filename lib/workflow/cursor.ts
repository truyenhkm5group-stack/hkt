/**
 * ═══════════ CON TRỎ TIÊU THỤ `domain_events` CỦA WORKFLOW — CHỈ MÁY CHỦ ═══════════
 *
 * Một dòng `workflow_cursors['domain_events']` mỗi CSDL tổ chức: vị trí `(recorded_at, id)` của sự kiện cuối cùng
 * đã được xét. Con trỏ CHỈ TIẾN — mọi lượt ghi là so-sánh-rồi-đổi trên giá trị cũ, nên hai lượt chạy chồng nhau
 * không kéo nó lùi (lượt chậm hơn đổi hụt, và lượt chạy trùng sự kiện đã bị `workflow_runs.dedupe_key` chặn).
 *
 * `recorded_at` giữ tới MICRO giây; `Date` của JS chỉ có mili giây. Con trỏ lưu chuỗi micro giây do CSDL tự in
 * (`to_char … US`) và so ngược lại bằng `::timestamptz` — cắt về mili giây thì sự kiện cùng mili giây bị đọc lại
 * mãi, hoặc bị bỏ sót.
 *
 * LƯỢT ĐẦU KHÔNG XỬ LÝ LỊCH SỬ: con trỏ chưa có ⇒ đặt ở sự kiện MỚI NHẤT hiện có. Một tổ chức bật luật đầu tiên
 * hôm nay không được thấy máy "bắn lại" mọi lần đổi trạng thái của cả năm qua — luật được khai cho những gì
 * xảy ra TỪ GIỜ. Con trỏ được khởi tạo ngay lúc một luật được BẬT (`setRuleStatus` ACTIVE), nên sự kiện đầu
 * tiên sau lúc bật không bị lượt khởi tạo nuốt mất.
 */
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";

export const EVENT_CURSOR_KEY = "domain_events";

export type CursorPos = { at: string; id: string };

/** Mốc "trước mọi sự kiện" — CSDL chưa có sự kiện nào lúc khởi tạo. */
const ORIGIN: CursorPos = { at: "1970-01-01T00:00:00.000000Z", id: "" };

/** Biểu thức SQL in `recorded_at` tới micro giây, giờ UTC. */
export const RECORDED_AT_TEXT = sql<string>`to_char(${schema.domainEvents.recordedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function encodeCursor(p: CursorPos): string {
  return `${p.at}|${p.id}`;
}

export function decodeCursor(v: string | null | undefined): CursorPos | null {
  if (!v) return null;
  const i = v.indexOf("|");
  if (i <= 0) return null;
  return { at: v.slice(0, i), id: v.slice(i + 1) };
}

export async function readEventCursor(db: Db): Promise<CursorPos | null> {
  const [row] = await db.select({ value: schema.workflowCursors.value }).from(schema.workflowCursors).where(sql`${schema.workflowCursors.key} = ${EVENT_CURSOR_KEY}`);
  return decodeCursor(row?.value);
}

/** Con trỏ hiện tại; chưa có thì khởi tạo ở sự kiện mới nhất (lượt đầu không xử lý lịch sử). */
export async function ensureEventCursor(db: Db): Promise<CursorPos> {
  const cur = await readEventCursor(db);
  if (cur) return cur;
  const ev = schema.domainEvents;
  const [latest] = await db
    .select({ id: ev.id, at: RECORDED_AT_TEXT })
    .from(ev)
    .orderBy(sql`${ev.recordedAt} desc`, sql`${ev.id} desc`)
    .limit(1);
  const pos = latest ? { at: latest.at, id: latest.id } : ORIGIN;
  await db.insert(schema.workflowCursors).values({ key: EVENT_CURSOR_KEY, value: encodeCursor(pos) }).onConflictDoNothing();
  return (await readEventCursor(db)) ?? pos;
}

/** Tiến con trỏ từ `from` tới `to` — so-sánh-rồi-đổi, không bao giờ lùi. Trả `true` khi đã tiến. */
export async function advanceEventCursor(db: Db, from: CursorPos, to: CursorPos): Promise<boolean> {
  if (encodeCursor(from) === encodeCursor(to)) return false;
  const rows = await db
    .update(schema.workflowCursors)
    .set({ value: encodeCursor(to), updatedAt: new Date() })
    .where(sql`${schema.workflowCursors.key} = ${EVENT_CURSOR_KEY} and ${schema.workflowCursors.value} = ${encodeCursor(from)}`)
    .returning({ key: schema.workflowCursors.key });
  return rows.length > 0;
}
