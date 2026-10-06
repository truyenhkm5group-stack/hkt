/**
 * VÌ SAO KHÁCH KHÔNG MUA — đọc sổ sự kiện (luật ở `lost-reasons-shared.ts`). Cùng tập hội thoại với phễu của màn «Hiệu quả»:
 * hội thoại có tin khách trong kỳ, khung thử bị loại.
 */
import { and, gte, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import { HUMAN_TOUCHED, onPage } from "@/lib/sales-chatbot/events-sql";
import { lostReasonOf, lostReport, type LostReason, type LostReport } from "@/lib/sales-chatbot/lost-reasons-shared";

export type LostReasonsResult = LostReport & { idsByReason: Partial<Record<LostReason, string[]>> };

/** Trần số hội thoại giữ lại cho drill-down mỗi lý do (danh sách hiện 200 dòng). */
const DRILL_CAP = 200;

export async function loadLostReasons(opts: { days?: number; now?: Date; pageId?: string | null }): Promise<LostReasonsResult> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 30), 1), 180);
  const now = opts.now ?? new Date();
  const since = new Date(dauNgayVN(now).getTime() - (days - 1) * 86_400_000);
  const db = await getDb();
  const e = schema.salesConversationEvents;
  const rows = await db
    .select({
      id: e.conversationId,
      ordered: sql<boolean>`bool_or(${e.type} = 'order.confirmed' or (${e.type} = 'order.drafted' and ${e.actorKind} = 'HUMAN'))`,
      declined: sql<string | null>`(array_agg(coalesce(${e.payload}->>'reason', '') order by ${e.occurredAt} desc) filter (where ${e.type} = 'conversation.declined'))[1]`,
      handedOff: sql<boolean>`bool_or(${HUMAN_TOUCHED})`,
      quoted: sql<boolean>`bool_or(${e.type} = 'quote.given')`,
      lastCustomerAt: sql<Date>`max(${e.occurredAt}) filter (where ${e.type} = 'message.received')`,
    })
    .from(e)
    .where(and(gte(e.occurredAt, since), ne(e.channel, "TEST"), onPage(opts.pageId)))
    .groupBy(e.conversationId)
    .having(sql`bool_or(${e.type} = 'message.received')`);
  const idsByReason: Partial<Record<LostReason, string[]>> = {};
  const items = rows.map((r) => {
    const ordered = Boolean(r.ordered);
    const lost = lostReasonOf({ ordered, declinedReason: r.declined ?? null, handedOff: Boolean(r.handedOff), quoted: Boolean(r.quoted), lastCustomerAt: new Date(r.lastCustomerAt) }, now);
    if (lost) {
      const list = (idsByReason[lost.code] ??= []);
      if (list.length < DRILL_CAP) list.push(r.id);
    }
    return { ordered, reason: lost?.code ?? null };
  });
  return { ...lostReport(items), idsByReason };
}
