/**
 * AI ĐÃ SẴN SÀNG TỰ TRẢ LỜI CHƯA — đọc số đếm thật của tổ chức NGỮ CẢNH (luật ở `readiness-shared.ts`). Chỉ đếm, không ghi.
 */
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { assessReadiness, type ReadinessCheck, type ReadinessVerdict } from "@/lib/sales-chatbot/readiness-shared";

export async function loadReadiness(cfg: SalesChatbotConfig, ai: { ready: boolean; reason: string | null }, now: Date = new Date()): Promise<{ verdict: ReadinessVerdict; checks: ReadinessCheck[] }> {
  const db = await getDb();
  const d30 = new Date(now.getTime() - 30 * 86_400_000);
  const d7 = new Date(now.getTime() - 7 * 86_400_000);
  const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);
  const v = schema.productVariants;
  const e = schema.salesConversationEvents;
  const [priced, receipts, real, drafts, replays, priceErrors] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(v).where(and(eq(v.isRemoved, false), sql`${v.retailPrice} > 0`)),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.stockReceipts),
    db.select({ n: sql<number>`count(distinct ${e.conversationId})::int` }).from(e).where(and(gte(e.occurredAt, d30), ne(e.channel, "TEST"), eq(e.type, "message.received"))),
    db.select({ n: sql<number>`count(*)::int` }).from(e).where(and(gte(e.occurredAt, d30), eq(e.channel, "TEST"), eq(e.type, "order.drafted"))),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.salesReplayRuns).where(and(eq(schema.salesReplayRuns.status, "DONE"), gte(schema.salesReplayRuns.finishedAt, d30))),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.salesAiReviews).where(and(eq(schema.salesAiReviews.kind, "PRICE_UNGROUNDED"), eq(schema.salesAiReviews.status, "CONFIRMED"), gte(schema.salesAiReviews.reviewedAt, d7))),
  ]);
  return assessReadiness({
    botEnabled: cfg.enabled,
    aiReady: ai.ready,
    aiReason: ai.reason,
    pricedVariants: n(priced),
    sellWithoutStockCheck: cfg.sellWithoutStockCheck,
    stockReceipts: n(receipts),
    notifyGroupOnHandoff: cfg.handoff.notifyGroup,
    realConversations30d: n(real),
    testDrafts30d: n(drafts),
    replayRuns30d: n(replays),
    confirmedPriceErrors7d: n(priceErrors),
  });
}
