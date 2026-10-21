/**
 * ═══════════ GIÁM SÁT CHẤT LƯỢNG AI BÁN HÀNG HẰNG NGÀY — LƯỢT CỦA MỘT TỔ CHỨC (giai đoạn 2B, 21/10/2026) ═══════════
 *
 * Chạy KÉ job `sales-health` (fan-out mỗi 5 phút, module `ai_sales`) — không thêm lịch scheduler mới (AGENTS mục 7). Mỗi tổ chức chạy
 * ĐÚNG MỘT lượt mỗi ngày giờ Việt Nam, từ `SALES_QUALITY_FROM_HOUR_VN`: đếm trọn NGÀY HÔM QUA bằng bộ dò thuần (detectors.ts) +
 * ảnh chụp HANDOFF_UNANSWERED lúc chạy (handoff-reply.ts), rồi tạo MỘT việc / mã / ngày cho phòng chịu trách nhiệm.
 *  · 0 lời gọi AI, 0 dòng ghi vào hội thoại; ghi duy nhất `notifications` (khoá `sales-quality:<mã>:<ngày>`) + một khoá settings.
 *  · Việc KHÔNG mang chữ tin, họ tên, SĐT hay mã hội thoại thô — chỉ số đếm, mẫu số và mã BĂM.
 *  · Không bao giờ ném: lỗi trả về trong kết quả, job giám sát vẫn chạy tiếp.
 */
import { and, asc, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { handoffReplyClass, type HandoffReplyFact } from "@/lib/constants/handoff-reply";
import {
  SALES_QUALITY_CODES,
  SALES_QUALITY_MAX_ATTEMPTS,
  SALES_QUALITY_MAX_CONVERSATIONS,
  SALES_QUALITY_SAMPLE_HASHES,
  SALES_QUALITY_SPEC,
  SALES_QUALITY_STATE_KEY,
  salesQualityDedupeKey,
  salesQualityDue,
  salesQualityWindow,
  vnDayOf,
  type SalesQualityCode,
} from "@/lib/constants/sales-quality";
import { getWorkConfig } from "@/lib/queries/work-config";
import { aiSilentSql, handoffDueAt } from "@/lib/sales-chatbot/handoff-routing";
import { listQuickReplies, loadFocusProducts } from "@/lib/sales-chatbot/quick-replies";
import { conversationHash, scanThreadQuality, templateHead, type QualityBases } from "@/lib/sales-quality/detectors";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { rowsOf } from "@/lib/sql-rows";

export type SalesQualityCount = { hits: number; conversations: number; hashes: string[] };
export type SalesQualityState = {
  day: string;
  at: string;
  conversations: number;
  /** Đọc chạm trần ⇒ số đếm là trần dưới. */
  capped: boolean;
  counts: Record<SalesQualityCode, number>;
  bases: QualityBases & { handoffWaiting: number };
  /** Hạn chờ người đọc được (giờ); `null` ⇒ không kết luận HANDOFF_UNANSWERED. */
  slaHours: number | null;
};
export type SalesQualityResult = { ran: false; reason: string } | { ran: true; day: string; created: number; state: SalesQualityState };

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
};

export type HandoffFactRow = HandoffReplyFact & { id: string };

/**
 * Mốc trả lời của MỌI hội thoại trong hàng đợi người lúc `now` (`aiSilentSql` — đúng định nghĩa hộp thư / hàng đợi /work). `db` truyền vào
 * để ops `stuck-conversation-audit` đọc ĐÚNG tập này bằng handle CHỈ ĐỌC của tổ chức — tập «chờ người» của script và của Quality Supervisor
 * là MỘT câu SQL, không phải hai bản chép.
 */
