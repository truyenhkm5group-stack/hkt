import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { isDue, renderTemplate, shortName } from "@/lib/constants/outreach";
import { loadOutreachConfig, nurtureVars } from "@/lib/outreach/build";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";

/**
 * Gửi tin cho các mục đã chọn (chỉ PENDING đã đến hạn, có hội thoại Pancake). Tôn trọng giới hạn ngày và giãn cách 1,5 giây.
 * Băn khoăn nhiều bước: gửi xong bước k → chuẩn bị bước k+1, hẹn sau nurtureStepGapDays ngày; hết bước → SENT.
 */
export async function sendOutreachTargets(ids: string[], actor: string, options: { dryRun?: boolean } = {}) {
  const db = await getDb();
  const cfg = await loadOutreachConfig();
  const client = getPancakePagesClient();
  const t = schema.outreachTargets;
  const [sentToday] = await db.select({ count: sql<number>`count(*)` }).from(t).where(gte(t.sentAt, new Date(Date.now() - 86_400_000)));
  let remaining = Math.max(0, cfg.dailyLimit - Number(sentToday?.count ?? 0));
  const targets = await db.select().from(t).where(and(inArray(t.id, ids), eq(t.status, "PENDING")));
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let notDue = 0;
  for (const row of targets) {
    if (!isDue(row)) {
      notDue += 1;
      continue;
    }
    if (!row.pageId || !row.conversationId) {
      await db.update(t).set({ status: "SKIPPED", error: "Không có hội thoại Pancake — nhắn qua Zalo/SMS", updatedAt: new Date() }).where(eq(t.id, row.id));
      skipped += 1;
      continue;
    }
    if (remaining <= 0) {
      skipped += 1;
      continue;
    }
    const r = options.dryRun ? { ok: true as const } : await client.sendMessage(row.pageId, row.conversationId, row.pancakeCustomerId, row.message);
    const now = new Date();
    let mediaNote = "";
    if (r.ok && !options.dryRun && Array.isArray(row.mediaUrls) && row.mediaUrls.length) {
      const failures: string[] = [];
      for (const url of row.mediaUrls.slice(0, cfg.maxMediaPerMessage)) {
        await new Promise((res) => setTimeout(res, 800));
        const a = await client.sendAttachment(row.pageId, row.conversationId, row.pancakeCustomerId, url);
        if (!a.ok) failures.push(a.error ?? "lỗi");
      }
      if (failures.length) mediaNote = `Ảnh/video: ${failures.length}/${row.mediaUrls.length} gửi lỗi (${failures[0].slice(0, 120)})`;
    }
    if (r.ok) {
      const steps = row.segment === "NURTURE" ? cfg.nurtureSteps : [row.message];
      const nextStep = row.step + 1;
      if (nextStep < steps.length) {
        const nextMessage = renderTemplate(steps[nextStep], nurtureVars(cfg, shortName(row.customerName), row.suggestions));
        await db.update(t).set({ status: "PENDING", step: nextStep, message: nextMessage, sentCount: row.sentCount + 1, sentAt: now, sentBy: actor, nextAt: new Date(now.getTime() + cfg.nurtureStepGapDays * 86_400_000), error: mediaNote, updatedAt: now }).where(eq(t.id, row.id));
      } else {
        await db.update(t).set({ status: "SENT", step: nextStep, sentCount: row.sentCount + 1, sentAt: now, sentBy: actor, nextAt: null, error: mediaNote, updatedAt: now }).where(eq(t.id, row.id));
      }
      sent += 1;
      remaining -= 1;
    } else {
      await db.update(t).set({ status: "FAILED", error: ("error" in r && r.error ? r.error : "Gửi thất bại").slice(0, 300), updatedAt: now }).where(eq(t.id, row.id));
      failed += 1;
    }
    if (!options.dryRun) await new Promise((res) => setTimeout(res, 1500));
  }
  return { sent, failed, skipped, notDue, remainingToday: remaining };
}
