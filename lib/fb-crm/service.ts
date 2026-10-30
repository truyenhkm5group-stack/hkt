import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import {
  FB_CONNECTION_DEFAULT,
  FB_CONNECTION_STATUSES,
  FB_CRM_SCHEMA_MISSING,
  FB_CRM_TASK_TAG,
  FB_URL_REJECT_LABEL,
  FB_URL_SET_SOURCES,
  FB_URL_SOURCES,
  careTaskBlockedReason,
  isUndefinedTableError,
  normalizeFacebookProfileUrl,
  planFbCrmOp,
  type FbConnectionState,
  type FbConnectionStatus,
  type FbCrmOp,
  type FbUrlSource,
} from "@/lib/constants/fb-crm";
import { todayVN } from "@/lib/format";
import { pancakeThreadPsidOf } from "@/lib/sales-chatbot/avatar-profile";
import { saveManualTask } from "@/lib/work/service";

/**
 * ═══════════ FACEBOOK FRIEND CRM — ĐƯỜNG GHI (lát 1) ═══════════
 *
 * `customers:write` → zod → đọc trạng thái → `planFbCrmOp` (luật thuần, lib/constants/fb-crm.ts) → ghi dòng + nhật ký trong MỘT
 * giao dịch → `audit()`. Không đổi gì ⇒ KHÔNG ghi gì (luật 61). Mọi bảng nằm ở CSDL của TỔ CHỨC (`getDb()` theo ngữ cảnh) — tổ
 * chức này không đọc / ghi được khách của tổ chức khác.
 *
 * Không có đường nào ở đây gọi Facebook: đây là sổ ghi lại việc NGƯỜI đã làm bằng tay.
 */

export type FbCrmResult = { ok: true; changed: boolean; message: string; taskId?: string } | { ok: false; error: string };

const isoDate = z.iso.date({ error: "Ngày không hợp lệ" });

const opZ = z.discriminatedUnion("op", [
  z.object({ op: z.literal("SET_URL"), url: z.string().max(500, "Link quá dài"), source: z.enum(FB_URL_SET_SOURCES, { error: "Chọn nguồn của link" }) }).strict(),
  z.object({ op: z.literal("CLEAR_URL") }).strict(),
  z.object({ op: z.literal("SET_STATUS"), to: z.enum(["CONSENTED", "INVITE_SENT", "FRIENDS", "DECLINED"]), note: z.string().max(500).optional() }).strict(),
  z.object({ op: z.literal("SET_DNC"), reason: z.string().max(500) }).strict(),
  z.object({ op: z.literal("CLEAR_DNC"), note: z.string().max(500).optional() }).strict(),
  z.object({ op: z.literal("SET_OWNER"), userId: z.string().min(1).max(100).nullable() }).strict(),
  z.object({ op: z.literal("SET_NEXT_CARE"), on: isoDate.nullable() }).strict(),
]);
export type FbCrmOpInput = z.input<typeof opZ>;

const taskZ = z
  .object({
    title: z.string().trim().max(300).optional(),
    note: z.string().trim().max(2000).optional(),
    dueOn: isoDate.nullable().optional(),
  })
  .strict();
export type FbCrmTaskInput = z.input<typeof taskZ>;

const STATUS_SET = new Set<string>(FB_CONNECTION_STATUSES);
const SOURCE_SET = new Set<string>(FB_URL_SOURCES);

/** Trạng thái hiện tại của một khách; chưa có dòng ⇒ mặc định. */
export async function loadFbConnectionState(db: Db, customerId: string): Promise<FbConnectionState> {
  const [row] = await db.select().from(schema.customerFbConnections).where(eq(schema.customerFbConnections.customerId, customerId)).limit(1);
  if (!row) return { ...FB_CONNECTION_DEFAULT };
  return {
    fbProfileUrl: row.fbProfileUrl,
    fbUrlSource: (SOURCE_SET.has(row.fbUrlSource) ? row.fbUrlSource : "NONE") as FbUrlSource,
    connectionStatus: (STATUS_SET.has(row.connectionStatus) ? row.connectionStatus : "NOT_ASKED") as FbConnectionStatus,
    careOwnerUserId: row.careOwnerUserId,
    nextCareOn: row.nextCareOn,
    doNotContact: row.doNotContact,
    doNotContactReason: row.doNotContactReason,
  };
}