export async function collectHandoffFacts(db: Db, now: Date): Promise<HandoffFactRow[]> {
  // Không đặt bí danh cho bảng: `aiSilentSql` (định nghĩa hàng đợi của hộp thư) trỏ cột theo TÊN BẢNG đầy đủ.
  const C = sql.raw(`"sales_chat_conversations"`);
  const res = await db.execute(sql`select ${C}.id, ${C}.last_customer_at, ${C}.last_bot_at, ${C}.last_staff_at, ${C}.handoff_queued_at, ${C}.state->'handoff'->>'at' as handoff_at,
      (select max(i.created_at) from "sales_chat_inbound" i where i.page_id = ${C}.page_id and i.thread_id = ${C}.thread_id and i.note = 'PAGE_REPLY'
        and coalesce(i.sender_kind, '') not in ('PANCAKE_AUTOMATION', 'META_SYSTEM', 'AI_AGENT')) as page_human_at,
      (select max(i.created_at) from "sales_chat_inbound" i where i.page_id = ${C}.page_id and i.thread_id = ${C}.thread_id and i.note = 'PAGE_REPLY' and i.sender_kind = 'VERIFIED_HUMAN') as page_verified_at,
      (select max(i.created_at) from "sales_chat_inbound" i where i.page_id = ${C}.page_id and i.thread_id = ${C}.thread_id and i.note = 'PAGE_REPLY' and i.sender_kind = 'AI_AGENT') as page_ai_at
    from ${C} where ${aiSilentSql(now)} limit 20000`);
  return rowsOf<Record<string, unknown>>(res).map((r) => ({
    id: String(r.id),
    lastCustomerAt: toDate(r.last_customer_at),
    lastBotAt: toDate(r.last_bot_at),
    lastStaffAt: toDate(r.last_staff_at),
    pageHumanAt: toDate(r.page_human_at),
    pageVerifiedAt: toDate(r.page_verified_at),
    pageAiAt: toDate(r.page_ai_at),
    handoffAt: toDate(r.handoff_queued_at) ?? toDate(r.handoff_at),
  }));
}

/** HANDOFF_UNANSWERED lúc `now`: hội thoại trong hàng đợi người (`collectHandoffFacts`) quá hạn mà chưa ai trả lời. */
export async function collectHandoffUnanswered(now: Date): Promise<{ ids: string[]; waiting: number; slaMs: number | null }> {
  const slaMs = handoffDueAt(new Date(0), await getWorkConfig())?.getTime() ?? null;
  const facts = await collectHandoffFacts(await getDb(), now);
  return { ids: facts.filter((f) => handoffReplyClass(f, now, slaMs) === "UNANSWERED_OVER_SLA").map((f) => f.id), waiting: facts.length, slaMs };
}

/** Quét tin của ngày hôm qua bằng bộ dò thuần. */
async function scanDay(from: Date, to: Date): Promise<{ byCode: Map<SalesQualityCode, { hits: number; convs: Set<string> }>; bases: QualityBases; conversations: number; capped: boolean }> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const m = schema.salesChatMessages;
  // Hội thoại có tin trong kỳ thì `updated_at` ≥ đầu kỳ. Kênh TEST (khung thử của chủ shop) không phải khách thật.
  const convs = await db.select({ id: c.id }).from(c).where(and(gte(c.updatedAt, from), sql`${c.channel} <> 'TEST'`)).limit(SALES_QUALITY_MAX_CONVERSATIONS + 1);
  const ids = convs.slice(0, SALES_QUALITY_MAX_CONVERSATIONS).map((x) => x.id);
  const templates = (await listQuickReplies().catch(() => [])).map((r) => ({ title: r.title, answer: r.answer, head: templateHead(r.answer) }));
  const products = await loadFocusProducts().catch(() => []);
  const byCode = new Map<SalesQualityCode, { hits: number; convs: Set<string> }>();
  const bases: QualityBases = { customerMessages: 0, botMessages: 0, quantityAnswers: 0, deliverySecondAsks: 0, complaints: 0 };
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await db.select({ conv: m.conversationId, seq: m.seq, role: m.role, content: m.content, at: m.createdAt }).from(m).where(and(inArray(m.conversationId, ids.slice(i, i + 200)), lt(m.createdAt, to))).orderBy(asc(m.conversationId), asc(m.seq));
    const threads = new Map<string, typeof rows>();
    for (const r of rows) (threads.get(r.conv) ?? threads.set(r.conv, []).get(r.conv)!).push(r);
    for (const [conv, msgs] of threads) {
      const q = scanThreadQuality(msgs, { from, to, templates, products });
      for (const k of Object.keys(bases) as (keyof QualityBases)[]) bases[k] += q.bases[k];
      for (const h of q.hits) {
        const e = byCode.get(h.code) ?? { hits: 0, convs: new Set<string>() };
        e.hits += 1;
        e.convs.add(conv);
        byCode.set(h.code, e);
      }
    }
  }
  return { byCode, bases, conversations: ids.length, capped: convs.length > SALES_QUALITY_MAX_CONVERSATIONS };
}

