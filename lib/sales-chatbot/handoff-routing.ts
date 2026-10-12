import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { activeUserIdsWhoCan } from "@/lib/auth/session";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { MONEY_UNKNOWN, workKey, type WorkItem, type WorkStatus } from "@/lib/constants/work";
import { departmentFor } from "@/lib/constants/work-ownership";
import { slaDueAt } from "@/lib/constants/work-sla";
import { actionsOf, WORK_SOURCE_SPEC } from "@/lib/constants/work-sources";
import { autoAssignOn } from "@/lib/constants/workforce";
import { sendInboxMessages } from "@/lib/inbox/send";
import { activeMembershipsByUser } from "@/lib/org/membership";
import { getWorkConfig, type WorkConfig } from "@/lib/queries/work-config";
import { getStaffing } from "@/lib/queries/workforce";
import { escalationOf } from "@/lib/work/escalation";
import {
  HANDOFF_QUEUE_CLEAR,
  HANDOFF_QUEUE_SOURCE,
  HANDOFF_UNOWNED_REASONS,
  handoffEpisodeKey,
  handoffFollowupKey,
  handoffOwnerOf,
  handoffQueueView,
  type HandoffOwner,
  type HandoffQueueView,
  type HandoffUnownedReason,
} from "@/lib/sales-chatbot/handoff-routing-shared";
import { AI_DOWN_HANDOFF_REASON, aiHoldOf, STAFF_COOLDOWN_REASON_LIST } from "@/lib/sales-chatbot/ai-hold-shared";
import { humanHandlingKindSql, needsHumanReasonSql, WAITING_REPLY_SQL, WEB_STAFF_REASON } from "@/lib/sales-chatbot/inbox-states";

/**
 * ═══════════ AI IM THÌ PHẢI CÓ CHỦ — ĐƯỜNG GHI (P0 11/10/2026, yêu cầu 9 «Human handoff») ═══════════
 *
 * NGUYÊN NHÂN GỐC (đo trên mã, tệp:dòng ở báo cáo của bản vá):
 *  1. «Chuyển người» chỉ đổi `status = 'HANDOFF'` — không vào hàng đợi phòng nào (`/work` không chiếu hội thoại chatbot), không ai
 *     được giao, không có mốc để tính hạn.
 *  2. Tin báo dùng khoá chống trùng VĨNH VIỄN `sales-chat:handoff:<hội thoại>` ⇒ lần chuyển người thứ hai của CÙNG hội thoại (khách
 *     nhắn sau khi chốt đơn, AI hỏng lần hai…) không báo ai.
 *  3. Khách nhắn thêm khi đang chờ người ⇒ bot im (đúng) nhưng KHÔNG báo ai (cổng `holdGate` chỉ bỏ qua tin).
 *  4. «Hội thoại quá dài» chuyển người mà không gọi hàm báo nào.
 *  5. Tin chỉ tới chuông ERP của MỌI người xem hộp thư — việc của tất cả là việc của không ai; nhóm chat HSLC đã tắt từ 03/10.
 *
 * CƠ CHẾ (không luật mới nào về giờ / phòng — luật 22):
 *  · VÀO HÀNG ĐỢI: đóng dấu `handoff_queued_at` ở MỌI đường chuyển người đang báo (`notifySalesChatHandoff`), và lượt quét
 *    `sales-health` (5 phút) đóng dấu mọi hội thoại AI im mà chưa có dấu — kể cả đường chuyển người không báo (quá dài, chat web).
 *  · PHÒNG = `departmentFor(SALES_CHAT_HANDOFF)` (đọc `work.ownership`); HẠN = `slaDueAt(SALES_CHAT_HANDOFF, queued_at)` (đọc `work.sla`)
 *    — tính LÚC ĐỌC (luật 26), không ghi hạn xuống CSDL. «Trả cho AI» xoá dấu ⇒ hết hạn.
 *  · NGƯỜI: chỉ khi phòng BẬT «Phân việc tự động» (mặc định tắt — luật 25), qua ĐÚNG máy phân việc của `/work`
 *    (`buildDepartmentPlan` → `planDistribution`): không nhồi quá trần, không giao cho người nghỉ, KHÔNG lấy khỏi tay người đang cầm.
 *  · BÁO: một tin mỗi ĐỢT chờ người; tin khách mới khi đang chờ ⇒ MỘT tin mỗi chu kỳ trả lời (không mỗi tin một thông báo). Người nhận:
 *    người đang cầm → người của phòng xem được hộp thư → (phòng trống) mọi người xem hộp thư — không bao giờ rơi im.
 *  · LEO THANG: tính lúc đọc bằng `escalationOf` của `/work`; ngưỡng `STALE` (vỡ hạn > 24 giờ VÀ chưa ai cầm) ⇒ MỘT tin mỗi phòng mỗi
 *    ngày (luật 26).
 */

