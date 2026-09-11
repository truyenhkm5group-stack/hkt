/**
 * ═══════════ GHI LẠI PHỄU HỘI THOẠI — THUẦN, KIỂM THỬ ĐƯỢC ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md` · bảng: `conversation_funnel` (db/schema.ts)
 * · hằng số: `lib/constants/conversion.ts`.
 *
 * Job `cs-chat` đã gọi Pancake Pages API và đã có sẵn trong tay: hội thoại, thẻ, tới 50 tin nhắn,
 * và kết quả ghép đơn. Mô-đun này KHÔNG gọi thêm API nào — nó chỉ chuyển thứ đã có trong bộ nhớ
 * thành một dòng bằng chứng lưu được. Thêm một lượt gọi API thứ hai để lấy cùng dữ liệu là tự nhân
 * đôi chi phí và tự tạo ra hai phiên bản sự thật.
 *
 * MỌI HÀM Ở ĐÂY TRỪ HÀM UPSERT ĐỀU THUẦN, nên phần dễ sai nhất — dựng dòng thời gian và mốc phản
 * hồi đầu tiên — kiểm thử được trực tiếp, không cần CSDL.
 *
 * KHÔNG CÓ PHÉP SUY DIỄN Ý ĐỊNH MUA ở đây. ERP không có nguồn cho nó; xem `UNMEASURABLE_STAGES`
 * trong `lib/constants/conversion.ts` và docblock của bảng trong `db/schema.ts`.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import type { PancakeMessage } from "@/lib/integrations/pancake/pages";
import { extractCustomerEvidence, type OrderMatch } from "@/lib/cs/chat-detect";
import type { OrderMatchBasis } from "@/lib/constants/conversion";

/**
 * ───────────── DÒNG THỜI GIAN CỦA MỘT HỘI THOẠI ─────────────
 *
 * `firstShopReplyAt` là thứ quan trọng nhất ở đây. `lib/constants/operating-funnel.ts` ghi ở khâu
 * LEAD: *"Không có mốc phản hồi đầu tiên cho từng lead, nên tỷ lệ và thời gian phản hồi CHƯA đo
 * được."* Mốc này chính là cái còn thiếu đó, và nó CHỈ đúng khi lấy tin của shop gửi SAU tin đầu
 * của khách — tin shop gửi trước (tin chào mời tự động) không phải là phản hồi cho ai cả.
 */
export type MessageTimeline = {
  firstCustomerMessageAt: Date | null;
  firstShopReplyAt: Date | null;
  lastCustomerMessageAt: Date | null;
  lastShopMessageAt: Date | null;
  customerMessageCount: number;
  shopMessageCount: number;
  /** Nhân viên trả lời (tên trên tin của page). '' = chưa ai trả lời, hoặc Pancake không trả tên. */
  ownerName: string;
  /** Mốc SỚM NHẤT trong toàn bộ tin đọc được — biên của cửa sổ quét, để phân biệt "chưa có" với "chưa đọc tới". */
  earliestMessageAt: Date | null;
};

export function messageTimeline(messages: PancakeMessage[]): MessageTimeline {
  let firstCustomer: Date | null = null;
  let lastCustomer: Date | null = null;
  let lastShop: Date | null = null;
  let earliest: Date | null = null;
  let customerCount = 0;
  let shopCount = 0;
  let ownerName = "";

  for (const m of messages) {
    if (!m.text && !m.hasAttachment) continue;
    const at = m.insertedAt;
    if (at && (!earliest || at < earliest)) earliest = at;
    if (m.fromPage) {
      shopCount += 1;
      if (at && (!lastShop || at > lastShop)) lastShop = at;
      // Tên người trả lời SỚM NHẤT: người mở hội thoại là người đang giữ khách này.
      if (!ownerName && m.fromName) ownerName = m.fromName;
    } else {
      customerCount += 1;
      if (at && (!firstCustomer || at < firstCustomer)) firstCustomer = at;
      if (at && (!lastCustomer || at > lastCustomer)) lastCustomer = at;
    }
  }

  /*
    PHẢN HỒI = TIN CỦA SHOP SAU TIN ĐẦU CỦA KHÁCH.

    Không có điều kiện "sau" thì một tin chào mời shop gửi trước sẽ được tính là đã phản hồi trong
    0 giây, và thời gian phản hồi trung vị của cả shop sẽ tụt xuống gần 0 — một con số đẹp mô tả
    sai hoàn toàn việc đang xảy ra.
  */
  let firstReply: Date | null = null;
  if (firstCustomer) {
    for (const m of messages) {
      if (!m.fromPage || !m.insertedAt) continue;
      if (m.insertedAt < firstCustomer) continue;
      if (!firstReply || m.insertedAt < firstReply) firstReply = m.insertedAt;
    }
  }

  return {
    firstCustomerMessageAt: firstCustomer,
    firstShopReplyAt: firstReply,
    lastCustomerMessageAt: lastCustomer,
    lastShopMessageAt: lastShop,
    customerMessageCount: customerCount,
    shopMessageCount: shopCount,
    ownerName,
    earliestMessageAt: earliest,
  };
}