/**
 * Mọi mã THEO PAGE ERP biết về khách — `customers.fb_id` + PSID của các hội thoại của khách (Pancake `<page>_<PSID>` hoặc
 * Messenger trực tiếp: mã luồng = PSID). Dùng để TỪ CHỐI link trỏ vào chính mã đó.
 */
export async function pageScopedIdsOf(db: Db, customerId: string): Promise<string[]> {
  const [cust] = await db.select({ fbId: schema.customers.fbId }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  const convs = await db
    .select({ pageId: schema.salesChatConversations.pageId, threadId: schema.salesChatConversations.threadId })
    .from(schema.salesChatConversations)
    .where(eq(schema.salesChatConversations.customerId, customerId));
  const ids = new Set<string>();
  if (cust?.fbId) ids.add(cust.fbId);
  for (const c of convs) {
    if (!c.threadId) continue;
    ids.add(c.threadId);
    const psid = pancakeThreadPsidOf(c.threadId, c.pageId);
    if (psid) ids.add(psid);
  }
  return [...ids];
}

const MESSAGES: Record<FbCrmOp["op"], string> = {
  SET_URL: "Đã lưu link Facebook.",
  CLEAR_URL: "Đã xoá link Facebook.",
  SET_STATUS: "Đã ghi trạng thái kết bạn.",
  SET_DNC: "Đã đưa khách vào danh sách KHÔNG LIÊN HỆ.",
  CLEAR_DNC: "Đã gỡ cờ không liên hệ.",
  SET_OWNER: "Đã đổi nhân viên phụ trách.",
  SET_NEXT_CARE: "Đã đặt ngày chăm sóc tiếp.",
};

/**
 * CSDL chưa áp 0262 (bảng chưa có — tổ chức đang `DEGRADED_MIGRATION`) ⇒ trả lỗi nói rõ, KHÔNG ghi gì: lượt đọc trạng thái đứng
 * TRƯỚC mọi lượt ghi và lượt ghi nằm trong một giao dịch, nên 42P01 không bao giờ để lại nửa thay đổi.
 */
async function guardSchema(fn: () => Promise<FbCrmResult>): Promise<FbCrmResult> {
  try {
    return await fn();
  } catch (e) {
    if (isUndefinedTableError(e)) return { ok: false, error: FB_CRM_SCHEMA_MISSING };
    throw e;
  }
}

/** MỘT thao tác của người trên MỘT khách. Lõi tự kiểm quyền — vỏ Next chỉ gọi `requireUser`. */
export async function fbCrmApplyCore(user: SessionUser, customerId: string, raw: unknown, today: string = todayVN()): Promise<FbCrmResult> {
  return guardSchema(() => applyInner(user, customerId, raw, today));
}

async function applyInner(user: SessionUser, customerId: string, raw: unknown, today: string): Promise<FbCrmResult> {
  if (!can(user, "customers:write")) return { ok: false, error: "Bạn không có quyền sửa thông tin khách (customers:write)." };
  const parsed = opZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const input = parsed.data;
  const db = await getDb();
  const [customer] = await db.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  if (!customer) return { ok: false, error: "Không có khách này." };

  let op: FbCrmOp;
  if (input.op === "SET_URL") {
    const norm = normalizeFacebookProfileUrl(input.url, await pageScopedIdsOf(db, customerId));
    if (!norm.ok) return { ok: false, error: FB_URL_REJECT_LABEL[norm.reason] };
    op = { op: "SET_URL", url: norm.url, source: input.source };
  } else if (input.op === "SET_OWNER" && input.userId) {
    const [u] = await db.select({ id: schema.users.id, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, input.userId)).limit(1);
    if (!u || !u.active) return { ok: false, error: "Nhân viên này không còn hoạt động." };
    op = { op: "SET_OWNER", userId: u.id };
  } else op = input as FbCrmOp;

  const cur = await loadFbConnectionState(db, customerId);
  const plan = planFbCrmOp(cur, op, today);
  if (plan.kind === "ERROR") return { ok: false, error: plan.error };
  if (plan.kind === "NOOP") return { ok: true, changed: false, message: "Không có gì thay đổi." };

  const now = new Date();
  const next = plan.next;
  const urlChanged = op.op === "SET_URL" || op.op === "CLEAR_URL";
  const update = {
    fbProfileUrl: next.fbProfileUrl,
    fbUrlSource: next.fbUrlSource,
    connectionStatus: next.connectionStatus,
    careOwnerUserId: next.careOwnerUserId,
    nextCareOn: next.nextCareOn,
    doNotContact: next.doNotContact,
    doNotContactReason: next.doNotContactReason,
    updatedAt: now,
    ...(urlChanged ? { fbUrlSetByUserId: next.fbProfileUrl ? user.id : null, fbUrlSetAt: next.fbProfileUrl ? now : null } : {}),
  };
  await db.transaction(async (tx) => {
    await tx.insert(schema.customerFbConnections).values({ customerId, ...update }).onConflictDoUpdate({ target: schema.customerFbConnections.customerId, set: update });
    await tx.insert(schema.customerFbConnectionEvents).values(plan.events.map((e) => ({ customerId, kind: e.kind, fromValue: e.fromValue, toValue: e.toValue, note: e.note, actorId: user.id })));
  });
  await audit({ userId: user.id, userEmail: user.email, action: "FB_CRM_UPDATE", entity: "CUSTOMER", entityId: customerId, before: cur, after: next, reason: `Facebook Friend CRM · ${op.op} · ${customer.name}` });
  return { ok: true, changed: true, message: MESSAGES[op.op] };
}

/**
 * Tạo NHIỆM VỤ CSKH cho khách (việc tay của phòng Kinh doanh & CSKH, `saveManualTask`). Chặn khi khách «không liên hệ». CHỐNG
 * TRÙNG: khách đã có một nhiệm vụ của trang này còn MỞ tạo trong ngày (giờ VN) ⇒ trả lại nhiệm vụ đó, không tạo cái thứ hai.
 */
export async function fbCrmCreateTaskCore(user: SessionUser, customerId: string, raw: unknown, today: string = todayVN()): Promise<FbCrmResult> {
  return guardSchema(() => createTaskInner(user, customerId, raw, today));
}

async function createTaskInner(user: SessionUser, customerId: string, raw: unknown, today: string): Promise<FbCrmResult> {
  if (!can(user, "customers:write")) return { ok: false, error: "Bạn không có quyền sửa thông tin khách (customers:write)." };
  const parsed = taskZ.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const [customer] = await db.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  if (!customer) return { ok: false, error: "Không có khách này." };
  const cur = await loadFbConnectionState(db, customerId);
  const blocked = careTaskBlockedReason(cur);
  if (blocked) return { ok: false, error: blocked };

  const w = schema.workItems;
  const [open] = await db
    .select({ id: w.id })
    .from(w)
    .where(
      and(
        eq(w.businessEntity, "CUSTOMER"),
        eq(w.businessEntityId, customerId),
        sql`${w.tags} @> ${JSON.stringify([FB_CRM_TASK_TAG])}::jsonb`,
        sql`${w.status} not in ('DONE', 'CANCELLED')`,
        sql`(${w.createdAt} at time zone 'Asia/Ho_Chi_Minh')::date = ${today}::date`,
      ),
    )
    .limit(1);
  if (open) return { ok: true, changed: false, message: "Khách đã có một nhiệm vụ CSKH đang mở tạo hôm nay — không tạo trùng.", taskId: open.id };

  const d = parsed.data;
  const dueAt = d.dueOn ? new Date(`${d.dueOn}T17:00:00+07:00`) : null;
  const r = await saveManualTask(
    {
      title: d.title?.trim() || `Chăm sóc khách «${customer.name}» (Facebook CRM)`,
      summary: d.note?.trim() ?? "",
      department: "SALES",
      assigneeId: cur.careOwnerUserId,
      businessEntity: "CUSTOMER",
      businessEntityId: customerId,
      tags: [FB_CRM_TASK_TAG],
      dueAt,
    },
    { id: user.id, email: user.email, name: user.name, source: "UI" },
  );
  if ("error" in r) return { ok: false, error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: "FB_CRM_TASK_CREATE", entity: "CUSTOMER", entityId: customerId, after: { workItemId: r.id, assigneeId: cur.careOwnerUserId, dueOn: d.dueOn ?? null }, reason: "Facebook Friend CRM · tạo nhiệm vụ CSKH" });
  return { ok: true, changed: true, message: "Đã tạo nhiệm vụ CSKH (phòng Kinh doanh & CSKH).", taskId: r.id };
}
