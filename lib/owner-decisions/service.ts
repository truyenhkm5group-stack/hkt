import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import {
  checkDecisionRequest,
  foldLatestDecisions,
  repeatsLatest,
  type DecisionRequest,
  type OwnerDecisionItem,
  type RecommendationDecision,
  type RecommendationDecisionRow,
} from "@/lib/constants/owner-decisions";
import { emitDomainEvent } from "@/lib/events/emit";

/**
 * ═══════════ GHI PHẢN ỨNG VỚI MỘT ĐỀ XUẤT (Company OS · Agent H) — LÕI, KHÔNG "use server" ═══════════
 *
 * Tệp DUY NHẤT ghi `recommendation_decisions`, và nó chỉ INSERT (append-only — bài kiểm quét mã nguồn).
 * Dòng sổ và sự kiện `recommendation.decided` ghi trong CÙNG một giao dịch: không bao giờ có phản ứng
 * mà thiếu sự kiện, hay ngược lại.
 *
 * `item` là đề xuất do MÁY CHỦ dựng lại từ nguồn ngay lúc ghi (xem `findOwnerDecisionItem`), không phải
 * bản trình duyệt gửi lên — ảnh chụp phải là thứ ERP thật sự đã đề xuất, không phải thứ ai đó gõ.
 *
 * Lõi này KHÔNG đóng việc ở nguồn và không đổi một con số nào: chấp nhận "cắt chiến dịch" không cắt
 * chiến dịch, người vẫn phải làm ở màn hình quảng cáo (luật 19, target-architecture Q9).
 */
type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type RecordDecisionInput = {
  item: OwnerDecisionItem;
  decision: RecommendationDecision;
  reason: string;
  snoozeUntil: Date | null;
  actor: Actor;
  /** Nơi bấm, vd `ui:/` hoặc `ui:/cockpit`. */
  source: string;
  now: Date;
};

export type RecordDecisionResult = { ok: true; id: string; skipped: false } | { ok: true; id: string; skipped: true } | { error: string };

/** Mọi dòng sổ của những khoá này, xếp theo thời điểm quyết tăng dần (đầu vào của `foldLatestDecisions`). */
export async function readDecisionRows(db: DbLike, keys: readonly string[]): Promise<RecommendationDecisionRow[]> {
  if (!keys.length) return [];
  const r = schema.recommendationDecisions;
  const rows = await db.select().from(r).where(inArray(r.sourceKey, [...keys])).orderBy(asc(r.decidedAt));
  return rows.map(toRow);
}

export function toRow(x: typeof schema.recommendationDecisions.$inferSelect): RecommendationDecisionRow {
  return {
    id: x.id,
    sourceKey: x.sourceKey,
    kind: x.kind,
    decision: x.decision as RecommendationDecision,
    reason: x.reason,
    snoozeUntil: x.snoozeUntil,
    decidedByUserId: x.decidedByUserId,
    decidedBy: x.decidedBy,
    decidedAt: x.decidedAt,
  };
}

export async function recordRecommendationDecisionCore(db: Db, input: RecordDecisionInput): Promise<RecordDecisionResult> {
  // Luật 34: phản ứng với đề xuất là của MỘT người. Máy không "chấp nhận" đề xuất của chính nó.
  if (!input.actor.id) return { error: "Phản ứng với đề xuất phải là của một tài khoản — máy không quyết thay người" };
  const req: DecisionRequest = { decision: input.decision, reason: input.reason ?? "", snoozeUntil: input.snoozeUntil };
  const ok = checkDecisionRequest(req, input.now);
  if ("error" in ok) return ok;
  const actorId = input.actor.id;

  return db.transaction(async (tx) => {
    const r = schema.recommendationDecisions;
    const existing = (await tx.select().from(r).where(eq(r.sourceKey, input.item.sourceKey)).orderBy(asc(r.decidedAt))).map(toRow);
    const latest = foldLatestDecisions(existing).get(input.item.sourceKey);
    // Bấm lại đúng phản ứng đang có hiệu lực (bấm đúp, trình duyệt gửi lại) ⇒ KHÔNG ghi thêm dòng nào.
    if (latest && repeatsLatest(latest, req)) return { ok: true as const, id: latest.id, skipped: true as const };

    const [row] = await tx
      .insert(r)
      .values({
        sourceKey: input.item.sourceKey,
        kind: input.item.kind,
        decision: input.decision,
        reason: input.reason.trim(),
        snoozeUntil: input.decision === "SNOOZED" ? input.snoozeUntil : null,
        decidedByUserId: actorId,
        decidedBy: input.actor.label,
        decidedAt: input.now,
        snapshot: { ...input.item } as Record<string, unknown>,
      })
      .returning({ id: r.id });

    await emitDomainEvent(tx, {
      name: "recommendation.decided",
      subjectType: "recommendation",
      subjectId: input.item.sourceKey,
      modelId: input.item.modelId,
      payload: {
        decisionId: row.id,
        kind: input.item.kind,
        decision: input.decision,
        reason: input.reason.trim() || null,
        snoozeUntil: input.snoozeUntil ? input.snoozeUntil.toISOString() : null,
        impact: input.item.impact,
      },
      actorKind: "USER",
      actorId,
      source: input.source,
      dedupeKey: `recommendation_decision:${row.id}`,
      occurredAt: input.now,
    });
    return { ok: true as const, id: row.id, skipped: false as const };
  });
}
