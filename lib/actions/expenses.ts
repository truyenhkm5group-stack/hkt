"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { vnStartOfDay } from "@/lib/format";
import { adSpendSchema, expenseSchema } from "@/lib/validation/expenses";

export type ActionResult = { ok: true; id?: string } | { error: string };

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

// ───────────────────────── Chi phí ─────────────────────────

export async function createExpense(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user.role, "expenses:write")) return { error: "Không có quyền" };
  const parsed = expenseSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();
  const [row] = await db
    .insert(schema.expenses)
    .values({ category: data.category, description: data.description, amount: data.amount, occurredAt: vnStartOfDay(data.occurredAt), reference: data.reference, createdBy: user.email })
    .returning({ id: schema.expenses.id });
  await audit({ userId: user.id, userEmail: user.email, action: "EXPENSE_CREATE", entity: "EXPENSE", entityId: row.id, detail: data });
  revalidatePath("/expenses");
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true, id: row.id };
}

export async function updateExpense(id: string, input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user.role, "expenses:write")) return { error: "Không có quyền" };
  if (!id) return { error: "Thiếu mã chi phí" };
  const parsed = expenseSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();
  const existing = await db.query.expenses.findFirst({ where: eq(schema.expenses.id, id) });
  if (!existing) return { error: "Không tìm thấy khoản chi phí" };
  await db
    .update(schema.expenses)
    .set({ category: data.category, description: data.description, amount: data.amount, occurredAt: vnStartOfDay(data.occurredAt), reference: data.reference })
    .where(eq(schema.expenses.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "EXPENSE_UPDATE", entity: "EXPENSE", entityId: id, detail: { before: { category: existing.category, description: existing.description, amount: existing.amount, occurredAt: existing.occurredAt, reference: existing.reference }, after: data } });
  revalidatePath("/expenses");
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true, id };
}

export async function deleteExpense(id: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user.role, "expenses:write")) return { error: "Không có quyền" };
  if (!id) return { error: "Thiếu mã chi phí" };
  const db = await getDb();
  const existing = await db.query.expenses.findFirst({ where: eq(schema.expenses.id, id) });
  if (!existing) return { error: "Không tìm thấy khoản chi phí" };
  await db.delete(schema.expenses).where(eq(schema.expenses.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "EXPENSE_DELETE", entity: "EXPENSE", entityId: id, detail: { category: existing.category, description: existing.description, amount: existing.amount, occurredAt: existing.occurredAt } });
  revalidatePath("/expenses");
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true };
}

// ───────────────────────── Quảng cáo ─────────────────────────

export async function createAdSpend(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user.role, "expenses:write")) return { error: "Không có quyền" };
  const parsed = adSpendSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();
  const [row] = await db
    .insert(schema.adSpends)
    .values({ platform: data.platform, campaign: data.campaign, spend: data.spend, leads: data.leads, orders: data.orders, revenue: data.revenue, spendDate: vnStartOfDay(data.spendDate), note: data.note, createdBy: user.email })
    .returning({ id: schema.adSpends.id });
  await audit({ userId: user.id, userEmail: user.email, action: "AD_SPEND_CREATE", entity: "AD_SPEND", entityId: row.id, detail: data });
  revalidatePath("/expenses");
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true, id: row.id };
}

export async function updateAdSpend(id: string, input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user.role, "expenses:write")) return { error: "Không có quyền" };
  if (!id) return { error: "Thiếu mã chi tiêu" };
  const parsed = adSpendSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();
  const existing = await db.query.adSpends.findFirst({ where: eq(schema.adSpends.id, id) });
  if (!existing) return { error: "Không tìm thấy dòng chi tiêu quảng cáo" };
  await db
    .update(schema.adSpends)
    .set({ platform: data.platform, campaign: data.campaign, spend: data.spend, leads: data.leads, orders: data.orders, revenue: data.revenue, spendDate: vnStartOfDay(data.spendDate), note: data.note })
    .where(eq(schema.adSpends.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "AD_SPEND_UPDATE", entity: "AD_SPEND", entityId: id, detail: { before: { platform: existing.platform, campaign: existing.campaign, spend: existing.spend, leads: existing.leads, orders: existing.orders, revenue: existing.revenue, spendDate: existing.spendDate }, after: data } });
  revalidatePath("/expenses");
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true, id };
}

export async function deleteAdSpend(id: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user.role, "expenses:write")) return { error: "Không có quyền" };
  if (!id) return { error: "Thiếu mã chi tiêu" };
  const db = await getDb();
  const existing = await db.query.adSpends.findFirst({ where: eq(schema.adSpends.id, id) });
  if (!existing) return { error: "Không tìm thấy dòng chi tiêu quảng cáo" };
  await db.delete(schema.adSpends).where(eq(schema.adSpends.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "AD_SPEND_DELETE", entity: "AD_SPEND", entityId: id, detail: { platform: existing.platform, campaign: existing.campaign, spend: existing.spend, spendDate: existing.spendDate } });
  revalidatePath("/expenses");
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true };
}
