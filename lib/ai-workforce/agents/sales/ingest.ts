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
import { and, eq, lte } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { asArray, asRecord, str } from "@/lib/integrations/http";
import { getPancakePagesClient, type PancakeMessage } from "@/lib/integrations/pancake/pages";
import { normalize, stripHtml } from "@/lib/text";
import { AD_AUTO_GREETING_PHRASES, BOT_SENDER_NAMES, CHAT_FIELD_MAP, SYSTEM_NOTICE_PHRASES, REQUIRED_CHAT_FIELDS, type ChatRejectReason, type IngestSource, type SenderType } from "@/lib/constants/sales-ingest";
import { normalizePhone } from "@/lib/constants/landing";
import { emitAndDispatch, recordAiError } from "@/lib/ai-workforce/events";
import { aiEventKey } from "@/lib/constants/ai-events";
import { getAiSettings } from "@/lib/ai-workforce/config";

export type NormalizedMessage = {
  externalId: string;
  text: string;
  fromPage: boolean;
  /** CUSTOMER · PAGE_HUMAN · PAGE_BOT · UNKNOWN — xem `lib/constants/sales-ingest.ts`. */
  senderType: SenderType;
  fromName: string;
  sentAt: Date | null;
  hasAttachment: boolean;
  attachmentCount: number;
  /** Mã quảng cáo khách đã bấm — tín hiệu sản phẩm mạnh nhất có thật. Rỗng = tin không kèm quảng cáo. */
  adId?: string;
  /** Câu quảng cáo (chữ của shop). Thường chứa thẳng tên mẫu. */
  adDescription?: string;
  postUrl?: string;
  attachmentTypes?: string[];
  adMediaUrl?: string;
  raw: Record<string, unknown>;
};

export type NormalizedConversation = {
  pageId: string;
  externalId: string;
  pancakeCustomerId: string;
  customerName: string;
  phone: string;
  /** facebook · instagram · … Rỗng = chưa biết (chỉ chắc khi đọc từ danh sách page). */
  platform: string;
};

/**
 * Kết quả chuẩn hoá. Từ chối KHÔNG bao giờ là `null` trống: nó mang theo lý do và danh sách khoá
 * thật sự có trong gói tin, để một mẫu thật là đủ để hoàn thiện ánh xạ.
 */
export type NormalizeResult =
  | { ok: true; conversation: NormalizedConversation; message: NormalizedMessage }
  | { ok: false; reason: ChatRejectReason; missing: string[]; seenKeys: string[] };

/** Tên người gửi có phải MÁY không. So khớp theo cụm, không dấu, không phân biệt hoa thường. */
export function isBotName(name: string): boolean {
  const n = normalize(name);
  return BOT_SENDER_NAMES.some((bot) => n.includes(` ${bot} `));
}

/**
 * Phân loại người gửi. `fromPage` mới chỉ nói tin đến từ phía shop — chưa nói là NGƯỜI hay MÁY,
 * mà phân biệt đúng hai thứ đó là điều kiện để so sánh AI với nhân viên.
 */
