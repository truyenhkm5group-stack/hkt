import { getDb, schema } from "@/db";
import { activeUserIdsWhoCan } from "@/lib/auth/session";
import { markConnectionBrokenBySystem, openChannelPageToken } from "@/lib/connectors/service";
import { sendInboxMessages } from "@/lib/inbox/send";
import { needsReconnect, type GraphErrorKind } from "@/lib/integrations/messenger/graph-errors";

/**
 * ═══════════ MESSENGER TRỰC TIẾP: META NÓI TOKEN HỎNG ⇒ «CẦN NỐI LẠI» + BÁO NGƯỜI (gap analysis slice 3) ═══════════
 *
 * Trước đây lỗi 190 (token page bị thu hồi — người cấp đổi mật khẩu / gỡ quyền app / mất vai trò quản trị) chỉ thành một câu
 * lỗi trên dòng tin: không ai được báo, bot vẫn soạn câu (tốn lượt AI) rồi gửi hỏng mãi. Giờ, CHỈ với lỗi nói KẾT NỐI hỏng
 * (TOKEN · PERMISSION — ngoài 24 giờ / khách chặn page / chạm trần KHÔNG), theo NGUỒN của token đã dùng:
 *  · page có token RIÊNG (`org_channel_pages`, nối từ 0220): token hỏng là việc của ĐÚNG page đó — báo người (một chuông + một tin
 *    hộp thư mỗi page mỗi ngày), sức khoẻ page do nơi gửi ghi (`noteChannelPageHealth`). KHÔNG đụng kết nối chung (page khác vẫn
 *    chạy) và KHÔNG đổi trạng thái page — trạng thái page là lựa chọn của NGƯỜI (0220);
 *  · page cũ dùng token của hàng kết nối ĐƠN: kết nối về NHÁP qua đúng đường ghi của sổ kết nối (`markConnectionBrokenBySystem`,
 *    có điều kiện ⇒ một lần chuyển) và báo đúng lượt chuyển đó.
 * Lỗi của đường báo không bao giờ làm hỏng lượt gửi đang chạy.
 */

export const MESSENGER_CONNECTOR_KEY = "facebook-messenger";

async function notify(title: string, body: string, href: string, entityId: string, key: string, now: Date): Promise<void> {
  const db = await getDb();
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "critical", title, body, href, entityType: "ORG_CONNECTION", entityId, dedupeKey: key, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const users = await activeUserIdsWhoCan("settings:manage");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "CONNECTION_BROKEN", title, body, href, dedupeKey: `${key}:${userId}` })), db);
}

export async function noteMessengerGraphFailure(failure: { kind?: GraphErrorKind | null; error: string }, pageId: string, now: Date = new Date()): Promise<boolean> {
  if (!needsReconnect(failure.kind)) return false;
  try {
    const day = now.toISOString().slice(0, 10);
    const href = "/ai/sales-chatbot/messenger";
    const own = await openChannelPageToken(MESSENGER_CONNECTOR_KEY, pageId);
    if (own.ok) {
      const title = `Page ${pageId} cần nối lại`;
      const body = `${failure.error.slice(0, 400)} Chỉ page này không gửi được; các page khác vẫn chạy.`;
      await notify(title, body, href, `${MESSENGER_CONNECTOR_KEY}:${pageId}`, `messenger:reconnect:${pageId}:${day}`, now);
      return true;
    }
    const r = await markConnectionBrokenBySystem({ connectorKey: MESSENGER_CONNECTOR_KEY, reason: failure.error, actorLabel: "job:messenger-health" });
    if (!r.changed) return false;
    const title = "Messenger trực tiếp cần nối lại";
    const body = `${failure.error.slice(0, 400)} Bot và hộp thư tạm không gửi được qua Messenger / Instagram tới khi nối lại.`;
    await notify(title, body, href, MESSENGER_CONNECTOR_KEY, `messenger:reconnect:${day}`, now);
    return true;
  } catch {
    return false;
  }
}
