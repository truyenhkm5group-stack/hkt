/**
 * ═══════════ TIN KHÁCH: THỬ LẠI CÓ LÙI DẦN · DEAD-LETTER · KHÔNG TRẢ LỜI TRÙNG (sau sự cố P0 06/10/2026) ═══════════
 *
 * Trước bản này: AI hỏng ⇒ tin khách chốt `DONE` «Chuyển nhân viên» và không bao giờ được thử lại; gửi hỏng ⇒ `DONE` kèm câu
 * lỗi; tiến trình chết giữa lúc gửi và lúc chốt ⇒ lượt giành quá hạn 3 phút ⇒ lượt khác giành lại ⇒ gọi AI LẦN HAI và gửi câu
 * thứ hai. Ba luật ở đây, dùng chung cho Pancake (fanpage.ts) và Messenger trực tiếp (messenger.ts) — không chép sang từng kênh:
 *
 *  1. KHÔNG TRẢ LỜI TRÙNG (`alreadyRepliedAfter`): trước khi gọi AI, hội thoại đã có câu bot gửi SAU tin khách mới nhất của
 *     lượt ⇒ tin đó đã được trả lời (lượt trước chết sau khi gửi) ⇒ chốt, KHÔNG gọi AI, KHÔNG gửi. Thà thiếu một câu còn hơn
 *     khách nhận hai câu (chủ shop: «tuyệt đối không gửi hai câu trả lời cho khách»).
 *  2. DEAD-LETTER (`status = 'DEAD'`): tin bot KHÔNG trả lời được — AI hỏng (đã chuyển người) · gửi hỏng (có thể đã tới nơi:
 *     KHÔNG tự gửi lại) · hết lượt thử. Việc của người; cockpit đọc thẳng. Không còn lẫn với tin đã xử lý.
 *  3. THỬ LẠI CÓ LÙI DẦN (`requeueDecision` · `requeueAiDownDeadLetters`): tin DEAD vì AI hỏng, còn trong cửa sổ trả lời
 *     (30 phút — nhắn vào hội thoại đã nguội là làm phiền), chưa hết lượt, tới mốc lùi dần (2 · 4 · 8 phút), provider đã có
 *     lượt THÀNH CÔNG sau lúc hỏng, chưa ai của shop trả lời và chưa có câu bot nào ⇒ trả về hàng chờ một lần nữa.
 *     Lỗi lượt thử ⇒ engine lại chuyển người như cũ; hết lượt ⇒ nằm lại DEAD.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/lib/sql-rows";

/** Số lượt xử lý tối đa của MỘT tin khách (lượt đầu + thử lại). */
export const INBOUND_MAX_ATTEMPTS = 3;
/** Tin quá tuổi này (phút) không thử lại nữa — nhắn vào hội thoại đã nguội là làm phiền (cùng cửa sổ quét lại 30 phút). */
export const INBOUND_RETRY_WINDOW_MINUTES = 30;
/** Lùi dần: lượt thử thứ n (n = số lượt đã hỏng) đợi 2^n phút — 2 · 4 · 8. */
export function backoffMinutes(attempts: number): number {
  return Math.min(2 ** Math.max(1, attempts), 30);
}

/** Câu ghi chú của tin DEAD vì AI hỏng — `requeueAiDownDeadLetters` chỉ thử lại đúng loại này. */
export const DEAD_AI_DOWN_NOTE = "AI hỏng — bot không trả lời được, đã chuyển nhân viên";
/** Câu ghi chú của tin DEAD vì gửi hỏng — KHÔNG tự gửi lại (lượt gửi có thể đã tới nơi). */
export const DEAD_SEND_NOTE_PREFIX = "Gửi hỏng — ";
/** Câu ghi chú khi bỏ qua vì tin đã được trả lời ở lượt trước (tiến trình chết sau khi gửi). */
export const ALREADY_REPLIED_NOTE = "Đã trả lời ở lượt trước (tiến trình dừng sau khi gửi) — không trả lời lại";
/** Lượt không mở được hội thoại (lỗi tạm) — nhả tin, lùi dần (`releaseWithBackoff`); hết lượt ⇒ DEAD. */
export const CONV_OPEN_FAILED_NOTE = "Không mở được hội thoại";
/** AI CỐ Ý chuyển người (gọi handoff / quá dài) ⇒ bot im trên kênh nhắn tin, chờ người. */
export const HANDOFF_SILENT_NOTE = "Chuyển nhân viên — bot không nhắn gì, chờ người trả lời";
/** Lượt AI không sinh câu nào để gửi. */
export const EMPTY_REPLY_NOTE = "Bot không có câu trả lời";

export type RequeueRow = { attempts: number; createdAt: Date; nextAttemptAt: Date | null };

