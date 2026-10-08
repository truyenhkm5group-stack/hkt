/**
 * ═══════════ GƯƠNG SỨC KHOẺ TỔ CHỨC — LƯỢT ĐO CỦA JOB `sales-health` (sứ mệnh saas-ops-signals · LAUNCH SPRINT §11) — CHỈ MÁY CHỦ ═══════════
 *
 * Job `sales-health` (5 phút, từng tổ chức có AI bán hàng) đã TÍNH các kết luận về Facebook · webhook · AI · gửi tin trong CSDL của tổ
 * chức, rồi chỉ báo Lark / Telegram — không lưu ở đâu người vận hành đọc được. Tệp này lấy ĐÚNG ảnh chụp vừa đánh giá
 * (`runSalesHealthCheck`) + vài câu đếm bổ sung (7 ngày, lần cuối, sổ đơn của bot) và ghi BẢY dòng `platform_org_health` ở CSDL NHÀ
 * (`writeOrgHealth`, một câu). Kiểm đã hết lỗi ⇒ dòng về OK, không xoá.
 *
 *  · `buildMirrorRows` là HÀM THUẦN (sự thật ⇒ bảy dòng) — kiểm thử dựng sự thật tay, không cần CSDL.
 *  · Một nguồn đọc hỏng ⇒ dòng đó UNKNOWN kèm câu «không đọc được», các dòng khác vẫn ghi (CHƯA BIẾT ≠ 0, luật 42).
 *  · `detail` NGẮN, KHÔNG PII: số đếm + mã lý do. Không chép câu lỗi gốc (câu của Meta / Pancake có thể mang tên khách).
 *
 * ─── KIỂM ĐĂNG KÝ WEBHOOK (`checkPageWebhook`) — CÓ TRẦN ───
 * Mỗi page tốn 2 lời gọi Graph (debug_token + subscribed_apps). Mỗi lượt job kiểm tối đa `WEBHOOK_CHECK_MAX_PAGES_PER_RUN` page, mỗi
 * page tối đa một lần mỗi `WEBHOOK_CHECK_EVERY_MINUTES` (page kiểm cũ nhất trước) ⇒ ~8 lời gọi / page / ngày. Graph báo chạm trần
 * (RATE_LIMIT) ⇒ dừng lượt, NGHỈ `WEBHOOK_CHECK_RATE_PAUSE_MINUTES`. App nền tảng chưa cấu hình ⇒ không gọi, dòng nói «chưa kiểm được».
 * Trạng thái lần kiểm lưu ở `settings` của TỔ CHỨC (khoá `WEBHOOK_CHECK_SETTING_KEY`), không cột mới.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { listChannelPages } from "@/lib/connectors/service";
import { ORDER_ATTEMPT_ENTITY, ORDER_CREATE_FAILED_ACTION, ORDER_VALIDATION_FAILED_ACTION, worstLevel, type OpsLevel, type SendFailureReason } from "@/lib/constants/ops-signals";
import { checkPageWebhook, messengerApp, WEBHOOK_STATES, type WebhookState } from "@/lib/integrations/messenger/graph";
import { graphErrorKindOfText } from "@/lib/integrations/messenger/graph-errors";
import { currentOrganization } from "@/lib/platform/context";
import { writeOrgHealth, type OrgHealthMeasurement } from "@/lib/platform/org-health";
import { AI_STOP_NOTE, AI_STOP_REASONS, type AiStopReason } from "@/lib/pricing/ai-entitlement";
import { aiBalanceGateStrict, loadAiEntitlement } from "@/lib/pricing/ai-gate";
import { AI_DOWN_HANDOFF_REASON } from "@/lib/sales-chatbot/ai-hold-shared";
import { MESSENGER_DIRECT_KEY } from "@/lib/sales-chatbot/channel-ownership";
import { CUSTOMER_ROW, SEND_ERROR_NOTE_RE } from "@/lib/sales-chatbot/health";
import { PENDING_ELIGIBLE_MINUTES, type HealthCheckKey, type HealthLevel, type SalesHealth, type SalesHealthSnapshot } from "@/lib/sales-chatbot/health-shared";
import { DEAD_AI_DOWN_NOTE, DEAD_SEND_NOTE_PREFIX } from "@/lib/sales-chatbot/inbound-retry";
import { messengerTokenFor } from "@/lib/sales-chatbot/messenger";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { rowsOf } from "@/lib/sql-rows";

export const WEBHOOK_CHECK_SETTING_KEY = "ai.salesHealth.webhookChecks";
export const WEBHOOK_CHECK_EVERY_MINUTES = 360;
export const WEBHOOK_CHECK_MAX_PAGES_PER_RUN = 2;
export const WEBHOOK_CHECK_RATE_PAUSE_MINUTES = 60;
/**
 * Trần chờ MỘT lời gọi Graph của phép kiểm sức khoẻ: hàng đợi job chạy tuần tự và dùng chung — Graph treo thì job giám sát của mọi tổ
 * chức sau nó trễ theo. Ngắn hơn trần chung của `graph()` vì đây là phép kiểm phụ, hết giờ ⇒ page UNKNOWN, lượt sau kiểm lại.
 */