const C = schema.salesChatConversations;
const DEFAULT_DEPARTMENT = WORK_SOURCE_SPEC.SALES_CHAT_HANDOFF.department!;

/** Chat web chờ nhân viên trả lại — không tự hết hạn. */
const WEB_STAFF_HOLD_SQL = sql<boolean>`coalesce(${C.status} = 'HANDOFF' and ${C.handoffReason} = ${WEB_STAFF_REASON}, false)`;

/**
 * «AI không trả lời và đang chờ NGƯỜI» — bản SQL của `isAiSilent` (handoff-routing-shared.ts), dựng từ ĐÚNG các điều kiện của hộp thư
 * (`inbox-states.ts`). Khung THỬ không bao giờ vào hàng đợi.
 */
export function aiSilentSql(now: Date): SQL<boolean> {
  return sql<boolean>`(${C.channel} <> 'TEST' and (${needsHumanReasonSql("AI_HANDOFF", now)} or ${needsHumanReasonSql("AI_DOWN", now)} or ${humanHandlingKindSql("MANUAL_TAKEOVER", now, false)} or ${WEB_STAFF_HOLD_SQL}))`;
}

/** Phòng của hàng đợi — `work.ownership` ghi đè, mặc định lấy lại từ sổ nguồn việc. */
export function handoffDepartment(cfg: Pick<WorkConfig, "ownership">): DepartmentCode {
  return departmentFor(HANDOFF_QUEUE_SOURCE, null, DEFAULT_DEPARTMENT, cfg.ownership);
}

/** Hạn của một đợt — `work.sla` ghi đè, mặc định `CASE_SLA_HOURS.CS_CASE`. `null` = chủ shop cố ý không đặt hạn. */
export function handoffDueAt(queuedAt: Date, cfg: Pick<WorkConfig, "sla">): Date | null {
  return slaDueAt(HANDOFF_QUEUE_SOURCE, null, queuedAt, cfg.sla);
}

/** Người của phòng ĐANG hoạt động VÀ xem được hộp thư — người có thể trả lời khách thật. */
export async function handoffResponders(department: DepartmentCode): Promise<string[]> {
  const [byUser, viewers] = await Promise.all([activeMembershipsByUser(), activeUserIdsWhoCan("ai_sales:view")]);
  const can = new Set(viewers);
  return [...byUser.entries()].filter(([userId, ds]) => can.has(userId) && ds.some((d) => d.code === department)).map(([userId]) => userId);
}

type Recipients = { userIds: string[]; scope: "ASSIGNEE" | "DEPARTMENT" | "ALL_VIEWERS" };

/** Ai nhận tin về MỘT hội thoại chờ người: người đang cầm → người của phòng → (phòng trống) mọi người xem hộp thư. */
async function recipientsFor(assigneeUserId: string | null, department: DepartmentCode): Promise<Recipients> {
  const viewers = await activeUserIdsWhoCan("ai_sales:view");
  if (assigneeUserId && viewers.includes(assigneeUserId)) return { userIds: [assigneeUserId], scope: "ASSIGNEE" };
  const responders = await handoffResponders(department);
  if (responders.length) return { userIds: responders, scope: "DEPARTMENT" };
  return { userIds: viewers, scope: "ALL_VIEWERS" };
}

const inboxHref = (id: string) => `/ai/sales-chatbot/inbox?c=${encodeURIComponent(id)}`;

/**
 * Đưa MỘT hội thoại vào hàng đợi người (idempotent: đã có dấu của đợt này thì giữ). Trả mốc vào hàng đợi + chủ hiện tại. Phòng bật
 * phân việc tự động ⇒ thử giao người còn chỗ NGAY (cùng máy phân việc của `/work`). Không ném ra ngoài lượt chat.
 */
export async function enterHandoffQueue(conversationId: string, now: Date): Promise<{ queuedAt: Date; assigneeUserId: string | null; department: DepartmentCode } | null> {
  const db = await getDb();
  const [row] = await db
    .update(C)
    .set({ handoffQueuedAt: sql`coalesce(${C.handoffQueuedAt}, ${now})` })
    .where(and(eq(C.id, conversationId), sql`${C.channel} <> 'TEST'`))
    .returning({ queuedAt: C.handoffQueuedAt, assigneeUserId: C.assigneeUserId });
  if (!row?.queuedAt) return null;
  const cfg = await getWorkConfig();
  const department = handoffDepartment(cfg);
  let assigneeUserId = row.assigneeUserId;
  if (!assigneeUserId) assigneeUserId = (await autoAssignHandoffs(department, now, [conversationId]).catch(() => null))?.get(conversationId) ?? null;
  return { queuedAt: row.queuedAt, assigneeUserId, department };
}