/**
 * HÀM THUẦN — tin DEAD vì AI hỏng có được trả về hàng chờ lúc `now` không. `providerRecoveredAt` = lượt AI THÀNH CÔNG gần
 * nhất của tổ chức (null = chưa biết ⇒ không thử, để khỏi đốt lượt vào một provider vẫn đang chết).
 */
export function requeueDecision(row: RequeueRow, now: Date, providerRecoveredAt: Date | null, failedAt: Date | null): { ok: true } | { ok: false; reason: string } {
  if (row.attempts >= INBOUND_MAX_ATTEMPTS) return { ok: false, reason: `hết ${INBOUND_MAX_ATTEMPTS} lượt` };
  if (now.getTime() - row.createdAt.getTime() > INBOUND_RETRY_WINDOW_MINUTES * 60_000) return { ok: false, reason: `quá ${INBOUND_RETRY_WINDOW_MINUTES} phút — hội thoại đã nguội, để người trả lời` };
  if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime()) return { ok: false, reason: "chưa tới mốc lùi dần" };
  if (!providerRecoveredAt || (failedAt && providerRecoveredAt.getTime() <= failedAt.getTime())) return { ok: false, reason: "provider chưa có lượt thành công nào sau lúc hỏng" };
  return { ok: true };
}

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * Trong các tin VỪA GIÀNH, những tin nào ĐÃ được trả lời bởi một lượt đã chết: tin thuộc lượt giành QUÁ HẠN (`staleRows`) và
 * có trước câu bot cuối cùng gửi SAU mốc lượt đó giành. Chỉ những tin này được chốt mà không gọi AI; tin MỚI khách gửi sau đó
 * (cùng bị giành trong lượt này — review #607: deploy giết tiến trình sau khi trả lời M1, khách gửi M2) vẫn được xử lý.
 */
export async function alreadyRepliedRows(
  db: Db,
  pageId: string,
  threadId: string,
  staleRows: readonly { id: string; claimedAt: Date | null }[],
  claimed: readonly { id: string; createdAt: Date }[],
): Promise<string[]> {
  const since = Math.min(...staleRows.map((r) => r.claimedAt?.getTime() ?? Number.POSITIVE_INFINITY));
  if (!Number.isFinite(since)) return [];
  const t = schema.salesChatInbound;
  const [r] = await db
    .select({ at: sql<Date | string | null>`max(${t.createdAt})` })
    .from(t)
    .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId), eq(t.note, "BOT_SENT"), gte(t.createdAt, new Date(since))));
  if (!r?.at) return [];
  const botAt = new Date(r.at).getTime();
  const stale = new Set(staleRows.map((x) => x.id));
  return claimed.filter((c) => stale.has(c.id) && c.createdAt.getTime() <= botAt).map((c) => c.id);
}

/** Chuyển các tin của lượt (đúng mã giành) sang DEAD: tăng số lượt, hẹn mốc lùi dần, ghi câu lỗi. */
export async function deadLetter(db: Db, ids: string[], claim: string, note: string, error: string | null, now: Date): Promise<void> {
  if (!ids.length) return;
  const t = schema.salesChatInbound;
  await db
    .update(t)
    .set({
      status: "DEAD",
      processedAt: now,
      note: note.slice(0, 300),
      lastError: (error ?? note).slice(0, 500),
      attempts: sql`${t.attempts} + 1`,
      nextAttemptAt: sql`${now}::timestamptz + make_interval(mins => least(power(2, greatest(${t.attempts} + 1, 1))::int, 30))`,
    })
    .where(and(inArray(t.id, ids), eq(t.claimId, claim)));
}

/** Lượt không mở được hội thoại (lỗi tạm): nhả tin, tăng lượt, hẹn mốc lùi dần; hết lượt ⇒ DEAD. */
export async function releaseWithBackoff(db: Db, ids: string[], claim: string, note: string, now: Date): Promise<void> {
  if (!ids.length) return;
  const t = schema.salesChatInbound;
  await db
    .update(t)
    .set({
      claimId: null,
      claimedAt: null,
      note: note.slice(0, 300),
      lastError: note.slice(0, 500),
      attempts: sql`${t.attempts} + 1`,
      nextAttemptAt: sql`${now}::timestamptz + make_interval(mins => least(power(2, greatest(${t.attempts} + 1, 1))::int, 30))`,
      status: sql`case when ${t.attempts} + 1 >= ${INBOUND_MAX_ATTEMPTS} then 'DEAD' else ${t.status} end`,
      processedAt: sql`case when ${t.attempts} + 1 >= ${INBOUND_MAX_ATTEMPTS} then ${now}::timestamptz else ${t.processedAt} end`,
    })
    .where(and(inArray(t.id, ids), eq(t.claimId, claim)));
}