export function classifySender(input: {
  fromPage: boolean;
  fromName: string;
  fromAgent?: boolean;
  /** Nội dung tin — cần để nhận ra thông báo do nền tảng sinh. */
  text?: string;
  /** Tên khách của hội thoại — tin phía shop mang ĐÚNG tên này không thể là nhân viên viết. */
  customerName?: string;
}): SenderType {
  if (!input.fromPage) return "CUSTOMER";
  if (input.fromAgent || isBotName(input.fromName)) return "PAGE_BOT";

  /*
    THÔNG BÁO CỦA NỀN TẢNG — nhận ra bằng HAI dấu hiệu độc lập, mỗi cái đủ để kết luận.

    Đo 15/09/2026: 17/18 hội thoại trong mẻ thật bị kết luận "người đã tiếp quản" vì những chuỗi
    này, và nhân sự AI dừng ở toàn bộ hội thoại đến từ quảng cáo.
  */
  const noiDung = normalize(input.text ?? "");
  // ① Chuỗi sự kiện của Facebook. Danh sách HẸP, xem `SYSTEM_NOTICE_PHRASES`.
  if (SYSTEM_NOTICE_PHRASES.some((p) => noiDung.includes(p))) return "PAGE_SYSTEM";
  // ② Tin phía shop mang ĐÚNG tên khách: không nhân viên nào viết dưới tên khách hàng. Dấu hiệu
  //    này không cần danh sách chuỗi nào, nên nó bắt được cả những mẫu thông báo chưa từng thấy.
  const tenKhach = normalize(input.customerName ?? "").trim();
  if (tenKhach && normalize(input.fromName).trim() === tenKhach) return "PAGE_SYSTEM";
  // ③ Lời chào tự động của quảng cáo click-to-message.
  if (AD_AUTO_GREETING_PHRASES.some((p) => noiDung.includes(p))) return "PAGE_SYSTEM";

  // Tin của shop không rõ tên người gửi: KHÔNG đoán là nhân viên. Đoán sai theo hướng đó sẽ
  // tính một tin máy thành "câu nhân viên trả lời" và mọi phép đo đối chiếu đều lệch.
  return input.fromName.trim() ? "PAGE_HUMAN" : "UNKNOWN";
}

/**
 * Dấu vân tay NỘI DUNG của một tin nhắn, dùng để bắt trùng CHÉO KÊNH khi webhook và API đọc bù
 * đánh mã khác nhau cho cùng một tin. Gồm chiều gửi + mốc tới GIÂY + nội dung đã chuẩn hoá.
 *
 * Mốc thời gian nằm trong vân tay một cách CÓ CHỦ Ý: khách hoàn toàn có thể nhắn lại đúng câu cũ
 * ("alo", "shop ơi") sau vài phút, và đó là hai tin thật, không phải một tin trùng.
 */
export function contentFingerprint(message: { fromPage: boolean; text: string; sentAt: Date | null }): string {
  const stamp = message.sentAt ? Math.floor(message.sentAt.getTime() / 1000) : 0;
  return [message.fromPage ? "OUT" : "IN", stamp, normalize(message.text).trim()].join("|");
}

