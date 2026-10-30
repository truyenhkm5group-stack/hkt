import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { andScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { isMissingAiDraftTable } from "@/lib/wholesale/email-ai-draft";
import type { DraftViolation } from "@/lib/wholesale/email-ai-draft-guard";

/**
 * NHÁP EMAIL AI — ĐỌC (P2b · 0265). Phạm vi theo lead (cùng mệnh đề với Hộp thư đi). Ngoài danh sách nháp còn đo TỶ LỆ BỊ SỬA và
 * TỶ LỆ BỊ CHẶN để Mission Control theo dõi. CSDL chưa áp 0265 ⇒ `{ unavailable: true }`.
 */

const d = schema.wholesaleEmailAiDrafts;
const l = schema.wholesaleLeads;

export type AiDraftRow = {
  id: string;
  leadId: string;
  leadName: string;
  toEmail: string | null;
  language: string;
  subject: string;
  body: string;
  status: "DRAFT" | "BLOCKED";
  violations: DraftViolation[];
  model: string | null;
  costUsd: number | null;
  requestedBy: string | null;
  createdAt: string;
};

export type AiDraftStats = { total: number; blocked: number; promoted: number; avgEditRatio: number | null; costUsd: number; costUnknown: number };

/** Nháp ĐANG MỞ (chờ người / bị chặn chờ bỏ) + số đo 30 ngày. */
export async function listAiDrafts(decision: ScopeDecision): Promise<{ rows: AiDraftRow[]; stats: AiDraftStats } | { unavailable: true }> {
  try {
    const db = await getDb();
    const requester = sql<string | null>`(select ${schema.users.name} from ${schema.users} where ${schema.users.id} = ${d.requestedByUserId})`;
    const [rows, [st]] = await Promise.all([
      db
        .select({ id: d.id, leadId: d.leadId, leadName: sql<string>`coalesce(${l.businessName}, '')`, toEmail: l.email, language: d.language, subject: d.subject, body: d.body, status: d.status, violations: d.violations, model: d.model, costUsd: d.costUsd, requestedBy: requester, createdAt: d.createdAt })
        .from(d)
        .innerJoin(l, eq(l.id, d.leadId))
        .where(andScope(inArray(d.status, ["DRAFT", "BLOCKED"]), decision))
        .orderBy(desc(d.createdAt))
        .limit(50),
      db
        .select({
          total: sql<number>`count(*)`.mapWith(Number),
          blocked: sql<number>`count(*) filter (where ${d.violations} <> '[]'::jsonb)`.mapWith(Number),
          promoted: sql<number>`count(*) filter (where ${d.status} = 'PROMOTED')`.mapWith(Number),
          avgEditRatio: sql<number | null>`avg(${d.editRatio})`,
          costUsd: sql<number>`coalesce(sum(${d.costUsd}), 0)`.mapWith(Number),
          costUnknown: sql<number>`count(*) filter (where ${d.costUsd} is null)`.mapWith(Number),
        })
        .from(d)
        .innerJoin(l, eq(l.id, d.leadId))
        .where(andScope(sql`${d.createdAt} >= now() - interval '30 days'`, decision)),
    ]);
    return {
      rows: rows.map((r) => ({ ...r, status: r.status === "BLOCKED" ? "BLOCKED" : "DRAFT", violations: Array.isArray(r.violations) ? (r.violations as DraftViolation[]) : [], createdAt: r.createdAt.toISOString() })),
      stats: { ...st, avgEditRatio: st.avgEditRatio === null ? null : Math.round(Number(st.avgEditRatio) * 1000) / 1000 },
    };
  } catch (e) {
    if (isMissingAiDraftTable(e)) return { unavailable: true };
    throw e;
  }
}