/** Điều kiện giành: tin chưa tới mốc thử lại thì KHÔNG được giành (lùi dần có hiệu lực ở mọi đường giành). */
export function dueForClaim(now: Date) {
  const t = schema.salesChatInbound;
  return sql`(${t.nextAttemptAt} is null or ${t.nextAttemptAt} <= ${now})`;
}

export type RequeueResult = { checked: number; requeued: { pageId: string; threadId: string }[]; skipped: Record<string, number> };

/**
 * Trả tin DEAD vì AI hỏng về hàng chờ khi đủ điều kiện (`requeueDecision`) — gọi trong job `sales-followup` (5 phút). Mỗi hội
 * thoại: hội thoại còn đang «AI tạm không trả lời được» (người chưa nhận / chưa trả lời), không câu page (`PAGE_REPLY`) và không
 * câu bot nào sau tin ⇒ mở lại hội thoại (OPEN) và trả tin về PENDING. Không ném. Nơi gọi xử lý hội thoại vừa trả về.
 */
export async function requeueAiDownDeadLetters(aiDownReason: string, providerRecoveredAt: Date | null, now: Date = new Date()): Promise<RequeueResult> {
  const out: RequeueResult = { checked: 0, requeued: [], skipped: {} };
  const bump = (k: string) => (out.skipped[k] = (out.skipped[k] ?? 0) + 1);
  try {
    const db = await getDb();
    const rows = rowsOf<{ page_id: string; thread_id: string; attempts: number; created_at: Date | string; next_attempt_at: Date | string | null; processed_at: Date | string | null; conv_id: string | null; conv_status: string | null; handoff_reason: string | null; answered: boolean }>(
      await db.execute(sql`
        select i.page_id, i.thread_id, max(i.attempts)::int as attempts, max(i.created_at) as created_at, max(i.next_attempt_at) as next_attempt_at,
               max(i.processed_at) as processed_at, c.id as conv_id, c.status as conv_status, c.handoff_reason,
               exists (
                 select 1 from sales_chat_inbound o
                 where o.page_id = i.page_id and o.thread_id = i.thread_id and o.note in ('BOT_SENT', 'PAGE_REPLY') and o.created_at >= max(i.created_at)
               ) as answered
        from sales_chat_inbound i
        left join sales_chat_conversations c on c.page_id = i.page_id and c.thread_id = i.thread_id
        where i.status = 'DEAD' and i.note = ${DEAD_AI_DOWN_NOTE} and i.imported_at is null
          and i.created_at >= ${new Date(now.getTime() - INBOUND_RETRY_WINDOW_MINUTES * 60_000)}
        group by i.page_id, i.thread_id, c.id, c.status, c.handoff_reason
        limit 20
      `),
    );
    for (const r of rows) {
      out.checked += 1;
      const d = requeueDecision(
        { attempts: Number(r.attempts), createdAt: new Date(r.created_at), nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : null },
        now,
        providerRecoveredAt,
        r.processed_at ? new Date(r.processed_at) : null,
      );
      if (!d.ok) {
        bump(d.reason);
        continue;
      }
      if (r.answered) {
        bump("page / bot đã trả lời sau tin");
        continue;
      }
      if (!r.conv_id || r.conv_status !== "HANDOFF" || r.handoff_reason !== aiDownReason) {
        bump("hội thoại không còn ở «AI tạm không trả lời được» (người đã nhận)");
        continue;
      }
      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;
      // Mở lại ĐÚNG hội thoại đang ở lý do AI hỏng (điều kiện trong câu ghi — người vừa nhận thì câu này không chạm gì).
      const reopened = await db
        .update(c)
        .set({ status: "OPEN", handoffReason: null, state: sql`${c.state} - 'handoff'`, updatedAt: now })
        .where(and(eq(c.id, r.conv_id), eq(c.status, "HANDOFF"), eq(c.handoffReason, aiDownReason)))
        .returning({ id: c.id });
      if (!reopened.length) {
        bump("hội thoại vừa đổi trạng thái");
        continue;
      }
      await db
        .update(t)
        .set({ status: "PENDING", claimId: null, claimedAt: null, processedAt: null, note: null, nextAttemptAt: null })
        .where(and(eq(t.pageId, r.page_id), eq(t.threadId, r.thread_id), eq(t.status, "DEAD"), eq(t.note, DEAD_AI_DOWN_NOTE), sql`${t.importedAt} is null`));
      out.requeued.push({ pageId: r.page_id, threadId: r.thread_id });
    }
  } catch {
    // Không ném: lượt sau thử lại.
  }
  return out;
}