function toDate(value: unknown): Date | null {
  if (typeof value === "number") return new Date(value > 1e12 ? value : value * 1000);
  const s = str(value);
  if (!s) return null;
  // Pancake trả ISO không múi giờ nhưng là UTC — gắn Z vào đúng như mapper đơn hàng đang làm.
  const d = new Date(/^\d{4}-\d{2}-\d{2}T/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? `${s}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Đọc một khoá dạng "a.b" trong một object lồng nhau. */
function pick(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), root);
}

/** Giá trị đầu tiên khác rỗng trong danh sách khoá đã KHAI ở `CHAT_FIELD_MAP`. */
function firstByMap(sources: Record<string, unknown>[], field: keyof typeof CHAT_FIELD_MAP): string {
  for (const key of CHAT_FIELD_MAP[field].keys) {
    if (key.includes("==") || key.includes("=") || key.endsWith("[]")) continue; // khoá mô tả, không phải khoá đọc được
    for (const source of sources) {
      const value = str(pick(source, key));
      if (value) return value;
    }
  }
  return "";
}

/**
 * Chuẩn hoá gói tin webhook hội thoại Pancake.
 *
 * KHÔNG ĐOÁN. Chỉ đọc đúng những khoá đã khai trong `CHAT_FIELD_MAP`; thiếu một trong ba khoá bắt
 * buộc (page · hội thoại · tin nhắn) thì TỪ CHỐI kèm lý do và danh sách khoá thật sự có trong gói
 * tin. Ghi một dòng không chống trùng được còn tệ hơn không ghi: nó mở cửa cho tin nhân bản và
 * cho những lượt chạy AI lặp lại trên cùng một câu của khách.
 */
export function normalizeChatWebhook(payload: unknown): NormalizeResult {
  if (payload === null || payload === undefined) return { ok: false, reason: "EMPTY_PAYLOAD", missing: REQUIRED_CHAT_FIELDS, seenKeys: [] };
  if (typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "NOT_JSON_OBJECT", missing: REQUIRED_CHAT_FIELDS, seenKeys: [] };

  const root = asRecord(payload);
  const body = asRecord(root.data ?? root.message ?? root);
  const conversationRaw = asRecord(root.conversation ?? body.conversation ?? root);
  const seenKeys = [...new Set([...Object.keys(root), ...Object.keys(body).map((k) => `data.${k}`)])].slice(0, 40);

  const pageId = firstByMap([root, body, conversationRaw], "pageId");
  // Mã hội thoại: `id` ở gốc hội thoại, nhưng ở gốc GÓI TIN `id` lại là mã tin nhắn — nên đọc
  // khoá tường minh trước, và chỉ lấy `id` từ object hội thoại.
  const conversationId = str(root.conversation_id, body.conversation_id) || str(conversationRaw.conversation_id) || (root.conversation || body.conversation ? str(conversationRaw.id) : "");
  const messageId = str(body.id, body.message_id, root.message_id);
  const missing: string[] = [];
  if (!pageId) missing.push("pageId");
  if (!conversationId) missing.push("conversationId");
  if (!messageId) missing.push("messageId");
  if (missing.length) return { ok: false, reason: "MISSING_REQUIRED_FIELD", missing, seenKeys };

  const from = asRecord(body.from ?? root.from);
  const senderId = str(from.id, body.from_id);
  const customer = asRecord(conversationRaw.customer ?? root.customer ?? (senderId && senderId !== pageId ? from : {}));
  const phones = [...asArray(conversationRaw.recent_phone_numbers), ...asArray(customer.phone_numbers)]
    .map((phone) => normalizePhone(str(asRecord(phone).phone_number, phone)))
    .filter((phone) => /^0\d{9}$/.test(phone));

  const fromPage = senderId === pageId || Boolean(body.from_page) || str(body.type) === "page" || str(root.type).includes("page");
  const fromName = str(from.name);
  const attachments = asArray(body.attachments);
  const noiDungTin = stripHtml(str(body.message, body.original_message, body.text));
  const tenKhachHT = str(customer.name, fromPage ? "" : fromName);
  return {
    ok: true,
    conversation: {
      pageId,
      externalId: conversationId,
      pancakeCustomerId: str(customer.id, customer.fb_id),
      customerName: tenKhachHT,
      phone: phones[0] ?? "",
      // Nền tảng chỉ CHẮC CHẮN khi đọc từ danh sách page; từ gói tin chỉ nhận khi có khoá tường minh.
      platform: str(root.platform, conversationRaw.platform),
    },
    message: {
      externalId: messageId,
      text: noiDungTin,
      fromPage,
      senderType: classifySender({ fromPage, fromName, text: noiDungTin, customerName: tenKhachHT }),
      fromName,
      sentAt: toDate(body.inserted_at ?? body.created_time ?? body.created_at ?? root.inserted_at),
      hasAttachment: attachments.length > 0,
      attachmentCount: attachments.length,
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
export async function ingestMessage(
  conversation: NormalizedConversation,
  message: NormalizedMessage,
  source: string,
  db?: Db,
  ingestSource: IngestSource = "POLL",
): Promise<IngestResult> {
  const conn = db ?? (await getDb());
  const conversationId = await upsertConversation(conversation, conn);
  if (!message.externalId) {
    return { conversationId, messageId: null, duplicate: false, eventEmitted: false, reason: "Tin nhắn không có mã — không ghi được vì không chống trùng được" };
  }

  // CHỐNG TRÙNG CHÉO KÊNH. Khoá `external_id` chỉ bắt được khi hai đường dùng CÙNG một mã tin
  // nhắn. Ánh xạ webhook chưa được kiểm chứng (xem lib/constants/sales-ingest.ts), nên nếu
  // webhook đánh mã khác API đọc bù thì cùng một câu của khách sẽ vào hai dòng và chạy AI hai
  // lượt. Vân tay nội dung + mốc tới GIÂY bắt được đúng trường hợp đó.
  const fingerprint = contentFingerprint(message);
  const twin = await conn.query.salesMessages.findFirst({
    where: and(eq(schema.salesMessages.conversationId, conversationId), eq(schema.salesMessages.contentHash, fingerprint)),
    columns: { id: true, externalId: true, ingestSource: true },
  });
  if (twin && twin.externalId !== message.externalId) {
    // Ghi lại MỘT lần để chủ shop biết hai đường đang đánh mã khác nhau — im lặng thì ánh xạ sai
    // sẽ sống mãi.
    //
    // `once` là thứ THỰC THI chữ "MỘT lần" ở câu trên. Thiếu nó, cửa sổ đọc chồng lấn gặp lại
    // đúng mâu thuẫn này mỗi 45 giây và ghi thêm một dòng: đo 22/09/2026 ra 4.571 dòng cho MỘT
    // tin nhắn. Số lần gặp vẫn được đếm trong `detail.seen`, nên vẫn phân biệt được một trục
    // trặc thoáng qua với một mâu thuẫn đang sống.
    await recordAiError(
      {
        scope: "INGEST",
        agentKey: "sales",
        subjectType: "CONVERSATION",
        subjectId: conversationId,
        message: `Hai đường nạp đánh mã khác nhau cho cùng một tin: ${twin.ingestSource}=${twin.externalId} vs ${ingestSource}=${message.externalId}`,
        once: true,
      },
      conn,
    );
    return { conversationId, messageId: twin.id, duplicate: true, eventEmitted: false, reason: "Tin đã được đường nạp khác ghi (trùng chéo kênh theo vân tay nội dung)" };
  }

  const [inserted] = await conn
    .insert(schema.salesMessages)
    .values({
      conversationId,
      externalId: message.externalId,
      direction: message.fromPage ? "OUT" : "IN",
      fromPage: message.fromPage,
      senderType: message.senderType,
      fromName: message.fromName,
      text: message.text,
      hasAttachment: message.hasAttachment,
      attachmentCount: message.attachmentCount,
      adId: message.adId ?? "",
      adDescription: message.adDescription ?? "",
      postUrl: message.postUrl ?? "",
      attachmentTypes: message.attachmentTypes ?? [],
      adMediaUrl: message.adMediaUrl ?? "",
      platform: conversation.platform,
      ingestSource,
      contentHash: fingerprint,
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

  // CHỐNG VÒNG LẶP: tin của shop không bao giờ trở thành việc cho máy — kể cả tin do chính nhân
  // sự AI hay một bot khác gửi.
  if (message.fromPage) {
    await linkHumanReply(conversationId, inserted.id, message, conn);
    return {
      conversationId,
      messageId: inserted.id,
      duplicate: false,
      eventEmitted: false,
      reason: `Tin từ page (${message.senderType}) — không tạo việc cho nhân sự AI (chống vòng lặp)`,
    };
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
 * NỐI CÂU NHÂN VIÊN VÀO ĐÚNG LƯỢT — không giả định một-đổi-một.
 *
 * Một lượt = một tin của KHÁCH, rồi mọi tin của shop cho tới tin tiếp theo của khách. Nhân viên
 * hay trả lời bằng ba bốn tin liền ("dạ chị", "mẫu này 499k ạ", "chị cho em xin size"), và đôi
 * khi không trả lời tin nào cả. Nối theo "gợi ý gần nhất còn trống" như bản đầu sẽ gán câu thứ
 * nhất rồi bỏ rơi ba câu sau, và gán nhầm khi nhân viên trả lời muộn hơn một lượt khách mới.
 *
 * Cách đúng: từ tin của shop, tìm NGƯỢC lên tin gần nhất của khách — đó là lượt nó thuộc về — rồi
 * nối vào gợi ý mang đúng `trigger_message_id` ấy. Ô `human_reply` giữ câu ĐẦU TIÊN của lượt làm
 * ảnh chụp cho bảng danh sách; số tin và thời gian phản hồi được cập nhật đủ.
 */
async function linkHumanReply(conversationId: string, shopMessageId: string, message: NormalizedMessage, db: Db) {
  if (!message.text.trim()) return;
  // Bot không phải nhân viên: tính tin bot thành "câu người trả lời" là làm hỏng mọi phép đo.
  if (message.senderType !== "PAGE_HUMAN") return;
  const sentAt = message.sentAt ?? new Date();

  // Tin gần nhất của KHÁCH trước tin này — mốc mở lượt.
  const trigger = await db.query.salesMessages.findFirst({
    where: and(eq(schema.salesMessages.conversationId, conversationId), eq(schema.salesMessages.fromPage, false), lte(schema.salesMessages.sentAt, sentAt)),
    orderBy: (m, { desc }) => [desc(m.sentAt), desc(m.createdAt)],
    columns: { id: true, sentAt: true },
  });
  if (!trigger) return;

  const suggestion = await db.query.salesSuggestions.findFirst({
    where: and(eq(schema.salesSuggestions.conversationId, conversationId), eq(schema.salesSuggestions.triggerMessageId, trigger.id)),
    columns: { id: true, humanReply: true, humanReplyCount: true, humanRepliedAt: true },
  });
  if (!suggestion) return;

  const first = !suggestion.humanRepliedAt;
  const seconds = trigger.sentAt ? Math.max(0, Math.round((sentAt.getTime() - trigger.sentAt.getTime()) / 1000)) : null;
  await db
    .update(schema.salesSuggestions)
    .set({
      // Chỉ câu ĐẦU của lượt được giữ làm ảnh chụp; các câu sau chỉ tăng bộ đếm.
      ...(first ? { humanReply: message.text.slice(0, 4000), humanRepliedAt: sentAt, humanResponseSeconds: seconds } : {}),
      humanReplyCount: (suggestion.humanReplyCount ?? 0) + 1,
    })
    .where(eq(schema.salesSuggestions.id, suggestion.id));
  void shopMessageId;
}

/**
 * NỐI LẠI CÂU NHÂN VIÊN SAU KHI MÁY ĐÃ CHẠY — bắt buộc cho đường nạp theo LÔ.
 *
 * `linkHumanReply` ở trên chạy NGAY lúc ghi từng tin, và nó đúng cho webhook: tin khách tới ⇒ máy
 * chạy ⇒ có gợi ý ⇒ rồi nhân viên mới trả lời. Đường nạp theo lô đi NGƯỢC thứ tự ấy: cả lịch sử
 * hội thoại được ghi trước, `drainSalesTasks` mới sinh gợi ý sau. Nên lúc mỗi tin của nhân viên
 * được ghi, bảng gợi ý còn TRỐNG, `if (!suggestion) return` bắn ra, và không một câu nào được nối.
 *
 * Đo trên bản chạy thử 14/09/2026: 148 tin `PAGE_HUMAN` nằm sẵn trong CSDL, 36 gợi ý — nối được 0.
 * Mất phần này thì nấc SHADOW mất luôn lý do tồn tại: không có câu người thật để đặt cạnh câu máy.
 *
 * Hàm TÍNH LẠI từ đầu chứ không cộng dồn, nên chạy bao nhiêu lần cũng ra một kết quả, và nó chỉ
 * ghi khi số liệu thật sự đổi.
 */
export async function relinkHumanReplies(options: { pageId?: string } = {}, db?: Db) {
  const conn = db ?? (await getDb());
  const conversations = await conn.query.salesConversations.findMany({
    where: options.pageId ? eq(schema.salesConversations.pageId, options.pageId) : undefined,
    columns: { id: true },
  });
  let updated = 0;
  let linked = 0;
  for (const conversation of conversations) {
    const suggestions = await conn.query.salesSuggestions.findMany({
      where: eq(schema.salesSuggestions.conversationId, conversation.id),
      columns: { id: true, triggerMessageId: true, humanReply: true, humanReplyCount: true, humanResponseSeconds: true },
    });
    if (!suggestions.length) continue;
    const messages = await conn.query.salesMessages.findMany({
      where: eq(schema.salesMessages.conversationId, conversation.id),
      orderBy: (m, { asc }) => [asc(m.sentAt), asc(m.createdAt)],
      columns: { id: true, fromPage: true, senderType: true, text: true, sentAt: true },
    });

    // Một lượt = tin của khách, rồi mọi tin NHÂN VIÊN cho tới tin khách kế tiếp.
    const luot = new Map<string, { text: string; at: Date; seconds: number | null }[]>();
    let moc: { id: string; at: Date | null } | null = null;
    for (const message of messages) {
      if (!message.fromPage) {
        moc = { id: message.id, at: message.sentAt };
        continue;
      }
      // Tin bot không phải câu nhân viên trả lời; tin rỗng không so sánh được với câu nào.
      if (message.senderType !== "PAGE_HUMAN" || !message.text.trim() || !moc) continue;
      const at = message.sentAt ?? new Date();
      const seconds = moc.at ? Math.max(0, Math.round((at.getTime() - moc.at.getTime()) / 1000)) : null;
      const danhSach = luot.get(moc.id) ?? [];
      danhSach.push({ text: message.text, at, seconds });
      luot.set(moc.id, danhSach);
    }

    for (const suggestion of suggestions) {
      const danhSach = suggestion.triggerMessageId ? (luot.get(suggestion.triggerMessageId) ?? []) : [];
      const dau = danhSach[0] ?? null;
      const moi = {
        humanReply: dau ? dau.text.slice(0, 4000) : "",
        humanRepliedAt: dau ? dau.at : null,
        humanResponseSeconds: dau ? dau.seconds : null,
        humanReplyCount: danhSach.length,
      };
      const giongCu =
        (suggestion.humanReply ?? "") === moi.humanReply &&
        (suggestion.humanReplyCount ?? 0) === moi.humanReplyCount &&
        (suggestion.humanResponseSeconds ?? null) === moi.humanResponseSeconds;
      if (giongCu) continue;
      await conn.update(schema.salesSuggestions).set(moi).where(eq(schema.salesSuggestions.id, suggestion.id));
      updated += 1;
      if (dau) linked += 1;
    }
  }
  return { conversations: conversations.length, updated, linked };
}

/** Nạp từ gói tin webhook. Trả lý do đọc được khi không nạp được — không nuốt lặng. */
export async function ingestChatWebhook(payload: unknown, db?: Db): Promise<IngestResult | { conversationId: null; reason: string }> {
  const settings = await getAiSettings();
  if (!settings.enabled || !settings.ingestEnabled) return { conversationId: null, reason: "Nạp hội thoại đang tắt trong cấu hình" };
  const normalized = normalizeChatWebhook(payload);
  if (!normalized.ok) {
    // Gói tin không nhận dạng được vẫn được lưu nguyên văn ở `webhook_events` (tầng route lo việc
    // đó). Ở đây chỉ ghi CHẨN ĐOÁN: thiếu khoá nào, gói tin thật sự có khoá gì. Một mẫu thật là đủ
    // để hoàn thiện ánh xạ mà không phải đoán.
    await recordAiError(
      {
        scope: "WEBHOOK",
        agentKey: "sales",
        message: `Gói tin hội thoại không nhận dạng được (${normalized.reason}) — thiếu: ${normalized.missing.join(", ") || "—"}`,
        detail: { seenKeys: normalized.seenKeys },
      },
      db,
    );
    return { conversationId: null, reason: `Không nhận dạng được: thiếu ${normalized.missing.join(", ") || "khoá bắt buộc"}; khoá có trong gói tin: ${normalized.seenKeys.join(", ") || "(rỗng)"}` };
  }
  return ingestMessage(normalized.conversation, normalized.message, "pancake-chat-webhook", db, "WEBHOOK");
}

/** Tin từ Pages API (đường đã kiểm chứng) → dạng chuẩn hoá dùng chung với webhook. */
function toNormalizedMessage(m: PancakeMessage, customerName = ""): NormalizedMessage {
  const text = stripHtml(m.text);
  return {
    externalId: m.id,
    text,
    fromPage: m.fromPage,
    senderType: classifySender({ fromPage: m.fromPage, fromName: m.fromName, text, customerName }),
    fromName: m.fromName,
    sentAt: m.insertedAt,
    hasAttachment: m.hasAttachment,
    attachmentCount: m.attachmentCount,
    adId: m.adId,
    adDescription: m.adDescription,
    postUrl: m.postUrl,
    attachmentTypes: m.attachmentTypes,
    adMediaUrl: m.adMediaUrl,
    raw: {},
  };
}

/**
 * Job nạp bù: đọc hội thoại cập nhật trong N giờ gần nhất qua Pages API.
 * Chạy được song song với webhook vì chống trùng nằm ở tầng dữ liệu.
 */
export async function syncSalesConversations(
  options: { hours?: number; limit?: number; pageId?: string; maxConversations?: number } = {},
) {
  const settings = await getAiSettings();
  if (!settings.enabled || !settings.ingestEnabled) return { skipped: true, reason: "Nạp hội thoại đang tắt", conversations: 0, messages: 0, events: 0, skippedNoCustomer: 0, pages: [] as string[], errors: [] as string[] };
  const hours = Math.min(Math.max(options.hours ?? 6, 1), 24 * 7);
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 300);
  // TRẦN CỨNG số hội thoại xử lý trong một lượt. Lần chạy thử đầu tiên phải NHỎ: nạp cả tài khoản
  // rồi mới phát hiện ánh xạ sai là dọn dẹp hàng nghìn dòng, còn nạp 20 hội thoại thì đọc hết bằng mắt.
  const maxConversations = Math.min(Math.max(options.maxConversations ?? 1_000, 1), 1_000);
  const db = await getDb();
  const client = getPancakePagesClient();
  const until = new Date();
  const since = new Date(until.getTime() - hours * 3_600_000);
  let conversations = 0;
  let messages = 0;
  let events = 0;
  /** Hội thoại bị bỏ qua vì KHÁCH CHƯA NÓI CÂU NÀO — không tính vào trần, và phải nói ra. */
  let boQua = 0;
  const errors: string[] = [];

  const allPages = await client.listPages();
  // Chọn ĐÚNG MỘT page khi được chỉ định. Lần chạy thử đầu tiên chỉ nên chạm vào một page.
  const pages = options.pageId ? allPages.filter((p) => p.id === options.pageId) : allPages;
  if (options.pageId && !pages.length) {
    return { skipped: true, reason: `Không thấy page ${options.pageId} trong các page đọc được`, conversations: 0, messages: 0, events: 0, skippedNoCustomer: 0, pages: allPages.map((p) => p.id), errors: [] as string[] };
  }
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
      if (conversations >= maxConversations) break;
      try {
        const fetched = await client.listMessages(page.id, conversation.id, conversation.customerId, 30);
        // TRẦN 20 PHẢI LÀ 20 HỘI THOẠI CÓ VIỆC ĐỂ LÀM.
        //
        // Mẻ đầu: 2/20 suất rơi vào hội thoại chỉ có tin của shop (khách chưa nói câu nào), nên
        // chúng không sinh lượt chạy nào và cũng không có gì để chấm — 10% mẻ tiêu vào chỗ trống.
        // Đếm SAU khi biết hội thoại có tin khách hay không, chứ không đếm lúc vừa nhìn thấy nó.
        const coTinKhach = fetched.some((m) => !m.fromPage && m.text.trim());
        if (!coTinKhach) {
          boQua += 1;
          continue;
        }
        conversations += 1;
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
              platform: page.platform,
            },
            toNormalizedMessage(raw, conversation.customerName),
            "pancake-pages-poll",
            db,
            "POLL",
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
  return { skipped: false, hours, conversations, messages, events, skippedNoCustomer: boQua, pages: pages.map((p) => p.id), errors: errors.slice(0, 20) };
}