/** Mô tả chủ cho câu báo. */
function ownerSentence(scope: Recipients["scope"], department: DepartmentCode): string {
  if (scope === "ASSIGNEE") return "Hội thoại đã có người nhận — bạn đang phụ trách.";
  if (scope === "DEPARTMENT") return `Hàng đợi phòng ${DEPARTMENT_LABEL[department]} — chưa ai nhận, bấm «Nhận hội thoại».`;
  return `Phòng ${DEPARTMENT_LABEL[department]} chưa có ai xem được hộp thư — báo mọi người xem hộp thư; bấm «Nhận hội thoại».`;
}

/**
 * TIN BÁO CỦA MỘT ĐỢT CHỜ NGƯỜI (gọi từ `notifySalesChatHandoff`): vào hàng đợi rồi báo ĐÚNG người — MỘT tin mỗi đợt (khoá theo mốc vào
 * hàng đợi, không vĩnh viễn theo hội thoại). `dedupeKey` của nơi gọi (sự cố có danh tính riêng) thắng khoá đợt. Trả khoá đã dùng.
 */
export async function notifyHandoffEpisode(p: { conversationId: string; title: string; body: string; now: Date; dedupeKey?: string }): Promise<{ key: string; recipients: Recipients["scope"]; sent: number }> {
  const db = await getDb();
  const q = await enterHandoffQueue(p.conversationId, p.now).catch(() => null);
  const department = q?.department ?? handoffDepartment(await getWorkConfig());
  const key = p.dedupeKey ?? (q ? handoffEpisodeKey(p.conversationId, q.queuedAt) : `sales-chat:handoff:${p.conversationId}:${p.now.toISOString()}`);
  const who = await recipientsFor(q?.assigneeUserId ?? null, department);
  const body = `${p.body}\n${ownerSentence(who.scope, department)}`.slice(0, 2000);
  const href = inboxHref(p.conversationId);
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "warning", title: p.title, body, href, entityType: "SALES_CHAT", entityId: p.conversationId, dedupeKey: key, occurredAt: p.now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const sent = await sendInboxMessages(who.userIds.map((userId) => ({ userId, kind: "SALES_CHAT_HANDOFF", title: p.title, body, href, dedupeKey: `${key}:${userId}` })), db);
  if (q) await db.update(C).set({ handoffAlertedAt: p.now }).where(eq(C.id, p.conversationId));
  return { key, recipients: who.scope, sent };
}

/**
 * KHÁCH NHẮN THÊM KHI ĐANG CHỜ NGƯỜI (gọi từ `holdGate` — mọi kênh nhắn tin — và lượt quét cho chat web): hội thoại vẫn trong hàng đợi
 * (đóng dấu nếu thiếu), và người phụ trách / phòng nhận MỘT tin mỗi chu kỳ trả lời. «Chưa đọc» không đổi luật (#784 / #792): nó đi theo
 * con trỏ đọc của người xem, tin khách mới tự làm hội thoại chưa đọc. Không ném.
 */
export async function noteCustomerWhileQueued(conversationId: string, now: Date): Promise<"NOT_SILENT" | "DEDUPED" | "NOTIFIED"> {
  const db = await getDb();
  const [row] = await db
    .select({ silent: aiSilentSql(now), lastStaffAt: C.lastStaffAt, waiting: WAITING_REPLY_SQL })
    .from(C)
    .where(eq(C.id, conversationId))
    .limit(1);
  if (!row?.silent) return "NOT_SILENT";
  const q = await enterHandoffQueue(conversationId, now);
  if (!q) return "NOT_SILENT";
  // Nhân viên đã trả lời sau tin khách cuối (ERP / page) ⇒ không có tin nào đang chờ: không báo.
  if (!row.waiting) return "DEDUPED";
  const key = handoffFollowupKey(conversationId, q.queuedAt, row.lastStaffAt);
  const title = "Khách nhắn thêm — đang chờ nhân viên";
  const who = await recipientsFor(q.assigneeUserId, q.department);
  const href = inboxHref(conversationId);
  const body = `Khách gửi tin mới trong lúc AI đã dừng trả lời. ${ownerSentence(who.scope, q.department)}`;
  const inserted = await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "warning", title, body, href, entityType: "SALES_CHAT", entityId: conversationId, dedupeKey: key, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey })
    .returning({ id: schema.notifications.id });
  if (!inserted.length) return "DEDUPED";
  await sendInboxMessages(who.userIds.map((userId) => ({ userId, kind: "SALES_CHAT_HANDOFF", title, body, href, dedupeKey: `${key}:${userId}` })), db);
  await db.update(C).set({ handoffAlertedAt: now }).where(eq(C.id, conversationId));
  return "NOTIFIED";
}

/**
 * AI NHẬN LẠI hội thoại («Trả cho AI» — gọi SAU khi câu ghi `status = 'OPEN'` thành công): rời hàng đợi người ⇒ xoá mốc ⇒ hết hạn. Chỉ
 * xoá khi hội thoại không còn AI im (một lượt tiếp quản chen giữa giữ nguyên dấu của nó).
 */
