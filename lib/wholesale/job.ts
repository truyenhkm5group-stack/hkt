import { and, count, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { SyncTrigger } from "@/lib/sync/runner";
import { runSyncJob } from "@/lib/sync/runner";
import { runLeadHunterTick, type TickDeps, type TickResult } from "@/lib/wholesale/engine";
import { autoPrepareForLead } from "@/lib/wholesale/outreach";
import { getLeadHunterConfig } from "@/lib/wholesale/store";

/**
 * ═══════════ JOB «wholesale-leads» — MỘT LƯỢT QUÉT CHO TỔ CHỨC ĐANG CHẠY ═══════════
 *
 * Bộ lịch gọi mỗi 3 phút cho từng tổ chức khách (fan-out tầng tự động). Không có việc ⇒ trả `IDLE` mà KHÔNG ghi
 * `sync_runs` (480 dòng rỗng mỗi ngày không nói gì với ai). Có việc ⇒ `runSyncJob` giữ khoá theo tổ chức + job, nên lượt
 * của bộ lịch và lượt «Chạy ngay» do người bấm không chồng nhau.
 */

export type WholesaleJobOutcome = { skipped: "IDLE"; detail: string } | { skipped: "RUNNING"; detail: string } | TickResult;

/** Có việc cho lượt này không — câu hỏi rẻ, trước khi mở khoá / ghi sổ. */
export async function leadHunterHasWork(now = new Date()): Promise<boolean> {
  const db = await getDb();
  const c = schema.wholesaleCampaigns;
  const l = schema.wholesaleLeads;
  const s = schema.wholesalePlaceSnapshots;
  const [[camps], [leads], [snaps]] = await Promise.all([
    db.select({ n: count() }).from(c).where(or(eq(c.status, "RUNNING"), and(eq(c.status, "PAUSED"), inArray(c.pauseReason, ["BUDGET_DAILY", "BUDGET_MONTHLY", "REQUEST_LIMIT"])))),
    db.select({ n: count() }).from(l).where(or(eq(l.enrichmentStatus, "PENDING_DETAILS"), and(eq(l.websiteStatus, "PENDING"), eq(l.enrichmentStatus, "READY")))),
    db.select({ n: count() }).from(s).where(and(isNull(s.purgedAt), lt(s.expiresAt, new Date(now.getTime() + 3 * 86_400_000)))),
  ]);
  return Number(camps?.n ?? 0) + Number(leads?.n ?? 0) + Number(snaps?.n ?? 0) > 0;
}

export async function runWholesaleLeadsJob(o: { trigger: SyncTrigger; actor: string; budgetMs?: number }, deps: TickDeps = {}): Promise<WholesaleJobOutcome> {
  if (!(await leadHunterHasWork())) return { skipped: "IDLE", detail: "Không chiến dịch nào đang chạy, không lead nào chờ bổ sung." };
  const r = await runSyncJob({ source: "ERP", job: "wholesale-leads", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
    const tick = await runLeadHunterTick({ budgetMs: o.budgetMs ?? 50_000 }, deps);
    const cfg = await getLeadHunterConfig();
    let prepared = 0;
    for (const id of tick.qualified) if (await autoPrepareForLead(id, cfg, new Date())) prepared++;
    ctx.summary.imported = tick.newLeads;
    ctx.summary.updated = tick.detailsDone + tick.websitesDone + tick.refreshed;
    ctx.summary.skipped = tick.purged;
    ctx.summary.detail = prepared ? `${tick.detail} · ${prepared} lời chào soạn sẵn chờ duyệt` : tick.detail;
    if (tick.paused.length) ctx.summary.warning = `Đã tự tạm dừng ${tick.paused.length} chiến dịch (${tick.paused[0]!.reason}).`;
    return tick;
  });
  if (r.skippedBecauseRunning) return { skipped: "RUNNING", detail: "Lượt trước của tổ chức này còn đang chạy." };
  return r.result ?? { skipped: "IDLE", detail: "Lượt không trả kết quả." };
}
