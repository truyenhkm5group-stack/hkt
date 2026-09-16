/**
 * MỘT VÒNG NẠP TIN SỐNG — đọc Pancake, soạn gợi ý, KHÔNG BAO GIỜ gửi.
 *
 * Tệp này KHÔNG import cổng gửi tin. Đó không phải một quy ước mà là một tính chất kiểm được:
 * `tests/sales-copilot.test.ts` quét mã nguồn và khoá lại rằng chỉ đúng một tệp trong cả kho mã
 * truyền khoá người duyệt vào cổng gửi, và tệp ấy là một Server Action đòi phiên đăng nhập.
 *
 * Mỗi vòng làm ĐÚNG bốn việc, theo thứ tự, và dừng ở việc thứ tư:
 *   1. đọc hội thoại + tin mới của page (cửa sổ tính từ mốc lần đọc được cuối, có chồng lấn)
 *   2. nối câu nhân viên đã trả lời vào đúng lượt
 *   3. chạy dây chuyền để soạn câu gợi ý
 *   4. ghi lại mốc và sức khoẻ
 *
 * Việc thứ năm — gửi — không tồn tại ở đây.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { relinkHumanReplies, syncSalesConversations } from "@/lib/ai-workforce/agents/sales/ingest";
import { drainSalesTasks } from "@/lib/ai-workforce/agents/sales/pipeline";
import {
  LIVE_INGEST_MAX_CONVERSATIONS,
  windowHours,
} from "@/lib/constants/live-ingest";

export type IngestTick = {
  /**
   * `true` = VÒNG NÀY ĐỌC ĐƯỢC. Không phải "không có lỗi nào".
   *
   * Một hội thoại lẻ hỏng (khách xoá tin, Pancake trả thiếu trường) trong khi 29 hội thoại kia nạp
   * bình thường thì vòng ấy ĐÃ CHẠY. Gọi nó là hỏng thì đồng hồ nghỉ-dài-dần leo lên tới trần và
   * màn hình báo LỖI, nên người trực đi tìm một sự cố không tồn tại trong khi việc thật là một
   * hội thoại cần xem bằng mắt. Lỗi lẻ vẫn được ghi ở `error` và vẫn hiện ra màn hình.
   */
  ok: boolean;
  pageId: string;
  windowHours: number;
  conversations: number;
  messages: number;
  suggestionsDrained: number;
  error: string;
  /** Mốc tin khách mới nhất SAU vòng này — dùng cho cửa sổ vòng sau. */
  latestCustomerAt: Date | null;
};

export async function readCursor(pageId: string, dbIn?: Db) {
  const db = dbIn ?? (await getDb());
  return db.query.salesIngestCursors.findFirst({ where: eq(schema.salesIngestCursors.pageId, pageId) });
}

/**
 * CHẠY MỘT VÒNG.
 *
 * Không ném ra ngoài: một lượt Pancake hỏng là chuyện thường ngày (429, token hết hạn, mạng chập
 * chờn), và nó không được phép giết tiến trình. Hỏng thì ghi lại, đếm thêm một lần hỏng liên tiếp,
 * và để người gọi quyết định nghỉ bao lâu.
 */
export async function runIngestTick(pageId: string, dbIn?: Db): Promise<IngestTick> {
  const db = dbIn ?? (await getDb());
  const truoc = await readCursor(pageId, db);
  const gio = windowHours(truoc?.lastOkAt ?? null);
  const batDau = new Date();

  const ket: IngestTick = { ok: false, pageId, windowHours: gio, conversations: 0, messages: 0, suggestionsDrained: 0, error: "", latestCustomerAt: null };
  // Vòng KHÔNG chạy được: cả lượt đọc bị từ chối (công tắc nạp tắt) hoặc ném lỗi. Khác hẳn lỗi lẻ.
  let hongCaVong = false;

  try {
    const nap = await syncSalesConversations({ pageId, hours: gio, limit: 100, maxConversations: LIVE_INGEST_MAX_CONVERSATIONS });
    if ("skipped" in nap && nap.skipped) {
      ket.error = nap.reason ?? "Nạp hội thoại đang tắt";
      hongCaVong = true;
    } else {
      ket.conversations = nap.conversations;
      ket.messages = nap.messages;
      if (nap.errors.length) ket.error = nap.errors.slice(0, 2).join(" · ");
    }

    // Nối câu nhân viên đã trả lời vào đúng lượt khách — nếu không, một hội thoại đã được người xử
    // lý vẫn nằm trong hàng đợi như thể chưa ai đụng tới.
    await relinkHumanReplies({ pageId }, db).catch(() => undefined);

    // SOẠN câu gợi ý. Đây là việc tốn token, nhưng vẫn nằm trong nhà: không dòng nào đi ra ngoài.
    const chay = await drainSalesTasks(LIVE_INGEST_MAX_CONVERSATIONS, db);
    ket.suggestionsDrained = typeof chay === "object" && chay && "ran" in chay ? Number((chay as { ran?: number }).ran ?? 0) : 0;

    const [moiNhat] = await db
      .select({ luc: sql<string | null>`max(${schema.salesMessages.sentAt})` })
      .from(schema.salesMessages)
      .innerJoin(schema.salesConversations, eq(schema.salesConversations.id, schema.salesMessages.conversationId))
      .where(
        and(
          eq(schema.salesConversations.pageId, pageId),
          eq(schema.salesMessages.fromPage, false),
          eq(schema.salesMessages.senderType, "CUSTOMER"),
        ),
      );
    ket.latestCustomerAt = moiNhat?.luc ? new Date(moiNhat.luc) : null;
    ket.ok = !hongCaVong;
  } catch (error) {
    ket.error = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 400) : String(error).slice(0, 400);
    ket.ok = false;
    hongCaVong = true;
  }

  // MÃ TIN CUỐI PHẢI LÀ TIN CỦA CHÍNH PAGE NÀY. Bản trước hỏi `sales_messages` không nối bảng hội
  // thoại, nên khi có từ hai page trở lên, mốc của page A lại mang mã tin của page B — một mốc
  // trông như chứng cứ mà chỉ đúng khi thí điểm đúng một page.
  const [tinCuoi] = ket.latestCustomerAt
    ? await db
        .select({ externalId: schema.salesMessages.externalId })
        .from(schema.salesMessages)
        .innerJoin(schema.salesConversations, eq(schema.salesConversations.id, schema.salesMessages.conversationId))
        .where(and(eq(schema.salesConversations.pageId, pageId), eq(schema.salesMessages.fromPage, false), eq(schema.salesMessages.senderType, "CUSTOMER")))
        .orderBy(desc(schema.salesMessages.sentAt))
        .limit(1)
    : [];

  const chung = {
    lastRunAt: batDau,
    lastError: ket.error.slice(0, 400),
    updatedAt: new Date(),
  };
  const khiOk = !hongCaVong
    ? {
        lastOkAt: batDau,
        consecutiveErrors: 0,
        lastMessageAt: ket.latestCustomerAt,
        lastMessageExternalId: tinCuoi?.externalId ?? "",
        messagesIngested: (truoc?.messagesIngested ?? 0) + ket.messages,
        conversationsSeen: (truoc?.conversationsSeen ?? 0) + ket.conversations,
      }
    : { consecutiveErrors: (truoc?.consecutiveErrors ?? 0) + 1 };

  await db
    .insert(schema.salesIngestCursors)
    .values({ pageId, ...chung, ...khiOk })
    .onConflictDoUpdate({ target: schema.salesIngestCursors.pageId, set: { ...chung, ...khiOk } });

  return ket;
}