const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** Chữ của một việc — số đếm, mẫu số, mã băm, việc phải làm. Không chữ tin, không tên, không SĐT. HÀM THUẦN. */
export function salesQualityText(code: SalesQualityCode, day: string, n: SalesQualityCount, base: string, now: Date): { title: string; body: string } {
  const spec = SALES_QUALITY_SPEC[code];
  const what = spec.unit === "CONVERSATION" ? `${n.conversations} hội thoại` : `${n.hits} tin / ${n.conversations} hội thoại`;
  // Ảnh chụp (đơn vị HỘI THOẠI) là tình trạng LÚC CHẠY, không phải của ngày hôm qua.
  const when = spec.unit === "CONVERSATION" ? `lúc ${new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(11, 16)} ngày ${dayLabel(vnDayOf(now))}` : `ngày ${dayLabel(day)}`;
  const hashes = n.hashes.length ? ` Mã hội thoại băm (≤ ${SALES_QUALITY_SAMPLE_HASHES}): ${n.hashes.join(" ")}.` : "";
  return {
    title: `Chất lượng AI bán hàng · ${spec.label}: ${what} (${when})`,
    body: `${base}.${hashes} Việc cần làm: ${spec.action}`,
  };
}

/** Một lượt của tổ chức NGỮ CẢNH. `now` là tham số — bài kiểm không đọc đồng hồ thật (AGENTS 50). Không ném. */
export async function runSalesQualityDaily(now: Date = new Date()): Promise<SalesQualityResult> {
  if (!salesQualityDue(now)) return { ran: false, reason: "chưa tới giờ chạy" };
  const { day, from, to } = salesQualityWindow(now);
  let attempts = 0;
  try {
    const prev = await getSettingJson<{ day?: string; error?: string; attempts?: number }>(SALES_QUALITY_STATE_KEY, {});
    // Lượt lỗi được thử lại ở nhịp 5 phút kế, TỐI ĐA `SALES_QUALITY_MAX_ATTEMPTS` lần / ngày — lỗi bền (CSDL hỏng) không được biến job
    // giám sát thành một vòng quét 5.000 hội thoại mỗi 5 phút.
    if (prev.day === day && (!prev.error || (prev.attempts ?? 0) >= SALES_QUALITY_MAX_ATTEMPTS)) return { ran: false, reason: "hôm nay đã chạy" };
    attempts = prev.day === day ? (prev.attempts ?? 0) : 0;
    const scan = await scanDay(from, to);
    const ho = await collectHandoffUnanswered(now);
    const counts = Object.fromEntries(SALES_QUALITY_CODES.map((k) => [k, 0])) as Record<SalesQualityCode, number>;
    const detail = new Map<SalesQualityCode, SalesQualityCount>();
    const sample = (convs: Iterable<string>) => [...convs].map(conversationHash).sort().slice(0, SALES_QUALITY_SAMPLE_HASHES);
    for (const [code, e] of scan.byCode) detail.set(code, { hits: e.hits, conversations: e.convs.size, hashes: sample(e.convs) });
    if (ho.ids.length) detail.set("HANDOFF_UNANSWERED", { hits: ho.ids.length, conversations: ho.ids.length, hashes: sample(ho.ids) });
    for (const [code, n] of detail) counts[code] = n.hits;
    const b = scan.bases;
    const slaHours = ho.slaMs === null ? null : Math.round(ho.slaMs / 3_600_000);
    const baseOf: Record<SalesQualityCode, string> = {
      // Tập «chờ người» = ĐÚNG hàng đợi /work (aiSilentSql) — rộng hơn nhóm WAITING_HUMAN của ops stuck-conversation-audit (gồm cả hội
      // thoại nhân viên đang tiếp quản), nên số ngày đầu có thể lệch số của script; nói ra để người đọc không đi tìm lỗi.
      HANDOFF_UNANSWERED: `Mẫu số: ${ho.waiting} hội thoại đang chờ người · tập = hàng đợi chờ người của /work (khác nhóm «chờ người» của ops stuck-conversation-audit) · hạn ${slaHours === null ? "không đặt" : `${slaHours} giờ`} (work.sla)`,
      QTY_REASKED: `Mẫu số: ${b.quantityAnswers} tin khách chỉ là câu trả lời số lượng`,
      SECONDARY_INTENT_UNANSWERED: `Mẫu số: ${b.deliverySecondAsks} tin khách hỏi số lượng + thời gian giao`,
      WRONG_PRODUCT_TEMPLATE: `Mẫu số: ${b.botMessages} tin bot`,
      ADDRESS_REASK: `Mẫu số: ${b.botMessages} tin bot (trần dưới — lịch sử thiếu trạng thái đơn nháp từng lượt)`,
      COMPLAINT_WHILE_SELLING: `Mẫu số: ${b.complaints} tin khách phàn nàn`,
      CLARIFY_FALLBACK: `Mẫu số: ${b.botMessages} tin bot`,
      CLAIM_GUARD_BLOCK: `Mẫu số: ${b.botMessages} tin bot`,
    };
    const db = await getDb();
    let created = 0;
    for (const code of SALES_QUALITY_CODES) {
      const n = detail.get(code);
      if (!n || n.conversations === 0) continue;
      const { title, body } = salesQualityText(code, day, n, `${baseOf[code]}${scan.capped && code !== "HANDOFF_UNANSWERED" ? ` · đọc chạm trần ${SALES_QUALITY_MAX_CONVERSATIONS} hội thoại — số là trần dưới` : ""}`, now);
      const ins = await db
        .insert(schema.notifications)
        .values({ kind: "SALES_QUALITY", severity: "warning", title, body, href: "/ai/sales-chatbot/inbox", entityType: "SALES_QUALITY", entityId: code, dedupeKey: salesQualityDedupeKey(code, day), occurredAt: now })
        .onConflictDoNothing({ target: schema.notifications.dedupeKey })
        .returning({ id: schema.notifications.id });
      created += ins.length;
    }
    const state: SalesQualityState = { day, at: now.toISOString(), conversations: scan.conversations, capped: scan.capped, counts, bases: { ...b, handoffWaiting: ho.waiting }, slaHours };
    await setSettingJson(SALES_QUALITY_STATE_KEY, state);
    return { ran: true, day, created, state };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 160);
    await setSettingJson(SALES_QUALITY_STATE_KEY, { day, at: now.toISOString(), error, attempts: attempts + 1 }).catch(() => undefined);
    return { ran: false, reason: `lỗi lần ${attempts + 1}/${SALES_QUALITY_MAX_ATTEMPTS}: ${error}` };
  }
}

/** Dòng tóm tắt cho `sync_runs` của job giám sát (chỉ số đếm). HÀM THUẦN. */
export function salesQualitySummary(r: SalesQualityResult): string {
  if (!r.ran) return r.reason === "chưa tới giờ chạy" || r.reason === "hôm nay đã chạy" ? "" : ` · chất lượng AI ngày: ${r.reason}`;
  const parts = SALES_QUALITY_CODES.filter((k) => r.state.counts[k] > 0).map((k) => `${k} ${r.state.counts[k]}`);
  return ` · chất lượng AI ${r.day}: ${parts.length ? parts.join(" · ") : "không lỗi"} (${r.state.conversations} hội thoại · ${r.created} việc mới)`;
}
