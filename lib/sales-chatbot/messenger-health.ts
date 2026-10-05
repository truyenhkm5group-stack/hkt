import { getDb, schema } from "@/db";
import { activeUserIdsWhoCan } from "@/lib/auth/session";
import { markConnectionBrokenBySystem } from "@/lib/connectors/service";
import { sendInboxMessages } from "@/lib/inbox/send";
import { needsReconnect, type GraphErrorKind } from "@/lib/integrations/messenger/graph-errors";

/**
 * ═══════════ MESSENGER TRỰC TIẾP: META NÓI TOKEN HỎNG ⇒ «CẦN NỐI LẠI» + BÁO NGƯỜI (gap analysis slice 3) ═══════════
 *
 * Trước đây lỗi 190 (token page bị thu hồi — người cấp đổi mật khẩu / gỡ quyền app / mất vai trò quản trị) chỉ thành một câu
 * lỗi trên dòng tin: kết nối vẫn «Đang bật», bot vẫn soạn câu (tốn lượt AI) rồi gửi hỏng mãi, và không ai được báo. Giờ:
 *  · chỉ lỗi nói KẾT NỐI hỏng (TOKEN · PERMISSION) mới đụng tới kết nối — ngoài 24 giờ / khách chặn page / chạm trần KHÔNG;
 *  · kết nối về NHÁP qua đúng đường ghi của sổ kết nối (`markConnectionBrokenBySystem`, có điều kiện ⇒ một lần chuyển);
 *  · đúng lượt chuyển đó báo MỘT chuông + một tin hộp thư cho người cấu hình được kết nối, kèm việc phải làm.
 * Lỗi của đường báo không bao giờ làm hỏng lượt gửi đang chạy.
 */

export const MESSENGER_CONNECTOR_KEY = "facebook-messenger";

export async function noteMessengerGraphFailure(failure: { kind?: GraphErrorKind | null; error: string }, now: Date = new Date()): Promise<boolean> {
  if (!needsReconnect(failure.kind)) return false;
  try {
    const r = await markConnectionBrokenBySystem({ connectorKey: MESSENGER_CONNECTOR_KEY, reason: failure.error, actorLabel: "job:messenger-health" });
    if (!r.changed) return false;
    const title = "Messenger trực tiếp cần nối lại";
    const body = `${failure.error.slice(0, 400)} Bot và hộp thư tạm không gửi được qua Messenger / Instagram tới khi nối lại.`;
    const href = "/ai/sales-chatbot/messenger";
    const key = `messenger:reconnect:${now.toISOString().slice(0, 10)}`;
    const db = await getDb();
    await db
      .insert(schema.notifications)
      .values({ kind: "SYSTEM", severity: "critical", title, body, href, entityType: "ORG_CONNECTION", entityId: MESSENGER_CONNECTOR_KEY, dedupeKey: key, occurredAt: now })
      .onConflictDoNothing({ target: schema.notifications.dedupeKey });
    const users = await activeUserIdsWhoCan("settings:manage");
    await sendInboxMessages(users.map((userId) => ({ userId, kind: "CONNECTION_BROKEN", title, body, href, dedupeKey: `${key}:${userId}` })), db);
    return true;
  } catch {
    return false;
  }
}