export async function clearHandoffQueue(conversationId: string, now: Date = new Date()): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(C)
    .set(HANDOFF_QUEUE_CLEAR)
    .where(and(eq(C.id, conversationId), sql`not ${aiSilentSql(now)}`))
    .returning({ id: C.id });
  return rows.length > 0;
}

/**
 * Người quản lý «Giao cho…» một hội thoại ĐANG chờ người ⇒ người được giao nhận MỘT tin (khoá theo đợt + người). AI đang trả lời ⇒ không
 * báo (giao để theo dõi, không có khách nào đang chờ). Không ném.
 */
export async function notifyHandoffAssignee(conversationId: string, userId: string, now: Date = new Date()): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ silent: aiSilentSql(now), queuedAt: C.handoffQueuedAt }).from(C).where(eq(C.id, conversationId)).limit(1);
  if (!row?.silent) return false;
  const key = `sales-chat:handoff-assigned:${conversationId}:${userId}:${(row.queuedAt ?? now).toISOString()}`;
  const sent = await sendInboxMessages([{ userId, kind: "SALES_CHAT_HANDOFF", title: "Bạn được giao một khách đang chờ", body: "Hội thoại AI đã dừng trả lời được giao cho bạn — trả lời khách trong hộp thư.", href: inboxHref(conversationId), dedupeKey: key }], db);
  return sent > 0;
}

/* ═══════════════════ PHÉP CHIẾU CHO `/work` ═══════════════════ */

type QueueRow = {
  id: string;
  channel: string;
  status: string;
  handoffReason: string | null;
  queuedAt: Date | null;
  updatedAt: Date;
  assigneeUserId: string | null;
  assigneeName: string | null;
  assigneeActive: boolean | null;
  lastStaffAt: Date | null;
  handoffAt: Date | null;
  customerName: string | null;
};

async function silentRows(now: Date, ids?: string[]): Promise<QueueRow[]> {
  const db = await getDb();
  const u = schema.users;
  return db
    .select({
      id: C.id,
      channel: C.channel,
      status: C.status,
      handoffReason: C.handoffReason,
      queuedAt: C.handoffQueuedAt,
      updatedAt: C.updatedAt,
      assigneeUserId: C.assigneeUserId,
      assigneeName: u.name,
      assigneeActive: u.active,
      lastStaffAt: C.lastStaffAt,
      handoffAt: sql<Date | null>`case when ${C.state}->'handoff'->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (${C.state}->'handoff'->>'at')::timestamptz end`,
      customerName: sql<string | null>`coalesce(${C.state}->'customer'->>'name', (select i.customer_name from "sales_chat_inbound" i where i.page_id = ${C.pageId} and i.thread_id = ${C.threadId} and i.customer_name is not null order by i.created_at desc limit 1))`,
    })
    .from(C)
    .leftJoin(u, eq(u.id, C.assigneeUserId))
    .where(and(aiSilentSql(now), ...(ids ? [inArray(C.id, ids)] : [])))
    .limit(2000);
}

/**
 * Việc chiếu của nguồn `SALES_CHAT_HANDOFF` — một hội thoại AI im một dòng. `createdAt` = mốc vào hàng đợi (hạn tính từ đó qua
 * `applyWorkConfig`); hội thoại chưa có dấu (đường chuyển người không báo, chưa tới lượt quét) vẫn hiện, mang thẻ `NOT_QUEUED`.
 */
export async function handoffWorkItems(now: Date): Promise<WorkItem[]> {
  const rows = await silentRows(now);
  return rows.map((r) => {
    // Chưa có dấu hàng đợi ⇒ mốc chuyển người của chính đường chuyển (`state.handoff.at`); `updated_at` chỉ là chỗ lùi cuối — cột này bị
    // mọi lượt ghi đẩy tới, dùng nó làm mốc tính hạn là hạn KHÔNG BAO GIỜ vỡ (HOTFIX P0 12/10/2026).
    const queued = r.queuedAt ?? r.handoffAt ?? r.updatedAt;
    const held = Boolean(r.assigneeUserId && r.assigneeActive);
    const status: WorkStatus = !held ? "NEW" : r.lastStaffAt && r.lastStaffAt.getTime() >= queued.getTime() ? "IN_PROGRESS" : "ASSIGNED";
    return {
      key: workKey(HANDOFF_QUEUE_SOURCE, r.id),
      sourceType: HANDOFF_QUEUE_SOURCE,
      sourceKey: r.id,
      kind: null,
      title: `Khách chờ nhân viên: ${r.customerName?.trim() || "Khách"}`,
      summary: r.handoffReason ?? "Nhân viên đang tiếp quản",
      department: DEFAULT_DEPARTMENT,
      assignee: held ? { id: r.assigneeUserId, email: "", name: r.assigneeName ?? "" } : null,
      status,
      statusAuthority: "SOURCE",
      priority: "HIGH",
      score: 70,
      createdAt: queued,
      startedAt: null,
      dueAt: null,
      slaAt: null,
      completedAt: null,
      snoozedUntil: null,
      businessEntity: "CONVERSATION",
      businessEntityId: r.id,
      sourceUrl: inboxHref(r.id),
      money: MONEY_UNKNOWN,
      tags: [r.channel, ...(r.queuedAt ? [] : ["NOT_QUEUED"])],
      evidence: { source: "Hộp thư AI bán hàng", detail: r.queuedAt ? `Vào hàng đợi người ${r.queuedAt.toISOString()}` : "AI đã dừng nhưng chưa vào hàng đợi — lượt quét 5 phút sẽ đóng dấu" },
      blockedReason: "",
      creationSource: "AUTO",
      actions: actionsOf(HANDOFF_QUEUE_SOURCE),
      recommendedAction: "Mở hộp thư, trả lời khách; xong thì «Trả cho AI».",
    };
  });
}

