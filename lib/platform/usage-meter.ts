import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import { getDbFor, getPlatformDb, schema } from "@/db";
import { readFanpagesActive, readOrgUsage } from "@/lib/platform/saas-ledger";
import type { Organization } from "@/lib/platform/types";
import { EMPTY_READINGS, type MeterReadings, type UsagePeriod } from "@/lib/pricing/meter";

/**
 * ═══════════ ĐỒNG HỒ ĐO DÙNG — ĐƯỜNG ĐỌC DUY NHẤT (0222 · lib/pricing/meter.ts) ═══════════
 *
 * Số dùng của MỘT tổ chức trong MỘT kỳ, ghép từ hai nguồn đã có — không bảng đếm thứ hai:
 *  · CSDL của chính tổ chức, bằng ĐÚNG câu đếm của sổ dùng theo ngày (`readOrgUsage`, 0204) cho cả kỳ: hội thoại mới,
 *    hội thoại AI (phân biệt cả kỳ), tin khách, tin AI, đơn do AI chốt; cộng fanpage đang hoạt động (tức thời).
 *  · `platform_ai_usage` (CSDL nhà): lời gọi model, token, lượt đọc / vẽ ảnh — lọc ĐÚNG `org_code`.
 * Lỗi của MỘT nguồn ⇒ các đồng hồ của nguồn đó `null` (CHƯA BIẾT) + câu lỗi; không bao giờ đổi thành 0 (luật 42).
 * Chỉ ĐẾM — không đọc nội dung hội thoại, tên, SĐT.
 */

export type PeriodUsageResult = { readings: MeterReadings; measuredAt: string; errors: string[] };

/** Số dùng của tổ chức `org` trong `[period.from, min(now, period.to))`. */
export async function readPeriodUsage(org: Pick<Organization, "code" | "isHome">, period: UsagePeriod, now: Date = new Date()): Promise<PeriodUsageResult> {
  const readings: MeterReadings = { ...EMPTY_READINGS };
  const errors: string[] = [];
  const to = now < period.to ? now : period.to;
  try {
    const db = await getDbFor(org);
    const u = await readOrgUsage(db, period.from, to);
    readings.conversation_count = u.conversationsStarted;
    readings.ai_conversations = u.aiActiveConversations;
    readings.incoming_messages = u.customerMessages;
    readings.outgoing_ai_messages = u.botMessages;
    readings.orders_created_by_ai = u.aiOrders;
    readings.fanpages_active = await readFanpagesActive(db);
  } catch (e) {
    errors.push(`CSDL tổ chức: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`);
  }
  try {
    const pdb = await getPlatformDb();
    const a = schema.platformAiUsage;
    const [r] = await pdb
      .select({
        calls: sql<number>`coalesce(sum(${a.requests}), 0)::int`,
        input: sql<number>`coalesce(sum(${a.inputTokens}), 0)::float8`,
        output: sql<number>`coalesce(sum(${a.outputTokens}), 0)::float8`,
        images: sql<number>`coalesce(sum(${a.requests}) filter (where ${a.modality} in ('VISION','IMAGE') or ${a.feature} = 'creative_image'), 0)::int`,
      })
      .from(a)
      .where(and(eq(a.orgCode, org.code), gte(a.at, period.from), lt(a.at, to), ne(a.status, "BLOCKED_QUOTA")));
    readings.ai_calls = Number(r?.calls ?? 0);
    readings.input_tokens = Number(r?.input ?? 0);
    readings.output_tokens = Number(r?.output ?? 0);
    readings.image_calls = Number(r?.images ?? 0);
  } catch (e) {
    errors.push(`Sổ AI: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`);
  }
  return { readings, measuredAt: now.toISOString(), errors };
}
