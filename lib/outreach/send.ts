import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadOutreachConfig } from "@/lib/outreach/build";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";

/** Gửi tin cho các mục đã chọn (chỉ PENDING, có hội thoại Pancake). Tôn trọng giới hạn ngày và giãn cách 1,5 giây. */
export async function sendOutreachTargets(ids: string[], actor: string, options: { dryRun?: boolean } = {}) {
  const db = await getDb();
  const cfg = await loadOutreachConfig();
  const client = getPancakePagesClient();
  const [sentToday] = await db.select({ count: sql<number>`count(*)` }).from(schema.outreachTargets).where(and(eq(schema.outreachTargets.status, "SENT"), gte(schema.outreachTargets.sentAt, new Date(Date.now() - 86_400_000))));
  let remaining = Math.max(0, cfg.dailyLimit - Number(sentToday?.count ?? 0));
  const targets = await db.select().from(schema.outreachTargets).where(and(inArray(schema.outreachTargets.id, ids), eq(schema.outreachTargets.status, "PENDING")));
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of targets) {
    if (!t.pageId || !t.conversationId) {
      await db.update(schema.outreachTargets).set({ status: "SKIPPED", error: "Không có hội thoại Pancake — nhắn qua Zalo/SMS", updatedAt: new Date() }).where(eq(schema.outreachTargets.id, t.id));
      skipped += 1;
      continue;
    }
    if (remaining <= 0) {
      skipped += 1;
      continue;
    }
    if (options.dryRun) {
      sent += 1;
      continue;
    }
    const r = await client.sendMessage(t.pageId, t.conversationId, t.pancakeCustomerId, t.message);
    if (r.ok) {
      await db.update(schema.outreachTargets).set({ status: "SENT", sentAt: new Date(), sentBy: actor, error: "", updatedAt: new Date() }).where(eq(schema.outreachTargets.id, t.id));
      sent += 1;
      remaining -= 1;
    } else {
      await db.update(schema.outreachTargets).set({ status: "FAILED", error: (r.error ?? "Gửi thất bại").slice(0, 300), updatedAt: new Date() }).where(eq(schema.outreachTargets.id, t.id));
      failed += 1;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { sent, failed, skipped, remainingToday: remaining };
}
