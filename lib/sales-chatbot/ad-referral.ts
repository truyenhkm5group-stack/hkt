/**
 * ═══════════ QUẢNG CÁO DẪN KHÁCH VÀO HỘI THOẠI — LƯU LÊN HỘI THOẠI, ĐỌC LẠI KHI LÊN ĐƠN (CHỈ MÁY CHỦ) ═══════════
 *
 * Bộ đọc gói tin + lý lẽ: `ad-referral-shared.ts`. Cửa sổ quy kết: `lib/constants/chat-ad-attribution.ts`.
 *
 *  · `recordConversationAd` — ghi `ad_id` / `ad_seen_at` / `ad_source` lên hội thoại khi mã MỚI khác mã đang lưu (hoặc cùng mã
 *    nhưng có MỐC BẤM THẬT mới hơn), và lượt bấm không cũ hơn lượt đang lưu (gói tin tới sai thứ tự không được kéo mã cũ đè lên mã mới).
 *  · `chatOrderAdId` — mã quảng cáo đơn TẠO lúc `orderAt` cho hội thoại này được mang: lượt bấm trong cửa sổ trước mốc tạo đơn,
 *    không thì `null`. Máy chủ quyết, không nhận từ client / AI.
 *  · `chatAdCoverage` — bao nhiêu hội thoại fanpage có khách nhắn trong kỳ mang mã quảng cáo (màn /ads in ra, vì chưa đo được
 *    Pancake có gửi trường quảng cáo không).
 */
import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CHAT_AD_ATTRIBUTION_SETTING_KEY, chatAdForOrder, parseChatAttributionWindowDays } from "@/lib/constants/chat-ad-attribution";
import type { AdReferral } from "@/lib/sales-chatbot/ad-referral-shared";
import { getSettingJson } from "@/lib/settings";

const c = schema.salesChatConversations;

/** Ghi mã quảng cáo lên hội thoại. `at` = mốc tin (dùng khi gói tin không có mốc bấm). Trả `true` khi đã ghi. */
export async function recordConversationAd(conversationId: string, ref: AdReferral, at: Date): Promise<boolean> {
  const db = await getDb();
  const seen = ref.clickedAt ?? at;
  const rows = await db
    .update(c)
    .set({ adId: ref.adId, adSeenAt: seen, adSource: ref.source })
    .where(
      and(
        eq(c.id, conversationId),
        sql`(${c.adSeenAt} is null or ${c.adSeenAt} <= ${seen.toISOString()}::timestamptz)`,
        /*
          Mã KHÁC ⇒ ghi. CÙNG mã ⇒ chỉ làm mới mốc khi gói tin mang MỐC BẤM THẬT mới hơn: khách bấm lại đúng quảng cáo ấy sau
          một tuần thì đơn mới vẫn phải vào cửa sổ. Gói không có mốc bấm (Pancake có thể gửi lại cả danh sách cộng dồn ở MỖI tin)
          thì không làm mới — nếu không, mỗi tin nhắn lại kéo dài cửa sổ quy kết của một lượt bấm cũ.
        */
        ref.clickedAt
          ? sql`(${c.adId} is distinct from ${ref.adId} or ${c.adSeenAt} < ${ref.clickedAt.toISOString()}::timestamptz)`
          : sql`${c.adId} is distinct from ${ref.adId}`,
      ),
    )
    .returning({ id: c.id });
  return rows.length > 0;
}

/** Cửa sổ quy kết (ngày) đang áp — setting của tổ chức, thiếu / sai ⇒ mặc định. */
export async function loadChatAttributionWindowDays(): Promise<number> {
  return parseChatAttributionWindowDays(await getSettingJson<unknown>(CHAT_AD_ATTRIBUTION_SETTING_KEY, null));
}

/**
 * Mã quảng cáo đơn tạo lúc `orderAt` của hội thoại `conversationId` được mang — hoặc `null`. Đọc hỏng ⇒ `null` kèm nhật ký: đơn
 * vẫn lên (chưa quy kết được), vì một lượt đọc quảng cáo hỏng không được làm mất đơn của khách.
 */
export async function chatOrderAdId(conversationId: string, orderAt: Date): Promise<string | null> {
  try {
    const db = await getDb();
    const [row] = await db.select({ adId: c.adId, adSeenAt: c.adSeenAt }).from(c).where(eq(c.id, conversationId)).limit(1);
    if (!row?.adId) return null;
    return chatAdForOrder(row, orderAt, await loadChatAttributionWindowDays());
  } catch (error) {
    console.error(`[quảng cáo hội thoại] không đọc được mã quảng cáo của hội thoại ${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export type ChatAdCoverage = {
  /** Hội thoại fanpage có tin KHÁCH trong kỳ. */
  conversations: number;
  /** Trong số đó: mang mã quảng cáo. */
  withAd: number;
};

/** Độ phủ mã quảng cáo trên hội thoại fanpage có khách nhắn trong kỳ. `from`/`to` null ⇒ không giới hạn. */
export async function chatAdCoverage(from: Date | null, to: Date | null): Promise<ChatAdCoverage> {
  const db = await getDb();
  const conds = [eq(c.channel, "FANPAGE"), isNotNull(c.lastCustomerAt)];
  if (from) conds.push(gte(c.lastCustomerAt, from));
  if (to) conds.push(lte(c.lastCustomerAt, to));
  const [row] = await db
    .select({ conversations: sql<number>`count(*)`, withAd: sql<number>`count(*) filter (where ${c.adId} is not null)` })
    .from(c)
    .where(and(...conds));
  return { conversations: Number(row?.conversations ?? 0), withAd: Number(row?.withAd ?? 0) };
}