/* ═══════════════════ GIAO NGƯỜI: CỬA CỦA MÁY ═══════════════════ */

/** Danh tính máy phân việc — cùng chuỗi với `lib/work/assign.ts::MACHINE_ASSIGNER` (không import để tránh vòng phụ thuộc). */
const MACHINE_EMAIL = "job:work-auto-assign";

/**
 * Máy giao MỘT hội thoại chờ người cho một người. CHỈ hội thoại chưa ai cầm (luật 25: không lấy khỏi tay ai) và còn đang AI im. Ghi
 * nhật ký với người thao tác là MÁY (`userId: null`, luật 34); báo người được giao một tin.
 */
export async function assignHandoffByMachine(conversationId: string, userId: string, now: Date = new Date()): Promise<{ ok: true } | { error: string }> {
  const db = await getDb();
  const [target] = await db.select({ id: schema.users.id, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!target?.active) return { error: "Tài khoản không tồn tại hoặc đã khoá" };
  const taken = await db
    .update(C)
    .set({ assigneeUserId: userId, assignedAt: now })
    .where(and(eq(C.id, conversationId), isNull(C.assigneeUserId), aiSilentSql(now)))
    .returning({ id: C.id });
  if (!taken.length) return { error: "Hội thoại đã có người nhận hoặc AI đã trả lời lại" };
  await audit({ userId: null, userEmail: MACHINE_EMAIL, action: "SALES_INBOX_MACHINE_ASSIGN", entity: "SALES_CONVERSATION", entityId: conversationId, before: { assignee: null }, after: { assignee: userId }, reason: "Phân việc tự động — hội thoại AI chờ người" });
  await notifyHandoffAssignee(conversationId, userId, now).catch(() => false);
  return { ok: true };
}

/**
 * PHÂN VIỆC TỰ ĐỘNG cho hội thoại chờ người của MỘT phòng — chỉ khi phòng BẬT công tắc (mặc định tắt ⇒ trả rỗng, không đọc gì thêm).
 * Kế hoạch dựng bằng ĐÚNG `buildDepartmentPlan` (máy phân việc của `/work`): không nhồi quá trần, bỏ người đang nghỉ, chỉ việc chưa ai
 * cầm. Chỉ ÁP phần giao của nguồn này (`only` = giới hạn thêm theo hội thoại). Trả bản đồ hội thoại → người đã giao.
 */
export async function autoAssignHandoffs(department: DepartmentCode, now: Date, only?: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!autoAssignOn(department, await getStaffing())) return out;
  // Nạp muộn: auto-assign-run → work-adapters → tệp này (vòng phụ thuộc nếu nạp tĩnh).
  const { buildDepartmentPlan } = await import("@/lib/work/auto-assign-run");
  const { plan } = await buildDepartmentPlan({ department, now, machineOnly: true });
  const want = only ? new Set(only.map((id) => workKey(HANDOFF_QUEUE_SOURCE, id))) : null;
  for (const a of plan.assignments) {
    if (a.source !== HANDOFF_QUEUE_SOURCE || (want && !want.has(a.key))) continue;
    const id = a.key.slice(HANDOFF_QUEUE_SOURCE.length + 1);
    const r = await assignHandoffByMachine(id, a.userId, now);
    if ("ok" in r) out.set(id, a.userId);
  }
  return out;
}

/* ═══════════════════ BẤT BIẾN: «CHUYỂN NGƯỜI KHÔNG CHỦ» ═══════════════════ */

export type UnownedHandoffCount = {
  /** Hội thoại AI đang im (phải có chủ). */
  silent: number;
  person: number;
  department: number;
  /** Hàng đợi CHUNG — phòng chưa có ai, tổ chức có người xem hộp thư (không phải «không chủ», nhưng cấu hình phòng thiếu người). */
  shared: number;
  unowned: number;
  byReason: Record<HandoffUnownedReason, number>;
  departmentCode: DepartmentCode;
  responders: number;
  /** Người xem được hộp thư của cả tổ chức. */
  viewers: number;
  /** Tối đa 50 mã hội thoại không chủ — để audit mở thẳng. */
  sample: string[];
};