export const WEBHOOK_CHECK_TIMEOUT_MS = 5_000;

type Agg = { count24h: number; count7d: number; lastAt: string | null; lastReason: string | null; correlationId: string | null };

/** Sự thật một lượt đo đã đọc. `null` ở một ô = nguồn đó không đọc được ⇒ dòng tương ứng UNKNOWN. HÀM THUẦN dùng nó. */
export type MirrorFacts = {
  health: Pick<SalesHealth, "status" | "checks">;
  snapshot: Pick<SalesHealthSnapshot, "botEnabled" | "queue" | "provider">;
  inbound: { send7d: number; deadOther24h: number; deadOther7d: number; abandoned7d: number; lastProcessingAt: string | null; plan24h: number; plan7d: number } | null;
  lastSend: { at: string; reason: SendFailureReason; conversationId: string | null } | null;
  lastPlanStop: { at: string; reason: AiStopReason; conversationId: string | null } | null;
  lastAiDown: { at: string; conversationId: string } | null;
  /** `null` = không đọc được sổ đơn của bot. */
  orders: { write: Agg | null; validation: Agg | null } | null;
  /** Page Messenger NỐI THẲNG đang bật (`null` = không đọc được). `failing` = lỗi token / quyền MỚI HƠN tin cuối nhận được. */
  pages: { active: string[]; failing: { pageId: string; reason: "TOKEN" | "PERMISSION"; at: string }[] } | null;
  webhook: { states: Record<string, WebhookState>; checkedNow: number; skipped: "NO_APP" | "RATE_PAUSED" | "RATE_LIMITED" | null };
  /** Cổng gói ĐANG chặn AI (dùng thử hết · đình chỉ) — `null` = không đọc được. */
  entitlement: { allowed: boolean; reason: AiStopReason | null } | null;
  /** Số dư AI hết ⇒ khách MỚI không được AI nhận — `null` = không đọc được. */
  balanceClosed: boolean | null;
};

const levelOf = (l: HealthLevel | undefined): OpsLevel => (l ? l : "OK");
const checkOf = (f: MirrorFacts, key: HealthCheckKey) => f.health.checks.find((c) => c.key === key);
const unreadable = (key: OrgHealthMeasurement["key"], what: string): OrgHealthMeasurement => ({ key, level: "UNKNOWN", count24h: null, count7d: null, lastAt: null, lastReason: null, correlationId: null, detail: `Không đọc được ${what} lượt này — CHƯA BIẾT.` });
const toDate = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};
const join = (parts: readonly (string | null | false | undefined)[]) => parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" · ") || null;

