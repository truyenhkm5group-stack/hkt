/**
 * Ghi fixture `buildInboxFixture` vào CSDL của tổ chức đang chạy (bài kiểm bất biến + lượt đo tay). Chỉ dùng trong kiểm thử.
 * Ghi THEO LÔ bằng drizzle (không trigger nào bị vượt qua — mọi dòng đi qua đúng đường ghi của CSDL).
 */
import { getDb, schema } from "@/db";
import { fanpageVisitorKey, PAGE_REPLY, STAFF_OUT_PREFIX } from "@/lib/sales-chatbot/fanpage";
import type { FixtureConv } from "./inbox-unread-fixture";

const CHUNK = 500;
/** Chữ hệ thống Facebook chèn vào tin riêng trả lời bình luận — không ai gõ, không phải câu trả lời. */
export const PAGE_SYSTEM_TEXT = "Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình. Xem bình luận.";

async function chunked<T>(rows: T[], write: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await write(rows.slice(i, i + CHUNK));
}

/** Trả về bản đồ khoá fixture → mã hội thoại. `viewerIds[i]` mang con trỏ `conv.cursors[i]`. */
export async function seedInboxFixture(convs: FixtureConv[], pageId: string, viewerIds: string[]): Promise<Map<string, string>> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const ids = new Map<string, string>();
  const d = (x: number | null) => (x === null ? null : new Date(x));
  await chunked(convs, async (part) => {
    const got = await db
      .insert(c)
      .values(
        part.map((v) => ({
          channel: v.channel,
          status: "OPEN",
          visitorKey: v.channel === "FANPAGE" ? fanpageVisitorKey(pageId, v.key) : v.key,
          pageId: v.channel === "FANPAGE" ? pageId : null,
          threadId: v.channel === "FANPAGE" ? v.key : null,
          lastCustomerAt: d(v.lastCustomerAt),
          lastBotAt: d(v.lastBotAt),
          lastStaffAt: d(v.lastStaffAt),
          staffSeenAt: d(v.staffSeenAt),
          historyUntil: d(v.historyUntil),
          createdAt: new Date((v.msgs[0]?.at ?? Date.now()) - 60_000),
        })),
      )
      .returning({ id: c.id, visitorKey: c.visitorKey, threadId: c.threadId });
    for (const [i, g] of got.entries()) ids.set(part[i].key, g.id);
  });
  const inbound: (typeof schema.salesChatInbound.$inferInsert)[] = [];
  // Nguồn gốc tin phía page (0242 · response-ownership): luân phiên TẤT ĐỊNH — người đã xác minh · tự động · ứng dụng khác · AI · dòng
  // cũ chưa có cột (NULL ⇒ #803 tự phân loại: chữ hệ thống · tin mẫu · KHÔNG RÕ, tin chào đầu phiên).
  const KINDS = ["VERIFIED_HUMAN", "PANCAKE_AUTOMATION", "OTHER_APP", "AI_AGENT", null, null, null] as const;
  let pageN = 0;
  const web: (typeof schema.salesChatMessages.$inferInsert)[] = [];
  for (const v of convs) {
    const id = ids.get(v.key)!;
    v.msgs.forEach((m, i) => {
      if (v.channel === "WEB") {
        web.push({ conversationId: id, seq: i + 1, role: m.side === "C" ? "user" : "assistant", content: [{ type: "text", text: m.side === "C" ? "Khách hỏi" : "Bot đáp" }], createdAt: new Date(m.at) });
        return;
      }
      inbound.push({
        pageId,
        threadId: v.key,
        messageId: m.side === "STAFF" ? `${STAFF_OUT_PREFIX}${v.key}-${i}` : `${v.key}-${i}`,
        text: m.side === "C" ? "Khách hỏi" : m.page === "SYSTEM" ? PAGE_SYSTEM_TEXT : m.page === "EMPTY" ? "" : "Shop đáp",
        note: m.side === "BOT" ? "BOT_SENT" : m.side === "STAFF" || m.side === "PAGE" ? PAGE_REPLY : (m.note ?? null),
        kind: m.comment ? "COMMENT" : "INBOX",
        senderKind: m.side === "PAGE" && !m.page && !m.imported ? KINDS[pageN++ % KINDS.length] : null,
        // Mốc NGUỒN (0242): một phần ba dòng sống có mốc tạo ở nguồn sớm hơn mốc nhận 3 giây; cứ 23 dòng có một dòng lệch đồng hồ (nguồn
        // muộn hơn 90 giây) — để thứ tự theo nguồn của #803 khác thứ tự theo mốc nhận.
        sourceAt: m.imported || m.side === "BOT" || m.side === "STAFF" ? null : i % 23 === 7 ? new Date(m.at + 90_000) : i % 3 === 1 ? new Date(m.at - 3_000) : null,
        status: "DONE",
        importedAt: m.imported ? new Date(m.at + 86_400_000) : null,
        createdAt: new Date(m.at),
      });
    });
    // Chat web: một dòng kết quả công cụ mang vai `user` (không phải khách) — `customerMessageRowSql` phải bỏ qua.
    if (v.channel === "WEB" && v.msgs.length) web.push({ conversationId: id, seq: v.msgs.length + 1, role: "user", content: [{ type: "tool_result", toolUseId: "x", content: "ok" }], createdAt: new Date(v.msgs[v.msgs.length - 1].at + 1_000) });
  }
  await chunked(inbound, (part) => db.insert(schema.salesChatInbound).values(part));
  await chunked(web, (part) => db.insert(schema.salesChatMessages).values(part));
  const reads: (typeof schema.salesChatReads.$inferInsert)[] = [];
  for (const v of convs)
    v.cursors.forEach((at, i) => {
      if (at !== null && viewerIds[i]) reads.push({ conversationId: ids.get(v.key)!, userId: viewerIds[i], readThroughAt: new Date(at), updatedAt: new Date(at) });
    });
  await chunked(reads, (part) => db.insert(schema.salesChatReads).values(part));
  return ids;
}