/**
 * CÂU ĐẾM «chuyển người không chủ» — cho audit / chỉ số (yêu cầu 11 «Unassigned handoff count»). Phải bằng 0 sau mọi luồng: hội thoại
 * AI im mà không người cầm VÀ (chưa vào hàng đợi HOẶC phòng của hàng đợi không có ai xem được hộp thư). Chủ của từng dòng đi qua
 * `handoffOwnerOf` — một định nghĩa với dòng hộp thư.
 */
export async function countUnownedHandoffs(now: Date = new Date()): Promise<UnownedHandoffCount> {
  const cfg = await getWorkConfig();
  const departmentCode = handoffDepartment(cfg);
  const [rows, responders, viewers] = await Promise.all([silentRows(now), handoffResponders(departmentCode), activeUserIdsWhoCan("ai_sales:view")]);
  const out: UnownedHandoffCount = { silent: rows.length, person: 0, department: 0, shared: 0, unowned: 0, byReason: Object.fromEntries(HANDOFF_UNOWNED_REASONS.map((r) => [r, 0])) as Record<HandoffUnownedReason, number>, departmentCode, responders: responders.length, viewers: viewers.length, sample: [] };
  for (const r of rows) {
    const o = handoffOwnerOf({ silent: true, assigneeUserId: r.assigneeUserId, assigneeActive: Boolean(r.assigneeActive), queuedAt: r.queuedAt, department: departmentCode, responders: responders.length, viewers: viewers.length });
    if (!o) continue;
    if (o.kind === "PERSON") out.person += 1;
    else if (o.kind === "DEPARTMENT") out.department += 1;
    else if (o.kind === "SHARED") out.shared += 1;
    else {
      out.unowned += 1;
      out.byReason[o.reason] += 1;
      if (out.sample.length < 50) out.sample.push(r.id);
    }
  }
  return out;
}

/* ═══════════════════ DÒNG HỘP THƯ ═══════════════════ */

export type HandoffViewRow = { id: string; silent: boolean; queuedAt: Date | null; assigneeUserId: string | null; assigneeName: string | null; assigneeActive: boolean; lastStaffAt: Date | null; waitingSince: Date | null };

/** Bối cảnh MỘT lần cho cả trang hộp thư: phòng, số người trả lời được, cấu hình hạn. */
export async function handoffViewContext(): Promise<{ cfg: WorkConfig; department: DepartmentCode; responders: number; viewers: number }> {
  const cfg = await getWorkConfig();
  const department = handoffDepartment(cfg);
  const [responders, viewers] = await Promise.all([handoffResponders(department), activeUserIdsWhoCan("ai_sales:view")]);
  return { cfg, department, responders: responders.length, viewers: viewers.length };
}

/** «chờ X phút · phụ trách · hạn» của MỘT hội thoại; `null` = AI đang trả lời (không hiện). */
export function handoffViewOf(r: HandoffViewRow, ctx: { cfg: WorkConfig; department: DepartmentCode; responders: number; viewers?: number }, now: Date): HandoffQueueView | null {
  const owner: HandoffOwner | null = handoffOwnerOf({ silent: r.silent, assigneeUserId: r.assigneeUserId, assigneeActive: r.assigneeActive, queuedAt: r.queuedAt, department: ctx.department, responders: ctx.responders, viewers: ctx.viewers });
  if (!owner) return null;
  // Chưa có dấu (đường chuyển người không báo, chưa tới lượt quét) ⇒ vẫn hiện, tính chờ từ «bây giờ» là nói dối — dùng mốc tin cuối.
  const queuedAt = r.queuedAt ?? r.lastStaffAt ?? r.waitingSince ?? now;
  return handoffQueueView({ owner, queuedAt, assigneeName: r.assigneeName, lastStaffAt: r.lastStaffAt, waitingSince: r.waitingSince, dueAt: r.queuedAt ? handoffDueAt(r.queuedAt, ctx.cfg) : null }, now);
}

/* ═══════════════════ LƯỢT QUÉT (job `sales-health`, 5 phút) ═══════════════════ */

export type HandoffSweepResult = { cleared: number; stamped: number; followups: number; assigned: number; staleDepartments: number; recovered: number; noResponderAlerts: number; unowned: UnownedHandoffCount };