function fbRow(f: MirrorFacts): OrgHealthMeasurement {
  if (!f.pages) return unreadable("FB_CONNECTION", "danh sách page Messenger");
  const active = f.pages.active;
  if (!active.length) return { key: "FB_CONNECTION", level: "NA", count24h: null, count7d: null, lastAt: null, lastReason: null, correlationId: null, detail: "Không có page Messenger nối thẳng (kênh Pancake / web đo ở «Gửi tin»)." };
  const expired = active.filter((id) => f.webhook.states[id] === "TOKEN_EXPIRED");
  const failing = f.pages.failing.filter((p) => active.includes(p.pageId));
  const bad = new Set([...expired, ...failing.map((p) => p.pageId)]);
  const last = [...failing].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  const reason = expired.length ? "TOKEN_EXPIRED" : (last?.reason ?? null);
  const checked = active.filter((id) => f.webhook.states[id]).length;
  return {
    key: "FB_CONNECTION",
    level: bad.size ? "CRITICAL" : "OK",
    count24h: bad.size,
    count7d: null,
    lastAt: toDate(last?.at ?? null),
    lastReason: reason,
    correlationId: last ? `page:${last.pageId}` : expired[0] ? `page:${expired[0]}` : null,
    detail: join([`${bad.size}/${active.length} page lỗi token / quyền`, `${checked}/${active.length} page đã kiểm webhook`, f.webhook.skipped === "NO_APP" ? "app nền tảng chưa cấu hình — chưa kiểm được webhook" : f.webhook.skipped ? "Graph đang giới hạn — tạm dừng kiểm" : null]),
  };
}

function webhookRow(f: MirrorFacts): OrgHealthMeasurement {
  if (!f.inbound) return unreadable("WEBHOOK", "hàng chờ tin khách");
  const active = f.pages?.active ?? [];
  const notSub = active.filter((id) => f.webhook.states[id] === "NOT_SUBSCRIBED").length;
  const missing = active.filter((id) => f.webhook.states[id] === "MISSING_FIELDS").length;
  const silence = checkOf(f, "WEBHOOK");
  const backlog = checkOf(f, "BACKLOG");
  const abandoned24 = f.snapshot.queue.abandoned24h;
  // Mỗi vế một (mức, lý do) — dòng lấy vế NẶNG nhất, thứ tự liệt kê là thứ tự ưu tiên khi bằng mức.
  const parts: { level: OpsLevel; reason: string; text: string }[] = [];
  if (notSub) parts.push({ level: "CRITICAL", reason: "NOT_SUBSCRIBED", text: `${notSub} page chưa đăng ký webhook` });
  if (missing) parts.push({ level: "WARNING", reason: "MISSING_FIELDS", text: `${missing} page đăng ký thiếu trường` });
  if (backlog && backlog.level !== "OK") parts.push({ level: levelOf(backlog.level), reason: "BACKLOG", text: `hàng chờ ${f.snapshot.queue.pending} tin quá SLO` });
  if (abandoned24 > 0) parts.push({ level: "WARNING", reason: "ABANDONED", text: `${abandoned24} tin bỏ sót / 24 giờ` });
  if (f.inbound.deadOther24h > 0) parts.push({ level: "WARNING", reason: "DEAD_LETTER", text: `${f.inbound.deadOther24h} tin không xử lý được / 24 giờ` });
  if (silence?.level === "WARNING") parts.push({ level: "WARNING", reason: "SILENT", text: "im so với nền cùng khung giờ" });
  if (silence?.level === "UNKNOWN") parts.push({ level: "UNKNOWN", reason: "BASELINE_THIN", text: "chưa đủ ngày dữ liệu để biết im hay không" });
  const level = worstLevel(...parts.map((p) => p.level));
  const top = parts.find((p) => p.level === level) ?? null;
  return {
    key: "WEBHOOK",
    level: parts.length ? level : "OK",
    count24h: abandoned24 + f.inbound.deadOther24h,
    count7d: f.inbound.abandoned7d + f.inbound.deadOther7d,
    lastAt: toDate(f.inbound.lastProcessingAt),
    lastReason: top?.reason ?? null,
    correlationId: null,
    detail: join(parts.map((p) => p.text)) ?? "Tin khách tới và được xử lý bình thường.",
  };
}

