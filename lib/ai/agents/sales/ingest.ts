/**
 * NẠP HỘI THOẠI PANCAKE vào miền bán hàng.
 *
 * Hai đường vào, CÙNG một hàm ghi:
 *   • Webhook chat (`/api/webhooks/pancake-chat/<bí mật>`) — tức thì, có thể trùng, có thể thiếu.
 *   • Job đọc Pages API — chậm hơn nhưng chắc chắn, vá những gói tin webhook đánh rơi.
 *
 * Vì cả hai cùng ghi một chỗ, chống trùng phải nằm ở TẦNG DỮ LIỆU chứ không nằm ở tầng gọi:
 * khoá duy nhất `(conversation_id, external_id)` của `sales_messages`. Webhook gửi lại lần thứ
 * năm và job chạy cùng lúc vẫn chỉ ra một dòng.
 *
 * CHỐNG VÒNG LẶP: tin `from_page` (shop gửi, kể cả tin do chính nhân sự AI gửi) KHÔNG BAO GIỜ
 * sinh sự kiện. Thiếu luật này, một tin máy gửi ra sẽ quay lại thành một tin cần trả lời, và
 * con bot sẽ tự nói chuyện với chính nó cho tới khi hết tiền.
 */
import { and, eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { asArray, asRecord, str } from "@/lib/integrations/http";
import { getPancakePagesClient, type PancakeMessage } from "@/lib/integrations/pancake/pages";
import { stripHtml } from "@/lib/text";
import { normalizePhone } from "@/lib/constants/landing";
import { emitAndDispatch, recordAiError } from "@/lib/ai/events";
import { aiEventKey } from "@/lib/constants/ai-events";
import { getAiSettings } from "@/lib/ai/config";

export type NormalizedMessage = {
  externalId: string;
  text: string;
  fromPage: boolean;
  fromName: string;
  sentAt: Date | null;
  hasAttachment: boolean;
  raw: Record<string, unknown>;
};

export type NormalizedConversation = {
  pageId: string;
  externalId: string;
  pancakeCustomerId: string;
  customerName: string;
  phone: string;
};

function toDate(value: unknown): Date | null {
  if (typeof value === "number") return new Date(value > 1e12 ? value : value * 1000);
  const s = str(value);
  if (!s) return null;
  // Pancake trả ISO không múi giờ nhưng là UTC — gắn Z vào đúng như mapper đơn hàng đang làm.
  const d = new Date(/^\d{4}-\d{2}-\d{2}T/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? `${s}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Chuẩn hoá gói tin webhook chat của Pancake. Hình dạng gói tin không được bảo đảm giữa các bản
 * API nên hàm này nhận nhiều biến thể và trả `null` khi không đủ khoá — thiếu khoá thì không có
 * cách nào chống trùng, mà ghi một dòng không chống trùng được là mở cửa cho tin nhân bản.
 */
export function normalizeChatWebhook(payload: unknown): { conversation: NormalizedConversation; message: NormalizedMessage } | null {
  const root = asRecord(payload);
  const body = asRecord(root.data ?? root.message ?? root);
  const conversationRaw = asRecord(root.conversation ?? body.conversation ?? root);
  const pageId = str(root.page_id, body.page_id, conversationRaw.page_id);
  const conversationId = str(root.conversation_id, body.conversation_id, conversationRaw.id, conversationRaw.conversation_id);
  const messageId = str(body.id, body.message_id, root.message_id);
  if (!pageId || !conversationId || !messageId) return null;

  const from = asRecord(body.from ?? root.from);
  const fromId = str(from.id, body.from_id);
  const customer = asRecord(conversationRaw.customer ?? root.customer ?? (from.id && fromId !== pageId ? from : {}));
  const phones = [...asArray(conversationRaw.recent_phone_numbers), ...asArray(customer.phone_numbers)]
    .map((p) => normalizePhone(str(asRecord(p).phone_number, p)))
    .filter((p) => /^0\d{9}$/.test(p));

  const fromPage = fromId === pageId || Boolean(body.from_page) || str(body.type) === "page" || str(root.type).includes("page");
  return {
    conversation: {
      pageId,
      externalId: conversationId,
      pancakeCustomerId: str(customer.id, customer.fb_id),
      customerName: str(customer.name, from.name),
      phone: phones[0] ?? "",
    },
    message: {
      externalId: messageId,
      text: stripHtml(str(body.message, body.original_message, body.text)),
      fromPage,
      fromName: str(from.name),
      sentAt: toDate(body.inserted_at ?? body.created_time ?? body.created_at ?? root.inserted_at),
      hasAttachment: asArray(body.attachments).length > 0,
      raw: body,
    },
  };
}

/** Tìm hoặc tạo dòng hội thoại. Khoá tự nhiên `(page_id, external_id)`. */
export async function upsertConversation(conversation: NormalizedConversation, db?: Db): Promise<string> {
  const conn = db ?? (await getDb());
  const existing = await conn.query.salesConversations.findFirst({
    where: and(eq(schema.salesConversations.pageId, conversation.pageId), eq(schema.salesConversations.externalId, conversation.externalId)),
    columns: { id: true, customerName: true, phone: true, pancakeCustomerId: true },
  });
  if (existing) {
    // Chỉ BỔ SUNG chỗ còn trống; không đè tên / SĐT đã có bằng giá trị rỗng của một gói tin nghèo.
    const patch: Record<string, unknown> = {};
    if (!existing.customerName && conversation.customerName) patch.customerName = conversation.customerName;
    if (!existing.phone && conversation.phone) patch.phone = conversation.phone;
    if (!existing.pancakeCustomerId && conversation.pancakeCustomerId) patch.pancakeCustomerId = conversation.pancakeCustomerId;
    if (Object.keys(patch).length) {
      await conn.update(schema.salesConversations).set({ ...patch, updatedAt: new Date() }).where(eq(schema.salesConversations.id, existing.id));
    }
    return existing.id;
  }
  const [row] = await conn
    .insert(schema.salesConversations)
    .values({
      channel: "PANCAKE",
      pageId: conversation.pageId,
      externalId: conversation.externalId,
      pancakeCustomerId: conversation.pancakeCustomerId,
      customerName: conversation.customerName,
      phone: conversation.phone,
      stage: "NEW_LEAD",
    })
    .onConflictDoNothing({ target: [schema.salesConversations.pageId, schema.salesConversations.externalId] })
    .returning({ id: schema.salesConversations.id });
  if (row) return row.id;
  // Hai tiến trình cùng tạo một hội thoại: kẻ thua đọc lại dòng của kẻ thắng.
  const again = await conn.query.salesConversations.findFirst({
    where: and(eq(schema.salesConversations.pageId, conversation.pageId), eq(schema.salesConversations.externalId, conversation.externalId)),
    columns: { id: true },
  });
  if (!again) throw new Error("Không tạo được hội thoại bán hàng");
  return again.id;
}

export type IngestResult = { conversationId: string; messageId: string | null; duplicate: boolean; eventEmitted: boolean; reason: string };

/**
 * Ghi một tin nhắn và (nếu là tin của KHÁCH) phát sự kiện `CUSTOMER_MESSAGE_RECEIVED`.
 * Idempotent theo `(conversation_id, external_id)`.
 */
export async function ingestMessage(conversation: NormalizedConversation, message: NormalizedMessage, source: string, db?: Db): Promise<IngestResult> {
  const conn = db ?? (await getDb());
  const conversationId = await upsertConversation(conversation, conn);
  if (!message.externalId) {
    return { conversationId, messageId: null, duplicate: false, eventEmitted: false, reason: "Tin nhắn không có mã — không ghi được vì không chống trùng được" };
  }
  const [inserted] = await conn
    .insert(schema.salesMessages)
    .values({
      conversationId,
      externalId: message.externalId,
      direction: message.fromPage ? "OUT" : "IN",
      fromPage: message.fromPage,
      fromName: message.fromName,
      text: message.text,
      hasAttachment: message.hasAttachment,
      sentAt: message.sentAt,
      raw: message.raw,
    })
    .onConflictDoNothing({ target: [schema.salesMessages.conversationId, schema.salesMessages.externalId] })
    .returning({ id: schema.salesMessages.id });

  if (!inserted) {
    return { conversationId, messageId: null, duplicate: true, eventEmitted: false, reason: "Tin nhắn đã có trong ERP (gói tin gửi lại)" };
  }

  const stamp = message.sentAt ?? new Date();
  await conn
    .update(schema.salesConversations)
    .set(message.fromPage ? { lastShopMessageAt: stamp, updatedAt: new Date() } : { lastCustomerMessageAt: stamp, updatedAt: new Date() })
    .where(eq(schema.salesConversations.id, conversationId));

  // TẮT TỔNG: vẫn GHI tin nhắn (lịch sử hội thoại là dữ liệu, mất là mất hẳn) nhưng KHÔNG tạo
  // việc cho máy. Chốt chặn này nằm ở chính đường ghi, nên webhook hay job nạp bù đều không thể
  // đi vòng qua nó.
  const settings = await getAiSettings();
  if (!settings.enabled) {
    return { conversationId, messageId: inserted.id, duplicate: false, eventEmitted: false, reason: "Nền tảng AI đang tắt — đã ghi tin nhắn nhưng không tạo việc" };
  }

  // CHỐNG VÒNG LẶP: tin của shop không bao giờ trở thành việc cho máy.
  if (message.fromPage) {
    await linkHumanReply(conversationId, message, conn);
    return { conversationId, messageId: inserted.id, duplicate: false, eventEmitted: false, reason: "Tin của shop — không tạo việc cho nhân sự AI (chống vòng lặp)" };
  }
  if (!message.text.trim()) {
    return { conversationId, messageId: inserted.id, duplicate: false, eventEmitted: false, reason: "Tin không có chữ (ảnh / sticker) — chưa xử lý ở bản này" };
  }

  await emitAndDispatch(
    {
      type: "CUSTOMER_MESSAGE_RECEIVED",
      source,
      subjectType: "CONVERSATION",
      subjectId: conversationId,
      payload: { messageId: inserted.id, externalId: message.externalId, pageId: conversation.pageId, conversationExternalId: conversation.externalId },
      occurredAt: message.sentAt,
      dedupeKey: aiEventKey("CUSTOMER_MESSAGE_RECEIVED", [conversationId, message.externalId]),
    },
    conn,
  );
  return { conversationId, messageId: inserted.id, duplicate: false, eventEmitted: true, reason: "Đã tạo việc cho nhân sự bán hàng" };
}

/**
 * Nối câu NHÂN VIÊN thực sự trả lời vào gợi ý gần nhất của máy.
 * Đây là toàn bộ giá trị của nấc SHADOW: đặt hai câu cạnh nhau để đo xem máy có làm được việc không.
 */
async function linkHumanReply(conversationId: string, message: NormalizedMessage, db: Db) {
  if (!message.text.trim()) return;
  const suggestion = await db.query.salesSuggestions.findFirst({
    where: and(eq(schema.salesSuggestions.conversationId, conversationId), eq(schema.salesSuggestions.humanReply, "")),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
    columns: { id: true, createdAt: true },
  });
  if (!suggestion) return;
  const at = message.sentAt ?? new Date();
  // Chỉ nối câu gửi SAU gợi ý; câu trước đó là của cuộc đối thoại khác.
  if (suggestion.createdAt && at.getTime() < suggestion.createdAt.getTime()) return;
  await db
    .update(schema.salesSuggestions)
    .set({ humanReply: message.text.slice(0, 4000), humanRepliedAt: at })
    .where(eq(schema.salesSuggestions.id, suggestion.id));
}

/** Nạp từ gói tin webhook. Trả lý do đọc được khi không nạp được — không nuốt lặng. */
export async function ingestChatWebhook(payload: unknown, db?: Db): Promise<IngestResult | { conversationId: null; reason: string }> {
  const settings = await getAiSettings();
  if (!settings.enabled || !settings.ingestEnabled) return { conversationId: null, reason: "Nạp hội thoại đang tắt trong cấu hình" };
  const normalized = normalizeChatWebhook(payload);
  if (!normalized) return { conversationId: null, reason: "Gói tin thiếu page_id / conversation_id / message_id" };
  return ingestMessage(normalized.conversation, normalized.message, "pancake-chat-webhook", db);
}

function toNormalizedMessage(m: PancakeMessage): NormalizedMessage {
  return {
    externalId: m.id,
    text: stripHtml(m.text),
    fromPage: m.fromPage,
    fromName: m.fromName,
    sentAt: m.insertedAt,
    hasAttachment: m.hasAttachment,
    raw: {},
  };
}

/**
 * Job nạp bù: đọc hội thoại cập nhật trong N giờ gần nhất qua Pages API.
 * Chạy được song song với webhook vì chống trùng nằm ở tầng dữ liệu.
 */
export async function syncSalesConversations(options: { hours?: number; limit?: number } = {}) {
  const settings = await getAiSettings();
  if (!settings.enabled || !settings.ingestEnabled) return { skipped: true, reason: "Nạp hội thoại đang tắt", conversations: 0, messages: 0, events: 0 };
  const hours = Math.min(Math.max(options.hours ?? 6, 1), 24 * 7);
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 300);
  const db = await getDb();
  const client = getPancakePagesClient();
  const until = new Date();
  const since = new Date(until.getTime() - hours * 3_600_000);
  let conversations = 0;
  let messages = 0;
  let events = 0;
  const errors: string[] = [];

  const pages = await client.listPages();
  for (const page of pages) {
    let conversationList: Awaited<ReturnType<typeof client.listConversations>> = [];
    try {
      conversationList = await client.listConversations(page.id, since, until, limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${page.name}: ${message}`);
      await recordAiError({ scope: "INGEST", agentKey: "sales", message: `Không đọc được hội thoại page ${page.id}: ${message}` }, db);
      continue;
    }
    for (const conversation of conversationList) {
      conversations += 1;
      try {
        const fetched = await client.listMessages(page.id, conversation.id, conversation.customerId, 30);
        // Cũ trước: trạng thái bán hàng chỉ đúng khi tin nhắn được nạp theo đúng thứ tự xảy ra.
        const ordered = [...fetched].sort((a, b) => (a.insertedAt?.getTime() ?? 0) - (b.insertedAt?.getTime() ?? 0));
        for (const raw of ordered) {
          const result = await ingestMessage(
            {
              pageId: page.id,
              externalId: conversation.id,
              pancakeCustomerId: conversation.customerId,
              customerName: conversation.customerName,
              phone: conversation.phones.map(normalizePhone).find((p) => /^0\d{9}$/.test(p)) ?? "",
            },
            toNormalizedMessage(raw),
            "pancake-pages-poll",
            db,
          );
          if (!result.duplicate && result.messageId) messages += 1;
          if (result.eventEmitted) events += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${conversation.id}: ${message}`);
        await recordAiError({ scope: "INGEST", agentKey: "sales", subjectType: "CONVERSATION", subjectId: conversation.id, message }, db);
      }
    }
  }
  return { skipped: false, hours, conversations, messages, events, errors: errors.slice(0, 20) };
}
