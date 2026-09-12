"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import { CS_KINDS, CS_RULES_KEY, CS_STATUSES } from "@/lib/constants/cs";
import { CS_MUTATE_ACTIONS, type CsQuickActionKey } from "@/lib/constants/cs-actions";
import { detectCsCases } from "@/lib/cs/detect";
import { addCsNote, applyCsQuickAction, setCsCaseFields, type CsActor } from "@/lib/cs/workqueue";
import { findOrderForCase, listCsCaseEvents } from "@/lib/queries/cs";
import { setSettingJson } from "@/lib/settings";

type Result<T = object> = ({ ok: true } & T) | { error: string };

const caseSchema = z.object({
  id: z.string().optional(),
  orderId: z.string().trim().max(100).optional().nullable(),
  kind: z.enum(CS_KINDS),
  status: z.enum(CS_STATUSES).default("OPEN"),
  title: z.string().trim().min(2).max(300),
  detail: z.string().trim().max(2000).default(""),
  customerName: z.string().trim().max(200).default(""),
  customerPhone: z.string().trim().max(30).default(""),
  assignee: z.string().trim().max(100).default(""),
  resolution: z.string().trim().max(2000).default(""),
});

function revalidate() {
  // `/shipments` nằm trong danh sách vì miền của case quyết định kiện có nằm trong hàng đợi care
  // hay không: đóng một case sai địa chỉ làm đổi số ở CẢ HAI bàn làm việc.
  for (const p of ["/cs", "/shipments", "/alerts", "/"]) revalidatePath(p);
}

/** Người thao tác, theo hình dạng `lib/cs/workqueue.ts` dùng — nguồn `UI` vì đây là Server Action của giao diện. */
function actorOf(user: SessionUser): CsActor {
  return { id: user.id, email: user.email, name: user.name, source: "UI" };
}

async function authorize() {
  const user = await requireUser();
  return { user, error: can(user, "cs:manage") ? null : "Bạn không có quyền xử lý case CSKH" };
}

export async function saveCsCase(input: unknown): Promise<Result<{ id: string }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = caseSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const data = parsed.data;
  const db = await getDb();
  let customerId: string | null = null;
  if (data.orderId) {
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, data.orderId), columns: { id: true, customerId: true, billFullName: true, billPhone: true } });
    if (!order) return { error: "Không tìm thấy đơn hàng" };
    customerId = order.customerId;
    if (!data.customerName) data.customerName = order.billFullName ?? "";
    if (!data.customerPhone) data.customerPhone = order.billPhone ?? "";
  }
  const resolvedAt = data.status === "DONE" || data.status === "CANCELLED" ? new Date() : null;
  if (data.id) {
    const existing = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, data.id) });
    if (!existing) return { error: "Không tìm thấy case" };
    await db
      .update(schema.csCases)
      .set({ orderId: data.orderId ?? existing.orderId, customerId: customerId ?? existing.customerId, kind: data.kind, status: data.status, title: data.title, detail: data.detail, customerName: data.customerName, customerPhone: data.customerPhone, assignee: data.assignee, resolution: data.resolution, resolvedAt: resolvedAt ?? (data.status === "OPEN" || data.status === "IN_PROGRESS" ? null : existing.resolvedAt), updatedAt: new Date() })
      .where(eq(schema.csCases.id, data.id));
    await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_UPDATE", entity: "CS_CASE", entityId: data.id, detail: { before: { status: existing.status, kind: existing.kind, assignee: existing.assignee }, after: data } });
    revalidate();
    return { ok: true, id: data.id };
  }
  const [row] = await db
    .insert(schema.csCases)
    .values({ orderId: data.orderId ?? null, customerId, kind: data.kind, status: data.status, source: "MANUAL", title: data.title, detail: data.detail, customerName: data.customerName, customerPhone: data.customerPhone, assignee: data.assignee, resolution: data.resolution, createdBy: user.email, resolvedAt })
    .returning({ id: schema.csCases.id });
  await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_CREATE", entity: "CS_CASE", entityId: row.id, detail: data });
  revalidate();
  return { ok: true, id: row.id };
}