function aiRow(f: MirrorFacts): OrgHealthMeasurement {
  if (f.health.status === "OFF" || !f.snapshot.botEnabled) return { key: "AI", level: "NA", count24h: null, count7d: null, lastAt: null, lastReason: null, correlationId: null, detail: "Bot trả lời khách đang TẮT (chủ shop tắt)." };
  const provider = checkOf(f, "PROVIDER");
  const silent = checkOf(f, "BOT_SILENT");
  const level = worstLevel(levelOf(provider?.level), levelOf(silent?.level));
  const p = f.snapshot.provider;
  const reason = provider && provider.level !== "OK" && provider.level !== "UNKNOWN" ? (p.lastErrorKind ?? "PROVIDER") : silent && silent.level !== "OK" ? "BOT_SILENT" : null;
  const lastErr = toDate(p.lastErrorAt);
  return {
    key: "AI",
    level: provider || silent ? level : "UNKNOWN",
    count24h: f.snapshot.queue.failedAiDown24h,
    count7d: null,
    lastAt: f.lastAiDown ? toDate(f.lastAiDown.at) : lastErr,
    lastReason: reason,
    correlationId: f.lastAiDown?.conversationId ?? null,
    detail: join([
      provider ? `nhà cung cấp: ${provider.level}${p.errorsInWindow ? ` (${p.errorsInWindow} lỗi gần đây)` : ""}${p.blockedInWindow ? ` · ${p.blockedInWindow} lượt bị chặn` : ""}` : null,
      silent && silent.level !== "OK" ? "bot im: tin khách được chốt mà không câu bot nào" : null,
      f.snapshot.queue.failedAiDown24h ? `${f.snapshot.queue.failedAiDown24h} hội thoại chuyển người vì AI hỏng / 24 giờ` : null,
    ]),
  };
}

function sendRow(f: MirrorFacts): OrgHealthMeasurement {
  if (!f.inbound) return unreadable("SEND", "tin gửi hỏng");
  const c24 = f.snapshot.queue.failedSend24h;
  const reason = f.lastSend?.reason ?? null;
  return {
    key: "SEND",
    level: c24 > 0 ? (reason === "TOKEN" || reason === "PERMISSION" ? "CRITICAL" : "WARNING") : "OK",
    count24h: c24,
    count7d: f.inbound.send7d,
    lastAt: toDate(f.lastSend?.at ?? null),
    lastReason: reason,
    correlationId: f.lastSend?.conversationId ?? null,
    detail: c24 ? `${c24} tin khách không gửi được câu trả lời / 24 giờ` : "Không tin nào gửi hỏng trong 24 giờ.",
  };
}

function orderRow(key: "ORDER_WRITE" | "ORDER_VALIDATION", f: MirrorFacts): OrgHealthMeasurement {
  if (!f.orders) return unreadable(key, "sổ đơn của bot");
  const a = key === "ORDER_WRITE" ? f.orders.write : f.orders.validation;
  const c24 = a?.count24h ?? 0;
  return {
    key,
    level: c24 > 0 ? (key === "ORDER_WRITE" ? "CRITICAL" : "WARNING") : "OK",
    count24h: c24,
    count7d: a?.count7d ?? 0,
    lastAt: toDate(a?.lastAt ?? null),
    lastReason: a?.lastReason ?? null,
    correlationId: a?.correlationId ?? null,
    detail: c24 ? (key === "ORDER_WRITE" ? `${c24} lượt bot ghi khách / đơn bị lõi đơn ném lỗi / 24 giờ — hội thoại đã chuyển nhân viên (lý do «sau ghi» = đơn có thể đã có, kiểm trước khi lên tay)` : `${c24} lượt đơn của bot bị từ chối / 24 giờ`) : null,
  };
}

