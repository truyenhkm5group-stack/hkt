import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import { aiUsageDaily } from "@/lib/ai-usage/ledger";
import { memo } from "@/lib/cache";
import { AGENTS, AI_AUTONOMY_LABEL, agentLabel, type AgentZone, type AiAutonomy } from "@/lib/constants/department-ai";
import {
  MC_GRADUATION_KEY,
  MC_MEASURES,
  MC_WINDOWS,
  MC_ZONES,
  graduationVerdict,
  parseGraduation,
  type GraduationRule,
  type GraduationVerdict,
  type ReviewSample,
  type ZoneMeasure,
} from "@/lib/constants/mission-control";
import { currentOrganization } from "@/lib/platform/context";
import { PRIMARY_ATTEMPT, VERIFIED_CASH } from "@/lib/queries/return-rate";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { attributedOrderFacts } from "@/lib/sales-chatbot/attribution";
import { getSettingJson } from "@/lib/settings";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ MISSION CONTROL — ĐƯỜNG ĐỌC (chủ shop 30/10/2026 · lib/constants/mission-control.ts) ═══════════
 *
 * Một hàng cho MỖI KHOÁ của sổ `AGENTS` (department-ai.ts) — không danh sách agent thứ hai. Mọi số đọc từ nguồn ĐANG CÓ:
 *  · lượt / token / USD — `aiUsageDaily` (sổ dùng AI ở CSDL nhà, lọc ĐÚNG mã tổ chức đang đăng nhập — cách ly tổ chức);
 *  · việc máy phát hiện đang mở — `collectWorkItems` (đúng phép chiếu của /work), `creationSource = AUTO`, phòng = phòng của agent;
 *  · người duyệt / bác — quy kết đơn của màn «Hiệu quả» (bot bán hàng) · `recommendation_decisions` (đề xuất buồng lái) ·
 *    `tech_tasks` (PR của agent Tech);
 *  · tiền thật — đơn GIAO THÀNH CÔNG (ORDER_OUTCOME, qua quy kết) + VERIFIED_CASH; chưa chứng từ ⇒ `null`.
 * Chưa có nguồn ⇒ chỉ số mang `missing` (in «chưa đo được»), KHÔNG số 0, KHÔNG số gần đúng. Đệm 90 giây theo tổ chức (lib/cache).
 */

export type UsageCell = { turns: number; requests: number; inputTokens: number; outputTokens: number; costUsd: number | null; unknownCost: number };
export type OutcomeCell = { delivered: number; verifiedCash: number | null };

export type ZoneRow = {
  zone: AgentZone;
  label: string;
  name: string | null;
  home: string | null;
  autonomy: AiAutonomy;
  autonomyLabel: string;
  measure: ZoneMeasure;
  /** `null` = KHÔNG ÁP DỤNG (agent không gọi mô hình — `measure.usageNone` nói vì sao). */
  usage: Record<(typeof MC_WINDOWS)[number], UsageCell> | null;
  /** Việc máy phát hiện đang mở trên /work của phòng này. `null` = không đọc được hàng đợi lúc này. */
  workOpen: number | null;
  /** Khối lượng riêng (care máy mở ca); `unknown` = đợt cũ chưa ghi nguồn mở (đứng ngoài, không đoán). */
  volume: Record<(typeof MC_WINDOWS)[number], { count: number; unknown: number }> | null;
  /** `null` = CHƯA ĐO ĐƯỢC (`measure.review.kind === "NONE"`). */
  review: Record<(typeof MC_WINDOWS)[number], ReviewSample> | null;
  outcome: Record<(typeof MC_WINDOWS)[number], OutcomeCell> | null;
  rule: GraduationRule | null;
  verdict: GraduationVerdict;
};

export type MissionControl = { orgCode: string; generatedAt: Date; zones: ZoneRow[]; workFailed: string[] };

const sinceOf = (now: Date, days: number) => new Date(dauNgayVN(now).getTime() - (days - 1) * 86_400_000);

