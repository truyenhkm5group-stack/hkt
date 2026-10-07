import { and, desc, eq, gte } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";

/**
 * CHỨNG CỨ TỪ SỔ AI cho hộp thư bán hàng (lib/sales-chatbot/ai-status.ts) — CHỈ ĐỌC `platform_ai_usage`, luôn lọc theo ĐÚNG mã tổ
 * chức nơi gọi truyền vào (tổ chức ngữ cảnh của phiên), không bao giờ đọc chéo tổ chức. Không mang nội dung tin.
 */

/**
 * Các lượt AI của bot bán hàng trên MỘT hội thoại (ref = mã hội thoại) từ mốc `since` (tin cũ nhất đang hiện) — mốc + trạng thái,
 * mới nhất trước, tối đa `limit` dòng. Chỉ mục `platform_ai_usage_org_ref_at_idx` (0231) phục vụ đúng câu này.
 */
export async function salesAiCallsForConversation(orgCode: string, conversationId: string, since: Date, limit = 200): Promise<{ at: Date; status: string }[]> {
  const pdb = await getPlatformDb();
  const u = schema.platformAiUsage;
  return pdb
    .select({ at: u.at, status: u.status })
    .from(u)
    .where(and(eq(u.orgCode, orgCode), eq(u.ref, conversationId), eq(u.feature, "sales_chatbot"), gte(u.at, since)))
    .orderBy(desc(u.at))
    .limit(limit);
}

/** Lượt AI gần nhất của bot bán hàng trong tổ chức từ mốc `since` — `null` = chưa có lượt nào. */
export async function lastSalesAiCall(orgCode: string, since: Date): Promise<{ at: Date; status: string } | null> {
  const pdb = await getPlatformDb();
  const u = schema.platformAiUsage;
  const [last] = await pdb
    .select({ at: u.at, status: u.status })
    .from(u)
    .where(and(eq(u.orgCode, orgCode), eq(u.feature, "sales_chatbot"), gte(u.at, since)))
    .orderBy(desc(u.at))
    .limit(1);
  return last ?? null;
}