function quotaRow(f: MirrorFacts): OrgHealthMeasurement {
  const ent = f.entitlement;
  const parts: { level: OpsLevel; reason: string; text: string }[] = [];
  if (ent && !ent.allowed && ent.reason) parts.push({ level: "CRITICAL", reason: ent.reason, text: "cổng gói đang chặn AI trả lời khách" });
  if (f.balanceClosed) parts.push({ level: "CRITICAL", reason: "BALANCE_EXHAUSTED", text: "số dư AI hết — AI không nhận khách mới" });
  const plan24 = f.inbound?.plan24h ?? null;
  if (plan24) parts.push({ level: "WARNING", reason: f.lastPlanStop?.reason ?? "BALANCE_EXHAUSTED", text: `${plan24} tin khách bị cổng gói chặn / 24 giờ` });
  const unknown = ent === null || f.balanceClosed === null || f.inbound === null;
  const level = parts.length ? worstLevel(...parts.map((p) => p.level)) : unknown ? "UNKNOWN" : "OK";
  const top = parts.find((p) => p.level === level) ?? null;
  return {
    key: "QUOTA",
    level,
    count24h: plan24,
    count7d: f.inbound?.plan7d ?? null,
    lastAt: toDate(f.lastPlanStop?.at ?? null),
    lastReason: top?.reason ?? f.lastPlanStop?.reason ?? null,
    correlationId: f.lastPlanStop?.conversationId ?? null,
    detail: join([...parts.map((p) => p.text), unknown ? "một phần cổng gói / số dư không đọc được lượt này" : null]),
  };
}

/** Bảy dòng gương từ sự thật đã đọc. HÀM THUẦN, hai lần chạy ra cùng kết quả. */
export function buildMirrorRows(f: MirrorFacts): OrgHealthMeasurement[] {
  return [fbRow(f), webhookRow(f), aiRow(f), sendRow(f), orderRow("ORDER_VALIDATION", f), orderRow("ORDER_WRITE", f), quotaRow(f)];
}

/** Câu lỗi gửi đã lưu ở `sales_chat_inbound.note` ⇒ lý do ngắn. Gợi ý của graph-errors.ts nhận lại tất định; còn lại đoán theo mẫu chữ. HÀM THUẦN. */
export function sendFailureReason(note: string | null | undefined): SendFailureReason {
  const kind = graphErrorKindOfText(note);
  if (kind === "TOKEN" || kind === "PERMISSION" || kind === "WINDOW" || kind === "RECIPIENT" || kind === "RATE_LIMIT") return kind;
  const s = (note ?? "").toLowerCase();
  if (/timeout|timed out|hết giờ/.test(s)) return "TIMEOUT";
  if (/http [45][0-9]{2}|từ chối|không nhận tin/.test(s)) return "REJECTED";
  return "OTHER";
}

// ─────────────────────────── Đọc sự thật (CSDL tổ chức ngữ cảnh) ───────────────────────────

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const isoOf = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const n = (v: unknown): number => (Number.isFinite(Number(v ?? 0)) ? Number(v ?? 0) : 0);

const PLAN_NOTES = AI_STOP_REASONS.map((r) => AI_STOP_NOTE[r]);
const planReasonOf = (note: string | null): AiStopReason | null => (note ? (AI_STOP_REASONS.find((r) => AI_STOP_NOTE[r] === note) ?? null) : null);

async function conversationOf(pageId: string, threadId: string): Promise<string | null> {
  const c = schema.salesChatConversations;
  const [row] = await (await getDb()).select({ id: c.id }).from(c).where(and(eq(c.pageId, pageId), eq(c.threadId, threadId))).limit(1);
  return row?.id ?? null;
}

