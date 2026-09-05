"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { CS_KINDS, CS_RULES_KEY, CS_STATUSES } from "@/lib/constants/cs";
import { detectCsCases } from "@/lib/cs/detect";
import { findOrderForCase } from "@/lib/queries/cs";
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
  for (const p of ["/cs", "/alerts", "/"]) revalidatePath(p);
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

/** Đổi nhanh trạng thái / người phụ trách */
export async function updateCsCaseQuick(input: { id: string; status?: string; assignee?: string }): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z.object({ id: z.string().min(1), status: z.enum(CS_STATUSES).optional(), assignee: z.string().trim().max(100).optional() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const set: Partial<typeof schema.csCases.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.status) {
    set.status = parsed.data.status;
    set.resolvedAt = parsed.data.status === "DONE" || parsed.data.status === "CANCELLED" ? new Date() : null;
  }
  if (parsed.data.assignee !== undefined) set.assignee = parsed.data.assignee;
  await db.update(schema.csCases).set(set).where(eq(schema.csCases.id, parsed.data.id));
  await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_UPDATE", entity: "CS_CASE", entityId: parsed.data.id, detail: parsed.data });
  revalidate();
  return { ok: true };
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