/** Dòng sẽ ghi vào `conversation_funnel`. Khớp đúng cột, không thêm suy diễn nào ở tầng ghi. */
export type ConversationFunnelRow = typeof schema.conversationFunnel.$inferInsert;

/**
 * Dựng một dòng phễu từ những gì job đã có trong tay. Thuần — không chạm CSDL, không gọi API.
 *
 * `scanWindowFrom` là mốc sớm nhất ta THẬT SỰ đọc được: lấy mốc sớm nhất trong các tin, và nếu
 * không có tin nào thì lấy biên cửa sổ quét. Không có nó thì một hội thoại `phone_at = NULL` không
 * phân biệt được "khách chưa cho số" với "ta chưa đọc tới đoạn khách cho số".
 */
export function buildConversationFunnelRow(input: {
  pageId: string;
  conversationId: string;
  pancakeCustomerId: string;
  customerName: string;
  tags: string[];
  messages: PancakeMessage[];
  convPhones: string[];
  match: OrderMatch;
  /** Biên dưới của cửa sổ quét lần này. */
  since: Date;
  /** Page này đã chạm trần số hội thoại mỗi lượt quét ⇒ còn hội thoại chưa đọc. */
  truncated: boolean;
}): ConversationFunnelRow {
  const timeline = messageTimeline(input.messages);
  const evidence = extractCustomerEvidence(input.messages, input.convPhones);
  const matchBasis: OrderMatchBasis = input.match.kind;

  // ĐỦ THÔNG TIN = có CẢ HAI. Mốc là cái muộn hơn — trước đó chưa lên đơn được.
  const phoneAt = evidence.phoneFirstAt;
  const addressAt = evidence.addressFirstAt;
  const infoCompleteAt =
    evidence.phone && evidence.address
      ? ([phoneAt, addressAt].filter((d): d is Date => d instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null)
      : null;

  return {
    pageId: input.pageId,
    conversationId: input.conversationId,
    pancakeCustomerId: input.pancakeCustomerId,
    customerName: input.customerName.slice(0, 200),
    phone: evidence.phone || null,
    firstCustomerMessageAt: timeline.firstCustomerMessageAt,
    firstShopReplyAt: timeline.firstShopReplyAt,
    lastCustomerMessageAt: timeline.lastCustomerMessageAt,
    lastShopMessageAt: timeline.lastShopMessageAt,
    customerMessageCount: timeline.customerMessageCount,
    shopMessageCount: timeline.shopMessageCount,
    phoneAt,
    addressAt,
    addressText: evidence.address.slice(0, 500),
    infoCompleteAt,
    tags: input.tags.slice(0, 30),
    ownerName: timeline.ownerName.slice(0, 200),
    matchedOrderId: input.match.order?.id ?? null,
    matchBasis,
    matchCandidates: input.match.kind === "AMBIGUOUS" ? input.match.candidates : input.match.order ? 1 : 0,
    matchedOrderAt: input.match.order?.insertedAt ?? null,
    truncated: input.truncated,
    lastScanAt: new Date(),
    scanWindowFrom: timeline.earliestMessageAt ?? input.since,
    evidence: {
      phone: evidence.phoneText,
      /*
        SĐT do Pancake tách sẵn KHÔNG có mốc thời gian của tin. Không ghi cờ này thì `phone_at = NULL`
        bị đọc thành "khách chưa cho số", trong khi thật ra là "có số nhưng không biết lúc nào".
      */
      phoneFromPancakeList: evidence.phoneFromPancakeList,
      address: evidence.address,
      tags: input.tags.slice(0, 30),
    },
  };
}

/**
 * Ghi các dòng phễu. Khoá tự nhiên `(page_id, conversation_id)` ⇒ quét lại thì CẬP NHẬT.
 *
 * ─── HAI THỨ KHÔNG BAO GIỜ BỊ GHI ĐÈ ───
 *
 * `first_seen_at` giữ nguyên lần đầu ERP thấy hội thoại: đó là mốc dựng nên ĐỘ PHỦ, và ghi đè nó
 * mỗi lần quét sẽ làm khoảng phủ trông như chỉ dài 48 giờ mãi mãi.
 *
 * `scan_window_from` chỉ được LÙI VỀ SỚM HƠN, không bao giờ tiến lên: nó là mốc sớm nhất ta từng
 * đọc được: một lượt quét sau với cửa sổ hẹp hơn không được xoá đi hiểu biết đã có.
 *
 * Mốc bằng chứng (`phone_at`, `address_at`) chỉ được GIỮ CÁI SỚM HƠN — dùng
 * `least(...)` thay vì lấy giá trị mới, vì lượt quét sau có cửa sổ hẹp hơn sẽ không còn thấy tin
 * cũ và sẽ báo `NULL`. Để `NULL` ghi đè một mốc đã biết là **xoá bằng chứng lặng lẽ**.
 */
export async function upsertConversationFunnel(db: Db, rows: ConversationFunnelRow[]): Promise<number> {
  if (!rows.length) return 0;
  const cf = schema.conversationFunnel;
  const inserted = await db
    .insert(cf)
    .values(rows)
    .onConflictDoUpdate({
      target: [cf.pageId, cf.conversationId],
      set: {
        pancakeCustomerId: sql`excluded.pancake_customer_id`,
        customerName: sql`excluded.customer_name`,
        // Số mới nhất khách đưa thắng; nhưng KHÔNG để NULL xoá số đã biết.
        phone: sql`coalesce(excluded.phone, ${cf.phone})`,
        // Mốc SỚM hơn thắng: cửa sổ quét hẹp lại không được làm mất mốc đã ghi.
        firstCustomerMessageAt: sql`least(excluded.first_customer_message_at, ${cf.firstCustomerMessageAt})`,
        firstShopReplyAt: sql`least(excluded.first_shop_reply_at, ${cf.firstShopReplyAt})`,
        // Mốc MUỘN hơn thắng: đây là hoạt động gần nhất.
        lastCustomerMessageAt: sql`greatest(excluded.last_customer_message_at, ${cf.lastCustomerMessageAt})`,
        lastShopMessageAt: sql`greatest(excluded.last_shop_message_at, ${cf.lastShopMessageAt})`,
        customerMessageCount: sql`greatest(excluded.customer_message_count, ${cf.customerMessageCount})`,
        shopMessageCount: sql`greatest(excluded.shop_message_count, ${cf.shopMessageCount})`,
        phoneAt: sql`least(excluded.phone_at, ${cf.phoneAt})`,
        addressAt: sql`least(excluded.address_at, ${cf.addressAt})`,
        addressText: sql`case when excluded.address_text <> '' then excluded.address_text else ${cf.addressText} end`,
        infoCompleteAt: sql`least(excluded.info_complete_at, ${cf.infoCompleteAt})`,
        tags: sql`excluded.tags`,
        ownerName: sql`case when excluded.owner_name <> '' then excluded.owner_name else ${cf.ownerName} end`,
        matchedOrderId: sql`coalesce(excluded.matched_order_id, ${cf.matchedOrderId})`,
        /*
          CĂN CỨ GHÉP PHẢI ĐI THEO ĐƠN ĐÃ GHÉP — nếu không, một lượt quét sau sẽ XOÁ LẶNG LẼ một
          hội thoại đã chuyển đổi.

          Lỗi đã tránh được ở đây: `matched_order_id` dùng `coalesce` nên GIỮ đơn cũ, nhưng nếu
          `match_basis` bị ghi đè thẳng bằng giá trị mới thì lượt quét sau (cửa sổ hẹp hơn, không
          thấy SĐT nữa ⇒ ghép ra `NONE`) sẽ để lại một dòng có `matched_order_id` mà `match_basis =
          'NONE'`. Truy vấn phễu đếm "đã thành đơn" theo CẢ HAI điều kiện, nên hội thoại đó biến mất
          khỏi tử số — tỷ lệ chuyển đổi tụt xuống mà không ai biết vì sao.

          Luật: chỉ nhận căn cứ mới khi lượt quét mới THẬT SỰ ghép được đơn.
        */
        matchBasis: sql`case when excluded.matched_order_id is not null then excluded.match_basis
          when ${cf.matchedOrderId} is not null then ${cf.matchBasis}
          else excluded.match_basis end`,
        matchCandidates: sql`excluded.match_candidates`,
        matchedOrderAt: sql`coalesce(excluded.matched_order_at, ${cf.matchedOrderAt})`,
        truncated: sql`excluded.truncated`,
        lastScanAt: sql`excluded.last_scan_at`,
        // Chỉ LÙI VỀ sớm hơn: mốc sớm nhất ta từng đọc được là kiến thức, không phải trạng thái.
        scanWindowFrom: sql`least(excluded.scan_window_from, ${cf.scanWindowFrom})`,
        evidence: sql`excluded.evidence`,
        updatedAt: sql`now()`,
        // `first_seen_at` CỐ Ý không có ở đây: ghi đè nó là xoá mốc dựng nên độ phủ.
      },
    })
    .returning({ id: cf.id });
  return inserted.length;
}