/** Bot bán hàng — mẫu ĐÚNG / BÁC + kết quả tiền thật, từ CHÍNH tập quy kết của màn «Hiệu quả». */
async function botWindow(days: number, now: Date): Promise<{ review: ReviewSample; outcome: OutcomeCell }> {
  const facts = await attributedOrderFacts({ days, now });
  const finished = facts.filter((f) => f.attribution === "AI_ONLY" && (f.settled || f.cancelled));
  const rejected = finished.filter((f) => f.cancelled).length;
  const deliveredIds = facts.filter((f) => (f.attribution === "AI_ONLY" || f.attribution === "AI_ASSISTED") && f.delivered).map((f) => f.orderId);
  let verifiedCash: number | null = null;
  if (deliveredIds.length) {
    const db = await getDb();
    const o = schema.orders;
    const s = schema.shipments;
    const [r] = await db
      .select({ cash: sql<string | null>`sum(case when ${VERIFIED_CASH} > 0 then ${VERIFIED_CASH} end)` })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(inArray(o.id, deliveredIds));
    verifiedCash = r?.cash === null || r?.cash === undefined ? null : Number(r.cash);
  }
  return { review: { correct: finished.length - rejected, rejected, sample: finished.length }, outcome: { delivered: deliveredIds.length, verifiedCash } };
}

/** Đề xuất buồng lái — phản ứng MỚI NHẤT của mỗi đề xuất trong kỳ; «nhắc lại sau» không vào mẫu. */
async function ownerDecisionWindow(kinds: readonly string[], since: Date): Promise<ReviewSample> {
  const db = await getDb();
  const raw = await db.execute(sql`
    select count(*) filter (where decision = 'ACCEPTED')::int as accepted, count(*) filter (where decision = 'DISMISSED')::int as dismissed
    from (
      select distinct on (source_key) source_key, decision
      from recommendation_decisions
      where decided_at >= ${since} and kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
      order by source_key, decided_at desc, id desc
    ) latest`);
  const [r] = rowsOf<{ accepted: number | string; dismissed: number | string }>(raw);
  const correct = Number(r?.accepted ?? 0);
  const rejected = Number(r?.dismissed ?? 0);
  return { correct, rejected, sample: correct + rejected };
}

/** PR của việc Tech có agent cầm, tạo trong kỳ, đã khép: gộp = đúng, đóng không gộp = bác. PR còn mở không vào mẫu. */
async function techPrWindow(since: Date): Promise<ReviewSample> {
  const db = await getDb();
  const t = schema.techTasks;
  const merged = sql`(${t.mergeState} = 'MERGED' or ${t.prState} = 'MERGED')`;
  const [r] = await db
    .select({
      merged: sql<number>`count(*) filter (where ${merged})::int`,
      closed: sql<number>`count(*) filter (where ${t.prState} = 'CLOSED' and not ${merged})::int`,
    })
    .from(t)
    .where(and(sql`${t.agentId} is not null`, sql`${t.prNumber} is not null`, gte(t.createdAt, since)));
  const correct = Number(r?.merged ?? 0);
  const rejected = Number(r?.closed ?? 0);
  return { correct, rejected, sample: correct + rejected };
}

/** Ca care máy tự mở (nguồn mở ≠ MANUAL). Đợt cũ chưa ghi nguồn mở đứng riêng — không đoán. */
async function careMachineWindow(since: Date): Promise<{ count: number; unknown: number }> {
  const db = await getDb();
  const c = schema.shipmentCare;
  const [r] = await db
    .select({
      machine: sql<number>`count(*) filter (where ${c.sourceTrigger} is not null and ${c.sourceTrigger} <> 'MANUAL')::int`,
      unknown: sql<number>`count(*) filter (where ${c.sourceTrigger} is null)::int`,
    })
    .from(c)
    .where(gte(c.openedAt, since));
  return { count: Number(r?.machine ?? 0), unknown: Number(r?.unknown ?? 0) };
}

async function reviewFor(m: ZoneMeasure, days: number, now: Date): Promise<{ review: ReviewSample | null; outcome: OutcomeCell | null }> {
  const since = sinceOf(now, days);
  if (m.review.kind === "BOT_ORDERS") return botWindow(days, now);
  if (m.review.kind === "OWNER_DECISIONS") return { review: await ownerDecisionWindow(m.review.decisionKinds, since), outcome: null };
  if (m.review.kind === "TECH_PRS") return { review: await techPrWindow(since), outcome: null };
  return { review: null, outcome: null };
}