/** Đổi nhanh trạng thái / người phụ trách từ hai ô chọn trên dòng. */
export async function updateCsCaseQuick(input: { id: string; status?: string; assignee?: string }): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z.object({ id: z.string().min(1), status: z.enum(CS_STATUSES).optional(), assignee: z.string().trim().max(100).optional() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const res = await setCsCaseFields(parsed.data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_UPDATE", entity: "CS_CASE", entityId: parsed.data.id, detail: parsed.data });
  revalidate();
  return { ok: true };
}

/**
 * ═══════════ MỘT NÚT TRÊN DÒNG = MỘT Ý ĐỊNH NGHIỆP VỤ ═══════════
 *
 * Cố ý KHÔNG nhận `{status, assignee, followUpAt}` tuỳ ý từ client rồi ghi thẳng. Client nói Ý
 * ĐỊNH ("đã liên hệ", "nhận việc", "hẹn lại"); `lib/cs/workqueue.ts` dịch ý định thành các trường.
 * Nhờ vậy "đã liên hệ mà quên gán người" hay "hẹn lại mà case vẫn ở Mới" không xảy ra được vì một
 * chỗ gọi nào đó quên một trường.
 *
 * Hành động `LINK` (mở Pancake, mở đơn) KHÔNG đi qua đây: chúng không ghi gì, chỉ là đường dẫn.
 */
const quickSchema = z.object({
  id: z.string().min(1),
  action: z.enum(CS_MUTATE_ACTIONS as [CsQuickActionKey, ...CsQuickActionKey[]]),
  /** Chỉ dùng cho `SNOOZE`. Chuỗi ISO từ client; máy chủ tự kiểm tra là mốc trong tương lai. */
  followUpAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(1000).optional(),
});

export async function csQuickAction(input: unknown): Promise<Result<{ status: string; assignee: string; followUpAt: string | null }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = quickSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { id, action } = parsed.data;
  if (action === "OPEN_POS" || action === "OPEN_ORDER" || action === "CHAT" || action === "OPEN_CARE") return { error: "Hành động này chỉ mở đường dẫn, không ghi dữ liệu" };
  const res = await applyCsQuickAction({ id, action, followUpAt: parsed.data.followUpAt ? new Date(parsed.data.followUpAt) : null, note: parsed.data.note }, actorOf(user));
  if ("error" in res) return res;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CS_CASE_UPDATE",
    entity: "CS_CASE",
    entityId: id,
    detail: { quickAction: action, after: { status: res.data.status, assignee: res.data.assignee, followUpAt: res.data.followUpAt } },
  });
  revalidate();
  return { ok: true, status: res.data.status, assignee: res.data.assignee, followUpAt: res.data.followUpAt ? res.data.followUpAt.toISOString() : null };
}

/** Ghi chú nhanh ngay trên dòng — xem `lib/cs/workqueue.ts::addCsNote` để biết vì sao không đè `resolution`. */
export async function addCsCaseNote(input: unknown): Promise<Result<{ note: string; at: string; by: string }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z.object({ id: z.string().min(1), note: z.string().trim().min(1).max(1000) }).safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Ghi chú không hợp lệ" };
  const res = await addCsNote(parsed.data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_NOTE", entity: "CS_CASE", entityId: parsed.data.id, detail: { note: parsed.data.note } });
  revalidate();
  return { ok: true, note: res.data.note, at: res.data.at.toISOString(), by: res.data.by };
}

/** Lịch sử case cho popover — đọc, nên chỉ cần quyền xem. */
export async function getCsCaseHistory(id: string): Promise<Result<{ events: { id: string; action: string; note: string; actor: string; at: string; previousStatus: string | null; nextStatus: string | null; followUpAt: string | null }[] }>> {
  const user = await requireUser();
  if (!can(user, "cs:view")) return { error: "Bạn không có quyền xem case CSKH" };
  const rows = await listCsCaseEvents(id);
  return {
    ok: true,
    events: rows.map((r) => ({
      id: r.id,
      action: r.action,
      note: r.note,
      actor: r.actorName || r.actorEmail,
      at: r.createdAt.toISOString(),
      previousStatus: r.previousStatus,
      nextStatus: r.nextStatus,
      followUpAt: r.followUpAt ? r.followUpAt.toISOString() : null,
    })),
  };
}

export async function deleteCsCase(id: string): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  const db = await getDb();
  await db.delete(schema.csCases).where(eq(schema.csCases.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_DELETE", entity: "CS_CASE", entityId: id });
  revalidate();
  return { ok: true };
}

export async function runCsDetection(): Promise<Result<{ created: number; scanned: number }>> {
  const { error } = await authorize();
  if (error) return { error };
  const r = await detectCsCases();
  revalidate();
  return { ok: true, ...r };
}

export async function searchOrdersForCase(term: string): Promise<Result<{ orders: Awaited<ReturnType<typeof findOrderForCase>> }>> {
  const { error } = await authorize();
  if (error) return { error };
  if (!term || term.trim().length < 2) return { ok: true, orders: [] };
  return { ok: true, orders: await findOrderForCase(term.trim()) };
}

const rulesSchema = z.object({
  lookbackDays: z.number().int().min(1).max(365),
  tagRules: z.array(z.object({ keyword: z.string().trim().min(2).max(60), kind: z.enum(CS_KINDS) })).max(100),
  noteRules: z.array(z.object({ keyword: z.string().trim().min(2).max(60), kind: z.enum(CS_KINDS) })).max(200),
});

export async function saveCsRules(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "cs:config")) return { error: "Không có quyền" };
  const parsed = rulesSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  await setSettingJson(CS_RULES_KEY, parsed.data);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: CS_RULES_KEY, detail: parsed.data });
  revalidate();
  return { ok: true };
}