async function readInbound(now: Date) {
  const db = await getDb();
  const d1 = new Date(now.getTime() - 86_400_000);
  const d7 = new Date(now.getTime() - 7 * 86_400_000);
  const eligibleFrom = new Date(now.getTime() - PENDING_ELIGIBLE_MINUTES * 60_000);
  const sendCond = sql`((status = 'DONE' and note ~* ${SEND_ERROR_NOTE_RE}) or (status = 'DEAD' and note like ${`${DEAD_SEND_NOTE_PREFIX}%`}))`;
  const deadOther = sql`(status = 'DEAD' and coalesce(note, '') not like ${`${DEAD_SEND_NOTE_PREFIX}%`} and coalesce(note, '') <> ${DEAD_AI_DOWN_NOTE})`;
  const abandoned = sql`(status = 'PENDING' and created_at < ${eligibleFrom})`;
  const planCond = sql`note in (${sql.join(PLAN_NOTES.map((x) => sql`${x}`), sql`, `)})`;
  const [r] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select
        count(*) filter (where ${sendCond}) as send_7d,
        count(*) filter (where ${deadOther} and created_at >= ${d1}) as dead_other_24h,
        count(*) filter (where ${deadOther}) as dead_other_7d,
        count(*) filter (where ${abandoned}) as abandoned_7d,
        max(created_at) filter (where ${deadOther} or ${abandoned}) as last_processing,
        count(*) filter (where ${planCond} and created_at >= ${d1}) as plan_24h,
        count(*) filter (where ${planCond}) as plan_7d
      from sales_chat_inbound
      where ${CUSTOMER_ROW} and created_at >= ${d7}
    `),
  );
  const [send] = rowsOf<Record<string, unknown>>(await db.execute(sql`select page_id, thread_id, created_at, left(note, 400) as note from sales_chat_inbound where ${CUSTOMER_ROW} and created_at >= ${d7} and ${sendCond} order by created_at desc limit 1`));
  const [plan] = rowsOf<Record<string, unknown>>(await db.execute(sql`select page_id, thread_id, created_at, note from sales_chat_inbound where ${CUSTOMER_ROW} and created_at >= ${d7} and ${planCond} order by created_at desc limit 1`));
  const inbound = { send7d: n(r?.send_7d), deadOther24h: n(r?.dead_other_24h), deadOther7d: n(r?.dead_other_7d), abandoned7d: n(r?.abandoned_7d), lastProcessingAt: isoOf(r?.last_processing), plan24h: n(r?.plan_24h), plan7d: n(r?.plan_7d) };
  const lastSend = send && isoOf(send.created_at) ? { at: isoOf(send.created_at)!, reason: sendFailureReason(typeof send.note === "string" ? send.note : null), conversationId: await conversationOf(String(send.page_id ?? ""), String(send.thread_id ?? "")) } : null;
  const planReason = plan ? planReasonOf(typeof plan.note === "string" ? plan.note : null) : null;
  const lastPlanStop = plan && planReason && isoOf(plan.created_at) ? { at: isoOf(plan.created_at)!, reason: planReason, conversationId: await conversationOf(String(plan.page_id ?? ""), String(plan.thread_id ?? "")) } : null;
  return { inbound, lastSend, lastPlanStop };
}

async function readLastAiDown(now: Date): Promise<MirrorFacts["lastAiDown"]> {
  const c = schema.salesChatConversations;
  const [row] = await (await getDb())
    .select({ id: c.id, at: c.updatedAt })
    .from(c)
    .where(and(eq(c.handoffReason, AI_DOWN_HANDOFF_REASON), gte(c.updatedAt, new Date(now.getTime() - 86_400_000))))
    .orderBy(sql`${c.updatedAt} desc`)
    .limit(1);
  return row ? { at: row.at.toISOString(), conversationId: row.id } : null;
}

/** Sổ đơn của bot: `audit_logs` entity ORDER_ATTEMPT (chỉ mục (entity, created_at)) — 24 giờ / 7 ngày + lần cuối. */
async function readOrderAttempts(now: Date): Promise<NonNullable<MirrorFacts["orders"]>> {
  const a = schema.auditLogs;
  const rows = await (await getDb())
    .select({
      action: a.action,
      c24: sql<number>`count(*) filter (where ${a.createdAt} >= ${new Date(now.getTime() - 86_400_000)})::int`,
      c7: sql<number>`count(*)::int`,
      lastAt: sql<Date | string | null>`max(${a.createdAt})`,
      lastReason: sql<string | null>`(array_agg(${a.detail}->>'reasonCode' order by ${a.createdAt} desc))[1]`,
      corr: sql<string | null>`(array_agg(${a.correlationId} order by ${a.createdAt} desc))[1]`,
    })
    .from(a)
    .where(and(eq(a.entity, ORDER_ATTEMPT_ENTITY), gte(a.createdAt, new Date(now.getTime() - 7 * 86_400_000)), inArray(a.action, [ORDER_CREATE_FAILED_ACTION, ORDER_VALIDATION_FAILED_ACTION])))
    .groupBy(a.action);
  const agg = (action: string): Agg | null => {
    const r = rows.find((x) => x.action === action);
    return r ? { count24h: n(r.c24), count7d: n(r.c7), lastAt: isoOf(r.lastAt), lastReason: r.lastReason, correlationId: r.corr } : null;
  };
  return { write: agg(ORDER_CREATE_FAILED_ACTION), validation: agg(ORDER_VALIDATION_FAILED_ACTION) };
}

async function readPages(): Promise<NonNullable<MirrorFacts["pages"]>> {
  const rows = (await listChannelPages(MESSENGER_DIRECT_KEY)).filter((p) => p.status === "ACTIVE" && p.kind === "PAGE");
  const failing: NonNullable<MirrorFacts["pages"]>["failing"] = [];
  for (const p of rows) {
    if (!p.lastErrorAt || (p.lastEventAt && p.lastEventAt >= p.lastErrorAt)) continue;
    const kind = graphErrorKindOfText(p.lastError);
    if (kind === "TOKEN" || kind === "PERMISSION") failing.push({ pageId: p.pageId, reason: kind, at: p.lastErrorAt.toISOString() });
  }
  return { active: rows.map((p) => p.pageId), failing };
}

type StoredChecks = { pages: Record<string, { at: string; state: WebhookState }>; pausedUntil: string | null };

/** Kiểm đăng ký webhook của page — CÓ TRẦN (đầu tệp). Không ném: lỗi một page ⇒ page đó UNKNOWN. */
export async function runWebhookChecks(pageIds: readonly string[], now: Date, deps: { fetchImpl?: typeof fetch } = {}): Promise<MirrorFacts["webhook"]> {
  const stored = await getSettingJson<StoredChecks>(WEBHOOK_CHECK_SETTING_KEY, { pages: {}, pausedUntil: null });
  const prev = stored.pages && typeof stored.pages === "object" ? stored.pages : {};
  const keep: Record<string, { at: string; state: WebhookState }> = {};
  const states: Record<string, WebhookState> = {};
  for (const id of pageIds) {
    const s = prev[id];
    if (s && (WEBHOOK_STATES as readonly string[]).includes(s.state) && typeof s.at === "string") {
      keep[id] = s;
      states[id] = s.state;
    }
  }
  const app = messengerApp();
  if (!app) return { states, checkedNow: 0, skipped: "NO_APP" };
  const paused = stored.pausedUntil ? Date.parse(stored.pausedUntil) : Number.NaN;
  if (Number.isFinite(paused) && paused > now.getTime()) return { states, checkedNow: 0, skipped: "RATE_PAUSED" };
  const age = (id: string) => (keep[id] ? now.getTime() - Date.parse(keep[id].at) : Number.POSITIVE_INFINITY);
  const due = [...pageIds].filter((id) => age(id) >= WEBHOOK_CHECK_EVERY_MINUTES * 60_000).sort((a, b) => age(b) - age(a)).slice(0, WEBHOOK_CHECK_MAX_PAGES_PER_RUN);
  let checkedNow = 0;
  let pausedUntil: string | null = null;
  for (const id of due) {
    const tk = await messengerTokenFor(id).catch(() => ({ ok: false as const, error: "token" }));
    if (!tk.ok) {
      keep[id] = { at: now.toISOString(), state: "UNKNOWN" };
      states[id] = "UNKNOWN";
      continue;
    }
    const c = await checkPageWebhook(app, id, tk.token, deps.fetchImpl, now, { timeoutMs: WEBHOOK_CHECK_TIMEOUT_MS }).catch(() => null);
    checkedNow += 1;
    if (c && c.state === "UNKNOWN" && graphErrorKindOfText(c.detail) === "RATE_LIMIT") {
      pausedUntil = new Date(now.getTime() + WEBHOOK_CHECK_RATE_PAUSE_MINUTES * 60_000).toISOString();
      break;
    }
    const state: WebhookState = c ? c.state : "UNKNOWN";
    keep[id] = { at: now.toISOString(), state };
    states[id] = state;
  }
  if (due.length || pausedUntil || Object.keys(prev).length !== Object.keys(keep).length) await setSettingJson(WEBHOOK_CHECK_SETTING_KEY, { pages: keep, pausedUntil } satisfies StoredChecks);
  return { states, checkedNow, skipped: pausedUntil ? "RATE_LIMITED" : null };
}

/**
 * Lượt đo: đọc sự thật ⇒ bảy dòng ⇒ MỘT câu ghi vào CSDL nhà. Trả câu ngắn cho chi tiết lượt job. KHÔNG ném (job giám sát không được
 * hỏng vì gương): lỗi ghi ⇒ câu «ghi gương hỏng» trong chi tiết lượt chạy.
 */
export async function mirrorSalesOpsHealth(input: { health: SalesHealth; snapshot: SalesHealthSnapshot; now?: Date; fetchImpl?: typeof fetch }): Promise<string> {
  const now = input.now ?? new Date();
  try {
    const org = await currentOrganization();
    const inbound = await attempt(() => readInbound(now));
    const pages = await attempt(() => readPages());
    const webhook = pages ? ((await attempt(() => runWebhookChecks(pages.active, now, { fetchImpl: input.fetchImpl }))) ?? { states: {}, checkedNow: 0, skipped: null }) : { states: {}, checkedNow: 0, skipped: null };
    const ent = await attempt(() => loadAiEntitlement(org.code, { now }));
    // Đường ĐỌC NÉM được: `aiBalanceGate` nuốt lỗi và trả «mở» (đúng cho khách) — ở đây lỗi đọc phải thành CHƯA BIẾT, không phải OK.
    const gateOpen = await attempt(() => aiBalanceGateStrict(org.code, { channel: "WEB", pageId: null, threadId: null, visitorKey: "ops-signals:probe" }, now));
    const facts: MirrorFacts = {
      health: input.health,
      snapshot: input.snapshot,
      inbound: inbound?.inbound ?? null,
      lastSend: inbound?.lastSend ?? null,
      lastPlanStop: inbound?.lastPlanStop ?? null,
      lastAiDown: await attempt(() => readLastAiDown(now)),
      orders: await attempt(() => readOrderAttempts(now)),
      pages,
      webhook,
      entitlement: ent ? { allowed: ent.allowed, reason: ent.reason } : null,
      balanceClosed: gateOpen === null ? null : !gateOpen,
    };
    const rows = buildMirrorRows(facts);
    await writeOrgHealth(org.code, rows, now);
    const bad = rows.filter((r) => r.level === "CRITICAL" || r.level === "WARNING").map((r) => `${r.key}:${r.level}`);
    return `gương ${rows.length} kiểm${bad.length ? ` (${bad.join(", ")})` : " ổn"}${webhook.checkedNow ? ` · kiểm webhook ${webhook.checkedNow} page` : ""}`;
  } catch (e) {
    return `ghi gương sức khoẻ hỏng: ${e instanceof Error ? e.message.slice(0, 160) : "lỗi lạ"}`;
  }
}