const emptyUsage = (): UsageCell => ({ turns: 0, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: null, unknownCost: 0 });

async function compute(now: Date, rules: Partial<Record<AgentZone, GraduationRule>>): Promise<MissionControl> {
  const org = await currentOrganization();
  const [usageRows, work] = await Promise.all([
    aiUsageDaily(org.code, Math.max(...MC_WINDOWS), now),
    collectWorkItems({ now }).catch(() => null),
  ]);
  const dayKeys = Object.fromEntries(MC_WINDOWS.map((w) => [w, new Date(sinceOf(now, w).getTime() + 7 * 3_600_000).toISOString().slice(0, 10)])) as Record<(typeof MC_WINDOWS)[number], string>;

  const zones: ZoneRow[] = [];
  for (const zone of MC_ZONES) {
    const spec = AGENTS[zone];
    const m = MC_MEASURES[zone];
    let usage: ZoneRow["usage"] = null;
    if (m.usageFeatures.length) {
      usage = { 7: emptyUsage(), 30: emptyUsage() };
      for (const r of usageRows) {
        if (!(m.usageFeatures as string[]).includes(r.feature)) continue;
        for (const w of MC_WINDOWS) {
          if (r.day < dayKeys[w]) continue;
          const cell = usage[w];
          cell.turns += r.turns;
          cell.requests += r.requests;
          cell.inputTokens += r.inputTokens;
          cell.outputTokens += r.outputTokens;
          cell.unknownCost += r.unknownCost;
          if (r.costUsd !== null) cell.costUsd = (cell.costUsd ?? 0) + r.costUsd;
        }
      }
    }
    const workOpen = work
      ? work.items.filter((i) => i.creationSource === "AUTO" && i.status !== "DONE" && i.status !== "CANCELLED" && (zone === "SYSTEM" ? i.sourceType === "TECH_TASK" : i.department === zone && i.sourceType !== "TECH_TASK")).length
      : null;

    const windows = await Promise.all(MC_WINDOWS.map((w) => reviewFor(m, w, now)));
    const review = m.review.kind === "NONE" ? null : ({ 7: windows[0].review!, 30: windows[1].review! } as ZoneRow["review"]);
    const outcome = m.outcome.kind === "NONE" ? null : ({ 7: windows[0].outcome!, 30: windows[1].outcome! } as ZoneRow["outcome"]);
    const volume = m.volume ? ({ 7: await careMachineWindow(sinceOf(now, 7)), 30: await careMachineWindow(sinceOf(now, 30)) } as ZoneRow["volume"]) : null;

    const rule = rules[zone] ?? null;
    let verdict: GraduationVerdict;
    if (!rule) verdict = graduationVerdict(undefined, null);
    else if (m.review.kind === "NONE") verdict = graduationVerdict(rule, null, m.review.missing);
    else verdict = graduationVerdict(rule, (await reviewFor(m, rule.windowDays, now)).review);

    zones.push({ zone, label: agentLabel(zone), name: spec.name, home: spec.home, autonomy: spec.autonomy, autonomyLabel: AI_AUTONOMY_LABEL[spec.autonomy], measure: m, usage, workOpen, volume, review, outcome, rule, verdict });
  }
  return { orgCode: org.code, generatedAt: now, zones, workFailed: work ? work.failed.map((f) => f.source) : ["(không đọc được hàng đợi)"] };
}

/** Điều kiện tốt nghiệp đã khai của tổ chức (KHÔNG mặc định). */
export async function missionControlRules(): Promise<Partial<Record<AgentZone, GraduationRule>>> {
  return parseGraduation(await getSettingJson<Record<string, unknown>>(MC_GRADUATION_KEY, {}));
}

/** Mission Control của tổ chức đang đăng nhập — đệm 90 giây (luật cache: điều kiện tốt nghiệp nằm trong khoá đệm). */
export async function loadMissionControl(now: Date = new Date()): Promise<MissionControl> {
  const rules = await missionControlRules();
  return memo(`mission-control:${JSON.stringify(rules)}`, 90_000, () => compute(now, rules));
}

/** Chỉ cho kiểm thử: tính thẳng, không qua đệm. */
export async function computeMissionControlForTest(now: Date): Promise<MissionControl> {
  return compute(now, await missionControlRules());
}