const VN_DAY = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/**
 * Lưới an toàn của bất biến, chạy cùng lịch giám sát AI bán hàng:
 *  1. Xoá dấu của hội thoại AI đã trả lời lại (đường trả lại nào quên xoá thì đây dọn) — dấu cũ không được thành mốc của đợt sau.
 *  2. Đóng dấu + báo hội thoại AI im mà chưa vào hàng đợi (quá dài · chat web · đường mới chưa nối). Mốc = `state.handoff.at` khi có
 *     (chứng cứ của chính đường chuyển người), không thì lúc quét — không đoán ngược.
 *  3. Tin khách chờ mà chưa báo (chat web không đi qua `holdGate`) ⇒ cùng đường `noteCustomerWhileQueued` (chống trùng theo khoá).
 *  4. Phòng bật phân việc tự động ⇒ giao người còn chỗ.
 *  5. Leo thang: vỡ hạn > 24 giờ mà chưa ai cầm ⇒ MỘT tin mỗi phòng mỗi ngày (luật 26).
 *  6. WATCHDOG (HOTFIX P0 12/10/2026): lần nhường TỰ HẾT HẠN (nhân viên vừa trả lời tay · AI hỏng) đã quá mốc mà hội thoại còn
 *     `HANDOFF` ⇒ mở lại cho AI bằng ĐÚNG cổng của đường xử lý tin (`holdGate`, ghi `ai.resumed` COOLDOWN_EXPIRED). Trước đây chỉ tin
 *     khách KẾ TIẾP mới mở lại, nên hộp thư treo «AI đã dừng» dù không còn lý do nào. KHÔNG BAO GIỜ chạm chuyển người bắt buộc (khách
 *     báo chuyển khoản, hàng rào khẳng định, khiếu nại, ghi đơn hỏng…) hay «Tiếp quản» — chỉ người trả lại được.
 *  7. Phòng phụ trách chưa có ai xem được hộp thư mà có khách chờ ⇒ hội thoại ở HÀNG ĐỢI CHUNG + MỘT tin quản trị mỗi phòng mỗi ngày.
 */
export async function sweepHandoffOwnership(now: Date = new Date()): Promise<HandoffSweepResult> {
  const db = await getDb();
  const recovered = await recoverExpiredHolds(now).catch(() => 0);
  const cleared = await db
    .update(C)
    .set({ handoffQueuedAt: null, handoffAlertedAt: null })
    .where(and(isNotNull(C.handoffQueuedAt), sql`not ${aiSilentSql(now)}`))
    .returning({ id: C.id });

  const handoffAt = sql<Date>`case when ${C.state}->'handoff'->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' and (${C.state}->'handoff'->>'at')::timestamptz <= ${now} then (${C.state}->'handoff'->>'at')::timestamptz else ${now} end`;
  const stampedRows = await db
    .update(C)
    .set({ handoffQueuedAt: handoffAt })
    .where(and(isNull(C.handoffQueuedAt), aiSilentSql(now)))
    .returning({ id: C.id, reason: C.handoffReason, customer: sql<{ name: string; phone: string } | null>`${C.state}->'customer'` });
  // Nạp muộn: alerts.ts gọi ngược tệp này (vòng phụ thuộc nếu nạp tĩnh).
  const { notifySalesChatHandoff } = await import("@/lib/sales-chatbot/alerts");
  for (const r of stampedRows) {
    const customer = r.customer && typeof r.customer.name === "string" && typeof r.customer.phone === "string" ? r.customer : null;
    await notifySalesChatHandoff(r.id, r.reason ?? "Nhân viên đang tiếp quản", customer, now).catch(() => undefined);
  }

  // Tin khách chờ sau lần báo cuối của đợt (chat web; kênh nhắn tin đã báo ở `holdGate` — khoá chống trùng giữ một tin).
  const waiting = await db
    .select({ id: C.id })
    .from(C)
    .where(and(aiSilentSql(now), isNotNull(C.handoffQueuedAt), WAITING_REPLY_SQL, sql`${C.lastCustomerAt} > coalesce(${C.handoffAlertedAt}, ${C.handoffQueuedAt})`))
    .limit(200);
  let followups = 0;
  for (const w of waiting) if ((await noteCustomerWhileQueued(w.id, now).catch(() => "DEDUPED")) === "NOTIFIED") followups += 1;

  const cfg = await getWorkConfig();
  const department = handoffDepartment(cfg);
  const assigned = (await autoAssignHandoffs(department, now).catch(() => new Map<string, string>())).size;

  // Leo thang tính LÚC ĐỌC trên đúng việc chiếu của `/work` (hạn theo `work.sla`).
  let staleDepartments = 0;
  const staff = await getStaffing();
  const items = (await handoffWorkItems(now)).map((i) => ({ ...i, department: handoffDepartment(cfg), slaAt: handoffDueAt(i.createdAt, cfg) }));
  const stale = items.filter((i) => escalationOf(i, now)?.level === "STALE");
  if (stale.length && staff.escalationOff[department] !== true) {
    const key = `sales-chat:handoff-stale:${department}:${VN_DAY(now)}`;
    const title = `${stale.length} khách chờ nhân viên quá hạn hơn một ngày — chưa ai nhận`;
    const body = `Hàng đợi phòng ${DEPARTMENT_LABEL[department]}: ${stale.length} hội thoại AI đã dừng trả lời, vỡ hạn hơn 24 giờ mà chưa ai cầm. Mở hộp thư (lọc «Chưa ai nhận») để nhận hoặc giao.`;
    const ins = await db
      .insert(schema.notifications)
      .values({ kind: "SYSTEM", severity: "critical", title, body, href: "/ai/sales-chatbot/inbox?f=UNASSIGNED", entityType: "SALES_CHAT", entityId: department, dedupeKey: key, occurredAt: now })
      .onConflictDoNothing({ target: schema.notifications.dedupeKey })
      .returning({ id: schema.notifications.id });
    if (ins.length) {
      staleDepartments = 1;
      const who = new Set([...(await handoffResponders(department)), ...(await activeUserIdsWhoCan("ai_sales:manage"))]);
      await sendInboxMessages([...who].map((userId) => ({ userId, kind: "SALES_CHAT_HANDOFF", title, body, href: "/ai/sales-chatbot/inbox?f=UNASSIGNED", dedupeKey: `${key}:${userId}` })), db);
    }
  }

  const unowned = await countUnownedHandoffs(now);
  let noResponderAlerts = 0;
  if (unowned.responders === 0 && unowned.silent - unowned.person > 0) {
    const key = `sales-chat:handoff-no-responder:${department}:${VN_DAY(now)}`;
    const waitingN = unowned.silent - unowned.person;
    const title = `Phòng ${DEPARTMENT_LABEL[department]} chưa có ai xem được hộp thư — ${waitingN} khách chờ đang ở hàng đợi chung`;
    const body = `${waitingN} hội thoại AI đã dừng chưa ai nhận. Phòng phụ trách hàng đợi khách chờ (khoá SALES_CHAT_HANDOFF) chưa có thành viên nào xem được hộp thư nên hội thoại đang nằm ở HÀNG ĐỢI CHUNG của mọi người xem hộp thư. Xếp người vào phòng ở Cấu hình → Nhân sự và phòng ban, hoặc đổi phòng ở Cấu hình → Phòng phụ trách.`;
    const ins = await db
      .insert(schema.notifications)
      .values({ kind: "SYSTEM", severity: "warning", title, body, href: "/ai/sales-chatbot/inbox?f=UNASSIGNED", entityType: "SALES_CHAT", entityId: department, dedupeKey: key, occurredAt: now })
      .onConflictDoNothing({ target: schema.notifications.dedupeKey })
      .returning({ id: schema.notifications.id });
    if (ins.length) {
      noResponderAlerts = 1;
      const managers = await activeUserIdsWhoCan("ai_sales:manage");
      await sendInboxMessages(managers.map((userId) => ({ userId, kind: "SALES_CHAT_HANDOFF", title, body, href: "/ai/sales-chatbot/inbox?f=UNASSIGNED", dedupeKey: `${key}:${userId}` })), db);
    }
  }
  return { cleared: cleared.length, stamped: stampedRows.length, followups, assigned, staleDepartments, recovered, noResponderAlerts, unowned };
}

/**
 * WATCHDOG: hội thoại còn `HANDOFF` với lý do nhường TỰ HẾT HẠN (nhân viên trả lời tay trên fanpage / Zalo · AI hỏng) mà mốc đã qua ⇒
 * mở lại qua `holdGate` (ghi có điều kiện + `ai.resumed` COOLDOWN_EXPIRED của MÁY). Chỉ những dòng `aiHoldOf` nói AI_ACTIVE kèm
 * `expired` — tiếp quản / chuyển người bắt buộc không bao giờ lọt vào. Lượt quét `resumeFanpageAfterPause` (job follow-up) sau đó
 * đánh giá lại lượt khách còn tươi. Trả số hội thoại đã mở lại. Không ném ra ngoài lượt quét.
 */
export async function recoverExpiredHolds(now: Date): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ id: C.id, status: C.status, handoffReason: C.handoffReason, state: C.state, updatedAt: C.updatedAt, humanCooldownUntil: C.humanCooldownUntil })
    .from(C)
    .where(and(eq(C.status, "HANDOFF"), sql`${C.channel} <> 'TEST'`, inArray(C.handoffReason, [...STAFF_COOLDOWN_REASON_LIST, AI_DOWN_HANDOFF_REASON])))
    .limit(500);
  const { holdGate } = await import("@/lib/sales-chatbot/conversation-control");
  let n = 0;
  for (const r of rows) {
    const hold = aiHoldOf(r, now);
    if (hold.state !== "AI_ACTIVE" || !hold.expired) continue;
    if ((await holdGate(r, now).catch(() => ({ skip: "lỗi" }))) === null) n += 1;
  }
  return n;
}
